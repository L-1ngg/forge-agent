import type { ToolContext, HarnessTool } from "./types.ts";

export type ToolInputRewrite<TInput extends object> = (input: TInput, context: ToolContext) => TInput | Promise<TInput>;
/** Policy hook supplied by the caller; throw to reject the final tool input. */
export type ToolInputAuthorizer<TInput extends object> = (input: TInput, context: ToolContext) => void | Promise<void>;

export interface ToolWrapperOptions<TInput extends object> {
	rewriteInput?: ToolInputRewrite<TInput>;
	authorizeInput?: ToolInputAuthorizer<TInput>;
}

/** Decorate a tool at its own boundary; core policy stays in the core package. */
export function wrapTool<TInput extends object, TOutput>(tool: HarnessTool<TInput, TOutput>, options: ToolWrapperOptions<TInput>): HarnessTool<TInput, TOutput> {
	return {
		...tool,
		async execute(input, context) {
			const rewritten = options.rewriteInput ? await options.rewriteInput(input, context) : input;
			// Authorization observes exactly what will be executed, never the pre-rewrite input.
			await options.authorizeInput?.(rewritten, context);
			return tool.execute(rewritten, context);
		},
	};
}
