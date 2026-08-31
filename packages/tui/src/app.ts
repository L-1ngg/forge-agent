import type { SessionEvent } from "@myh/protocol";
import { ProcessTerminal, TuiMainScreen, type Component, type Terminal } from "@earendil-works/pi-tui";
import { createEditor } from "./editor.ts";
import { StreamRenderer } from "./stream-renderer.ts";

export interface AppOptions {
	port: TuiAgentPort;
	terminal?: Terminal;
}

export interface TuiAgentPort {
	runTurn(input: string): AsyncIterable<SessionEvent>;
	steer(input: string): void;
	followUp(input: string): void;
	abort(): void;
}

export class App {
	readonly terminal: Terminal;
	readonly tui: TuiMainScreen;
	readonly renderer: StreamRenderer;
	readonly editor: ReturnType<typeof createEditor>;
	private running = false;
	private stopped = false;
	private readonly stoppedPromise: Promise<void>;
	private resolveStopped!: () => void;

	constructor(private readonly options: AppOptions) {
		this.stoppedPromise = new Promise((resolve) => {
			this.resolveStopped = resolve;
		});
		this.terminal = options.terminal ?? new ProcessTerminal();
		this.tui = new TuiMainScreen(this.terminal);
		this.renderer = new StreamRenderer();
		this.editor = createEditor(this.tui, (text) => void this.submit(text));
		this.tui.addChild(new AppLayout(this.renderer, this.editor));
		this.tui.setFocus(this.editor);
		this.tui.addInputListener((data) => {
			if (data === "\u001b") {
				if (this.running) this.options.port.abort();
				return { consume: true };
			}
			if (data === "\u0003") {
				if (this.running) this.options.port.abort();
				else void this.stop();
				return { consume: true };
			}
			return undefined;
		});
	}

	async start(): Promise<void> {
		this.tui.start();
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.tui.stop();
		this.resolveStopped();
	}

	waitUntilStopped(): Promise<void> {
		return this.stoppedPromise;
	}

	private async submit(text: string): Promise<void> {
		const input = text.trim();
		if (!input) return;
		if (this.running) {
			this.options.port.followUp(input);
			return;
		}
		this.running = true;
		try {
			for await (const event of this.options.port.runTurn(input)) this.apply(event);
		} finally {
			this.running = false;
		}
	}

	private apply(event: SessionEvent): void {
		this.renderer.apply(event);
		this.tui.requestRender();
	}
}

class AppLayout implements Component {
	constructor(private readonly renderer: StreamRenderer, private readonly editor: Component) {}

	render(width: number): string[] {
		return [...this.renderer.render(width), ...this.editor.render(width)];
	}

	handleInput(data: string): void {
		this.editor.handleInput?.(data);
	}

	invalidate(): void {
		this.renderer.invalidate();
		this.editor.invalidate();
	}
}
