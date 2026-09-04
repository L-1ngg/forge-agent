import type { RequestKind } from "@myh/protocol";

export type KeyOwner = "card" | "scrollback" | "composer" | "global";
export type EscStep = "leave_input" | "park_card" | "abort_turn" | "arm_rewind" | "rewind" | "noop";

export interface InputRouterState {
	cardFocused: boolean;
	cardParked: boolean;
	cardKind?: RequestKind;
	cardSubInput?: boolean;
	editorFocused?: boolean;
	running?: boolean;
	searching?: boolean;
}

/** Single priority function shared by input handling and visible hints. */
export function resolveKeyOwner(state: InputRouterState): KeyOwner {
	if (state.cardFocused) return "card";
	if (state.cardParked || state.searching) return "scrollback";
	if (state.editorFocused) return "composer";
	return "global";
}

/** Pure Esc ladder. A parked card must never fall through to turn abort. */
export function nextEscStep(state: InputRouterState, idle: "arm_rewind" | "rewind" | "noop" = "arm_rewind"): EscStep {
	if (state.cardSubInput) return "leave_input";
	if (state.cardFocused) return "park_card";
	if (state.cardParked) return "noop";
	if (state.running) return "abort_turn";
	return idle;
}

export interface ShortcutRoute {
	keys: readonly string[];
	label: string;
	pinned?: boolean;
}

export function shortcutRoutes(state: InputRouterState): readonly ShortcutRoute[] {
	const owner = resolveKeyOwner(state);
	if (owner === "card") {
		const escLabel = nextEscStep(state) === "leave_input" ? "back" : "scrollback";
		return [{ keys: ["Tab"], label: "next" }, { keys: ["Enter"], label: "choose" }, { keys: ["Esc"], label: escLabel, pinned: true }];
	}
	if (owner === "scrollback") return [{ keys: ["Tab", "Space"], label: requestKindShortcutLabel(state.cardKind), pinned: true }];
	if (owner === "composer") return [{ keys: ["Enter"], label: "send" }, { keys: ["Ctrl+Enter"], label: "send now" }, { keys: ["Ctrl+C"], label: "exit", pinned: true }];
	return [{ keys: ["Ctrl+C"], label: "exit", pinned: true }];
}

export function requestKindShortcutLabel(kind: RequestKind | undefined): string {
	switch (kind) {
		case "permission": return "permission";
		case "cancel_confirm": return "cancel turn";
		case "question": return "question";
		case "plan_approval": return "plan approval";
		case "oauth": return "oauth";
		default: return "card";
	}
}
