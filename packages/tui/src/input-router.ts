import type { RequestKind } from "@myh/protocol";

export type KeyOwner = "card" | "scrollback" | "composer" | "global";
export type EscStep = "leave_input" | "park_card" | "abort_turn" | "arm_rewind" | "rewind" | "noop";

export interface InputRouterState {
	cardFocused: boolean;
	cardParked: boolean;
	cardKind?: RequestKind | undefined;
	cardSubInput?: boolean | undefined;
	editorFocused?: boolean | undefined;
	running?: boolean | undefined;
	searching?: boolean | undefined;
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

/** Shortcuts are derived from the same KeyOwner that routes keys. */
export function shortcutRoutes(state: InputRouterState): readonly ShortcutRoute[] {
	const owner = resolveKeyOwner(state);
	if (owner === "card") {
		const escLabel = nextEscStep(state) === "leave_input" ? "back" : "scrollback";
		return [
			{ keys: ["pgup/pgdn"], label: "scroll" },
			{ keys: ["tab"], label: "next" },
			{ keys: ["enter"], label: "choose" },
			{ keys: ["esc"], label: escLabel, pinned: true },
		];
	}
	if (owner === "scrollback") {
		return [
			{ keys: ["pgup/pgdn"], label: "scroll" },
			{ keys: ["tab", "space"], label: requestKindShortcutLabel(state.cardKind), pinned: true },
		];
	}
	if (owner === "composer") {
		return [
			{ keys: ["enter"], label: state.running ? "queue" : "send" },
			{ keys: ["ctrl+enter"], label: "send now" },
			{ keys: ["ctrl+o"], label: "fold" },
			{ keys: ["pgup/pgdn"], label: "scroll" },
			{ keys: ["ctrl+c"], label: "quit", pinned: true },
		];
	}
	return [{ keys: ["ctrl+c"], label: "quit", pinned: true }];
}

export function requestKindShortcutLabel(kind: RequestKind | undefined): string {
	switch (kind) {
		case "permission":
			return "permission";
		case "cancel_confirm":
			return "cancel turn";
		case "question":
			return "question";
		case "plan_approval":
			return "plan approval";
		case "oauth":
			return "oauth";
		default:
			return "card";
	}
}
