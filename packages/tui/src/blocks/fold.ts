import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { BlockDisplayMode, BlockFoldConfig, BlockMetadata } from "@myh/protocol";

export interface FoldStateOptions {
	defaultDisplayMode?: BlockDisplayMode;
	currentDisplayMode?: BlockDisplayMode;
	manualOverride?: boolean;
	respectManualFolds?: boolean;
}

/** Owns the user-vs-streaming fold precedence for one block. */
export class FoldState {
	private respectManualFolds: boolean;
	private defaultMode: BlockDisplayMode;
	private currentMode: BlockDisplayMode;
	private manual = false;

	constructor(options: FoldStateOptions = {}) {
		this.defaultMode = options.defaultDisplayMode ?? "expanded";
		this.currentMode = options.currentDisplayMode ?? this.defaultMode;
		this.manual = options.manualOverride ?? false;
		this.respectManualFolds = options.respectManualFolds ?? true;
	}

	get displayMode(): BlockDisplayMode {
		return this.currentMode;
	}

	get currentDisplayMode(): BlockDisplayMode {
		return this.currentMode;
	}

	get defaultDisplayMode(): BlockDisplayMode {
		return this.defaultMode;
	}

	get manualOverride(): boolean {
		return this.manual;
	}

	get respectsManualFolds(): boolean {
		return this.respectManualFolds;
	}

	setDisplayMode(mode: BlockDisplayMode, manual = true): void {
		this.currentMode = mode;
		if (manual) this.manual = true;
	}

	toggle(): BlockDisplayMode {
		this.setDisplayMode(this.currentMode === "collapsed" ? "expanded" : "collapsed");
		return this.currentMode;
	}

	/** Apply a stream/default update without reopening a manually folded block. */
	updateDefault(mode: BlockDisplayMode): void {
		this.defaultMode = mode;
		if (!this.manual || !this.respectManualFolds) this.currentMode = mode;
	}

	/** Merge a streamed envelope while retaining a local manual fold. */
	updateFromEnvelope(metadata: Pick<BlockMetadata, "defaultDisplayMode" | "currentDisplayMode" | "manualOverride">, fold: BlockFoldConfig = {}): void {
		const incomingDefault = metadata.defaultDisplayMode ?? fold.defaultDisplayMode;
		if (fold.respectManualFolds !== undefined) this.respectManualFolds = fold.respectManualFolds;
		if (incomingDefault !== undefined) this.defaultMode = incomingDefault;

		const preserveManual = this.manual && this.respectManualFolds;
		if (!preserveManual) {
			if (metadata.manualOverride !== undefined) this.manual = metadata.manualOverride;
			if (metadata.currentDisplayMode !== undefined) this.currentMode = metadata.currentDisplayMode;
			else if (incomingDefault !== undefined) this.currentMode = incomingDefault;
		}
	}

	clearManualOverride(): void {
		this.manual = false;
		this.currentMode = this.defaultMode;
	}
}

export const FoldController = FoldState;

export interface FoldBlockOptions extends FoldStateOptions {
	title: string;
	lines?: readonly string[];
	truncatedLines?: number;
	firstLines?: number;
	lastLines?: number;
}

/** Shared presentation shell; specialized blocks only provide body lines. */
export class FoldBlock implements Component {
	readonly fold: FoldState;
	protected title: string;
	protected lines: string[];
	protected truncatedLines: number;
	protected firstLines: number | undefined;
	protected lastLines: number | undefined;

	constructor(options: FoldBlockOptions) {
		this.title = options.title;
		this.lines = [...(options.lines ?? [])];
		this.truncatedLines = normalizeCount(options.truncatedLines, 3);
		this.firstLines = normalizeOptionalCount(options.firstLines);
		this.lastLines = normalizeOptionalCount(options.lastLines);
		this.fold = new FoldState(options);
	}

	get displayMode(): BlockDisplayMode {
		return this.fold.displayMode;
	}

	get manualOverride(): boolean {
		return this.fold.manualOverride;
	}

	setLines(lines: readonly string[], defaultMode?: BlockDisplayMode): void {
		this.lines = [...lines];
		if (defaultMode) this.fold.updateDefault(defaultMode);
		this.invalidate();
	}

	/** Apply transport metadata without changing body content. */
	applyEnvelopeMetadata(metadata: Pick<BlockMetadata, "defaultDisplayMode" | "currentDisplayMode" | "manualOverride">, fold: BlockFoldConfig = {}): void {
		if (fold.truncatedLines !== undefined) this.truncatedLines = normalizeCount(fold.truncatedLines, 0);
		if (fold.firstLines !== undefined) this.firstLines = normalizeCount(fold.firstLines, 0);
		if (fold.lastLines !== undefined) this.lastLines = normalizeCount(fold.lastLines, 0);
		this.fold.updateFromEnvelope(metadata, fold);
		this.invalidate();
	}

	setTitle(title: string): void {
		this.title = title;
		this.invalidate();
	}

	update(lines: readonly string[], defaultMode?: BlockDisplayMode): void {
		this.setLines(lines, defaultMode);
	}

	toggle(): BlockDisplayMode {
		const mode = this.fold.toggle();
		this.invalidate();
		return mode;
	}

	setDisplayMode(mode: BlockDisplayMode, manual = true): void {
		this.fold.setDisplayMode(mode, manual);
		this.invalidate();
	}

	clearManualOverride(): void {
		this.fold.clearManualOverride();
		this.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const lines = [`${this.indicator()} ${this.title}`];
		if (this.fold.displayMode === "collapsed") return lines.map((line) => truncateToWidth(line, safeWidth));
		const body = this.visibleLines();
		return lines.concat(body).map((line) => truncateToWidth(line, safeWidth));
	}

	invalidate(): void {}

	protected indicator(): string {
		return this.fold.displayMode === "collapsed" ? ">" : "v";
	}

	protected visibleLines(): string[] {
		if (this.fold.displayMode === "expanded") return [...this.lines];
		if (this.firstLines !== undefined || this.lastLines !== undefined) return trimHeadTail(this.lines, this.firstLines ?? 0, this.lastLines ?? 0);
		if (this.lines.length <= this.truncatedLines) return [...this.lines];
		return [...this.lines.slice(0, this.truncatedLines), `... ${this.lines.length - this.truncatedLines} more lines`];
	}
}

function trimHeadTail(lines: readonly string[], first: number, last: number): string[] {
	if (lines.length <= first + last) return [...lines];
	const omitted = lines.length - first - last;
	const tail = last > 0 ? lines.slice(-last) : [];
	return [...lines.slice(0, first), `... ${omitted} lines omitted`, ...tail];
}

function normalizeCount(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value < 0) throw new RangeError("fold line count must be a non-negative finite number");
	return Math.floor(value);
}

function normalizeOptionalCount(value: number | undefined): number | undefined {
	return value === undefined ? undefined : normalizeCount(value, 0);
}
