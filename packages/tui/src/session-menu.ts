import { defaultStyle, writeText, type TerminalFrame } from "./frame.ts";
import type { Key } from "./keys.ts";
import type { Theme } from "./theme.ts";
import { truncateToWidth } from "./width.ts";

export interface AppSessionSummary { id: string; title: string; updatedAt: number; }
export type SessionMenuAction = { type: "cancel" } | { type: "select"; id: string } | { type: "discard" };

/** A modal owns keys without stopping the active model or answering permission cards. */
export class SessionMenu {
	private index = 0;
	constructor(readonly kind: "list" | "discard", private readonly sessions: AppSessionSummary[] = [], private readonly diagnostics: string[] = [], private readonly currentId?: string) { }
	handleKey(key: Key): SessionMenuAction | undefined {
		if (key.type === "escape" || this.kind === "discard" && key.type === "char" && key.text.toLowerCase() === "n") return { type: "cancel" };
		if (this.kind === "discard") return key.type === "char" && key.text.toLowerCase() === "y" ? { type: "discard" } : undefined;
		if (key.type === "arrow" && this.sessions.length) {
			if (key.direction === "down") this.index = (this.index + 1) % this.sessions.length;
			if (key.direction === "up") this.index = (this.index + this.sessions.length - 1) % this.sessions.length;
		}
		const selected = this.sessions[this.index];
		return key.type === "enter" && selected ? { type: "select", id: selected.id } : undefined;
	}
	paint(frame: TerminalFrame, theme: Theme): void {
		const style = { ...defaultStyle(), foreground: theme.color("status") };
		const line = (row: number, text: string) => writeText(frame, 1, row, truncateToWidth(text, Math.max(1, frame.columns - 2)), style);
		if (this.kind === "discard") {
			line(1, "空会话仍有草稿，丢弃后切换？");
			line(3, "y: 丢弃并切换 · n / Esc: 保留草稿");
			return;
		}
		line(0, "选择会话 · ↑/↓ 选择 · Enter 恢复 · Esc 返回（当前任务继续）");
		if (!this.sessions.length) line(2, "当前项目没有已保存会话");
		const height = Math.max(1, frame.rows - 5);
		const start = Math.max(0, this.index - height + 1);
		for (let i = start; i < Math.min(this.sessions.length, start + height); i++) {
			const item = this.sessions[i]!;
			const date = Number.isFinite(item.updatedAt) ? new Date(item.updatedAt).toLocaleString() : "Unknown time";
			line(2 + i - start, `${i === this.index ? ">" : " "} ${date} ${item.id === this.currentId ? "[当前] " : ""}${item.title}`);
		}
		if (this.diagnostics.length) line(frame.rows - 2, `读取诊断 (${this.diagnostics.length}): ${this.diagnostics[0]}`);
	}
}
