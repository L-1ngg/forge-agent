import { deepStrictEqual } from "node:assert";
import type { HarnessTool, ToolContext, ToolResult } from "../../packages/core/src/sdk.ts";
import { Trace } from "./scenario.ts";

export interface ExpectedToolCall {
	args: object;
	result(context: ToolContext): Promise<ToolResult<unknown>>;
}

/** Unexpected invocations fail before executing the supplied effect callback.
 * assertComplete also fails when Agent correctly converts a thrown error to a tool result. */
export function controlledTool(name: string, parameters: HarnessTool<object, unknown>["parameters"], calls: ExpectedToolCall[], trace = new Trace()) {
	let cursor = 0;
	const failures: unknown[] = [];
	const tool: HarnessTool<object, unknown> = {
		name, label: name, description: `Controlled ${name}`, parameters,
		async execute(args, context) {
			try {
				const expected = calls[cursor];
				if (!expected) throw new Error(`${name}: undeclared tool execution`);
				deepStrictEqual(args, expected.args, `${name}: unexpected arguments`);
				cursor++;
				trace.record("tool:start", { name, id: context.toolCallId, args });
				const result = await expected.result(context);
				trace.record("tool:end", { name, id: context.toolCallId, result });
				return result;
			} catch (error) { failures.push(error); throw error; }
		},
	};
	return { tool, assertComplete() {
		if (failures.length) throw new AggregateError(failures, `${name}: controlled tool failed`);
		if (cursor !== calls.length) throw new Error(`${name}: missing ${calls.length - cursor} tool executions`);
	} };
}
