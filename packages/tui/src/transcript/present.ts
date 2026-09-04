import type { AnyBlockEnvelope, BlockDisplayMode, EditBlockData, ExecuteBlockData, ThinkingBlockData } from "@myh/protocol";
import { defaultStyle, type CellStyle, type TerminalColor } from "../frame.ts";
import type { Theme } from "../theme.ts";
import { visibleWidth, wrapText } from "../width.ts";
import { renderMarkdown } from "../markdown.ts";
import { trimHeadTail, trimTail } from "./fold.ts";
import type { EntryChromeSpec, EntryRow, TranscriptEntry } from "./types.ts";

/** Kind renderers produce rows + a chrome declaration; the shell owns geometry. */
export interface EntryPresentation {
	rows: EntryRow[];
	chrome: EntryChromeSpec;
}

function fg(theme: Theme, slot: Parameters<Theme["color"]>[0], bold = false, background?: TerminalColor): CellStyle {
	return { foreground: theme.color(slot), background: background ?? { kind: "default" }, attributes: { bold, dim: false, italic: false, underline: false, blink: false, inverse: false, hidden: false, strikethrough: false } };
}

function row(text: string, style: CellStyle, background?: TerminalColor): EntryRow {
	return { spans: text ? [{ text, style }] : [], ...(background ? { background } : {}) };
}

export function formatTimestamp(timestamp: number | undefined): string | undefined {
	if (timestamp === undefined) return undefined;
	const date = new Date(timestamp);
	let hours = date.getHours();
	const minutes = date.getMinutes().toString().padStart(2, "0");
	const suffix = hours >= 12 ? "PM" : "AM";
	hours = hours % 12 || 12;
	return `${hours}:${minutes} ${suffix}`;
}

export function formatDurationMs(durationMs: number): string {
	const seconds = Math.max(0, durationMs) / 1000;
	return seconds >= 10 ? `${Math.round(seconds)}s` : `${seconds.toFixed(1)}s`;
}

export function presentEntry(entry: TranscriptEntry, contentWidth: number, theme: Theme): EntryPresentation {
	switch (entry.kind) {
		case "user":
			return presentUser(entry, contentWidth, theme);
		case "assistant":
			return presentAssistant(entry, contentWidth, theme);
		case "thinking":
			return presentThinking(entry.block, contentWidth, theme, entry.durationMs);
		case "execute":
			return presentExecute(entry.block, contentWidth, theme);
		case "edit":
			return presentEdit(entry.block, contentWidth, theme);
		case "notice":
			return presentNotice(entry, theme);
	}
}

const USER_PREFIX = "❯ ";

function presentUser(entry: TranscriptEntry & { kind: "user" }, contentWidth: number, theme: Theme): EntryPresentation {
	const surface = theme.color("surface");
	const textWidth = Math.max(1, contentWidth - visibleWidth(USER_PREFIX));
	const lines = wrapText(entry.text, textWidth);
	const rows = lines.map((line, index) => ({
		spans: [
			...(index === 0 ? [{ text: USER_PREFIX, style: fg(theme, "dim", false, surface) }] : []),
			{ text: line, style: fg(theme, "status", false, surface) },
		],
	}));
	return {
		rows,
		chrome: { surface, timestamp: formatTimestamp(entry.timestamp), vpadTop: 1, vpadBottom: 1, collapsed: false },
	};
}

function presentAssistant(entry: TranscriptEntry & { kind: "assistant" }, contentWidth: number, theme: Theme): EntryPresentation {
	const rows = renderMarkdown(entry.markdown, contentWidth, theme);
	return {
		rows,
		chrome: { timestamp: formatTimestamp(entry.timestamp), vpadTop: 0, vpadBottom: 1, collapsed: false },
	};
}

function displayModeOf(block: AnyBlockEnvelope): BlockDisplayMode {
	return block.currentDisplayMode ?? block.defaultDisplayMode ?? block.fold.defaultDisplayMode ?? "expanded";
}

function presentThinking(block: AnyBlockEnvelope, contentWidth: number, theme: Theme, durationMs?: number): EntryPresentation {
	const data = block.data as ThinkingBlockData;
	const streaming = block.lifecycle === "streaming";
	const title = streaming ? "Thinking…" : durationMs !== undefined ? `Thought for ${formatDurationMs(durationMs)}` : "Thought";
	const mode = displayModeOf(block);
	const header: EntryRow = {
		spans: [
			{ text: "◆ ", style: fg(theme, "accent_thinking") },
			{ text: title, style: fg(theme, "muted") },
		],
	};
	if (mode === "collapsed") {
		return { rows: [header], chrome: { collapsed: true, vpadTop: 0, vpadBottom: 1 } };
	}
	const body = data.markdown.split("\n");
	const visible = mode === "truncated" ? trimTail(body, block.fold.truncatedLines ?? 3) : body;
	const rows = [header, ...visible.map((line) => row(line === "…" ? line : line, fg(theme, line === "…" ? "muted" : "thinking_body")))];
	return {
		rows,
		chrome: { rail: streaming ? theme.color("accent_running") : undefined, collapsed: false, vpadTop: 0, vpadBottom: 1 },
	};
}

function presentExecute(block: AnyBlockEnvelope, contentWidth: number, theme: Theme): EntryPresentation {
	const data = block.data as ExecuteBlockData;
	const failed = block.lifecycle === "failed" || data.isError === true;
	const mode = displayModeOf(block);
	const titleStyle = fg(theme, failed ? "accent_error" : mode === "collapsed" ? "muted" : "status");
	const header: EntryRow = {
		spans: [
			{ text: "Run ", style: fg(theme, "muted", true) },
			{ text: data.command, style: titleStyle },
		],
	};
	if (mode === "collapsed") {
		return { rows: [header], chrome: { collapsed: true, vpadTop: 0, vpadBottom: 1 } };
	}
	const panel = theme.color("stdout_panel");
	const output = `${data.stdout ?? ""}${data.stderr ?? ""}`.split("\n").filter((line, index, all) => !(index === all.length - 1 && line === ""));
	const first = block.fold.firstLines ?? 2;
	const last = block.fold.lastLines ?? 3;
	const visible = mode === "truncated" ? trimHeadTail(output, first, last, (omitted) => `… +${omitted} lines`) : output;
	const bodyRows = visible.map((line) => row(line, fg(theme, line.startsWith("… +") ? "muted" : "status", false, panel), panel));
	return {
		rows: [header, ...bodyRows],
		chrome: {
			rail: block.lifecycle === "streaming" ? theme.color("accent_running") : failed ? theme.color("accent_error") : theme.color("accent_execute"),
			collapsed: false,
			vpadTop: 0,
			vpadBottom: 1,
		},
	};
}

function presentEdit(block: AnyBlockEnvelope, contentWidth: number, theme: Theme): EntryPresentation {
	const data = block.data as EditBlockData;
	const mode = displayModeOf(block);
	const name = data.path.split("/").pop() ?? data.path;
	const summary = data.additions > 0 || data.removals > 0 ? ` +${data.additions}/-${data.removals}` : "";
	const header: EntryRow = {
		spans: [
			{ text: "Edit ", style: fg(theme, "muted", true) },
			{ text: name, style: fg(theme, "muted") },
			...(summary ? [{ text: summary, style: fg(theme, "dim") }] : []),
		],
	};
	if (mode === "collapsed") {
		return { rows: [header], chrome: { collapsed: true, vpadTop: 0, vpadBottom: 1 } };
	}
	const addBg = theme.color("diff_add");
	const removeBg = theme.color("diff_remove");
	const maxLine = Math.max(1, ...data.hunks.map((hunk) => hunk.newStart + hunk.newLines));
	const gutterWidth = String(maxLine).length;
	const rows: EntryRow[] = [header];
	for (const hunk of data.hunks) {
		for (const line of hunk.lines) {
			if (line.type === "add") {
				const gutter = String(line.newLine ?? "").padStart(gutterWidth);
				rows.push({ spans: [{ text: `${gutter} + ${line.content}`, style: fg(theme, "status", false, addBg) }], background: addBg });
			} else if (line.type === "remove") {
				const gutter = " ".repeat(gutterWidth);
				rows.push({ spans: [{ text: `${gutter} - ${line.content}`, style: fg(theme, "status", false, removeBg) }], background: removeBg });
			} else {
				const gutter = String(line.newLine ?? "").padStart(gutterWidth);
				rows.push(row(`${gutter}   ${line.content}`, fg(theme, "muted")));
			}
		}
	}
	return { rows, chrome: { rail: theme.color("accent_edit"), collapsed: false, vpadTop: 0, vpadBottom: 1 } };
}

function presentNotice(entry: TranscriptEntry & { kind: "notice" }, theme: Theme): EntryPresentation {
	return {
		rows: [row(entry.text, fg(theme, entry.tone === "error" ? "error" : entry.tone === "success" ? "success" : "muted"))],
		chrome: { collapsed: false, vpadTop: 0, vpadBottom: 1 },
	};
}
