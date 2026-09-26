import { convertSchemaToJsonSchema, parseWithStandardSchema } from "@tanstack/ai";
import type { ZodType } from "zod";
import type { ToolOutcome } from "./errors.ts";
import type { HarnessTool, ObjectSchema, ToolContext } from "./types.ts";

/** Keep file/process operations and their structured errors independent of model presentation. */
export function defineBuiltinTool<TInput extends object, TOutput>(
	tool: Omit<HarnessTool<TInput, TOutput>, "parameters" | "validateArguments" | "execute"> & {
		inputSchema: ZodType<TInput>;
		execute(input: TInput, context: ToolContext): Promise<ToolOutcome<TOutput>>;
	},
	render: (output: TOutput) => string,
): HarnessTool<TInput, TOutput> {
	const { inputSchema, ...definition } = tool;
	const parameters = convertSchemaToJsonSchema(inputSchema);
	if (parameters?.type !== "object") throw new TypeError(`Tool ${tool.name} requires an object schema`);
	return {
		...definition,
		parameters: parameters as ObjectSchema,
		validateArguments: args => parseWithStandardSchema<TInput>(inputSchema, args),
		async execute(input, context) {
			const outcome = await tool.execute(input, context);
			const details = outcome.ok ? outcome.value : outcome.details;
			return {
				content: [
					{ type: "text", text: outcome.ok ? render(outcome.value) : JSON.stringify(outcome.error) },
					...(!outcome.ok && details !== undefined ? [{ type: "text" as const, text: render(details) }] : []),
				],
				details, isError: !outcome.ok,
			};
		}
	};
}
