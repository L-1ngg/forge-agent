/**
 * Pure screen layout (phase 2.2 B2). Priorities from phase-2.1 §2.6:
 * interactive >= 3, shortcuts = 1, transcript floor, status 0/1, header
 * hideable, compact at rows<=20, decorations cut at rows<=16.
 */
export interface ScreenLayoutInput {
	columns: number;
	rows: number;
	/** Desired content lines for the interactive slot (wrapped draft or card body), >= 1. */
	interactiveLines: number;
	/** Any known status segment; running keeps the row alive. */
	hasStatus: boolean;
	/** Card replaces the composer slot when a blocking request is visible. */
	interactiveOwner?: "composer" | "card";
	activityLines?: number;
	compact?: boolean;
	tiny?: boolean;
}

export interface ScreenLayoutPlan {
	gaps: { header: number; activity: number; prompt: number; shortcuts: number };
	header: { height: 0 | 1 };
	transcript: { height: number };
	activity: { height: number };
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
	const compact = input.compact ?? rows <= 20;
	const tiny = input.tiny ?? rows <= 16;
	const composerCap = Math.max(INTERACTIVE_MIN, Math.floor(rows / 2));

	let header: 0 | 1 = tiny ? 0 : 1;
	let status: 0 | 1 = input.hasStatus ? 1 : 0;
	let shortcuts: 0 | 1 = 1;
	const chromeRows = (input.interactiveOwner ?? "composer") === "composer" ? COMPOSER_CHROME_ROWS : 0;
	let interactive = Math.min(Math.max(input.interactiveLines + chromeRows, INTERACTIVE_MIN), composerCap);
	const owner: "composer" | "card" = input.interactiveOwner ?? "composer";
	let activity = Math.min(input.activityLines ?? 0, Math.max(0, rows - interactive - shortcuts - 1), Math.max(1, rows - interactive - shortcuts - TRANSCRIPT_FLOOR));

	let transcript = rows - header - status - shortcuts - interactive - activity;
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
		transcript = rows - header - status - shortcuts - interactive - activity;
	}
	if (transcript < 0) {
		shortcuts = rows > 0 ? 1 : 0;
		interactive = Math.max(0, rows - header - status - shortcuts);
		activity = 0;
		transcript = 0;
	}

	const gaps = { header: 0, activity: 0, prompt: 0, shortcuts: 0 };
	if (!compact && !tiny) {
		for (const name of ["header", "activity", "prompt", "shortcuts"] as const) {
			if (transcript <= TRANSCRIPT_FLOOR || name === "header" && !header || name === "activity" && !activity) continue;
			gaps[name] = 1;
			transcript--;
		}
	}
	return {
		gaps,
		header: { height: header },
		transcript: { height: transcript },
		activity: { height: activity },
		interactive: { height: interactive, owner },
		status: { height: status },
		shortcuts: { height: shortcuts },
		compact,
	};
}

/** Vertical offsets of each region, top to bottom; sums to <= rows. */
export function layoutOffsets(plan: ScreenLayoutPlan): { header: number; transcript: number; activity: number; interactive: number; status: number; shortcuts: number } {
	const header = 0;
	const transcript = header + plan.header.height + plan.gaps.header;
	const activity = transcript + plan.transcript.height + plan.gaps.activity;
	const interactive = activity + plan.activity.height + plan.gaps.prompt;
	const status = interactive + plan.interactive.height;
	const shortcuts = status + plan.status.height + plan.gaps.shortcuts;
	return { header, transcript, activity, interactive, status, shortcuts };
}
