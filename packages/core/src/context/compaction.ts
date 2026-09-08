import type { SessionEvent, SessionMessage, TokenUsage } from "@forge-agent/protocol";
import { selectedBranch, type CompactionEntry, type MessageEntry, type SessionState } from "../session-storage.ts";
import { estimateContextTokens } from "../usage.ts";

export interface ContextSettings { enabled: boolean; reserveTokens: number; keepRecentTokens: number; summaryReasoning: "inherit" | "off"; }
export const DEFAULT_CONTEXT: ContextSettings = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, summaryReasoning: "inherit" };
export interface RetryPolicy { enabled: boolean; maxRetries: number; baseDelayMs: number; }
export const DEFAULT_RETRY: RetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 2000 };
export function resolveRetryPolicy(settings: Partial<RetryPolicy> = {}): RetryPolicy {
	const policy = { ...DEFAULT_RETRY, ...settings };
	if (typeof policy.enabled !== "boolean" || !Number.isSafeInteger(policy.maxRetries) || policy.maxRetries < 0 || !Number.isFinite(policy.baseDelayMs) || policy.baseDelayMs < 0) throw new Error("Invalid retry settings");
	return policy;
}

export function validateRequestLimits(options: { maxTokens?: number; contextWindow?: number }): void {
	for (const key of ["maxTokens", "contextWindow"] as const) {
		if (options[key] !== undefined && (!Number.isSafeInteger(options[key]) || options[key]! <= 0)) throw new Error(`Invalid ${key}: expected a positive safe integer`);
	}
}
export type CompactionReason = "manual" | "threshold" | "overflow" | "length" | "usage";
export interface CompactionResult { status: "complete" | "skipped" | "error"; operationId: string; beforeTokens: number; afterTokens?: number; error?: string; }
export interface SummaryRequest { prompt: string; maxTokens: number; reasoning: "inherit" | "off"; }
export interface SummaryDriver {
	maxTokens?: number;
	retry?: Partial<RetryPolicy>;
	isRetryable?(message: SessionMessage): boolean;
	wait?(ms: number, signal: AbortSignal): Promise<void>;
	summaryThinking?(requested: "inherit" | "off"): { level: string; fallback?: string };
	summarize?(request: SummaryRequest, signal: AbortSignal): Promise<SessionMessage>;
}
export interface ContextView { entries: MessageEntry[]; previous?: CompactionEntry; }
export function contextView(state: SessionState): ContextView {
	const branch = selectedBranch(state);
	let index = branch.length - 1;
	while (index >= 0 && branch[index]?.type !== "compaction") index--;
	const previous = branch[index];
	if (previous?.type !== "compaction") return { entries: branch.filter((entry): entry is MessageEntry => entry.type === "message") };
	const start = branch.findIndex((entry) => entry.id === previous.firstKeptEntryId);
	if (start < 0 || start >= index || branch[start]?.type !== "message") throw new Error("Invalid compaction retained boundary");
	return { previous, entries: branch.slice(start).filter((entry): entry is MessageEntry => entry.type === "message") };
}
export function buildContext(state: SessionState): SessionMessage[] {
	const view = contextView(state);
	return structuredClone([
		...(view.previous ? [{ role: "user" as const, content: [{ type: "text" as const, text: view.previous.summary }], timestamp: Date.parse(view.previous.timestamp) }] : []),
		...view.entries.map((entry) => entry.message),
	]);
}
export interface CompactionPlan {
	firstKeptEntryId: string;
	history: SessionMessage[];
	prefix: SessionMessage[];
	previousSummary?: string;
	details: { readFiles: string[]; modifiedFiles: string[] };
}
export function prepareCompaction(state: SessionState, settings: ContextSettings): CompactionPlan | undefined {
	if (selectedBranch(state).at(-1)?.type === "compaction") return;
	const view = contextView(state);
	const entries = view.entries;
	const cuts = entries.flatMap((entry, index) => entry.message.role !== "toolResult" ? [index] : []);
	if (!cuts.length) return;
	let cut = cuts[0]!;
	let tokens = 0;
	for (let index = entries.length - 1; index >= 0; index--) {
		tokens += estimateContextTokens([entries[index]!.message]);
		if (tokens >= settings.keepRecentTokens) { cut = cuts.find((candidate) => candidate >= index) ?? cut; break; }
	}
	if (cut === 0) return;
	let turnStart = cut;
	if (entries[cut]?.message.role !== "user") {
		while (turnStart > 0 && entries[turnStart]?.message.role !== "user") turnStart--;
	}
	const history = entries.slice(0, turnStart).map((entry) => entry.message);
	const prefix = entries.slice(turnStart, cut).map((entry) => entry.message);
	const read = new Set(view.previous?.details?.readFiles ?? []);
	const modified = new Set(view.previous?.details?.modifiedFiles ?? []);
	for (const message of [...history, ...prefix]) for (const block of message.content) {
		if (block.type !== "tool_call" || typeof block.arguments.path !== "string") continue;
		if (block.name === "read") read.add(block.arguments.path);
		if (block.name === "write" || block.name === "edit") modified.add(block.arguments.path);
	}
	return { firstKeptEntryId: entries[cut]!.id, history, prefix, ...(view.previous ? { previousSummary: view.previous.summary } : {}), details: { readFiles: [...read].filter((path) => !modified.has(path)).sort(), modifiedFiles: [...modified].sort() } };
}

// Templates adapted from earendil-works/pi (MIT), pinned in ADR-014.
const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

export const SUMMARY_SYSTEM = "You are a context summarization assistant. Summarize the conversation provided inside the conversation tags. Do not continue the conversation or respond to questions in it. Output only the structured summary.";
export function serializeConversation(messages: readonly SessionMessage[]): string {
	return messages.map((message) => `[${message.role}]\n` + message.content.map((block) => {
		if (block.type === "text") return message.role === "toolResult" && block.text.length > 2000 ? block.text.slice(0, 2000) + "\n[truncated]" : block.text;
		if (block.type === "thinking") return `[thinking] ${block.thinking}`;
		if (block.type === "image") return `[image: ${block.mimeType}]`;
		return `[tool call ${block.name}] ${JSON.stringify(block.arguments)}`;
	}).join("\n")).join("\n\n");
}
export async function generateCompaction(plan: CompactionPlan, settings: ContextSettings, driver: SummaryDriver, signal: AbortSignal, instructions?: string, observe: (details: { phase: "retry" | "attempt"; attempt: number; delayMs?: number; error?: string; usage?: TokenUsage; thinking?: string }) => void = () => {}): Promise<{ summary: string; usage?: TokenUsage }> {
	if (!driver.summarize) throw new Error("Model does not support summarization");
	const usages: TokenUsage[] = [];
	const policy = resolveRetryPolicy(driver.retry);
	let totalAttempts = 0;
	const summarize = async (messages: SessionMessage[], template: string, factor: number): Promise<string> => {
		signal.throwIfAborted();
		const prompt = `<conversation>\n${serializeConversation(messages)}\n</conversation>\n\n${template}`;
		let result: SessionMessage;
		for (let retry = 0; ; retry++) {
			signal.throwIfAborted();
			const thinking = driver.summaryThinking?.(settings.summaryReasoning);
			result = await driver.summarize!({ prompt, maxTokens: Math.min(Math.floor(factor * settings.reserveTokens), (driver.maxTokens ?? 0) > 0 ? driver.maxTokens! : Infinity), reasoning: settings.summaryReasoning }, signal);
			totalAttempts++;
			if (result.usage) usages.push(result.usage);
			observe({ phase: "attempt", attempt: totalAttempts, ...(result.usage ? { usage: result.usage } : {}), ...(thinking ? { thinking: thinking.level, ...(thinking.fallback ? { error: thinking.fallback } : {}) } : {}) });
			if (!policy.enabled || retry >= policy.maxRetries || !driver.isRetryable?.(result)) break;
			const delayMs = policy.baseDelayMs * 2 ** retry;
			observe({ phase: "retry", attempt: retry + 1, delayMs, ...(result.errorMessage ? { error: result.errorMessage } : {}) });
			await (driver.wait ?? waitForRetry)(delayMs, signal);
		}
		signal.throwIfAborted();
		const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
		if (["error", "aborted", "length"].includes(result.stopReason ?? "") || !text || result.content.some((block) => block.type === "tool_call")) throw new Error(result.errorMessage ?? "Invalid or incomplete summary");
		return text;
	};
	let summary = plan.previousSummary ?? "No prior history.";
	if (plan.history.length) {
		const template = (plan.previousSummary ? `<previous-summary>\n${plan.previousSummary}\n</previous-summary>\n\n${UPDATE_SUMMARIZATION_PROMPT}` : SUMMARIZATION_PROMPT) + (instructions ? `\n\nAdditional focus: ${instructions}` : "");
		summary = await summarize(plan.history, template, 0.8);
	}
	if (plan.prefix.length) summary += "\n\n---\n\n**Turn Context (split turn):**\n\n" + await summarize(plan.prefix, TURN_PREFIX_SUMMARIZATION_PROMPT, 0.5);
	summary += `\n\n<read-files>\n${plan.details.readFiles.join("\n")}\n</read-files>\n<modified-files>\n${plan.details.modifiedFiles.join("\n")}\n</modified-files>`;
	return { summary, ...(usages.length ? { usage: sumUsage(usages) } : {}) };
}

export function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) { reject(signal.reason); return; }
		const aborted = () => { clearTimeout(timer); reject(signal.reason); };
		const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, ms);
		signal.addEventListener("abort", aborted, { once: true });
	});
}

export function sumUsage(usages: readonly TokenUsage[]): TokenUsage {
	return usages.reduce<TokenUsage>((total, usage) => ({
		input: total.input + usage.input, output: total.output + usage.output,
		cacheRead: total.cacheRead + usage.cacheRead, cacheWrite: total.cacheWrite + usage.cacheWrite,
		totalTokens: total.totalTokens + usage.totalTokens,
		cost: { input: (total.cost?.input ?? 0) + (usage.cost?.input ?? 0), output: (total.cost?.output ?? 0) + (usage.cost?.output ?? 0), cacheRead: (total.cost?.cacheRead ?? 0) + (usage.cost?.cacheRead ?? 0), cacheWrite: (total.cost?.cacheWrite ?? 0) + (usage.cost?.cacheWrite ?? 0), total: (total.cost?.total ?? 0) + (usage.cost?.total ?? 0) },
	}), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
}
