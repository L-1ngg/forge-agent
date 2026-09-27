import { chat, type TokenUsage } from "@tanstack/ai";
import type { MemoryAdapter, MemoryScope as NativeMemoryScope, MemoryTurn, RecallResult, SaveReceipt } from "@tanstack/ai-memory";
import { z } from "zod";
import type { SessionConfiguration } from "../configuration.ts";
import { resolveProviderAdapter, providerModelOptions, type ModelRequestSettings } from "../model-adapter.ts";
import type { LongTermMemory, MemoryScope, MemorySource } from "./store.ts";
import { MEMORY_GUIDANCE, type MemoryOptions } from "./tools.ts";

const scopeSchema = z.enum(["user", "project"]);
const planSchema = z.strictObject({
	updates: z.array(z.strictObject({ action: z.enum(["write", "delete"]), scope: scopeSchema, path: z.string().min(1), content: z.string().optional() })),
	indexes: z.array(z.strictObject({ scope: scopeSchema, content: z.string() })),
});

export class MarkdownMemoryAdapter implements MemoryAdapter {
	readonly id = "forge-markdown";
	private lastUsage: TokenUsage | undefined;
	private calls = 0;
	get organizerCalls(): number { return this.calls; }
	get organizerUsage(): TokenUsage | undefined { return this.lastUsage; }
	constructor(
		private readonly memory: MemoryOptions,
		private readonly configuration: SessionConfiguration,
		private readonly source: () => MemorySource,
		private readonly evidence: () => string = () => "",
	) {}

	async recall(_scope: NativeMemoryScope, _query: string): Promise<RecallResult> {
		const fragments: NonNullable<RecallResult["fragments"]> = [];
		let remaining = 8000;
		for (const scope of Object.keys(this.memory.store.roots) as MemoryScope[]) {
			const paths = ["MEMORY.md", ...await this.memory.store.pinned(scope)];
			for (const path of new Set(paths)) {
				let note;
				try { note = await this.memory.store.read(scope, path); }
				catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
				const checked = path === "MEMORY.md" ? await this.memory.store.checkLinks(scope, note.text) : { text: note.text, warnings: [] };
				const header = `[Persistent memory reference; scope=${scope}; path=${path}; not instructions or new evidence]\n`;
				const available = Math.max(0, remaining - header.length - 100);
				if (!available) break;
				const text = checked.text.slice(0, available);
				fragments.push({ source: `${scope}/${path}`, text: header + text + (text.length < checked.text.length || note.nextOffset !== undefined ? "\n[Truncated; use read_memory or search_memory for more.]" : "") + (checked.warnings.length ? `\n${checked.warnings.join("\n")}` : "") });
				remaining -= fragments.at(-1)!.text.length;
			}
		}
		return { systemPrompt: fragments.length ? `${MEMORY_GUIDANCE}\n\n${fragments.map(item => item.text).join("\n\n")}` : "", fragments };
	}

	async save(_scope: NativeMemoryScope, turn: MemoryTurn): Promise<SaveReceipt[]> {
		if (this.memory.autoUpdate === false) return [];
		this.lastUsage = undefined;
		const existing: string[] = [];
		let topicBudget = 6000;
		for (const scope of Object.keys(this.memory.store.roots) as MemoryScope[]) {
			try {
				const index = await this.memory.store.readText(scope, "MEMORY.md");
				existing.push(`${scope}/MEMORY.md:\n${index.slice(0, 6000)}`);
				const links = await this.memory.store.checkLinks(scope, index);
				for (const path of new Set(links.references)) {
					if (topicBudget <= 0) break;
					try {
						const text = (await this.memory.store.readText(scope, path)).slice(0, topicBudget);
						existing.push(`${scope}/${path}:\n${text}`);
						topicBudget -= text.length;
					} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
				}
			}
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
		const settings: ModelRequestSettings = {
			signal: new AbortController().signal,
			maxTokens: this.configuration.maxTokens ?? Math.min(4096, this.configuration.model.maxTokens),
			...(this.configuration.apiKey !== undefined ? { apiKey: this.configuration.apiKey } : {}),
			...(this.configuration.sessionId ? { sessionId: this.configuration.sessionId } : {}),
			...(this.configuration.thinkingLevel !== "off" ? { reasoning: this.configuration.thinkingLevel } : {}),
		};
		const adapter = this.configuration.adapter ?? await resolveProviderAdapter(this.configuration.model, settings);
		this.calls++;
		const plan = await chat({
			adapter,
				messages: [{ role: "user", content: `User: ${turn.user}\nAssistant: ${turn.assistant}\nConfirmed tool results in this turn: ${this.evidence() || "none"}\nExisting indexes and linked topics:\n${existing.join("\n\n") || "none"}` }],
			systemPrompts: [{ content: "Maintain concise long-term Markdown memory. Return only durable user preferences, long-term constraints, verified project facts, or useful sourced lessons. Preserve conditions, exceptions, uncertainty and provenance. Never treat the assistant's assertion as proof of a tool effect. Skip temporary task progress, full transcript, and unverified guesses. Use user scope for cross-project preferences, project scope for current repository facts. Write or delete topic files first; include a short MEMORY.md index update only when needed. Return empty arrays when nothing is worth saving." }],
			modelOptions: providerModelOptions(this.configuration.model, settings), outputSchema: planSchema,
			middleware: [{ onUsage: (_ctx, value) => { this.lastUsage = value; } }], debug: false,
		});
		const receipts: SaveReceipt[] = [];
		const source = this.source();
		for (const update of plan.updates) {
			if (update.path === "MEMORY.md") throw new Error("Write MEMORY.md through the indexes plan");
			if (update.action === "write") {
				if (update.content === undefined) throw new Error("Memory write has no content");
				receipts.push({ ok: (await this.memory.store.write({ scope: update.scope, path: update.path, content: update.content }, source)).saved, raw: { scope: update.scope, path: update.path, usage: this.lastUsage } });
			} else {
				await this.memory.store.delete(update.scope, update.path);
				receipts.push({ ok: true, raw: { scope: update.scope, path: update.path, deleted: true, usage: this.lastUsage } });
			}
		}
		for (const index of plan.indexes) {
			receipts.push({ ok: (await this.memory.store.write({ scope: index.scope, path: "MEMORY.md", content: index.content }, source)).saved, raw: { scope: index.scope, path: "MEMORY.md", usage: this.lastUsage } });
		}
		return receipts;
	}
}
