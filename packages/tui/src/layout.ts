export interface ScreenLayoutInput {
	columns?: number;
	rows: number;
	/** Content visibility hint; the agent status bar row remains fixed. */
	headerVisible?: boolean;
	statusVisible?: boolean;
	interactiveDesired?: number;
	interactiveOwner?: "composer" | "card";
	transcriptDesired?: number;
	/** User preference; the terminal height still forces compact mode at <=20 rows. */
	compact?: boolean;
	outerVpad?: number;
	outerHpadLeft?: number;
	outerHpadRight?: number;
}

export interface ScreenRegion {
	top: number;
	height: number;
}

export interface ScreenOuterPadding {
	top: number;
	bottom: number;
	left: number;
	right: number;
}

export interface ScreenLayoutPlan {
	header: ScreenRegion;
	transcript: ScreenRegion;
	interactive: ScreenRegion & { owner: "composer" | "card" };
	status: ScreenRegion;
	shortcuts: ScreenRegion;
	compact: boolean;
	outer: ScreenOuterPadding;
	inner: { top: number; height: number; width: number };
	totalHeight: number;
}

/** Matches grok-build's AgentView thresholds. */
export const SHORT_TERMINAL_ROWS = 16;
export const AUTO_COMPACT_MAX_ROWS = 20;
export const SCROLLBACK_MIN_ROWS = 5;

export function effectiveCompact(userCompact: boolean, rows: number): boolean {
	return userCompact || (Number.isFinite(rows) && rows > 0 && rows <= AUTO_COMPACT_MAX_ROWS);
}

/** Pure agent-view row budget model. The top status bar and shortcut row are
 * fixed; optional bottom status content yields before the scrollback floor. */
export function computeScreenLayout(input: ScreenLayoutInput): ScreenLayoutPlan {
	const columns = normalizeColumns(input.columns);
	const rows = normalizeRows(input.rows);
	const compact = effectiveCompact(input.compact === true, rows);
	const requestedTopVpad = finiteDimension(input.outerVpad, 1);
	const requestedLeftHpad = finiteDimension(input.outerHpadLeft, 2);
	const requestedRightHpad = finiteDimension(input.outerHpadRight, 2);
	// A zero-row measurement is an unpaintable viewport. Do not expose a
	// phantom top pad in the plan, because callers use `inner.top` as a paint
	// coordinate.
	const hasViewport = rows > 0;
	const verticalPad = hasViewport && !compact ? requestedTopVpad : 0;
	const bottomPad = hasViewport && !compact && rows > SHORT_TERMINAL_ROWS ? verticalPad : 0;
	const maxHorizontalPadding = Math.max(0, Math.floor((columns - 1) / 2));
	const leftPad = Math.min(compact ? 1 : requestedLeftHpad, maxHorizontalPadding);
	const rightPad = Math.min(compact ? 1 : requestedRightHpad, Math.max(0, columns - leftPad - 1));
	const innerTop = verticalPad;
	const innerHeight = Math.max(0, rows - verticalPad - bottomPad);
	const innerWidth = Math.max(1, columns - leftPad - rightPad);
	// Header visibility is part of the row budget.  In particular, a missing cwd
	// or a short terminal must not leave an unpaintable phantom row above the
	// transcript.  The <=16-row compact policy also hides optional header chrome.
	const headerHeight = hasViewport && input.headerVisible === true && rows > SHORT_TERMINAL_ROWS ? 1 : 0;
	const statusWanted = input.statusVisible === true;
	const owner = input.interactiveOwner ?? "composer";
	const shortcutHeight = innerHeight > 0 ? 1 : 0;
	let statusHeight = statusWanted ? 1 : 0;
	// A ratatui `Min(5)` is squeezed by short terminals. Keep the same useful
	// degradation explicitly so no region can escape the canvas.
	let transcriptFloor = innerHeight >= 20 ? SCROLLBACK_MIN_ROWS : innerHeight >= 16 ? 4 : innerHeight >= 8 ? 1 : 0;
	let interactiveMin = innerHeight >= 12 ? 3 : innerHeight >= 8 ? 2 : innerHeight >= 4 ? 1 : 0;
	const desiredInteractive = Math.max(interactiveMin, finiteHeight(input.interactiveDesired, 3));
	// The normal layout has one row between the top status bar and scrollback,
	// and one row between scrollback and the prompt. Compact/short mode reclaims
	// both gaps just like the upstream prompt policy.
	const statusGap = !compact && verticalPad > 0 ? 1 : 0;
	const interactiveGap = !compact && interactiveMin > 0 ? 1 : 0;
	let shortcutsGap = !compact && bottomPad > 0 && statusHeight === 0 && shortcutHeight > 0 ? 1 : 0;
	const fixedWithoutContent = (): number => headerHeight + statusGap + interactiveGap + statusHeight + shortcutsGap + shortcutHeight;
	const availableForContent = (): number => Math.max(0, innerHeight - fixedWithoutContent());

	// StatusLineFrame::On is clamped after all requested rows and the
	// scrollback floor have been accounted for. Drop it before sacrificing the
	// prompt or the transcript's useful minimum.
	if (availableForContent() < transcriptFloor + interactiveMin) {
		statusHeight = 0;
		shortcutsGap = !compact && bottomPad > 0 && shortcutHeight > 0 ? 1 : 0;
	}

	// On genuinely tiny viewports the scrollback Min is the flexible region.
	// The prompt and shortcuts remain reachable; the floor can reach zero only
	// when there is no room left after those fixed rows.
	const contentRows = availableForContent();
	if (contentRows < transcriptFloor + interactiveMin) {
		transcriptFloor = Math.min(transcriptFloor, Math.max(0, contentRows - interactiveMin));
	}
	if (contentRows < transcriptFloor + interactiveMin) {
		interactiveMin = Math.min(interactiveMin, Math.max(0, contentRows - transcriptFloor));
	}
	if (contentRows < transcriptFloor + interactiveMin) transcriptFloor = 0;

	const availableAfterFloor = Math.max(0, availableForContent() - transcriptFloor);
	const interactiveCap = Math.max(interactiveMin, Math.floor(Math.max(0, rows) / 2));
	const interactiveHeight = Math.min(desiredInteractive, interactiveCap, availableAfterFloor);
	const transcriptHeight = Math.max(0, availableForContent() - interactiveHeight);

	let top = innerTop;
	const header = region(top, headerHeight);
	top += header.height;
	top += statusGap;
	const transcript = region(top, transcriptHeight);
	top += transcript.height;
	top += interactiveGap;
	const interactive = { ...region(top, interactiveHeight), owner };
	top += interactive.height;
	const status = region(top, statusHeight);
	top += status.height;
	top += shortcutsGap;
	const shortcuts = region(top, shortcutHeight);
	top += shortcuts.height;

	// `fixed` is intentionally kept in the calculation above as a sanity guard.
	// Every region is clipped to the inner viewport for pathological dimensions.
	const clipped = (value: ScreenRegion): ScreenRegion => ({
		top: Math.min(innerTop + innerHeight, Math.max(innerTop, value.top)),
		height: Math.max(0, Math.min(value.height, innerTop + innerHeight - Math.max(innerTop, value.top))),
	});
	return {
		header: clipped(header),
		transcript: clipped(transcript),
		interactive: { ...clipped(interactive), owner },
		status: clipped(status),
		shortcuts: clipped(shortcuts),
		compact,
		outer: { top: verticalPad, bottom: bottomPad, left: leftPad, right: rightPad },
		inner: { top: innerTop, height: innerHeight, width: innerWidth },
		totalHeight: rows > 0 ? rows : 0,
	};
}

function region(top: number, height: number): ScreenRegion {
	return { top: Math.max(0, Math.floor(top)), height: Math.max(0, Math.floor(height)) };
}

function normalizeRows(rows: number): number {
	return !Number.isFinite(rows) || rows <= 0 ? 0 : Math.floor(rows);
}

function normalizeColumns(columns: number | undefined): number {
	return columns === undefined || !Number.isFinite(columns) || columns <= 0 ? 80 : Math.floor(columns);
}

function finiteDimension(value: number | undefined, fallback: number): number {
	return value === undefined || !Number.isFinite(value) || value < 0 ? fallback : Math.floor(value);
}

function finiteHeight(value: number | undefined, fallback: number): number {
	return value === undefined || !Number.isFinite(value) || value < 0 ? fallback : Math.floor(value);
}
