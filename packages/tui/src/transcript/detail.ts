import type { EditBlockData, ExecuteBlockData, ThinkingBlockData } from "@forge-agent/protocol";
import type { TranscriptEntry } from "./types.ts";

export interface EntryDetail {
	title: string;
	metadata: string;
	lines: string[];
	firstLine?: number;
	live: boolean;
	kind: TranscriptEntry["kind"];
}

export function readContent(entry: Extract<TranscriptEntry, { kind: "tool" }>): string {
	if (entry.name !== "read" || entry.lifecycle === "failed") return entry.content;
	try {
		const value: unknown = JSON.parse(entry.content);
		if (value && typeof value === "object" && "content" in value && typeof value.content === "string") return value.content;
	} catch { /* A plain-text result needs no decoding. */ }
	return entry.content;
}

export function readNotice(entry: Extract<TranscriptEntry, { kind: "tool" }>): string | undefined {
	if (entry.name !== "read") return;
	try {
		const value: unknown = JSON.parse(entry.content);
		if (value && typeof value === "object" && "notice" in value && typeof value.notice === "string") return value.notice;
	} catch { /* Non-JSON failures remain in the original content. */ }
}

export function entryDetail(entry: TranscriptEntry): EntryDetail {
	const base = { live: false, kind: entry.kind };
	switch (entry.kind) {
		case "tool": {
			const path = typeof entry.args.path === "string" ? entry.args.path : "";
			const read = entry.name === "read";
			if (entry.name === "bash") {
				const command = String(entry.args.command ?? "bash");
				let output = entry.content;
				try {
					const value: unknown = JSON.parse(output);
					if (value && typeof value === "object" && "stdout" in value && typeof value.stdout === "string") output = value.stdout + ("stderr" in value && typeof value.stderr === "string" ? value.stderr : "");
				} catch { /* Failure text remains readable without a structured result. */ }
				return { ...base, kind: "execute", title: `Run ${command}${entry.lifecycle === "failed" ? " (failed)" : ""}`, metadata: command, lines: [`$ ${command}`, "", ...output.split("\n")], live: entry.lifecycle === "streaming" };
			}
			if (entry.name === "edit") {
				const oldText = typeof entry.args.old_text === "string" ? entry.args.old_text : "";
				const newText = typeof entry.args.new_text === "string" ? entry.args.new_text : "";
				return { ...base, kind: "edit", title: `Edit ${path}${entry.lifecycle === "failed" ? " (failed)" : ""}`, metadata: path,
					lines: [...(entry.lifecycle === "failed" ? [entry.content] : []), ...oldText.split("\n").map((line) => `-${line}`), ...newText.split("\n").map((line) => `+${line}`)] };
			}
			return { ...base, title: `${read ? "Read" : entry.name} ${path}${entry.lifecycle === "failed" ? " (failed)" : ""}`.trim(), metadata: [path, readNotice(entry)].filter(Boolean).join(" | "),
				lines: (read ? readContent(entry) : `Arguments\n${JSON.stringify(entry.args, null, 2)}\n\nResult\n${entry.content}`).split("\n"),
				...(read && entry.lifecycle !== "failed" ? { firstLine: typeof entry.args.offset === "number" ? entry.args.offset : 1 } : {}) };
		}
		case "execute": {
			const data = entry.block.data as ExecuteBlockData;
			const output = `${data.stdout ?? ""}${data.stderr ?? ""}`;
			return { ...base, title: `Run ${data.command}${entry.block.lifecycle === "failed" ? " (failed)" : ""}`, metadata: data.command,
				lines: [`$ ${data.command}`, "", ...(output || entry.result || "").split("\n")], live: entry.block.lifecycle === "streaming" };
		}
		case "edit": {
			const data = entry.block.data as EditBlockData;
			return { ...base, title: `Edit ${data.path}${entry.block.lifecycle === "failed" ? " (failed)" : ""}`, metadata: data.path,
				lines: [...(entry.block.lifecycle === "failed" && entry.result ? [entry.result, ""] : []), ...data.hunks.flatMap((hunk) => [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
					...hunk.lines.map((line) => `${line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}${line.content}`)])] };
		}
		case "thinking": return { ...base, title: "Thought", metadata: "", lines: (entry.block.data as ThinkingBlockData).markdown.split("\n") };
		case "assistant": return { ...base, title: "Assistant", metadata: "", lines: entry.markdown.split("\n") };
		case "user": return { ...base, title: "User", metadata: "", lines: entry.text.split("\n") };
		case "notice": return { ...base, title: "Notice", metadata: "", lines: entry.text.split("\n") };
	}
}
