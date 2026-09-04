/** Stable UI-local identities shared by the pure projector and live renderer. */
export function messageEntryId(messageSeq: number, contentIndex: number): string {
	return `message-${normalizePart(messageSeq, "message sequence")}-content-${normalizePart(contentIndex, "content index")}`;
}

export function toolEntryId(toolCallId: string): string {
	return `tool-${toolCallId}`;
}

export function thinkingEntryId(messageSeq: number, contentIndex: number): string {
	return `thinking-${normalizePart(messageSeq, "message sequence")}-${normalizePart(contentIndex, "content index")}`;
}

export function contentIndexFromMessageEntryId(id: string): number {
	const match = /^message-\d+-content-(\d+)$/.exec(id);
	return match === null ? 0 : Number(match[1]);
}

function normalizePart(value: number, name: string): number {
	if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
	return value;
}
