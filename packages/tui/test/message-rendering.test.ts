import { expect, test } from "bun:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { SessionMessage } from "@myh/protocol";
import { StreamRenderer, UserMessageCard, createSemanticTheme, formatDurationMs, identityTheme } from "../src/index.ts";

const SURFACE = "\u001b[48;5;236m";
const MUTED = "\u001b[38;5;240m";
const THINKING = "\u001b[38;5;139m";

const markerTheme = createSemanticTheme({
	surface: (value) => `${SURFACE}${value}\u001b[49m`,
	muted: (value) => `${MUTED}${value}\u001b[39m`,
	accent_thinking: (value) => `${THINKING}${value}\u001b[39m`,
});

const fixedTime = () => "3:18 PM";

function userMessage(text: string, timestamp: number): SessionMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

test("user message renders as a full-width surface card with ❯ and right-aligned timestamp", () => {
	const renderer = new StreamRenderer({ theme: markerTheme, formatTime: fixedTime });
	const message = userMessage("hello", 1000);
	renderer.apply({ type: "message_start", timestamp: 1, message });
	renderer.apply({ type: "message_end", timestamp: 2, message });

	const line = renderer.render(80)[0] ?? "";
	expect(line).toContain(SURFACE);
	expect(line).toContain(`${MUTED}3:18 PM\u001b[39m`);
	const plain = stripTerminalSequences(line);
	expect(plain).toContain("❯ hello");
	expect(plain.indexOf("❯ hello")).toBeLessThan(plain.indexOf("3:18 PM"));
});

test("standalone UserMessageCard aligns the timestamp at the right edge", () => {
	const card = new UserMessageCard("hello", 1000, markerTheme, fixedTime);
	const plain = stripTerminalSequences(card.render(40)[0] ?? "");
	expect(plain).toContain("❯ hello");
	// 40 columns: "❯ hello" with 1-cell margins, stamp right-aligned with 1-cell margin.
	expect(plain.indexOf("3:18 PM")).toBe(40 - "3:18 PM".length - 1);
});

test("finished thinking collapses to a one-line summary with duration", () => {
	const renderer = new StreamRenderer({ theme: markerTheme, formatTime: fixedTime });
	const started: SessionMessage = { role: "assistant", content: [], timestamp: 2000 };
	renderer.apply({ type: "message_start", timestamp: 10, message: started });
	renderer.apply({ type: "message_delta", timestamp: 10, contentIndex: 0, contentType: "thinking", delta: "rea" });
	renderer.apply({ type: "message_delta", timestamp: 11, contentIndex: 0, contentType: "thinking", delta: "son" });
	renderer.apply({ type: "message_delta", timestamp: 12, contentIndex: 1, contentType: "text", delta: "answer" });
	const finished: SessionMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "reason" },
			{ type: "text", text: "answer" },
		],
		timestamp: 2000,
	};
	renderer.apply({ type: "message_end", timestamp: 2710, message: finished });

	const rendered = renderer.render(80).join("\n");
	expect(rendered).toContain(`${THINKING}◆ Thought for 2.7s\u001b[39m`);
	expect(rendered).not.toContain("thinking: reason");
	expect(rendered).toContain("answer");
});

test("thinking without streamed deltas shows no fabricated duration", () => {
	const renderer = new StreamRenderer({ theme: markerTheme });
	const message: SessionMessage = {
		role: "assistant",
		content: [{ type: "thinking", thinking: "reason" }],
		timestamp: 2000,
	};
	renderer.apply({ type: "message_start", timestamp: 1, message });
	renderer.apply({ type: "message_end", timestamp: 2, message });

	const rendered = renderer.render(80).join("\n");
	expect(rendered).toContain("◆ Thought");
	expect(rendered).not.toContain("Thought for");
});

test("Ctrl+O target includes a message thinking block and toggles it open", () => {
	const renderer = new StreamRenderer();
	const message: SessionMessage = {
		role: "assistant",
		content: [{ type: "thinking", thinking: "reason" }],
		timestamp: 2000,
	};
	renderer.apply({ type: "message_start", timestamp: 1, message });
	renderer.apply({ type: "message_end", timestamp: 2, message });

	const id = renderer.latestFoldableBlockId();
	expect(id).toBe("thinking-0-0");
	expect(renderer.render(80).join("\n")).not.toContain("reason");
	expect(renderer.toggleBlock(id ?? "")).toBe(true);
	expect(renderer.render(80).join("\n")).toContain("reason");
});

test("turn end appends a muted Worked-for footer", () => {
	const renderer = new StreamRenderer({ theme: markerTheme });
	renderer.apply({ type: "turn_start", timestamp: 100 });
	renderer.apply({ type: "message_start", timestamp: 101, message: userMessage("hi", 101) });
	renderer.apply({ type: "turn_end", timestamp: 13200 });

	const rendered = renderer.render(80).join("\n");
	expect(rendered).toContain(`${MUTED}Worked for 13s\u001b[39m`);
});

test("entries are separated by one blank line", () => {
	const renderer = new StreamRenderer();
	renderer.apply({ type: "message_start", timestamp: 1, message: userMessage("first", 1) });
	renderer.apply({ type: "message_end", timestamp: 2, message: userMessage("first", 1) });
	renderer.apply({ type: "message_start", timestamp: 3, message: userMessage("second", 3) });
	renderer.apply({ type: "message_end", timestamp: 4, message: userMessage("second", 3) });

	const lines = renderer.render(80);
	const firstIndex = lines.findIndex((line) => line.includes("first"));
	const secondIndex = lines.findIndex((line) => line.includes("second"));
	expect(secondIndex - firstIndex).toBe(2);
	expect(lines[firstIndex + 1]).toBe("");
});

test("identity theme keeps transcripts free of ANSI by default", () => {
	const renderer = new StreamRenderer({ theme: identityTheme });
	const message: SessionMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "reason" },
			{ type: "text", text: "plain" },
		],
		timestamp: 2000,
	};
	renderer.apply({ type: "message_start", timestamp: 1, message });
	renderer.apply({ type: "message_end", timestamp: 2, message });
	expect(renderer.render(80).join("\n")).not.toContain("\u001b");
});

test("assistant text carries a right-aligned timestamp on its first line", () => {
	const renderer = new StreamRenderer({ theme: markerTheme, formatTime: fixedTime });
	const message: SessionMessage = {
		role: "assistant",
		content: [{ type: "text", text: "answer" }],
		timestamp: 2000,
	};
	renderer.apply({ type: "message_start", timestamp: 1, message });
	renderer.apply({ type: "message_end", timestamp: 2, message });

	const line = renderer.render(80).find((value) => value.includes("answer")) ?? "";
	expect(line).toContain(`${MUTED}3:18 PM\u001b[39m`);
	const plain = stripTerminalSequences(line);
	expect(plain.indexOf("answer")).toBeLessThan(plain.indexOf("3:18 PM"));
	expect(plain.trimEnd().endsWith("3:18 PM")).toBe(true);
});

test("thinking shorter than 100ms shows no fake precision", () => {
	const renderer = new StreamRenderer({ theme: markerTheme });
	const started: SessionMessage = { role: "assistant", content: [], timestamp: 2000 };
	renderer.apply({ type: "message_start", timestamp: 10, message: started });
	renderer.apply({ type: "message_delta", timestamp: 10, contentIndex: 0, contentType: "thinking", delta: "fast" });
	const finished: SessionMessage = {
		role: "assistant",
		content: [{ type: "thinking", thinking: "fast" }],
		timestamp: 2000,
	};
	renderer.apply({ type: "message_end", timestamp: 60, message: finished });

	const rendered = renderer.render(80).join("\n");
	expect(rendered).toContain("◆ Thought");
	expect(rendered).not.toContain("Thought for");
});

test("formatDurationMs matches the compact seconds style", () => {
	expect(formatDurationMs(2700)).toBe("2.7s");
	expect(formatDurationMs(13_100)).toBe("13s");
});
