import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileError, toolError } from "./errors.ts";
import type { HarnessTool } from "./types.ts";

export interface EditInput {
	path: string;
	old_text: string;
	new_text: string;
	replace_all?: boolean;
}

export interface EditOutput {
	path: string;
	replacements: number;
}

export const editTool: HarnessTool<EditInput, EditOutput> = {
	name: "edit",
	label: "Edit file",
	description: "Replace an exact UTF-8 text fragment. A non-unique match is rejected unless replace_all is true.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", minLength: 1, description: "Absolute path or path relative to the working directory." },
			old_text: { type: "string", minLength: 1, description: "Exact text currently present in the file." },
			new_text: { type: "string", description: "Exact replacement text." },
			replace_all: { type: "boolean", description: "Replace every exact match instead of requiring one unique match." },
		},
		required: ["path", "old_text", "new_text"],
		additionalProperties: false,
	},
	async execute(input, context) {
		if (!input.path?.trim()) return toolError("INVALID_ARGUMENT", "path must be a non-empty string", "path", "non-empty file path", "src/index.ts");
		if (!input.old_text) return toolError("INVALID_ARGUMENT", "old_text must be non-empty", "old_text", "exact text to replace", "const oldName = true;");
		if (typeof input.new_text !== "string") return toolError("INVALID_ARGUMENT", "new_text must be a string", "new_text", "replacement text", "const newName = true;");

		const path = resolve(context.cwd, input.path);
		try {
			const content = await readFile(path, "utf8");
			const matches = content.split(input.old_text).length - 1;
			if (matches === 0) return toolError("EDIT_NOT_FOUND", "old_text was not found", "old_text", "an exact fragment present in the file", content.slice(0, 80));
			if (matches > 1 && !input.replace_all) {
				return toolError("EDIT_AMBIGUOUS", `old_text matched ${matches} times`, "old_text", "a unique fragment or replace_all: true", input.old_text);
			}
			const replacements = input.replace_all ? matches : 1;
			const next = input.replace_all ? content.split(input.old_text).join(input.new_text) : content.replace(input.old_text, () => input.new_text);
			await writeFile(path, next, "utf8");
			return { ok: true, value: { path, replacements } };
		} catch (error) {
			return fileError(error, "path", "readable and writable UTF-8 text file", "src/index.ts");
		}
	},
};
