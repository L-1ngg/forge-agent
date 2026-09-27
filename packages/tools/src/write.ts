import { defineBuiltinTool } from "./define-builtin.ts";
import { open, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileError, toolError } from "./errors.ts";
import type { HarnessTool } from "./types.ts";
import { z } from "zod";

const writeSchema = z.strictObject({
	path: z.string().min(1).regex(/\S/).meta({ description: "Absolute path or path relative to the working directory." }),
	content: z.string().meta({ description: "Complete UTF-8 file content." }),
	mode: z.enum(["overwrite", "create"]).optional().meta({ description: "overwrite replaces a file; create fails if it exists." }),
});
export type WriteInput = z.infer<typeof writeSchema>;

export interface WriteOutput {
	path: string;
	bytesWritten: number;
}

export const writeTool: HarnessTool<WriteInput, WriteOutput> = defineBuiltinTool({
	name: "write",
	label: "Write file",
	description: "Write UTF-8 content to a file. Parent directories must already exist.",
	inputSchema: writeSchema,
	async execute(input, context) {
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
}, output => `Wrote ${output.bytesWritten} bytes to ${output.path}`);
