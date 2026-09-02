import type { ToolOutcome } from "./errors.ts";

export interface ObjectSchema {
	type: "object";
	properties: Record<string, Record<string, unknown>>;
	required: string[];
	additionalProperties: false;
}

export interface ToolContext {
	cwd: string;
	/** Present when the tool is invoked through the agent adapter. */
	toolCallId?: string;
	env?: Record<string, string | undefined>;
	signal?: AbortSignal;
}

export interface HarnessTool<TInput extends object, TOutput> {
	name: string;
	label: string;
	description: string;
	parameters: ObjectSchema;
	execute(input: TInput, context: ToolContext): Promise<ToolOutcome<TOutput>>;
}
