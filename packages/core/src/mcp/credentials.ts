import type { McpCredentialRecord, McpCredentialStore } from "./types.ts";
export class MemoryMcpCredentialStore implements McpCredentialStore {
	private records = new Map<string, McpCredentialRecord>();
	private locks = new Map<string, Promise<void>>();
	async read(key: string) { return structuredClone(this.records.get(key)); }
	async write(key: string, record: McpCredentialRecord) { this.records.set(key, structuredClone(record)); }
	async delete(key: string) { this.records.delete(key); }
	async withLock<T>(key: string, operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
		const prior = this.locks.get(key) ?? Promise.resolve();
		let release!: () => void; const next = new Promise<void>(resolve => { release = resolve; }); this.locks.set(key, next);
		try { await prior; const current = signal ?? new AbortController().signal; current.throwIfAborted(); return await operation(current); }
		finally { release(); if (this.locks.get(key) === next) this.locks.delete(key); }
	}
	clear() { this.records.clear(); }
}
