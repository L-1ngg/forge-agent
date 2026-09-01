import { isViewportTUI, ProcessTerminal, TuiAltScreen, TuiMainScreen, type Component, type Terminal, type TUI, type TuiAltScreenOptions } from "@earendil-works/pi-tui";

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
	private layoutRoot: Component | undefined;
	private started = false;

	constructor(options: TuiHostOptions = {}) {
		this.options = options;
		this._mode = options.mode ?? "main";
		this._screen = createTuiHost(options);
		this.trackViewportLayoutRoot(this._screen);
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

	/** Mount one logical root, using the viewport-specific root when available. */
	setLayoutRoot(component: Component | undefined): void {
		const previous = this.layoutRoot;
		this.layoutRoot = component;
		if (isViewportTUI(this._screen)) {
			this._screen.setLayoutRoot(component);
			return;
		}
		if (previous && previous !== component) this._screen.removeChild(previous);
		if (component && !this._screen.children.includes(component)) this._screen.addChild(component);
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
		this._screen.start();
		this.started = true;
	}

	stop(): void {
		try {
			this._screen.stop();
		} finally {
			this.started = false;
		}
	}

	switchMode(mode: TuiHostMode): void {
		if (mode === this._mode) return;
		const previous = this._screen;
		const root = this.layoutRoot;
		const next = createTuiHost({ ...this.options, mode, terminal: previous.terminal });
		this.trackViewportLayoutRoot(next);
		for (const child of previous.children) {
			if (child !== root) next.addChild(child);
		}
		if (isViewportTUI(next)) next.setLayoutRoot(root);
		else if (root) next.addChild(root);
		const focused = (previous as TUI & { getFocusedComponent?: () => Component | null }).getFocusedComponent?.() ?? null;
		next.setFocus(focused);
		if (this.started) {
			previous.stop({ preserveScreen: true });
			next.start();
		}
		this._mode = mode;
		this._screen = next;
	}

	private trackViewportLayoutRoot(screen: TUI): void {
		if (!isViewportTUI(screen)) return;
		const setLayoutRoot = screen.setLayoutRoot.bind(screen);
		screen.setLayoutRoot = (component) => {
			this.layoutRoot = component;
			setLayoutRoot(component);
		};
	}
}

export const TuiHost = TuiHostController;
