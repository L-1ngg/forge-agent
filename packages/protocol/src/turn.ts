import type { SessionEvent } from "./events.ts";

export type TurnResult = { status: "success" | "error" | "aborted" | "length" | "deferred" };

/** Consume the event iterator before awaiting final settlement. */
export interface SessionTurn extends AsyncIterable<SessionEvent> {
	readonly result: Promise<TurnResult>;
}
