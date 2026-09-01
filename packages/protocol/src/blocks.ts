/** Shared block vocabulary. Core produces these values; clients render them. */

export const BLOCK_KINDS = ["text", "thinking", "edit", "execute", "fold"] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export const BLOCK_LIFECYCLES = ["streaming", "complete", "failed"] as const;
export type BlockLifecycle = (typeof BLOCK_LIFECYCLES)[number];

export const BLOCK_DISPLAY_MODES = ["collapsed", "truncated", "expanded"] as const;
export type BlockDisplayMode = (typeof BLOCK_DISPLAY_MODES)[number];
export type DisplayMode = BlockDisplayMode;

export interface BlockFoldConfig {
	defaultDisplayMode?: BlockDisplayMode;
	truncatedLines?: number;
	firstLines?: number;
	lastLines?: number;
	respectManualFolds?: boolean;
}

export interface BlockMetadata {
	id: string;
	kind: BlockKind;
	lifecycle?: BlockLifecycle;
	defaultDisplayMode?: BlockDisplayMode;
	currentDisplayMode?: BlockDisplayMode;
	manualOverride?: boolean;
	colorSlot?: string;
	createdAt?: number;
	updatedAt?: number;
}

export interface DiffLine {
	type: "context" | "add" | "remove";
	content: string;
	oldLine?: number;
	newLine?: number;
}

export interface DiffHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: DiffLine[];
	additions: number;
	removals: number;
}

export interface TextBlockData {
	text: string;
	markdown?: string;
}

export interface ThinkingBlockData {
	markdown: string;
	lang?: string;
}

export interface EditBlockData {
	path: string;
	language?: string;
	hunks: DiffHunk[];
	additions: number;
	removals: number;
}

export interface ExecuteBlockData {
	command: string;
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	isError?: boolean;
}

export interface FoldBlockData {
	title: string;
	lines: string[];
}

export interface BlockDataByKind {
	text: TextBlockData;
	thinking: ThinkingBlockData;
	edit: EditBlockData;
	execute: ExecuteBlockData;
	fold: FoldBlockData;
}

export type BlockEnvelope<K extends BlockKind = BlockKind> = K extends BlockKind
	? BlockMetadata & {
			kind: K;
			data: BlockDataByKind[K];
			fold: BlockFoldConfig;
	  }
	: never;

export type AnyBlockEnvelope = { [K in BlockKind]: BlockEnvelope<K> }[BlockKind];

/** Name used by the rendering notes and downstream clients. */
export type RenderBlock<K extends BlockKind = BlockKind> = BlockEnvelope<K>;

export function block<K extends BlockKind>(
	metadata: BlockMetadata & { kind: K },
	data: BlockDataByKind[K],
	fold: BlockFoldConfig = {},
): BlockEnvelope<K> {
	return {
		...metadata,
		data: structuredClone(data),
		fold: { ...fold },
	} as BlockEnvelope<K>;
}

/** Transport-safe copy used by headless JSON clients. */
export function serializeBlock<K extends BlockKind>(value: BlockEnvelope<K>): BlockEnvelope<K> {
	return structuredClone(value);
}
