import type { SessionEvent, SessionTurn, TurnResult } from "../../packages/protocol/src/index.ts";

/** A local host double: event delivery and final settlement are controlled separately. */
export function scriptedTurn(events: AsyncIterable<SessionEvent>, outcome: TurnResult | Promise<TurnResult> = { status: "success" }): SessionTurn {
	return { result: Promise.resolve(outcome), [Symbol.asyncIterator]: () => events[Symbol.asyncIterator]() };
}
