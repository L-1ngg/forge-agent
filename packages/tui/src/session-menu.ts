import { defaultStyle, writeText, type TerminalFrame } from "./frame.ts";
import type { Key } from "./keys.ts";
import type { Theme } from "./theme.ts";
import { truncateToWidth, wrapText } from "./width.ts";

export interface AppSessionSummary { id: string; title: string; updatedAt: number; }
export interface AppSessionPreview { id: string; revision: string; messages: { role: "user" | "assistant"; text: string; truncated: boolean; stopReason?: string }[]; }
export type SessionMenuAction = { type: "cancel" } | { type: "select"; id: string } | { type: "discard" } | { type: "preview"; id: string; revision: number };

/** A modal owns keys without stopping the active model or answering permission cards. */
export class SessionMenu {
	private index = 0;
	private expanded: string | undefined;
	private revision = 0;
	private preview: AppSessionPreview | undefined;
	private previewError: string | undefined;
	private top = 0;
	private previewHeight = 1;
	private previewLines = 0;
	private cache = new Map<string, AppSessionPreview>();
	cachedPreview(id: string): AppSessionPreview | undefined { return this.cache.get(id); }
	constructor(readonly kind: "list" | "discard", private sessions: AppSessionSummary[] = [], private diagnostics: string[] = [], private readonly currentId?: string, private loading = false) { }
	setList(sessions: AppSessionSummary[], diagnostics: string[]): void { this.sessions = sessions; this.diagnostics = diagnostics; this.loading = false; }
	setPreview(id: string, revision: number, preview?: AppSessionPreview, error?: string): void {
		if (id !== this.expanded || revision !== this.revision) return;
		this.preview = preview; this.previewError = error;
		if (preview) {
			this.cache.delete(id); this.cache.set(id, preview);
			if (this.cache.size > 20) this.cache.delete(this.cache.keys().next().value!);
		}
	}
	private collapse(): void { this.expanded = undefined; this.preview = undefined; this.previewError = undefined; this.top = 0; this.revision++; }
	handleKey(key: Key): SessionMenuAction | undefined {
		if (key.type === "escape") {
			if (this.expanded) { this.collapse(); return; }
			return { type: "cancel" };
		}
		if (this.kind === "discard") return key.type === "char" && key.text.toLowerCase() === "y" ? { type: "discard" } : key.type === "char" && key.text.toLowerCase() === "n" ? { type: "cancel" } : undefined;
		if (this.loading) return;
		if (key.type === "arrow" && this.sessions.length && (key.direction === "up" || key.direction === "down")) {
			this.collapse();
			this.index = (this.index + (key.direction === "down" ? 1 : -1) + this.sessions.length) % this.sessions.length;
		}
		if (this.expanded && (key.type === "pageDown" || key.type === "pageUp" || key.type === "mouse" && (key.action === "up" || key.action === "down"))) {
			const down = key.type === "pageDown" || key.type === "mouse" && key.action === "down";
			this.top = Math.max(0, Math.min(Math.max(0, this.previewLines - this.previewHeight), this.top + (down ? 1 : -1) * (key.type === "mouse" ? 3 : this.previewHeight)));
		}
		const selected = this.sessions[this.index];
		if (key.type === "ctrl" && key.key === "e" && selected) {
			if (this.expanded) { this.collapse(); return; }
			this.expanded = selected.id;
			return { type: "preview", id: selected.id, revision: ++this.revision };
		}
		return key.type === "enter" && selected ? { type: "select", id: selected.id } : undefined;
	}
	paint(frame: TerminalFrame, theme: Theme): void {
		const style = { ...defaultStyle(), foreground: theme.color("status") };
		const width = Math.max(1, frame.columns - 2);
		const line = (row: number, text: string) => { if (row >= 0 && row < frame.rows) writeText(frame, 1, row, truncateToWidth(text, width), style); };
		if (this.kind === "discard") {
			line(1, "空会话仍有草稿，丢弃后切换？");
			line(3, "y: 丢弃并切换 · n / Esc: 保留草稿");
			return;
		}
		line(0, this.loading ? "正在读取会话… Esc 返回" : "选择会话 · ↑/↓ 选择 · Enter 恢复");
		line(1, this.expanded ? "Ctrl+E/Esc 收起 · PgUp/PgDn 滚动" : "Ctrl+E 预览 · Esc 返回");
		if (this.loading) return;
		if (!this.sessions.length) line(3, "当前项目没有已保存会话");
		const available = Math.max(1, frame.rows - 4);
		const listHeight = this.expanded ? Math.max(1, Math.min(4, Math.floor(available / 3))) : available;
		const rowHeight = frame.rows >= 12 && listHeight >= 2 ? 2 : 1;
		const count = Math.max(1, Math.floor(listHeight / rowHeight));
		const start = Math.max(0, this.index - count + 1);
		for (let i = start; i < Math.min(this.sessions.length, start + count); i++) {
			const item = this.sessions[i]!;
			const row = 2 + (i - start) * rowHeight;
			const title = item.title.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
			line(row, `${i === this.index ? ">" : " "} ${item.id === this.currentId ? "[当前] " : ""}${title}`);
			if (rowHeight === 2) {
				const date = new Date(item.updatedAt);
				line(row + 1, Number.isFinite(date.getTime()) ? `  ${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "  时间未知");
			}
		}
		if (this.expanded) {
			const firstRow = 2 + listHeight;
			line(firstRow, "── 最近对话 ──");
			const content: string[] = [];
			if (this.previewError) content.push(`读取失败：${this.previewError}`);
			else if (!this.preview) content.push("正在读取预览…");
			else if (!this.preview.messages.length) content.push("暂无可预览文本");
			else for (const message of this.preview.messages) {
				const state = message.stopReason === "error" ? " · 失败" : message.stopReason === "aborted" ? " · 已中断" : message.stopReason === "length" ? " · 输出截断" : "";
				content.push(`${message.role === "user" ? "用户" : "助手"}${state}：`, message.text + (message.truncated ? " …[已省略]" : ""));
			}
			const lines = content.flatMap(text => wrapText(text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " "), width));
			this.previewHeight = Math.max(1, frame.rows - firstRow - 2);
			this.previewLines = lines.length;
			this.top = Math.min(this.top, Math.max(0, lines.length - this.previewHeight));
			for (let i = 0; i < this.previewHeight; i++) if (lines[this.top + i] !== undefined) line(firstRow + 1 + i, lines[this.top + i]!);
		}
		if (this.diagnostics.length) line(frame.rows - 1, `读取诊断 (${this.diagnostics.length}): ${this.diagnostics[0]}`);
	}
}
