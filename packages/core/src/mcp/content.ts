import type { ContentBlock } from "@modelcontextprotocol/client";
import { McpError, type McpArtifactStore, type McpContentSnapshot } from "./types.ts";

const TOTAL_LIMIT = 16 * 1024 * 1024, ARTIFACT_LIMIT = 8 * 1024 * 1024, TEXT_LIMIT = 64 * 1024;
export async function normalizeMcpContent(input: { serverId: string; remoteName: string; catalogRevision: number; content: ContentBlock[]; structuredContent?: unknown }, store: McpArtifactStore, signal?: AbortSignal): Promise<McpContentSnapshot> {
	const original = JSON.stringify({ content: input.content, ...("structuredContent" in input ? { structuredContent: input.structuredContent } : {}) });
	if (Buffer.byteLength(original) > TOTAL_LIMIT) throw new McpError("content-too-large", "MCP result exceeds 16 MiB; original content was not retained");
	const result: McpContentSnapshot = { serverId: input.serverId, remoteName: input.remoteName, catalogRevision: input.catalogRevision, fetchedAt: Date.now(), original: JSON.parse(original), content: [], artifacts: [], diagnostics: [], ...("structuredContent" in input ? { structuredContent: input.structuredContent } : {}) };
	let textBytes = 0;
	const artifact = async (bytes: Uint8Array, mimeType: string) => {
		if (bytes.byteLength > ARTIFACT_LIMIT) throw new McpError("content-too-large", "MCP attachment exceeds 8 MiB; original content was not retained");
		const ref = await store.put(bytes, { mimeType }, signal); result.artifacts.push(ref); return ref;
	};
	const text = async (value: string) => {
		const bytes = Buffer.from(value); const remaining = Math.max(0, TEXT_LIMIT - textBytes); textBytes += bytes.length;
		if (bytes.length <= remaining) result.content.push({ type: "text", text: value });
		else { const ref = await artifact(bytes, "text/plain"); result.content.push({ type: "text", text: `${bytes.subarray(0, remaining).toString("utf8")}\n[Truncated; complete text: artifact ${ref.id}, ${ref.size} bytes. Use mcp_read_artifact.]` }); result.diagnostics.push("text-truncated"); }
	};
	try {
		for (const block of input.content) {
			signal?.throwIfAborted();
			if (block.type === "text") await text(block.text);
			else if (block.type === "resource_link") await text(`Resource link (not fetched): ${JSON.stringify(block)}`);
			else if (block.type === "resource" && "text" in block.resource) await text(`Resource ${block.resource.uri}:\n${block.resource.text}`);
			else {
				const data = block.type === "resource" ? ("blob" in block.resource ? block.resource.blob : "") : block.data;
				const mime = block.type === "resource" ? block.resource.mimeType ?? "application/octet-stream" : block.mimeType;
				const ref = await artifact(Buffer.from(data, "base64"), mime);
				if ((block.type === "image" || block.type === "resource") && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime) && ref.size <= TEXT_LIMIT) result.content.push({ type: "image", data, mimeType: mime });
				await text(`Attachment ${ref.id}: ${mime}, ${ref.size} bytes. ${block.type === "audio" ? "Audio is not transcribed." : "Use mcp_read_artifact to access original bytes."}`);
			}
		}
		if ("structuredContent" in input) {
			const serialized = JSON.stringify(input.structuredContent);
			if (!input.content.some(block => block.type === "text" && block.text.trim() === serialized)) await text(`Structured result:\n${serialized}`);
		}
		return result;
	} catch (error) { await Promise.allSettled(result.artifacts.map(ref => store.delete?.(ref.id))); throw error; }
}
