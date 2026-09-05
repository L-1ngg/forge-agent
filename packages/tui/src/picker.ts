import type { InputCompletionItem } from "@forge-agent/protocol";
import { defaultStyle, fillRect, writeText, type TerminalFrame } from "./frame.ts";
import type { Theme } from "./theme.ts";
import { truncateToWidth } from "./width.ts";

export interface PickerState {
	items: InputCompletionItem[];
	prefix: string;
	index: number;
}

/** Paint a completion list into the bottom of a region; selected row uses surface_focus. */
export function paintPicker(frame: TerminalFrame, top: number, height: number, picker: PickerState, theme: Theme): void {
	if (height <= 0 || picker.items.length === 0) return;
	const visible = Math.min(height, picker.items.length);
	const start = Math.max(0, Math.min(picker.index - visible + 1, picker.items.length - visible));
	const y0 = top + height - visible;
	for (let offset = 0; offset < visible; offset++) {
		const item = picker.items[start + offset]!;
		const y = y0 + offset;
		if (y < 0 || y >= frame.rows) continue;
		const selected = start + offset === picker.index;
		const background = selected ? theme.color("surface_focus") : theme.color("surface");
		fillRect(frame, 0, y, frame.columns, 1, { ...defaultStyle(), background });
		const label = item.description ? `${item.label}  ${item.description}` : item.label;
		writeText(frame, 2, y, truncateToWidth(label, Math.max(1, frame.columns - 4)), {
			...defaultStyle(),
			foreground: selected ? theme.color("status") : theme.color("muted"),
			background,
		});
	}
}

export function pickerHeight(itemCount: number, max = 8): number {
	return Math.min(max, Math.max(0, itemCount));
}
