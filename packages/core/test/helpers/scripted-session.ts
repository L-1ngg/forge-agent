import { EventStream, type AssistantMessage, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { SessionEvent, SessionMessage, ToolCallBlock } from "@forge-agent/protocol";
import { AgentSession } from "../../src/agent-session.ts";
import { fromSessionMessage, toSessionMessage } from "../../src/event-projection.ts";
import type { SummaryDriver, ContextSettings } from "../../src/context/compaction.ts";
import type { SessionAssembly } from "../../src/configuration.ts";

/** Controlled model/tool boundary for the existing context and persistence contracts.
 * Contains no execution loop: every test runs the production AgentSession + Agent. */
export interface ScriptedDriver extends SummaryDriver {
	contextWindow: number;
	toolNames?: string[];
	isOverflow?(message: SessionMessage): boolean;
	stream(messages: readonly SessionMessage[], signal: AbortSignal, emit: (event: SessionEvent) => void): Promise<SessionMessage>;
	execute(call: ToolCallBlock, signal: AbortSignal): Promise<{ message: SessionMessage; details?: unknown; terminate?: boolean }>;
	abortInteractions(): void;
}
export function createScriptedSession(driver: ScriptedDriver, history: readonly SessionMessage[] = [], context: Partial<ContextSettings> = {}): AgentSession {
	const model = { id: "script", name: "script", api: "faux", provider: "faux", baseUrl: "", reasoning: false, input: ["text" as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: driver.contextWindow, maxTokens: driver.maxTokens ?? 1000 };
	const assembly: SessionAssembly = {
		options: {
			model, cwd: process.cwd(), systemPrompt: "", thinkingLevel: "off", context, history: [...history], stream(_model, request, options) {
				const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(event => event.type === "done" || event.type === "error", event => { if (event.type === "done") return event.message; if (event.type === "error") return event.error; throw new Error("Unexpected result"); });
				const signal = options?.signal ?? new AbortController().signal;
				const partial = fromSessionMessage({ role: "assistant", content: [], timestamp: 0, stopReason: "stop" }, model) as AssistantMessage;
				void (async () => {
					try {
						signal.throwIfAborted();
						stream.push({ type: "start", partial });
						const result = await driver.stream(request.messages.map(message => toSessionMessage(message)!), signal, event => {
							if (event.type === "message_delta") stream.push({ type: event.contentType === "text" ? "text_delta" : event.contentType === "thinking" ? "thinking_delta" : "toolcall_delta", contentIndex: event.contentIndex, delta: event.delta, partial });
						});
						const message = fromSessionMessage({ ...result, ...(signal.aborted ? { stopReason: "aborted" } : {}) }, model) as AssistantMessage;
						if (message.stopReason === "error" || message.stopReason === "aborted") stream.push({ type: "error", reason: message.stopReason, error: message });
						else stream.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
						stream.end(message);
					} catch (error) {
						const message: AssistantMessage = { ...partial, stopReason: signal.aborted ? "aborted" : "error", errorMessage: String(error) };
						stream.push({ type: "error", reason: signal.aborted ? "aborted" : "error", error: message }); stream.end(message);
					}
				})();
				return stream;
			}
		},
		toolset: {
			clear() { }, tools: (driver.toolNames ?? []).map(name => ({
				name, label: name, description: "fixture", parameters: { type: "object" }, async execute(id, args, signal) {
					const result = await driver.execute({ type: "tool_call", name, id, arguments: args as Record<string, unknown> }, signal ?? new AbortController().signal);
					return { content: result.message.content.filter(block => block.type === "text" || block.type === "image"), details: result.details, ...(result.terminate !== undefined ? { terminate: result.terminate } : {}) };
				}
			}))
		},
		driver: { ...driver, isOverflow: message => driver.isOverflow?.(message) ?? false },
	};
	const session = new AgentSession(assembly, async () => { throw new Error("Scripted session has no model catalog"); });
	const abort = session.abort.bind(session);
	session.abort = () => { abort(); driver.abortInteractions(); };
	return session;
}
