import { block, type ExecuteBlockData, type BlockEnvelope, type SessionEvent } from "@forge-agent/protocol";
import { createEditBlockData } from "./diff.ts";

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
