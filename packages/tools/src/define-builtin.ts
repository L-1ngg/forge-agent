import { convertSchemaToJsonSchema, parseWithStandardSchema } from "@tanstack/ai";
import type { ZodType } from "zod";
import type { ToolOutcome } from "./errors.ts";
import type { HarnessTool, ObjectSchema, ToolContext } from "./types.ts";

export function defineLocalTool<TInput extends object, TOutput>(
	tool: Omit<HarnessTool<TInput, TOutput>, "parameters" | "validateArguments"> & { inputSchema: ZodType<TInput>; normalizeInput?: (input: TInput) => TInput },
): HarnessTool<TInput, TOutput> {
	const { inputSchema, normalizeInput, ...definition } = tool;
	const parameters = convertSchemaToJsonSchema(inputSchema);
	const objectUnion = parameters?.oneOf?.length && parameters.oneOf.every(branch => branch.type === "object");
	if (parameters?.type !== "object" && !objectUnion) throw new TypeError(`Tool ${tool.name} requires an object schema`);
	return {
		...definition,
		parameters: { type: "object", ...parameters } as ObjectSchema,
		validateArguments: args => {
			const input = parseWithStandardSchema<TInput>(inputSchema, args);
			return normalizeInput ? normalizeInput(input) : input;
		},
	};
}

/** Keep file/process operations and their structured errors independent of model presentation. */
export function defineBuiltinTool<TInput extends object, TOutput>(
	tool: Omit<HarnessTool<TInput, TOutput>, "parameters" | "validateArguments" | "execute"> & {
		inputSchema: ZodType<TInput>;
		execute(input: TInput, context: ToolContext): Promise<ToolOutcome<TOutput>>;
	},
	render: (output: TOutput) => string,
): HarnessTool<TInput, TOutput> {
	return defineLocalTool({
		...tool,
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
	});
}
