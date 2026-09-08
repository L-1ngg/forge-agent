import { defineBuiltinTool } from "./define-builtin.ts";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileError, toolError } from "./errors.ts";
import type { HarnessTool } from "./types.ts";

export interface ReadInput {
	path: string;
	offset?: number;
	limit?: number;
}

export interface ReadOutput {
	path: string;
	content: string;
	totalLines: number;
	truncated: boolean;
	nextOffset?: number;
	notice?: string;
}

export const readTool: HarnessTool<ReadInput, ReadOutput> = defineBuiltinTool({
	name: "read",
	label: "Read file",
	description: "Read a UTF-8 text file, optionally selecting an one-based offset and line count, with a 2000-line / 50 KiB head preview.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", minLength: 1, description: "Absolute path or path relative to the working directory." },
			offset: { type: "integer", minimum: 1, description: "First one-based line to return." },
			limit: { type: "integer", minimum: 1, description: "Maximum number of lines to return." },
		},
		required: ["path"],
		additionalProperties: false,
	},
	async execute(input, context) {
		if (!input.path?.trim()) {
			return toolError("INVALID_ARGUMENT", "path must be a non-empty string", "path", "non-empty file path", "src/index.ts");
		}
		if (input.offset !== undefined && (!Number.isInteger(input.offset) || input.offset < 1)) {
			return toolError("INVALID_ARGUMENT", "offset must be a positive integer", "offset", "integer >= 1", "1");
		}
		if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
			return toolError("INVALID_ARGUMENT", "limit must be a positive integer", "limit", "integer >= 1", "20");
		}


		const path = resolve(context.cwd, input.path);
		try {
			const info = await stat(path);
			if (info.isDirectory()) return toolError("PATH_IS_DIRECTORY", "Expected a file but found a directory", "path", "UTF-8 text file", "README.md");
			const content = await readFile(path, "utf8");
			const lines = content.split("\n");
			const start = (input.offset ?? 1) - 1;
			if (start >= lines.length) return toolError("INVALID_ARGUMENT", "offset is beyond the end of the file", "offset", "existing line", "1");
			const selected: string[] = [];
			let bytes = 0;
			for (const line of lines.slice(start, start + Math.min(input.limit ?? 2000, 2000))) {
				const size = Buffer.byteLength(line) + (selected.length ? 1 : 0);
				if (bytes + size > 50 * 1024) break;
				selected.push(line); bytes += size;
			}
			const nextOffset = start + selected.length + 1;
			const truncated = nextOffset <= lines.length;
			const oversized = selected.length === 0 && truncated;
			return { ok: true, value: {
				path, content: selected.join("\n"), totalLines: lines.length, truncated,
				...(truncated && !oversized ? { nextOffset, notice: `Continue with offset=${nextOffset}.` } : {}),
				...(oversized ? { notice: `Line ${start + 1} exceeds 50 KiB. Use Bash to read a smaller byte range or selected fields.` } : {}),
			} };
		} catch (error) {
			return fileError(error, "path", "readable UTF-8 text file", "README.md");
		}
	},
}, output => output.content + (output.notice ? `\n${output.notice}` : ""));
