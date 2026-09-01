import type { ToolContext, HarnessTool } from "./types.ts";

export type ToolInputRewrite<TInput extends object> = (input: TInput, context: ToolContext) => TInput | Promise<TInput>;

export interface ToolWrapperOptions<TInput extends object> {
	rewriteInput?: ToolInputRewrite<TInput>;
}

/** Decorate a tool at its own boundary; core policy stays in the core package. */
export function wrapTool<TInput extends object, TOutput>(tool: HarnessTool<TInput, TOutput>, options: ToolWrapperOptions<TInput>): HarnessTool<TInput, TOutput> {
	return {
		...tool,
		async execute(input, context) {
			const rewritten = options.rewriteInput ? await options.rewriteInput(input, context) : input;
			return tool.execute(rewritten, context);
		},
	};
}
