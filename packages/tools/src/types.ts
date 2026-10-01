import type { ImageBlock, TextBlock } from "@forge-agent/protocol";
import type { ZodType } from "zod";

export interface ObjectSchema {
	type: "object";
	properties?: Record<string, unknown> | undefined;
	required?: string[] | undefined;
	additionalProperties?: boolean | Record<string, unknown> | undefined;
	[key: string]: unknown;
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
	/** Native schema for local tools; dynamic SDK and MCP tools use parameters. */
	inputSchema?: ZodType<TInput>;
	execute(input: TInput, context: ToolContext): Promise<ToolResult<TOutput>>;
}

/** Model content and display details are independent; progress uses the same shape. */
export interface ToolResult<TDetails = unknown> {
	content: (TextBlock | ImageBlock)[];
	details: TDetails | undefined;
	isError?: boolean;
}
