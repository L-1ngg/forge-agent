import { expect, test } from "bun:test";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import { block } from "@myh/protocol";
import { StreamRenderer, TranscriptScrollView } from "../src/index.ts";

test("a parked transcript keeps its top entry while earlier rows reflow on resize", () => {
	const { renderer, transcript } = transcriptFixture();
	for (let index = 0; index < 4; index++) {
		appendAssistant(renderer, `leading-${index} ${"wrapped words ".repeat(12)}`);
	}
	const markerId = appendAssistant(renderer, "RESIZE_ANCHOR");
	for (let index = 0; index < 4; index++) appendAssistant(renderer, `tail-${index}`);

	transcript.setViewportHeight(3);
	transcript.render(80);
	parkAtEntry(transcript, renderer, markerId, 80);
	expect(plain(transcript.render(80))[0]).toContain("RESIZE_ANCHOR");
	expect(plain(transcript.render(40))[0]).toContain("RESIZE_ANCHOR");
});

test("a parked transcript keeps its logical line while its own entry reflows", () => {
	const { renderer, transcript } = transcriptFixture();
	const markerId = appendUser(renderer, `${"wrapping words ".repeat(12)}\nLOGICAL_LINE_ANCHOR\nentry tail`);
	for (let index = 0; index < 5; index++) appendAssistant(renderer, `tail-${index}`);

	transcript.setViewportHeight(3);
	transcript.render(80);
	const markerRow = renderer.render(80).findIndex((line) => plain([line])[0]?.includes("LOGICAL_LINE_ANCHOR"));
	expect(markerRow).toBeGreaterThan(0);
	transcript.scrollTo(markerRow, { disableFollow: true });
	expect(plain(transcript.render(80))[0]).toContain("LOGICAL_LINE_ANCHOR");
	expect(plain(transcript.render(40))[0]).toContain("LOGICAL_LINE_ANCHOR");
	expect(renderer.getEntryIds()).toContain(markerId);
});

test("a logical-line anchor clamps its wrapped offset when the line shrinks", () => {
	const { renderer, transcript } = transcriptFixture();
	const markerId = appendUser(renderer, `WRAP_ANCHOR ${"words ".repeat(10)}\nNEXT_LOGICAL_LINE`);
	for (let index = 0; index < 5; index++) appendAssistant(renderer, `tail-${index}`);

	transcript.setViewportHeight(3);
	transcript.render(40);
	const span = renderer.getEntrySpans(40).find((value) => value.entryId === markerId);
	if (!span) throw new Error(`missing entry span: ${markerId}`);
	const firstLineStart = span.logicalLineStarts[0];
	const nextLineStart = span.logicalLineStarts[1];
	if (firstLineStart === undefined || nextLineStart === undefined) throw new Error("missing logical line rows");
	expect(nextLineStart - firstLineStart).toBeGreaterThan(1);
	transcript.scrollTo(span.start + firstLineStart + 1, { disableFollow: true });

	const resized = plain(transcript.render(120));
	expect(resized[0]).toContain("WRAP_ANCHOR");
	expect(resized[0]).not.toContain("NEXT_LOGICAL_LINE");
});

test("a parked transcript keeps its top entry while an earlier tool grows", () => {
	const { renderer, transcript } = transcriptFixture();
	renderer.apply({
		type: "tool_execution_start",
		timestamp: 1,
		toolCallId: "growing-tool",
		toolName: "bash",
		args: { command: "run" },
		block: executeBlock("one"),
	});
	const markerId = appendAssistant(renderer, "STREAM_ANCHOR");
	for (let index = 0; index < 5; index++) appendAssistant(renderer, `tail-${index}`);

	transcript.setViewportHeight(3);
	transcript.render(60);
	parkAtEntry(transcript, renderer, markerId, 60);
	expect(plain(transcript.render(60))[0]).toContain("STREAM_ANCHOR");

	renderer.apply({
		type: "tool_execution_update",
		timestamp: 2,
		toolCallId: "growing-tool",
		toolName: "bash",
		content: "updated",
		block: executeBlock(Array.from({ length: 12 }, (_, index) => `line-${index}`).join("\n")),
	});
	expect(plain(transcript.render(60))[0]).toContain("STREAM_ANCHOR");
});

test("a following transcript remains pinned to newly appended output", () => {
	const { renderer, transcript } = transcriptFixture();
	for (let index = 0; index < 8; index++) appendAssistant(renderer, `before-${index}`);
	transcript.setViewportHeight(3);
	transcript.render(60);
	expect(transcript.isFollowingEnd).toBe(true);

	appendAssistant(renderer, "LATEST_OUTPUT");
	const lines = plain(transcript.render(60));
	expect(transcript.isFollowingEnd).toBe(true);
	expect(lines.join("\n")).toContain("LATEST_OUTPUT");
});

function transcriptFixture(): { renderer: StreamRenderer; transcript: TranscriptScrollView } {
	const renderer = new StreamRenderer();
	const content = new Container();
	content.addChild(renderer);
	return {
		renderer,
		transcript: new TranscriptScrollView(content, {
			clipToViewport: true,
			entrySpans: (width) => renderer.getEntrySpans(width),
		}),
	};
}

function appendAssistant(renderer: StreamRenderer, text: string): string {
	return appendMessage(renderer, "assistant", text);
}

function appendUser(renderer: StreamRenderer, text: string): string {
	return appendMessage(renderer, "user", text);
}

function appendMessage(renderer: StreamRenderer, role: "assistant" | "user", text: string): string {
	const timestamp = renderer.getEntryIds().length + 1;
	const message = { role, content: [{ type: "text" as const, text }], timestamp };
	renderer.apply({ type: "message_start", timestamp, message });
	renderer.apply({ type: "message_end", timestamp: timestamp + 1, message });
	const id = renderer.getEntryIds().at(-1);
	if (!id) throw new Error(`${role} entry was not projected`);
	return id;
}

function parkAtEntry(transcript: TranscriptScrollView, renderer: StreamRenderer, entryId: string, width: number): void {
	const span = renderer.getEntrySpans(width).find((value) => value.entryId === entryId);
	if (!span) throw new Error(`missing entry span: ${entryId}`);
	transcript.scrollTo(span.start, { disableFollow: true });
}

function executeBlock(stdout: string) {
	return block(
		{ id: "growing-tool", kind: "execute", lifecycle: "streaming", currentDisplayMode: "expanded" },
		{ command: "run", stdout },
		{ defaultDisplayMode: "expanded", respectManualFolds: true },
	);
}

function plain(lines: readonly string[]): string[] {
	return lines.map((line) => stripTerminalSequences(line));
}
