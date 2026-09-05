import type { BlockDisplayMode, BlockFoldConfig, BlockMetadata } from "@forge-agent/protocol";

export interface FoldStateOptions {
	defaultDisplayMode?: BlockDisplayMode | undefined;
	currentDisplayMode?: BlockDisplayMode | undefined;
	manualOverride?: boolean | undefined;
	respectManualFolds?: boolean | undefined;
}

/** Owns the user-vs-streaming fold precedence for one entry. */
export class FoldState {
	private respectManualFolds: boolean;
	private defaultMode: BlockDisplayMode;
	private currentMode: BlockDisplayMode;
	private manual: boolean;

	constructor(options: FoldStateOptions = {}) {
		this.defaultMode = options.defaultDisplayMode ?? "expanded";
		this.currentMode = options.currentDisplayMode ?? this.defaultMode;
		this.manual = options.manualOverride ?? false;
		this.respectManualFolds = options.respectManualFolds ?? true;
	}

	get displayMode(): BlockDisplayMode {
		return this.currentMode;
	}

	get defaultDisplayMode(): BlockDisplayMode {
		return this.defaultMode;
	}

	get manualOverride(): boolean {
		return this.manual;
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

/** Keep the first/last lines with a single omission marker; used by execute output. */
export function trimHeadTail(lines: readonly string[], first: number, last: number, marker: (omitted: number) => string): string[] {
	if (lines.length <= first + last) return [...lines];
	const omitted = lines.length - first - last;
	const tail = last > 0 ? lines.slice(-last) : [];
	return [...lines.slice(0, first), marker(omitted), ...tail];
}

/** Keep the last N lines behind a muted ellipsis; used by thinking bodies. */
export function trimTail(lines: readonly string[], count: number): string[] {
	if (lines.length <= count) return [...lines];
	return ["…", ...lines.slice(-count)];
}
