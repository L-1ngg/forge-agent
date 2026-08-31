import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileError, toolError } from "./errors.ts";
import type { HarnessTool } from "./types.ts";

export interface ReadInput {
	path: string;
	start_line?: number;
	end_line?: number;
}

export interface ReadOutput {
	path: string;
	content: string;
	totalLines: number;
}

export const readTool: HarnessTool<ReadInput, ReadOutput> = {
	name: "read",
	label: "Read file",
	description: "Read a UTF-8 text file, optionally selecting an inclusive one-based line range.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", minLength: 1, description: "Absolute path or path relative to the working directory." },
			start_line: { type: "integer", minimum: 1, description: "First one-based line to return." },
			end_line: { type: "integer", minimum: 1, description: "Last one-based line to return, inclusive." },
		},
		required: ["path"],
		additionalProperties: false,
	},
	async execute(input, context) {
		if (!input.path?.trim()) {
			return toolError("INVALID_ARGUMENT", "path must be a non-empty string", "path", "non-empty file path", "src/index.ts");
		}
		if (input.start_line !== undefined && (!Number.isInteger(input.start_line) || input.start_line < 1)) {
			return toolError("INVALID_ARGUMENT", "start_line must be a positive integer", "start_line", "integer >= 1", "1");
		}
		if (input.end_line !== undefined && (!Number.isInteger(input.end_line) || input.end_line < 1)) {
			return toolError("INVALID_ARGUMENT", "end_line must be a positive integer", "end_line", "integer >= 1", "20");
		}
		if (input.start_line !== undefined && input.end_line !== undefined && input.start_line > input.end_line) {
			return toolError("INVALID_ARGUMENT", "start_line must not exceed end_line", "start_line", "start_line <= end_line", "10");
		}

		const path = resolve(context.cwd, input.path);
		try {
			const info = await stat(path);
			if (info.isDirectory()) return toolError("PATH_IS_DIRECTORY", "Expected a file but found a directory", "path", "UTF-8 text file", "README.md");
			const content = await readFile(path, "utf8");
			const lines = content.split("\n");
			const start = (input.start_line ?? 1) - 1;
			const end = input.end_line ?? lines.length;
			return { ok: true, value: { path, content: lines.slice(start, end).join("\n"), totalLines: lines.length } };
		} catch (error) {
			return fileError(error, "path", "readable UTF-8 text file", "README.md");
		}
	},
};
