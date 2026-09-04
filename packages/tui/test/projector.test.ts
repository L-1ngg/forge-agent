import { expect, test } from "bun:test";
import { block } from "@myh/protocol";
import { TranscriptProjector } from "../src/index.ts";

test("projector keeps message content ids stable from delta through message_end", () => {
	const projector = new TranscriptProjector();
	projector.apply({ type: "message_start", timestamp: 1, message: { role: "assistant", content: [], timestamp: 1 } });
	projector.apply({ type: "message_delta", timestamp: 2, contentIndex: 0, contentType: "text", delta: "hel" });
	projector.apply({ type: "message_delta", timestamp: 3, contentIndex: 1, contentType: "thinking", delta: "why" });
	const streaming = projector.getEntries();
	const ids = streaming.map((entry) => entry.id);
	projector.apply({ type: "message_end", timestamp: 4, message: { role: "assistant", content: [{ type: "text", text: "hello" }, { type: "thinking", thinking: "why" }], timestamp: 1 } });
	const complete = projector.getEntries();
	expect(complete.map((entry) => entry.id)).toEqual(ids);
	expect(complete.find((entry) => entry.id === ids[0])).toMatchObject({ kind: "assistant", lifecycle: "complete", markdown: "hello" });
});

test("projector anchors a tool entry at its assistant tool-call placeholder without duplicating it", () => {
	const projector = new TranscriptProjector();
	projector.apply({ type: "message_start", timestamp: 1, message: { role: "assistant", content: [{ type: "tool_call", id: "call-1", name: "bash", arguments: { command: "run" } }], timestamp: 1 } });
	projector.apply({ type: "message_end", timestamp: 2, message: { role: "assistant", content: [{ type: "tool_call", id: "call-1", name: "bash", arguments: { command: "run" } }], timestamp: 1 } });
	projector.apply({ type: "tool_execution_end", timestamp: 3, toolCallId: "call-1", toolName: "bash", content: "done", isError: false, block: block({ id: "call-1", kind: "execute", lifecycle: "complete" }, { command: "run", stdout: "done" }) });
	const entries = projector.getEntries();
	expect(entries.filter((entry) => entry.id === "tool-call-1")).toHaveLength(0);
	expect(entries.filter((entry) => entry.id === "message-0-content-0")).toHaveLength(1);
	expect(entries.find((entry) => entry.id === "message-0-content-0")).toMatchObject({ kind: "execute", block: { id: "call-1" } });
});

test("projector orders out-of-order content indexes without changing their ids", () => {
	const projector = new TranscriptProjector();
	projector.apply({ type: "message_delta", timestamp: 1, contentIndex: 2, contentType: "text", delta: "third" });
	projector.apply({ type: "message_delta", timestamp: 2, contentIndex: 0, contentType: "text", delta: "first" });
	projector.apply({ type: "message_delta", timestamp: 3, contentIndex: 1, contentType: "text", delta: "second" });
	expect(projector.getEntryIds()).toEqual([
		"message-0-content-0",
		"message-0-content-1",
		"message-0-content-2",
	]);
});

test("projector merges a late message_start into the implicit delta message", () => {
	const projector = new TranscriptProjector();
	projector.apply({ type: "message_delta", timestamp: 1, contentIndex: 1, contentType: "text", delta: "early" });
	const ids = projector.getEntryIds();
	projector.apply({ type: "message_start", timestamp: 2, message: { role: "assistant", content: [], timestamp: 1 } });
	expect(projector.getEntryIds()).toEqual(ids);
	expect(projector.getMessages()).toHaveLength(1);
	expect(projector.getEntry(ids[0] ?? "")).toMatchObject({ kind: "assistant", markdown: "early" });
});

test("projector moves a pre-message tool event into its later assistant placeholder", () => {
	const projector = new TranscriptProjector();
	projector.apply({ type: "tool_execution_start", timestamp: 1, toolCallId: "early-tool", toolName: "bash", args: { command: "run" }, block: block({ id: "early-tool", kind: "execute", lifecycle: "streaming" }, { command: "run", stdout: "" }) });
	expect(projector.getEntryIds()).toEqual(["tool-early-tool"]);
	projector.apply({ type: "message_start", timestamp: 2, message: { role: "assistant", content: [], timestamp: 2 } });
	projector.apply({ type: "message_end", timestamp: 3, message: { role: "assistant", content: [{ type: "text", text: "before" }, { type: "tool_call", id: "early-tool", name: "bash", arguments: { command: "run" } }, { type: "text", text: "after" }], timestamp: 2 } });
	const ids = projector.getEntryIds();
	expect(ids).toEqual(["message-0-content-0", "message-0-content-1", "message-0-content-2"]);
	expect(projector.getEntry("message-0-content-1")).toMatchObject({ kind: "execute", block: { id: "early-tool" } });
});

test("projector represents streamed tool deltas as a notice placeholder", () => {
	const projector = new TranscriptProjector();
	projector.apply({ type: "message_delta", timestamp: 1, contentIndex: 0, contentType: "tool_call", delta: "{" });
	expect(projector.getEntries()).toEqual([{ id: "message-0-content-0", kind: "notice", text: "Calling tool…", tone: "muted" }]);
});

test("projector keeps turn footer duration deterministic", () => {
	const projector = new TranscriptProjector();
	projector.apply({ type: "turn_start", timestamp: 1000 });
	projector.apply({ type: "turn_end", timestamp: 3710 });
	expect(projector.getEntries().at(-1)).toMatchObject({ kind: "notice", text: "Worked for 2.7s" });
});

test("projector preserves root chronology across notices, messages, and standalone tools", () => {
	const projector = new TranscriptProjector();
	projector.addNotice("before");
	const message = { role: "user" as const, content: [{ type: "text" as const, text: "middle" }], timestamp: 1 };
	projector.apply({ type: "message_start", timestamp: 1, message });
	projector.apply({ type: "message_end", timestamp: 2, message });
	projector.apply({
		type: "tool_execution_end",
		timestamp: 3,
		toolCallId: "after-tool",
		toolName: "bash",
		content: "done",
		isError: false,
		block: block({ id: "after-tool", kind: "execute", lifecycle: "complete" }, { command: "run", stdout: "done" }),
	});
	projector.addNotice("after");
	expect(projector.getEntryIds()).toEqual(["notice-0", "message-0-content-0", "tool-after-tool", "notice-1"]);
});
