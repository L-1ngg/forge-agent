import type { AnyBlockEnvelope, BlockLifecycle } from "@myh/protocol";
import type { Component } from "@earendil-works/pi-tui";
import type { ThemeSlot } from "../theme.ts";

/** UI-local transcript vocabulary. Protocol events remain the cross-client truth. */
export type TranscriptEntry =
	| { id: string; kind: "user"; text: string; timestamp?: number }
	| { id: string; kind: "assistant"; markdown: string; timestamp?: number; lifecycle: BlockLifecycle }
	| { id: string; kind: "thinking"; block: AnyBlockEnvelope; durationMs?: number }
	| { id: string; kind: "execute"; block: AnyBlockEnvelope }
	| { id: string; kind: "edit"; block: AnyBlockEnvelope }
	| { id: string; kind: "notice"; text: string; tone: "muted" | "error" | "success" };

export interface EntryRow {
	text: string;
	background?: ThemeSlot;
	/** Row-local column where the background begins, including any first-row prefix. */
	backgroundStart?: number;
	/** False for a soft-wrap continuation of the preceding width-stable logical line. */
	logicalLineStart?: boolean;
}

/** Optional body hook used when a block needs semantic row backgrounds. */
export interface EntryRowProvider extends Component {
	renderEntryRows?(width: number): readonly EntryRow[];
}

export interface EntryChrome {
	/** Semantic color used for the one-cell rail. Undefined means reserve-only rail. */
	rail?: ThemeSlot;
	/** Semantic background that owns every cell in the entry, including padding. */
	surface?: ThemeSlot;
	timestamp?: string;
	showPrefix?: boolean;
	/** Prefix inserted on the first content row only, matching upstream bullet prepending. */
	contentPrefix?: string;
	contentPrefixTone?: ThemeSlot;
	vpadTop: 0 | 1;
	vpadBottom: 0 | 1;
	collapsed?: boolean;
}

export interface EntryPresentation {
	rows: readonly EntryRow[];
	chrome: EntryChrome;
}

export interface EntryLayout {
	readonly railWidth: 1;
	readonly leftPadding: number;
	readonly contentWidth: number;
	readonly timestampWidth: number;
	readonly rightPadding: number;
	readonly totalWidth: number;
}

export interface EntryLayoutOptions {
	leftPadding?: number;
	rightPadding?: number;
	timestamp?: string;
	timestampReserve?: number;
	showPrefix?: boolean;
}
