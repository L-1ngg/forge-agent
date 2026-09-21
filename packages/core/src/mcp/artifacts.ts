import { randomUUID } from "node:crypto";
import { McpError, type McpArtifactReference, type McpArtifactStore } from "./types.ts";
export class MemoryMcpArtifactStore implements McpArtifactStore {
	private entries = new Map<string, { bytes: Uint8Array; metadata: McpArtifactReference }>();
	async put(bytes: Uint8Array, metadata: { mimeType: string; name?: string }, signal?: AbortSignal) {
		signal?.throwIfAborted(); const reference = { ...metadata, id: randomUUID(), size: bytes.byteLength };
		this.entries.set(reference.id, { bytes: bytes.slice(), metadata: reference }); return structuredClone(reference);
	}
	async read(id: string, signal?: AbortSignal) { signal?.throwIfAborted(); const entry = this.entries.get(id); if (!entry) throw new McpError("artifact-missing", "MCP artifact is missing"); return structuredClone(entry); }
	async delete(id: string) { this.entries.delete(id); }
	clear() { this.entries.clear(); }
}
