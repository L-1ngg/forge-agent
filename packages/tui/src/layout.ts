/**
 * Pure screen layout (phase 2.2 B2). Priorities from phase-2.1 §2.6:
 * interactive >= 3, shortcuts = 1, transcript floor, status 0/1, header
 * hideable, compact at rows<=20, decorations cut at rows<=16.
 */
export interface ScreenLayoutInput {
	columns: number;
	rows: number;
	/** Desired composer content lines (wrapped draft), >= 1. */
	composerLines: number;
	/** Any known status segment; running keeps the row alive. */
	hasStatus: boolean;
}

export interface ScreenLayoutPlan {
	header: { height: 0 | 1 };
	transcript: { height: number };
	interactive: { height: number; owner: "composer" | "card" };
	status: { height: 0 | 1 };
	shortcuts: { height: 0 | 1 };
	compact: boolean;
}

const COMPOSER_CHROME_ROWS = 2; // top + bottom border
const INTERACTIVE_MIN = 3;
const TRANSCRIPT_FLOOR = 5;

export function computeScreenLayout(input: ScreenLayoutInput): ScreenLayoutPlan {
	const rows = Math.max(0, Math.floor(input.rows));
	const compact = rows <= 20;
	const tiny = rows <= 16;
	const composerCap = compact ? 5 : 8;

	let header: 0 | 1 = tiny ? 0 : 1;
	let status: 0 | 1 = input.hasStatus ? 1 : 0;
	let shortcuts: 0 | 1 = 1;
	let interactive = Math.min(Math.max(input.composerLines + COMPOSER_CHROME_ROWS, INTERACTIVE_MIN), composerCap);
	const owner: "composer" | "card" = "composer";

	let transcript = rows - header - status - shortcuts - interactive;
	if (transcript < TRANSCRIPT_FLOOR && header === 1) {
		header = 0;
		transcript += 1;
	}
	if (transcript < TRANSCRIPT_FLOOR && status === 1) {
		status = 0;
		transcript += 1;
	}
	if (transcript < 1) {
		interactive = Math.max(1, interactive - (1 - transcript));
		transcript = rows - header - status - shortcuts - interactive;
	}
	if (transcript < 0) {
		shortcuts = rows > 0 ? 1 : 0;
		interactive = Math.max(0, rows - header - status - shortcuts);
		transcript = 0;
	}

	return {
		header: { height: header },
		transcript: { height: transcript },
		interactive: { height: interactive, owner },
		status: { height: status },
		shortcuts: { height: shortcuts },
		compact,
	};
}

/** Vertical offsets of each region, top to bottom; sums to <= rows. */
export function layoutOffsets(plan: ScreenLayoutPlan): { header: number; transcript: number; interactive: number; status: number; shortcuts: number } {
	const header = 0;
	const transcript = header + plan.header.height;
	const interactive = transcript + plan.transcript.height;
	const status = interactive + plan.interactive.height;
	const shortcuts = status + plan.status.height;
	return { header, transcript, interactive, status, shortcuts };
}
