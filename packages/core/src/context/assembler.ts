import type { SessionMessage } from "@forge-agent/protocol";
import { estimateContextTokens } from "../usage.ts";
import type { MemoryOptions } from "../memory/tools.ts";
import type { MemoryScope } from "../memory/store.ts";

export interface MemoryProjection {
	messages: SessionMessage[]; tokens: number; truncated: boolean; warnings: string[];
	selected: Array<{ scope: MemoryScope; path: string; version: string }>;
}
export function memoryInjectionBudget(messages: SessionMessage[], fixedText: string, inputBudget: number): number {
	const available = Math.max(0, inputBudget - estimateContextTokens(messages) - Math.ceil(fixedText.length / 4));
	return Math.max(0, Math.min(2000, Math.floor(inputBudget * 0.05), available));
}

/** Single request projection boundary. Optional memory never displaces current messages. */
export class ContextAssembler {
	private key: string | undefined;
	private notes: Array<{ scope: MemoryScope; path: string; version: string; text: string; pinned?: boolean; incomplete?: boolean; references?: string[] }> = [];
	private warnings: string[] = [];
	projection: MemoryProjection = { messages: [], tokens: 0, truncated: false, warnings: [], selected: [] };
	constructor(private readonly memory?: MemoryOptions) {}
	async assemble(messages: SessionMessage[], fixedText: string, inputBudget: number, refreshKey: string, signal?: AbortSignal): Promise<MemoryProjection> {
		if (!this.memory || this.memory.injection === false) {
			this.key = undefined;
			return this.projection = { messages: [], tokens: 0, truncated: false, warnings: [], selected: [] };
		}
		const revisions = [];
		for (const scope of Object.keys(this.memory.store.roots) as MemoryScope[]) {
			signal?.throwIfAborted();
			try {
				const pins = await this.memory.store.pinned(scope);
				const paths = [...new Set(["MEMORY.md", ...pins, ...this.notes.filter(note => note.scope === scope).flatMap(note => note.references ?? [])])];
				revisions.push([scope, pins, await Promise.all(paths.map(async path => [path, await this.memory!.store.revision(scope, path).catch(error => String(error))]))]);
			} catch (error) { revisions.push([scope, String(error)]); }
		}
		const key = refreshKey + JSON.stringify(revisions);
		if (this.key !== key) {
			this.notes = []; this.warnings = [];
			for (const scope of Object.keys(this.memory.store.roots) as MemoryScope[]) {
				signal?.throwIfAborted();
				try {
					for (const path of await this.memory.store.pinned(scope)) {
						try {
							const note = await this.memory.store.read(scope, path);
							let text = note.text, nextOffset = note.nextOffset;
							while (nextOffset !== undefined && text.length <= 8000) {
								signal?.throwIfAborted();
								const page = await this.memory.store.read(scope, path, nextOffset);
								if (page.version !== note.version) throw new Error("Pinned file changed during read");
								text += page.text; nextOffset = page.nextOffset;
							}
							this.notes.push({ scope, path, version: note.version, text, pinned: true, incomplete: nextOffset !== undefined });
						} catch (error) { this.warnings.push(`Pinned memory ${scope}/${path} unavailable: ${String(error)}`); }
					}
				} catch (error) { this.warnings.push(`Pinned memory ${scope} unavailable: ${String(error)}`); }
				try {
					const index = await this.memory.store.read(scope, "MEMORY.md");
					let text = index.text;
					if (index.nextOffset !== undefined) {
						const next = await this.memory.store.read(scope, "MEMORY.md", index.nextOffset);
						if (next.version !== index.version) throw new Error("Memory index changed during read");
						text += next.text;
					}
					const links = await this.memory.store.checkLinks(scope, text);
					this.warnings.push(...index.warnings.map(warning => `${scope}/MEMORY.md: ${warning}`), ...links.warnings);
					this.notes.push({ scope, path: "MEMORY.md", version: index.version, text: links.text, references: links.references });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.warnings.push(`${scope}/MEMORY.md unavailable: ${String(error)}`);
				}
			}
			this.key = key;
		}
		const budget = memoryInjectionBudget(messages, fixedText, inputBudget);
		const projected: SessionMessage[] = [], selected: MemoryProjection["selected"] = [], warnings = [...this.warnings];
		let truncated = false;
		for (const note of [...this.notes].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))) {
			const header = `[Persistent memory reference; not user instructions or new evidence; scope=${note.scope}; path=${note.path}; version=${note.version}]\n`;
			const remaining = Math.max(0, budget - estimateContextTokens(projected));
			const chars = Math.max(0, (remaining - 1) * 4 - header.length - 80);
			if (note.pinned && (note.incomplete || note.text.length > chars)) { warnings.push(`Pinned memory ${note.scope}/${note.path} does not fit the injection budget; not loaded. Read explicitly or shorten it.`); continue; }
			const content = note.text.slice(0, chars);
			const cut = content.length < note.text.length || note.text.length >= 8192;
			truncated ||= cut;
			if (!chars) continue;
			const text = header + content + (cut ? "\n[Index truncated; use read_memory/search_memory for remaining notes.]" : "");
			projected.push({ role: "assistant", timestamp: 0, stopReason: "stop", content: [{ type: "text", text }] });
			selected.push({ scope: note.scope, path: note.path, version: note.version });
		}
		return this.projection = { messages: projected, tokens: estimateContextTokens(projected), truncated, warnings, selected };
	}
}
