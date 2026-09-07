import type { AnyBlockEnvelope, BlockLifecycle, BlockDisplayMode } from "@forge-agent/protocol";
import type { CellStyle, TerminalColor } from "../frame.ts";

/** UI-local transcript vocabulary. Protocol events remain the cross-client truth. */
export type TranscriptEntry =
	| { id: string; kind: "user"; text: string; timestamp?: number }
	| { id: string; kind: "assistant"; markdown: string; timestamp?: number; lifecycle: BlockLifecycle }
	| { id: string; kind: "thinking"; block: AnyBlockEnvelope; durationMs?: number }
	| { id: string; kind: "execute"; block: AnyBlockEnvelope; result?: string }
	| { id: string; kind: "edit"; block: AnyBlockEnvelope; result?: string }
	| { id: string; kind: "tool"; toolCallId: string; name: string; args: Record<string, unknown>; content: string; lifecycle: BlockLifecycle; displayMode: BlockDisplayMode }
	| { id: string; kind: "notice"; text: string; tone: "muted" | "error" | "success" };

/** A styled text run inside one content row. */
export interface StyledSpan {
	text: string;
	style: CellStyle;
}

/**
 * One content row produced by a kind renderer. The entry shell owns every
 * other pixel: rail, padding, surface, timestamp gutter, vpad, clipping.
 */
export interface EntryRow {
	spans: StyledSpan[];
	/** Logical content position before wrapping; independent of terminal width. */
	source?: { line: number; column: number };
	/** Semantic full-row background (diff bands, output panel). */
	background?: TerminalColor | undefined;
}

/** Chrome declaration returned with a kind renderer's rows. */
export interface EntryChromeSpec {
	rail?: TerminalColor | undefined;
	surface?: TerminalColor | undefined;
	timestamp?: string | undefined;
	vpadTop: 0 | 1;
	vpadBottom: 0 | 1;
	/** Unpainted separation after the entry's surface and internal padding. */
	gapAfter?: 0 | 1;
	/** Collapsed entries drop the rail glyph but keep the rail column. */
	collapsed: boolean;
}
