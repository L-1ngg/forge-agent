import { expect, test } from "bun:test";
import { block, type SessionEvent, type SessionMessage } from "@forge-agent/protocol";
import { TranscriptProjector } from "../src/index.ts";

function userMessage(text: string, timestamp = 1000): SessionMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistantMessage(text: string, timestamp = 2000): SessionMessage {
	return { role: "assistant", content: [{ type: "text", text }], timestamp };
}

test("AC-24: entry ids stay stable from first delta to message_end", () => {
	const projector = new TranscriptProjector();
	projector.apply({ type: "message_start", timestamp: 1, message: { role: "assistant", content: [], timestamp: 1 } });
	projector.apply({ type: "message_delta", timestamp: 2, contentIndex: 0, contentType: "text", delta: "Hel" });
	const idsAfterFirstDelta = projector.getEntryIds();
	projector.apply({ type: "message_delta", timestamp: 3, contentIndex: 0, contentType: "text", delta: "lo" });
	expect(projector.getEntryIds()).toEqual(idsAfterFirstDelta);
	projector.apply({ type: "message_end", timestamp: 4, message: assistantMessage("Hello") });
	expect(projector.getEntryIds()).toEqual(idsAfterFirstDelta);
	// message_end is the final truth, not an append
	const entry = projector.getEntries()[0]!;
	expect(entry.kind).toBe("assistant");
	expect((entry as { markdown: string }).markdown).toBe("Hello");
});

test("AC-24: streaming never produces temporary thinking:/tool: dump entries", () => {
	const projector = new TranscriptProjector();
	const events: SessionEvent[] = [
		{ type: "message_start", timestamp: 1, message: { role: "assistant", content: [], timestamp: 1 } },
		{ type: "message_delta", timestamp: 2, contentIndex: 0, contentType: "thinking", delta: " pondering" },
		{ type: "message_delta", timestamp: 3, contentIndex: 1, contentType: "text", delta: "answer" },
	];
	for (const event of events) projector.apply(event);
	for (const entry of projector.getEntries()) {
		const text = entry.kind === "notice" ? entry.text : entry.kind === "user" ? entry.text : "";
		expect(text.startsWith("thinking:")).toBe(false);
		expect(text.startsWith("tool:")).toBe(false);
	}
	const kinds = projector.getEntries().map((entry) => entry.kind);
	expect(kinds).toEqual(["thinking", "assistant"]);
});

test("user message from the event stream becomes a user entry", () => {
	const projector = new TranscriptProjector();
	projector.apply({ type: "message_start", timestamp: 1, message: userMessage("hi") });
	projector.apply({ type: "message_end", timestamp: 2, message: userMessage("hi") });
	const [entry] = projector.getEntries();
	expect(entry).toMatchObject({ kind: "user", text: "hi", timestamp: 1000 });
});

test("AC-29: tool execution updates in place; toolResult does not duplicate", () => {
	const projector = new TranscriptProjector();
	const executeBlock = block(
		{ id: "call-1", kind: "execute", lifecycle: "complete", defaultDisplayMode: "truncated", currentDisplayMode: "truncated", manualOverride: false },
		{ command: "ls", stdout: "a\nb\n", exitCode: 0 },
		{ defaultDisplayMode: "truncated", firstLines: 2, lastLines: 3 },
	);
	projector.apply({ type: "tool_execution_start", timestamp: 1, toolCallId: "call-1", toolName: "bash", args: { command: "ls" }, block: executeBlock });
	expect(projector.getEntryIds()).toEqual(["tool-call-1"]);
	// update replaces in place
	const updated = block(
		{ id: "call-1", kind: "execute", lifecycle: "complete", defaultDisplayMode: "truncated", currentDisplayMode: "truncated", manualOverride: false },
		{ command: "ls", stdout: "a\nb\nc\n", exitCode: 0 },
		{ defaultDisplayMode: "truncated", firstLines: 2, lastLines: 3 },
	);
	projector.apply({ type: "tool_execution_end", timestamp: 2, toolCallId: "call-1", toolName: "bash", content: "a\nb\nc\n", isError: false, block: updated });
	expect(projector.getEntryIds()).toEqual(["tool-call-1"]);
	// the toolResult message does not add a second execute entry
	projector.apply({
		type: "message_end",
		timestamp: 3,
		message: { role: "toolResult", content: [{ type: "text", text: "a\nb\nc\n" }], timestamp: 3, toolCallId: "call-1", toolName: "bash" },
	});
	expect(projector.getEntryIds()).toEqual(["tool-call-1"]);
});

test("turn boundary adds the Worked-for notice", () => {
	const projector = new TranscriptProjector();
	projector.apply({ type: "turn_start", timestamp: 1000 });
	projector.apply({ type: "turn_end", timestamp: 3700, stopReason: "stop" });
	const notice = projector.getEntries().at(-1);
	expect(notice).toMatchObject({ kind: "notice", text: "Worked for 2.7s" });
});

test("AC-15: TUI projection and headless JSON carry the same block semantics", () => {
	const projector = new TranscriptProjector();
	const editBlock = block(
		{ id: "call-9", kind: "edit", lifecycle: "complete", defaultDisplayMode: "expanded", currentDisplayMode: "expanded", manualOverride: false },
		{
			path: "src/a.ts",
			hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, additions: 1, removals: 1, lines: [
				{ type: "remove", content: "old", oldLine: 1 },
				{ type: "add", content: "new", newLine: 1 },
				{ type: "add", content: "extra", newLine: 2 },
			] }],
			additions: 2,
			removals: 1,
		},
		{ defaultDisplayMode: "expanded" },
	);
	projector.apply({ type: "tool_execution_end", timestamp: 1, toolCallId: "call-9", toolName: "edit", content: "", isError: false, block: editBlock });
	const [entry] = projector.getEntries();
	expect(entry).toMatchObject({ kind: "edit" });
	if (entry?.kind !== "edit") throw new Error("unreachable");
	// same data the headless JSON stream carried
	expect(entry.block.data).toEqual(editBlock.data);
	expect(entry.block.fold).toEqual(editBlock.fold);
});
