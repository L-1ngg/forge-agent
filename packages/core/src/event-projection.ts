import { block, type ExecuteBlockData, type BlockEnvelope } from "@forge-agent/protocol";
import { createEditBlockData } from "./diff.ts";
import type { AssistantMessage, Message, Model, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { SessionContentBlock, SessionMessage, SessionEvent, StopReason } from "@forge-agent/protocol";
import type { AgentEvent } from "./runtime/types.ts";

function toProtocolStopReason(reason: AssistantMessage["stopReason"]): StopReason | undefined {
	if (reason === "pending") return undefined;
	if (reason === "toolUse") return "tool_use";
	return reason;
}

export function toPiStopReason(reason: StopReason | undefined): AssistantMessage["stopReason"] {
	if (reason === undefined) return "stop";
	if (reason === "tool_use") return "toolUse";
	return reason;
}

function toSessionContent(message: Message): SessionContentBlock[] {
	if (message.role === "user") {
		if (typeof message.content === "string") return [{ type: "text", text: message.content }];
		return message.content.map((block) => ({ ...block }));
	}
	if (message.role === "toolResult") {
		return message.content.map((block) => ({ ...block }));
	}
	return message.content.map((block) => {
		if (block.type === "text") return { type: "text" as const, text: block.text, ...(block.textSignature !== undefined ? { textSignature: block.textSignature } : {}) };
		if (block.type === "thinking") return {
			type: "thinking" as const, thinking: block.thinking,
			...(block.thinkingSignature !== undefined ? { thinkingSignature: block.thinkingSignature } : {}),
			...(block.redacted !== undefined ? { redacted: block.redacted } : {}),
		};
		return {
			type: "tool_call" as const, id: block.id, name: block.name, arguments: block.arguments,
			...(block.thoughtSignature !== undefined ? { thoughtSignature: block.thoughtSignature } : {}),
			...(block.namespace !== undefined ? { namespace: block.namespace } : {}),
		};
	});
}

export function toSessionMessage(message: Message): SessionMessage | undefined {
	if (typeof message !== "object" || message === null || !("role" in message)) return undefined;
	const standard = message as Message;
	if (standard.role !== "user" && standard.role !== "assistant" && standard.role !== "toolResult") return undefined;
	const base: SessionMessage = {
		role: standard.role,
		content: toSessionContent(standard),
		timestamp: standard.timestamp,
	};
	if (standard.role === "assistant") {
		const stopReason = toProtocolStopReason(standard.stopReason);
		return {
			...base,
			provider: standard.provider,
			model: standard.model,
			api: standard.api,
			usage: {
				input: standard.usage.input,
				output: standard.usage.output,
				cacheRead: standard.usage.cacheRead,
				cacheWrite: standard.usage.cacheWrite,
				totalTokens: standard.usage.totalTokens,
				cost: { ...standard.usage.cost },
			},
			...(stopReason !== undefined ? { stopReason } : {}),
			...(standard.errorMessage ? { errorMessage: standard.errorMessage } : {}),
			...("contextExcluded" in standard && standard.contextExcluded === true ? { contextExcluded: true } : {}),
		};
	}
	if (standard.role === "toolResult") {
		return { ...base, toolCallId: standard.toolCallId, toolName: standard.toolName, isError: standard.isError, ...(standard.details !== undefined ? { details: standard.details } : {}) };
	}
	return base;
}

function zeroUsage(): NonNullable<AssistantMessage["usage"]> {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function fromSessionMessage(message: SessionMessage, model: Model<string>): Message {
	const textAndImages = message.content
		.filter((block) => block.type === "text" || block.type === "image")
		.map((block) => ({ ...block }));
	if (message.role === "user") {
		return { role: "user", content: textAndImages, timestamp: message.timestamp } satisfies UserMessage;
	}
	if (message.role === "toolResult") {
		return {
			role: "toolResult",
			toolCallId: message.toolCallId ?? "unknown",
			toolName: message.toolName ?? "unknown",
			...(message.details !== undefined ? { details: message.details } : {}),
			content: textAndImages,
			isError: message.isError ?? false,
			timestamp: message.timestamp,
		} satisfies ToolResultMessage;
	}
	return {
		role: "assistant",
		content: message.content.filter((block) => block.type !== "image").map((block) => {
			if (block.type === "text" || block.type === "thinking") return { ...block };
			return { ...block, type: "toolCall" as const };
		}),
		api: message.api ?? model.api,
		provider: message.provider ?? model.provider,
		model: message.model ?? model.id,
		usage: message.usage ? mergeUsage(message.usage) : zeroUsage(),
		stopReason: toPiStopReason(message.stopReason),
		...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
		...(message.contextExcluded ? { contextExcluded: true } : {}),
		timestamp: message.timestamp,
	} satisfies AssistantMessage;
}

function mergeUsage(usage: NonNullable<SessionMessage["usage"]>): NonNullable<AssistantMessage["usage"]> {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, ...(usage.cost ?? {}) },
	};
}

export function projectEvent(event: AgentEvent): SessionEvent | undefined {
	const timestamp = Date.now();
	switch (event.type) {
		case "message_start": case "message_end": {
			const message = toSessionMessage(event.message);
			return message ? { type: event.type, message, timestamp } : undefined;
		}
		case "message_update": {
			const update = event.assistantMessageEvent;
			if (update.type !== "text_delta" && update.type !== "thinking_delta" && update.type !== "toolcall_delta") return undefined;
			return { type: "message_delta", timestamp, contentIndex: update.contentIndex, contentType: update.type === "text_delta" ? "text" : update.type === "thinking_delta" ? "thinking" : "tool_call", delta: update.delta };
		}
		case "turn_end": {
			const reason = event.message.role === "assistant" ? toProtocolStopReason(event.message.stopReason) : undefined;
			return { type: "turn_end", timestamp, ...(reason ? { stopReason: reason } : {}) };
		}
		case "tool_execution_start": return { ...event, timestamp };
		case "tool_execution_update": return { type: event.type, toolCallId: event.toolCallId, toolName: event.toolName, content: JSON.stringify(event.partialResult), timestamp };
		case "tool_execution_end": return { type: event.type, toolCallId: event.toolCallId, toolName: event.toolName, content: JSON.stringify(event.result), isError: event.isError, timestamp };
		case "agent_start": case "agent_end": case "turn_start": return { type: event.type, timestamp };
	}
}

export type CommandPresentation = Pick<ExecuteBlockData, "command" | "description">;

export function decorateToolEvent(event: SessionEvent, commands: Map<string, CommandPresentation>, edits: Map<string, BlockEnvelope<"edit">>): SessionEvent {
	if (event.type === "tool_execution_start") {
		rememberToolCommand(commands, event.toolCallId, event.toolName, event.args);
		const envelope = startToolBlock(event.toolCallId, event.toolName, event.args, event.timestamp);
		if (envelope?.kind === "edit") edits.set(event.toolCallId, envelope as BlockEnvelope<"edit">);
		return envelope ? { ...event, block: envelope } : event;
	}
	if (event.type === "tool_execution_end") {
		const edit = edits.get(event.toolCallId);
		let result: unknown;
		try { result = JSON.parse(event.content); } catch { result = event.content; }
		const envelope = edit
			? { ...edit, lifecycle: event.isError ? "failed" as const : "complete" as const, updatedAt: event.timestamp }
			: executeToolBlock(event.toolCallId, event.toolName, result, event.isError ? "failed" : "complete", event.timestamp, commands.get(event.toolCallId));
		commands.delete(event.toolCallId);
		edits.delete(event.toolCallId);
		return envelope ? { ...event, block: envelope } : event;
	}
	return event;
}

function startToolBlock(toolCallId: string, toolName: string, args: unknown, timestamp: number): BlockEnvelope<"edit" | "execute"> | undefined {
	const values = objectValue(args);
	if (toolName === "edit" && typeof values.path === "string" && typeof values.old_text === "string" && typeof values.new_text === "string") {
		return block(
			{ id: toolCallId, kind: "edit", lifecycle: "streaming", defaultDisplayMode: "expanded", currentDisplayMode: "expanded", manualOverride: false, colorSlot: "accent_edit", createdAt: timestamp, updatedAt: timestamp },
			createEditBlockData(values.path, values.old_text, values.new_text),
			{ defaultDisplayMode: "expanded", respectManualFolds: true },
		);
	}
	if (toolName !== "bash" || typeof values.command !== "string") return undefined;
	return block(
		{ id: toolCallId, kind: "execute", lifecycle: "streaming", defaultDisplayMode: "truncated", currentDisplayMode: "truncated", manualOverride: false, colorSlot: "accent_execute", createdAt: timestamp, updatedAt: timestamp },
		{ command: values.command, ...(typeof values.description === "string" ? { description: values.description } : {}) },
		{ defaultDisplayMode: "truncated", firstLines: 2, lastLines: 3, respectManualFolds: true },
	);
}

function executeToolBlock(toolCallId: string, toolName: string, result: unknown, lifecycle: "streaming" | "complete" | "failed", timestamp: number, original?: CommandPresentation): BlockEnvelope<"execute"> | undefined {
	if (toolName !== "bash") return undefined;
	const wrapper = objectValue(result);
	const details = objectValue(wrapper.details ?? result);
	const content = Array.isArray(wrapper.content)
		? wrapper.content.map((entry) => objectValue(entry).text).filter((entry): entry is string => typeof entry === "string").join("\n")
		: "";
	const structuredError = lifecycle === "failed" ? readableToolError(content) : undefined;
	const data: ExecuteBlockData = {
		command: typeof details.command === "string" ? details.command : original?.command ?? "bash",
		...(original?.description !== undefined ? { description: original.description } : {}),
		...(typeof details.stdout === "string" ? { stdout: details.stdout + (typeof details.notice === "string" ? "\n\n" + details.notice : "") } : content && structuredError === undefined ? { stdout: content } : {}),
		...(typeof details.stderr === "string" ? { stderr: details.stderr } : structuredError !== undefined ? { stderr: structuredError } : {}),
		...(typeof details.exitCode === "number" ? { exitCode: details.exitCode } : {}),
		...(lifecycle === "failed" ? { isError: true } : {}),
	};
	return block(
		{ id: toolCallId, kind: "execute", lifecycle, defaultDisplayMode: "truncated", currentDisplayMode: "truncated", manualOverride: false, colorSlot: "accent_execute", updatedAt: timestamp },
		data,
		{ defaultDisplayMode: "truncated", firstLines: 2, lastLines: 3, respectManualFolds: true },
	);
}

function rememberToolCommand(commands: Map<string, CommandPresentation>, toolCallId: string, toolName: string, args: unknown): void {
	if (toolName !== "bash") return;
	const { command, description } = objectValue(args);
	if (typeof command === "string") commands.set(toolCallId, { command, ...(typeof description === "string" ? { description } : {}) });
}

function objectValue(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

/** forge-agent tools throw structured errors; show the human message instead of raw JSON. */
function readableToolError(content: string): string | undefined {
	try {
		const value = objectValue(JSON.parse(content));
		return typeof value.error_code === "string" && typeof value.message === "string" ? value.message : undefined;
	} catch {
		return undefined;
	}
}


export function createEventProjection(): (event: AgentEvent) => SessionEvent | undefined {
	const commands = new Map<string, CommandPresentation>();
	const edits = new Map<string, BlockEnvelope<"edit">>();
	return event => {
		const projected = projectEvent(event);
		if (event.type === "agent_end") { commands.clear(); edits.clear(); }
		return projected ? decorateToolEvent(projected, commands, edits) : undefined;
	};
}
