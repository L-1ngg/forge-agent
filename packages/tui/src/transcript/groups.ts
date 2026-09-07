import { defaultStyle } from "../frame.ts";
import type { Theme } from "../theme.ts";
import { truncateToWidth, visibleWidth } from "../width.ts";
import { computeEntryLayout } from "./entry-shell.ts";
import { presentEntry, type EntryPresentation } from "./present.ts";
import type { TranscriptEntry } from "./types.ts";

export interface TranscriptView {
	id: string;
	presentation: EntryPresentation;
	members?: readonly TranscriptEntry[];
	/** Shared border range; only the selected row receives the focus background. */
	selectionGroup?: string;
	dense?: boolean;
}

const EXPLORATION: Record<string, readonly [string, string]> = {
	read: ["Read", "file"], list: ["Listed", "dir"], list_directory: ["Listed", "dir"],
	search: ["Searched", "pattern"], grep: ["Searched", "pattern"], glob: ["Searched", "pattern"],
};

function verb(entry: TranscriptEntry): readonly [string, string] | undefined {
	return entry.kind === "tool" && Object.hasOwn(EXPLORATION, entry.name) ? EXPLORATION[entry.name] : undefined;
}

function isCollapsed(entry: TranscriptEntry): boolean {
	if (entry.kind === "tool") return entry.displayMode === "collapsed";
	if ("block" in entry) return (entry.block.currentDisplayMode ?? entry.block.defaultDisplayMode ?? entry.block.fold.defaultDisplayMode) === "collapsed";
	return false;
}

function isMember(entry: TranscriptEntry): boolean {
	return isCollapsed(entry) && (!!verb(entry) || entry.kind === "thinking" && entry.block.lifecycle === "complete");
}

/** VerbRun and dense truncation are separate upstream rules, not per-tool-name buckets. */
export function transcriptViews(entries: readonly TranscriptEntry[], columns: number, theme: Theme, expanded: ReadonlySet<string>): TranscriptView[] {
	const views: TranscriptView[] = [];
	const present = (entry: TranscriptEntry): TranscriptView => {
		const hasTimestamp = entry.kind === "user" || entry.kind === "assistant";
		const layout = computeEntryLayout(columns, hasTimestamp ? "0:00 PM" : undefined);
		return { id: entry.id, presentation: presentEntry(entry, layout.contentWidth, theme), dense: isCollapsed(entry) };
	};
	const group = (members: readonly TranscriptEntry[], title: string): TranscriptView => {
		const id = `group:${members[0]!.id}`;
		const failed = members.filter((member) => member.kind === "tool" ? member.lifecycle === "failed" : "block" in member && member.block.lifecycle === "failed").length;
		const active = members.some((member) => member.kind === "tool" ? member.lifecycle === "streaming" : "block" in member && member.block.lifecycle === "streaming");
		const open = members.some((member) => expanded.has(member.id));
		const style = { ...defaultStyle(), foreground: theme.color(failed ? "error" : "muted") };
		const suffix = `${active ? " (running)" : ""}${failed ? ` (${failed} failed)` : ""}`;
		return { id, members, selectionGroup: id, dense: true, presentation: {
			rows: [{ spans: [
				{ text: open ? "▾ " : "◆ ", style: { ...style, foreground: theme.color(failed ? "accent_error" : active ? "accent_running" : "accent_tool") } },
				{ text: truncateToWidth(title, Math.max(1, computeEntryLayout(columns).contentWidth - 2 - visibleWidth(suffix))) + suffix, style: { ...style, attributes: { ...style.attributes, bold: true } } },
			] }], chrome: { collapsed: true, vpadTop: 0, vpadBottom: 1 },
		} };
	};
	for (let index = 0; index < entries.length;) {
		const entry = entries[index]!;
		if (!isMember(entry)) { views.push(present(entry)); index++; continue; }
		let end = index + 1;
		for (let next = end; next < entries.length; next++) {
			const candidate = entries[next]!;
			if (!verb(candidate) && candidate.kind !== "thinking") break;
			if (isMember(candidate)) end = next + 1;
		}
		const range = entries.slice(index, end);
		const members = range.filter(isMember);
		if (!members.some((member) => verb(member))) { views.push(present(entry)); index++; continue; }
		const buckets = new Map<string, { noun: string; count: number }>();
		for (const member of members) {
			const action = verb(member);
			if (!action) continue;
			const bucket = buckets.get(action[0]) ?? { noun: action[1], count: 0 };
			bucket.count++;
			buckets.set(action[0], bucket);
		}
		const title = [...buckets].map(([action, { noun, count }]) => `${action} ${count} ${noun}${count === 1 ? "" : "s"}`).join(", ");
		const header = group(members, title);
		views.push(header);
		const open = members.some((member) => expanded.has(member.id));
		for (const member of range) {
			if (open || !isMember(member)) views.push({ ...present(member), ...(isMember(member) ? { selectionGroup: header.id } : {}) });
		}
		index = end;
	}

	const result: TranscriptView[] = [];
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	for (let index = 0; index < views.length;) {
		const first = views[index]!;
		if (!first.dense || first.selectionGroup) { result.push(first); index++; continue; }
		let end = index + 1;
		while (end < views.length && views[end]!.dense && !views[end]!.selectionGroup) end++;
		const run = views.slice(index, end);
		const selectionGroup = `dense:${first.id}`;
		if (run.length > 11) {
			const hidden = run.slice(0, -10);
			const members = hidden.map((view) => byId.get(view.id)!);
			const header = group(members, `${hidden.length} earlier steps`);
			result.push({ ...header, selectionGroup });
			if (members.some((member) => expanded.has(member.id))) result.push(...hidden.map((view) => ({ ...view, selectionGroup })));
			result.push(...run.slice(-10).map((view) => ({ ...view, selectionGroup })));
		} else result.push(...run.map((view) => ({ ...view, selectionGroup })));
		index = end;
	}
	for (let index = 0; index < result.length - 1; index++) {
		if (result[index]!.dense && result[index + 1]!.dense) result[index]!.presentation.chrome.vpadBottom = 0;
	}
	return result;
}
