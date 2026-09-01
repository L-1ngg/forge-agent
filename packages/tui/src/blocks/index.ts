import { Text, type Component } from "@earendil-works/pi-tui";
import type { AnyBlockEnvelope } from "@myh/protocol";
import { EditBlock } from "./edit.ts";
import { ExecuteBlock } from "./execute.ts";
import { FoldBlock } from "./fold.ts";
import { ThinkingBlock } from "./thinking.ts";

export * from "./edit.ts";
export * from "./execute.ts";
export * from "./fold.ts";
export * from "./thinking.ts";

export function componentForBlock(block: AnyBlockEnvelope): Component {
	switch (block.kind) {
		case "text":
			return new Text(block.data.text, 1, 0);
		case "thinking":
			return new ThinkingBlock({ data: block });
		case "edit":
			return new EditBlock(block);
		case "execute":
			return new ExecuteBlock({ data: block });
		case "fold":
			return new FoldBlock({
				title: block.data.title,
				lines: block.data.lines,
				...block.fold,
				...(block.defaultDisplayMode !== undefined ? { defaultDisplayMode: block.defaultDisplayMode } : {}),
				...(block.currentDisplayMode !== undefined ? { currentDisplayMode: block.currentDisplayMode } : {}),
				...(block.manualOverride !== undefined ? { manualOverride: block.manualOverride } : {}),
			});
	}
}

/** Apply a streamed update to an existing component without resetting its fold state. */
export function updateBlockComponent(component: Component, block: AnyBlockEnvelope): Component {
	if (block.kind === "thinking" && component instanceof ThinkingBlock) {
		component.setText(block.data.markdown);
		component.applyEnvelopeMetadata(block, block.fold);
		return component;
	}
	if (block.kind === "edit" && component instanceof EditBlock) {
		component.setData(block.data);
		component.applyEnvelopeMetadata(block, block.fold);
		return component;
	}
	if (block.kind === "execute" && component instanceof ExecuteBlock) {
		component.setOutput(block.data);
		component.applyEnvelopeMetadata(block, block.fold);
		return component;
	}
	if (block.kind === "fold" && component instanceof FoldBlock) {
		component.setTitle(block.data.title);
		component.setLines(block.data.lines);
		component.applyEnvelopeMetadata(block, block.fold);
		return component;
	}
	return componentForBlock(block);
}
