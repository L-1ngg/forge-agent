import { expect, test } from "bun:test";
import { request, type RequestEnvelopeUnion, type ResponseEnvelope } from "@myh/protocol";
import { App, type AppRequestBus } from "../src/index.ts";

class FakeInput {
	raw: boolean | undefined;
	private listeners: ((chunk: Buffer) => void)[] = [];
	setRawMode(raw: boolean): void {
		this.raw = raw;
	}
	on(_event: "data", listener: (chunk: Buffer) => void): void {
		this.listeners.push(listener);
	}
	off(_event: "data", listener: (chunk: Buffer) => void): void {
		this.listeners = this.listeners.filter((candidate) => candidate !== listener);
	}
	resume(): void {}
	pause(): void {}
	emit(chunk: Buffer): void {
		for (const listener of [...this.listeners]) listener(chunk);
	}
}

class FakeOutput {
	readonly chunks: string[] = [];
	write(text: string): void {
		this.chunks.push(text);
	}
	get text(): string {
		return this.chunks.join("");
	}
	count(needle: string): number {
		return this.chunks.filter((chunk) => chunk === needle).length;
	}
}

class FakeBus implements AppRequestBus {
	readonly responses: ResponseEnvelope[] = [];
	private readonly envelopes: RequestEnvelopeUnion[] = [];
	private notify: (() => void) | undefined;

	push(envelope: RequestEnvelopeUnion): void {
		this.envelopes.push(envelope);
		this.notify?.();
	}

	respond(value: unknown): boolean {
		this.responses.push(value as ResponseEnvelope);
		return true;
	}

	async *requests(): AsyncIterable<RequestEnvelopeUnion> {
		let index = 0;
		for (;;) {
			if (index < this.envelopes.length) {
				yield this.envelopes[index]!;
				index++;
			} else {
				await new Promise<void>((resolve) => {
					this.notify = resolve;
				});
			}
		}
	}
}

function createApp(bus: FakeBus = new FakeBus()) {
	const input = new FakeInput();
	const output = new FakeOutput();
	const app = new App({ port: {}, host: "alt", requestBus: bus, cwd: "/tmp", homeDir: "/tmp", stdin: input, stdout: output });
	return { app, input, output, bus };
}

test("start enters alt-screen and raw mode; Ctrl+C restores the terminal", async () => {
	const { app, input, output } = createApp();
	await app.start();
	expect(output.text).toContain("\x1b[?1049h");
	expect(input.raw).toBe(true);
	const stopped = app.waitUntilStopped();
	input.emit(Buffer.from([0x03]));
	await stopped;
	expect(input.raw).toBe(false);
	expect(output.text.endsWith("\x1b[?1049l")).toBe(true);
});

test("q quits and stop is idempotent", async () => {
	const { app, input, output } = createApp();
	await app.start();
	input.emit(Buffer.from("q"));
	await app.waitUntilStopped();
	await app.stop();
	expect(input.raw).toBe(false);
	expect(output.count("\x1b[?1049l")).toBe(1);
});

test("permission request gets the conservative deny while no request UI exists", async () => {
	const { app, bus } = createApp();
	await app.start();
	bus.push(request("r-1", "permission", { toolCall: { type: "tool_call", id: "t-1", name: "bash", arguments: { command: "ls" } } }));
	await waitFor(() => bus.responses.length === 1);
	expect(bus.responses[0]).toEqual({
		type: "response",
		id: "r-1",
		result: { decision: "deny", reason: "interactive request UI is being rebuilt (phase 2.2 B0-B3)" },
	});
	await app.stop();
});

test("question request gets the conservative cancel while no request UI exists", async () => {
	const { app, bus } = createApp();
	await app.start();
	bus.push(request("r-2", "question", { prompt: "pick one" }));
	await waitFor(() => bus.responses.length === 1);
	expect(bus.responses[0]).toEqual({ type: "response", id: "r-2", result: { decision: "cancel" } });
	await app.stop();
});

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition not met in time");
}
