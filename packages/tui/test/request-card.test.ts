import { expect, test } from "bun:test";
import type { RequestEnvelopeFor, RequestKind, RequestOutcome, ResponseEnvelope } from "@myh/protocol";
import type { Terminal } from "@earendil-works/pi-tui";
import { App, RequestCard, responseForRequestAction } from "../src/index.ts";

test("App consumes a blocking request and returns the focused card response", async () => {
	const terminal = new FakeTerminal();
	const bus = new TestRequestBus();
	const app = new App({ terminal, port: idlePort(), requestBus: bus });
	await app.start();

	bus.push(permissionRequest("permission-1"));
	await Bun.sleep(0);
	expect(app.focusStack.top()?.id).toBe("permission-1");
	expect(app.tui.render(80).join("\n")).toContain("Permission: write");

	terminal.send("\r");
	expect(bus.responses).toEqual([
		{ type: "response", id: "permission-1", result: { decision: "allow_once" } },
	]);
	expect(app.focusStack.size).toBe(0);
	await app.stop();
});

test("Esc dismisses only the top card and leaves it in readable scrollback", async () => {
	const terminal = new FakeTerminal();
	const bus = new TestRequestBus();
	const app = new App({ terminal, port: idlePort(), requestBus: bus });
	await app.start();
	bus.push(permissionRequest("first"));
	bus.push(permissionRequest("second"));
	await Bun.sleep(0);

	terminal.send("\u001b");
	expect(app.focusStack.top()?.id).toBe("first");
	expect(app.focusStack.getScrollback().map((card) => [card.id, (card as { state?: string }).state])).toEqual([["second", "dismissed"]]);
	expect(app.tui.render(80).join("\n")).toContain("Permission: write");
	await app.stop();
});

test("Esc resolves a blocking card with a conservative terminal response", async () => {
	const terminal = new FakeTerminal();
	const bus = new TestRequestBus();
	const app = new App({ terminal, port: idlePort(), requestBus: bus });
	await app.start();
	bus.push(permissionRequest("esc"));
	await Bun.sleep(0);

	terminal.send("\u001b");
	expect(bus.responses).toEqual([{ type: "response", id: "esc", result: { decision: "deny", reason: "Dismissed by user" } }]);
	expect(app.focusStack.getScrollback().map((card) => [card.id, (card as { state?: string }).state])).toEqual([["esc", "dismissed"]]);
	await app.stop();
});

test("a bus timeout retires the card and restores editor focus", async () => {
	const terminal = new FakeTerminal();
	const bus = new TestRequestBus();
	const app = new App({ terminal, port: idlePort(), requestBus: bus });
	await app.start();
	bus.push(permissionRequest("timeout"));
	await Bun.sleep(0);

	bus.pushTerminal({ status: "timeout", requestId: "timeout" });
	await Bun.sleep(0);
	expect(app.focusStack.size).toBe(0);
	expect(app.focusStack.getScrollback().map((card) => [card.id, (card as { state?: string }).state])).toEqual([["timeout", "dismissed"]]);
	expect(app.editor.focused).toBe(true);
	expect(app.tui.render(80).join("\n")).toContain("Status: timeout");
	await app.stop();
});

test("a terminal received before its request is replayed when the card arrives", async () => {
	const terminal = new FakeTerminal();
	const bus = new TestRequestBus();
	const app = new App({ terminal, port: idlePort(), requestBus: bus });
	await app.start();

	bus.pushTerminal({ status: "cancelled", requestId: "early", reason: "aborted" });
	await Bun.sleep(0);
	bus.push(permissionRequest("early"));
	await Bun.sleep(0);

	expect(app.focusStack.size).toBe(0);
	expect(app.focusStack.getScrollback().map((card) => [card.id, (card as { state?: string }).state])).toEqual([["early", "dismissed"]]);
	expect(app.editor.focused).toBe(true);
	expect(app.tui.render(80).join("\n")).toContain("Status: cancelled");
	await app.stop();
});

test("a response delivered through the terminal stream resolves the card", async () => {
	const terminal = new FakeTerminal();
	const bus = new TestRequestBus();
	const app = new App({ terminal, port: idlePort(), requestBus: bus });
	await app.start();

	bus.pushTerminal({ status: "response", requestId: "external", result: { decision: "allow_once" } });
	bus.push(permissionRequest("external"));
	await Bun.sleep(0);

	expect(app.focusStack.getScrollback().map((card) => [card.id, (card as { state?: string }).state])).toEqual([["external", "resolved"]]);
	await app.stop();
});

test("Enter resolves the focused action without advancing the card selection", async () => {
	const terminal = new FakeTerminal();
	const bus = new TestRequestBus();
	const app = new App({ terminal, port: idlePort(), requestBus: bus });
	await app.start();
	bus.push(permissionRequest("selected"));
	await Bun.sleep(0);

	expect(app.tui.render(80).join("\n")).toContain("> 1. allow_once");
	terminal.send("\t");
	expect(app.focusStack.focusIndex).toBe(1);
	expect(app.tui.render(80).join("\n")).toContain("> 2. deny");
	terminal.send("\r");
	expect(bus.responses).toEqual([{ type: "response", id: "selected", result: { decision: "deny", reason: "Denied by user" } }]);
	await app.stop();
});

test("App stop does not wait forever for a request stream without close", async () => {
	const terminal = new FakeTerminal();
	const bus = new EndlessRequestBus();
	const app = new App({ terminal, port: idlePort(), requestBus: bus });
	await app.start();
	await Bun.sleep(0);

	await app.stop();
	expect(bus.returned).toBe(true);
	await app.waitUntilStopped();
});

test("App completes stop when closing the request stream rejects its pending read", async () => {
	const terminal = new FakeTerminal();
	const bus = new RejectingCloseRequestBus();
	const app = new App({ terminal, port: idlePort(), requestBus: bus });
	await app.start();
	await Bun.sleep(0);

	await app.stop();
	await app.waitUntilStopped();
});

test("App settles waitUntilStopped when TUI teardown throws", async () => {
	const app = new App({ terminal: new FakeTerminal(), port: idlePort() });
	const failure = new Error("tui teardown failed");
	(app.tui as unknown as { stop: () => void }).stop = () => {
		throw failure;
	};

	let caught: unknown;
	try {
		await app.stop();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBe(failure);
	await app.waitUntilStopped();
});

test("App settles waitUntilStopped when request bus teardown throws", async () => {
	const bus = new TestRequestBus();
	const failure = new Error("bus teardown failed");
	bus.close = () => {
		throw failure;
	};
	const app = new App({ terminal: new FakeTerminal(), port: idlePort(), requestBus: bus });

	let caught: unknown;
	try {
		await app.stop();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBe(failure);
	await app.waitUntilStopped();
});

test("question response selects one choice unless multiple is enabled", () => {
	const base: RequestEnvelopeFor<"question"> = {
		type: "request",
		id: "question",
		kind: "question",
		payload: {
			prompt: "Pick",
			choices: [
				{ id: "one", label: "One" },
				{ id: "two", label: "Two" },
			],
		},
	};
	expect(responseForRequestAction(base, "confirm")?.result).toEqual({ decision: "answer", answers: ["one"] });
	expect(responseForRequestAction({ ...base, payload: { ...base.payload, multiple: true } }, "confirm")?.result).toEqual({
		decision: "answer",
		answers: ["one", "two"],
	});
});

test("request cards reject actions belonging to another request kind", () => {
	const request = permissionRequest("strict-action");
	expect(responseForRequestAction(request, "confirm")).toBeUndefined();
});

test("permission card offers Always allow only when the request carries a remember rule", () => {
	const withoutRule = new RequestCard(permissionRequest("without"));
	const withRule = new RequestCard({
		...permissionRequest("with"),
		payload: { ...permissionRequest("with").payload, rememberRule: 'write {"path":"file.ts"}' },
	});
	expect(withoutRule.record.focusableCount).toBe(2);
	expect(withRule.record.focusableCount).toBe(3);
	expect(withRule.responseFor("allow_always")?.result).toEqual({
		decision: "allow_always",
		scope: { tool: "write", argsPattern: '{"content":"value","path":"file.ts"}' },
	});
});

function permissionRequest(id: string): RequestEnvelopeFor<"permission"> {
	return {
		type: "request",
		id,
		kind: "permission",
		payload: {
			toolCall: { type: "tool_call", id: `call-${id}`, name: "write", arguments: { path: "file.ts", content: "value" } },
		},
	};
}

function idlePort() {
	return {
		async *runTurn() {},
		steer() {},
		followUp() {},
		abort() {},
	};
}

class TestRequestBus {
	readonly responses: ResponseEnvelope[] = [];
	private readonly queue = new AsyncRequestQueue();
	private readonly terminalQueue = new AsyncTerminalQueue();

	requests() {
		return this.queue;
	}

	push(request: RequestEnvelopeFor<"permission">): void {
		this.queue.push(request);
	}

	respond(response: ResponseEnvelope): boolean {
		this.responses.push(response);
		return true;
	}

	terminals() {
		return this.terminalQueue;
	}

	pushTerminal(outcome: RequestOutcome<RequestKind>): void {
		this.terminalQueue.push(outcome);
	}

	close(): void {
		this.queue.close();
		this.terminalQueue.close();
	}
}

class EndlessRequestBus {
	returned = false;

	requests(): AsyncIterable<RequestEnvelopeFor<"permission">> {
		return {
			[Symbol.asyncIterator]: () => ({
				next: () => new Promise(() => undefined),
				return: async () => {
					this.returned = true;
					return { value: undefined, done: true };
				},
			}),
		};
	}

	respond(): boolean {
		return true;
	}
}

class RejectingCloseRequestBus {
	private rejectPending?: (error: Error) => void;

	requests(): AsyncIterable<RequestEnvelopeFor<"permission">> {
		return {
			[Symbol.asyncIterator]: () => ({
				next: () => new Promise((_, reject) => {
					this.rejectPending = reject;
				}),
			}),
		};
	}

	respond(): boolean {
		return true;
	}

	close(): void {
		this.rejectPending?.(new Error("request stream closed with an error"));
	}
}

class AsyncRequestQueue implements AsyncIterable<RequestEnvelopeFor<"permission">>, AsyncIterator<RequestEnvelopeFor<"permission">> {
	private readonly values: RequestEnvelopeFor<"permission">[] = [];
	private readonly waiters: Array<(result: IteratorResult<RequestEnvelopeFor<"permission">>) => void> = [];
	private closed = false;

	push(value: RequestEnvelopeFor<"permission">): void {
		const waiter = this.waiters.shift();
		if (waiter) waiter({ value, done: false });
		else this.values.push(value);
	}

	close(): void {
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
	}

	next(): Promise<IteratorResult<RequestEnvelopeFor<"permission">>> {
		const value = this.values.shift();
		if (value) return Promise.resolve({ value, done: false });
		if (this.closed) return Promise.resolve({ value: undefined, done: true });
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	[Symbol.asyncIterator](): AsyncIterator<RequestEnvelopeFor<"permission">> {
		return this;
	}
}

class AsyncTerminalQueue implements AsyncIterable<RequestOutcome<RequestKind>>, AsyncIterator<RequestOutcome<RequestKind>> {
	private readonly values: RequestOutcome<RequestKind>[] = [];
	private readonly waiters: Array<(result: IteratorResult<RequestOutcome<RequestKind>>) => void> = [];
	private closed = false;

	push(value: RequestOutcome<RequestKind>): void {
		const waiter = this.waiters.shift();
		if (waiter) waiter({ value, done: false });
		else this.values.push(value);
	}

	close(): void {
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
	}

	next(): Promise<IteratorResult<RequestOutcome<RequestKind>>> {
		const value = this.values.shift();
		if (value) return Promise.resolve({ value, done: false });
		if (this.closed) return Promise.resolve({ value: undefined, done: true });
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	[Symbol.asyncIterator](): AsyncIterator<RequestOutcome<RequestKind>> {
		return this;
	}
}

class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	private input?: (data: string) => void;

	start(onInput: (data: string) => void): void {
		this.input = onInput;
	}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	send(data: string): void {
		this.input?.(data);
	}
}
