import { defineBuiltinTool } from "./define-builtin.ts";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileError, toolError } from "./errors.ts";
import type { HarnessTool } from "./types.ts";
import { z } from "zod";

const editSchema = z.strictObject({
	path: z.string().min(1).regex(/\S/).meta({ description: "Absolute path or path relative to the working directory." }),
	old_text: z.string().min(1).meta({ description: "Exact text currently present in the file." }),
	new_text: z.string().meta({ description: "Exact replacement text." }),
	replace_all: z.boolean().optional().meta({ description: "Replace every exact match instead of requiring one unique match." }),
});
export type EditInput = z.infer<typeof editSchema>;

export interface EditOutput {
	path: string;
	replacements: number;
}

export const editTool: HarnessTool<EditInput, EditOutput> = defineBuiltinTool({
	name: "edit",
	label: "Edit file",
	description: "Replace an exact UTF-8 text fragment. A non-unique match is rejected unless replace_all is true.",
	inputSchema: editSchema,
	async execute(input, context) {
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
}, output => `Replaced ${output.replacements} occurrence(s) in ${output.path}`);
