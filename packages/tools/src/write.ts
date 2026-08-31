import { open, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileError, toolError } from "./errors.ts";
import type { HarnessTool } from "./types.ts";

export interface WriteInput {
	path: string;
	content: string;
	mode?: "overwrite" | "create";
}

export interface WriteOutput {
	path: string;
	bytesWritten: number;
}

export const writeTool: HarnessTool<WriteInput, WriteOutput> = {
	name: "write",
	label: "Write file",
	description: "Write UTF-8 content to a file. Parent directories must already exist.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", minLength: 1, description: "Absolute path or path relative to the working directory." },
			content: { type: "string", description: "Complete UTF-8 file content." },
			mode: { type: "string", enum: ["overwrite", "create"], description: "overwrite replaces a file; create fails if it exists." },
		},
		required: ["path", "content"],
		additionalProperties: false,
	},
	async execute(input, context) {
		if (!input.path?.trim()) return toolError("INVALID_ARGUMENT", "path must be a non-empty string", "path", "non-empty file path", "src/new.ts");
		if (typeof input.content !== "string") return toolError("INVALID_ARGUMENT", "content must be a string", "content", "UTF-8 string", "export {};\n");
		if (input.mode !== undefined && input.mode !== "overwrite" && input.mode !== "create") {
			return toolError("INVALID_ARGUMENT", "mode is not supported", "mode", "overwrite or create", "create");
		}

		const path = resolve(context.cwd, input.path);
		try {
			try {
				const parent = await stat(dirname(path));
				if (!parent.isDirectory()) return toolError("PARENT_NOT_FOUND", "Parent path is not a directory", "path", "path with an existing parent directory", "src/new.ts");
			} catch (error) {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
					return toolError("PARENT_NOT_FOUND", "Parent directory does not exist", "path", "path with an existing parent directory", "src/new.ts");
				}
				throw error;
			}

			if ((input.mode ?? "overwrite") === "create") {
				const handle = await open(path, "wx");
				try {
					await handle.writeFile(input.content, "utf8");
				} finally {
					await handle.close();
				}
			} else {
				await writeFile(path, input.content, "utf8");
			}
			return { ok: true, value: { path, bytesWritten: Buffer.byteLength(input.content) } };
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
				return toolError("ALREADY_EXISTS", "File already exists", "path", "a path that does not exist in create mode", "src/new.ts");
			}
			return fileError(error, "path", "writable file path", "src/new.ts");
		}
	},
};
