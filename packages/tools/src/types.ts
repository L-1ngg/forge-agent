import type { ImageBlock, TextBlock } from "@forge-agent/protocol";

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
	onUpdate?: (result: ToolResult<unknown>) => void;
}

export interface HarnessTool<TInput extends object, TOutput> {
	name: string;
	label: string;
	description: string;
	parameters: ObjectSchema;
	prepareArguments?: (args: unknown) => TInput;
	executionMode?: "parallel" | "sequential";
	execute(input: TInput, context: ToolContext): Promise<ToolResult<TOutput>>;
}

/** Model content and display details are independent; progress uses the same shape. */
export interface ToolResult<TDetails = unknown> {
	content: (TextBlock | ImageBlock)[];
	details: TDetails | undefined;
	isError?: boolean;
	terminate?: boolean;
}
