export type AbortInput =
	| { type: "turn_start" }
	| { type: "tool_call"; id: string }
	| { type: "tool_result"; id: string }
	| { type: "assistant_message" }
	| { type: "abort" }
	| { type: "turn_end" };

export interface AbortState {
	status: "idle" | "running" | "aborted" | "completed";
	openToolCalls: ReadonlySet<string>;
	completedToolCalls: ReadonlySet<string>;
	turnMessages: number;
	committedTurns: number;
}

export const initialAbortState = (): AbortState => ({
	status: "idle",
	openToolCalls: new Set(),
	completedToolCalls: new Set(),
	turnMessages: 0,
	committedTurns: 0,
});

export function stepAbortMachine(state: AbortState, input: AbortInput): AbortState {
	if (state.status === "aborted" || state.status === "completed") return state;
	if (input.type === "abort") {
		return { ...state, status: "aborted", openToolCalls: new Set() };
	}
	if (input.type === "turn_start") return { ...state, status: "running", turnMessages: 0 };
	if (state.status !== "running") return state;

	if (input.type === "tool_call") {
		if (state.openToolCalls.has(input.id) || state.completedToolCalls.has(input.id)) return state;
		return { ...state, openToolCalls: new Set([...state.openToolCalls, input.id]), turnMessages: state.turnMessages + 1 };
	}
	if (input.type === "tool_result") {
		if (!state.openToolCalls.has(input.id)) return state;
		const openToolCalls = new Set(state.openToolCalls);
		openToolCalls.delete(input.id);
		return { ...state, openToolCalls, completedToolCalls: new Set([...state.completedToolCalls, input.id]), turnMessages: state.turnMessages + 1 };
	}
	if (input.type === "assistant_message") return { ...state, turnMessages: state.turnMessages + 1 };
	if (input.type === "turn_end") {
		if (state.openToolCalls.size > 0) return state;
		return { ...state, status: "completed", committedTurns: state.committedTurns + 1 };
	}
	return state;
}

export function runAbortMachine(inputs: readonly AbortInput[]): AbortState {
	return inputs.reduce(stepAbortMachine, initialAbortState());
}
