import { ProcessTerminal, TuiAltScreen, TuiMainScreen, type Component, type Terminal, type TUI, type TuiAltScreenOptions } from "@earendil-works/pi-tui";

export type TuiHostMode = "main" | "alt";

export interface TuiHostOptions {
	terminal?: Terminal;
	mode?: TuiHostMode;
	altScreen?: TuiAltScreenOptions;
}

/** Construct the selected host without changing the component contract. */
export function createTuiHost(options: TuiHostOptions = {}): TUI {
	const terminal = options.terminal ?? new ProcessTerminal();
	return options.mode === "alt" ? new TuiAltScreen(terminal, undefined, undefined, options.altScreen) : new TuiMainScreen(terminal);
}

export const createHost = createTuiHost;

/**
 * Owns the host selection while keeping mounted components in one place.
 * Switching before start is synchronous; switching a running host preserves
 * the component tree and asks the new host to take over the terminal.
 */
export class TuiHostController {
	private _mode: TuiHostMode;
	private _screen: TUI;
	private readonly options: TuiHostOptions;
	private started = false;

	constructor(options: TuiHostOptions = {}) {
		this.options = options;
		this._mode = options.mode ?? "main";
		this._screen = createTuiHost(options);
	}

	get mode(): TuiHostMode {
		return this._mode;
	}

	get screen(): TUI {
		return this._screen;
	}

	get terminal(): Terminal {
		return this._screen.terminal;
	}

	get children(): Component[] {
		return this._screen.children;
	}

	mount(component: Component): void {
		this._screen.addChild(component);
	}

	setFocus(component: Component | null): void {
		this._screen.setFocus(component);
	}

	addInputListener(listener: Parameters<TUI["addInputListener"]>[0]): () => void {
		return this._screen.addInputListener(listener);
	}

	requestRender(force = false): void {
		this._screen.requestRender(force);
	}

	start(): void {
		this.started = true;
		this._screen.start();
	}

	stop(): void {
		this._screen.stop();
		this.started = false;
	}

	switchMode(mode: TuiHostMode): void {
		if (mode === this._mode) return;
		const previous = this._screen;
		const next = createTuiHost({ ...this.options, mode, terminal: previous.terminal });
		for (const child of previous.children) next.addChild(child);
		const focused = (previous as TUI & { getFocusedComponent?: () => Component | null }).getFocusedComponent?.() ?? null;
		next.setFocus(focused);
		if (this.started) {
			previous.stop({ preserveScreen: true });
			next.start();
		}
		this._mode = mode;
		this._screen = next;
	}
}

export const TuiHost = TuiHostController;
