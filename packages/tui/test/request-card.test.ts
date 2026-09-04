import { expect, test } from "bun:test";
import { block, type RequestEnvelopeFor, type RequestEnvelopeUnion, type RequestKind, type RequestOutcome, type ResponseEnvelope } from "@myh/protocol";
import { stripTerminalSequences, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { App, RequestCard, createSemanticTheme, frameFromLines, responseForRequestAction } from "../src/index.ts";

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

test("Esc parks only the top card and leaves the request pending", async () => {
	const terminal = new FakeTerminal();
	const bus = new TestRequestBus();
	const app = new App({ terminal, port: idlePort(), requestBus: bus });
	await app.start();
	bus.push(permissionRequest("first"));
	bus.push(permissionRequest("second"));
	await Bun.sleep(0);

	terminal.send("\u001b");
	expect(app.focusStack.top()?.id).toBe("first");
	expect(app.focusStack.getScrollback().map((card) => [card.id, (card as { state?: string }).state])).toEqual([["second", "parked"]]);
	expect(bus.responses).toEqual([]);
	expect(app.tui.render(80).join("\n")).toContain("Permission: write");
	await app.stop();
});

test("Esc parks a blocking card without responding and Tab resumes it", async () => {
	const terminal = new FakeTerminal();
	const bus = new TestRequestBus();
	const app = new App({ terminal, port: idlePort(), requestBus: bus });
	await app.start();
	bus.push(permissionRequest("esc"));
	await Bun.sleep(0);

	terminal.send("\u001b");
	expect(bus.responses).toEqual([]);
	expect(app.focusStack.getScrollback().map((card) => [card.id, (card as { state?: string }).state])).toEqual([["esc", "parked"]]);
	expect(app.tui.render(80).join("\n")).not.toContain("(parked)");
	terminal.send("\t");
	expect(app.focusStack.top()?.id).toBe("esc");
	expect(app.focusStack.getScrollback()).toEqual([]);
	expect(bus.responses).toEqual([]);
	await app.stop();
});

test("parked card owns the key route until it is resumed", async () => {
	const terminal = new FakeTerminal();
	const bus = new TestRequestBus();
	let submitted = false;
	const app = new App({ terminal, port: { ...idlePort(), followUp() {}, steer() {}, abort() {}, runTurn: async function* () { submitted = true; } }, requestBus: bus });
	await app.start();
	bus.push(permissionRequest("parked-owner"));
	await Bun.sleep(0);
	terminal.send("\u001b");
	terminal.send("\r");
	expect(submitted).toBe(false);
	expect(bus.responses).toEqual([]);
	terminal.send(" ");
	expect(app.focusStack.top()?.id).toBe("parked-owner");
	await app.stop();
});

test("parked card leaves scrollback navigation and fold controls reachable", async () => {
	const terminal = new FakeTerminal();
	const bus = new TestRequestBus();
	const app = new App({ terminal, port: idlePort(), requestBus: bus });
	app.renderer.apply({
		type: "tool_execution_end",
		timestamp: 1,
		toolCallId: "parked-fold",
		toolName: "bash",
		content: "done",
		isError: false,
		block: block({ id: "parked-fold", kind: "execute", lifecycle: "complete" }, { command: "run", stdout: "one\ntwo" }, { defaultDisplayMode: "expanded" }),
	});
	let moved = 0;
	const originalScroll = app.transcript.scrollLines.bind(app.transcript);
	(app.transcript as unknown as { scrollLines: (lines: number) => void }).scrollLines = (lines) => {
		moved += lines;
		originalScroll(lines);
	};
	await app.start();
	bus.push(permissionRequest("parked-navigation"));
	await Bun.sleep(0);
	terminal.send("\u001b");

	terminal.send("\u001b[5~");
	expect(moved).toBeLessThan(0);
	terminal.send("\u000f");
	expect(app.renderer.getRichBlocks().find((value) => value.id === "parked-fold")).toMatchObject({ manualOverride: true, currentDisplayMode: "collapsed" });
	terminal.send("hello");
	terminal.send("\r");
	expect(bus.responses).toEqual([]);
	await app.stop();
});

test("a terminal outcome retires a parked card", async () => {
	const terminal = new FakeTerminal();
	const bus = new TestRequestBus();
	const app = new App({ terminal, port: idlePort(), requestBus: bus });
	await app.start();
	bus.push(permissionRequest("parked-timeout"));
	await Bun.sleep(0);
	terminal.send("\u001b");

	bus.pushTerminal({ status: "timeout", requestId: "parked-timeout" });
	await Bun.sleep(0);
	expect(app.focusStack.hasParked).toBe(false);
	expect(app.focusStack.getScrollback().map((card) => [card.id, (card as { state?: string }).state])).toEqual([["parked-timeout", "dismissed"]]);
	expect(app.tui.render(80).join("\n")).toContain("timed out");
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
	expect(app.tui.render(80).join("\n")).toContain("timed out");
	await app.stop();
});

test("completed cards leave the fixed blocking region but remain in the transcript", async () => {
	const terminal = new FakeTerminal();
	const bus = new TestRequestBus();
	const app = new App({ terminal, port: idlePort(), requestBus: bus });
	await app.start();

	bus.push(permissionRequest("archive"));
	await Bun.sleep(0);
	terminal.send("\r");
	await Bun.sleep(0);

	const internal = app as unknown as { blockingCards: { children: unknown[] } };
	expect(internal.blockingCards.children).toHaveLength(0);
	expect(app.tui.render(120).join("\n")).toContain("Permission: write file.ts — allow_once");
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
	expect(app.tui.render(80).join("\n")).toContain("cancelled");
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

	expect(stripTerminalSequences(app.tui.render(80).join("\n"))).toContain("1 (●) Yes, allow once");
	terminal.send("\t");
	expect(app.focusStack.focusIndex).toBe(1);
	expect(stripTerminalSequences(app.tui.render(80).join("\n"))).toContain("2 (●) No, reject");
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

test("permission card renders the exact tool arguments before asking for approval", () => {
	const request: RequestEnvelopeFor<"permission"> = {
		type: "request",
		id: "dangerous-visible",
		kind: "permission",
		payload: {
			toolCall: { type: "tool_call", id: "call-dangerous-visible", name: "bash", arguments: { command: "rm -rf ./tmp" } },
			reason: "This command can delete data",
		},
	};

	const rendered = new RequestCard(request).render(120).join("\n");
	expect(rendered).toContain("bash rm -rf ./tmp");
	expect(rendered).toContain("This command can delete data");
});

test("themed request cards paint a stable rail, inset, and full-width surface on every row", () => {
	const theme = createSemanticTheme();
	const card = new RequestCard(permissionRequest("cell-geometry"), theme);
	card.focused = true;
	const lines = card.render(40);
	const frame = frameFromLines(lines, 40, lines.length);
	for (const [rowIndex, line] of lines.entries()) {
		expect(visibleWidth(stripTerminalSequences(line))).toBe(40);
		expect(frame.cells[rowIndex]?.[0]?.grapheme).toBe("┃");
		expect(frame.cells[rowIndex]?.[0]?.background).toMatchObject({ kind: "rgb" });
		expect([36, 54]).toContain(frame.cells[rowIndex]?.[0]?.background && "r" in frame.cells[rowIndex][0]!.background ? frame.cells[rowIndex][0]!.background.r : -1);
	}
	expect(stripTerminalSequences(lines[1] ?? "").indexOf("Permission")).toBe(3);
});

test("request-card action selection changes only the action surface color", () => {
	const theme = createSemanticTheme();
	const card = new RequestCard(permissionRequest("cell-selection"), theme);
	card.focused = true;
	const first = frameFromLines(card.render(40), 40, card.render(40).length);
	card.setFocusIndex(1);
	const second = frameFromLines(card.render(40), 40, card.render(40).length);
	const isFocusedRow = (row: typeof first.cells[number] | undefined): boolean => row?.[0]?.background?.kind === "rgb" && "r" in row[0].background && row[0].background.r === 54;
	const firstAction = first.cells.findIndex(isFocusedRow);
	const secondAction = second.cells.findIndex(isFocusedRow);
	expect(firstAction).toBeGreaterThanOrEqual(0);
	expect(secondAction).toBeGreaterThan(firstAction);
	for (const index of [0, 1, 2, 3]) expect(first.cells[index]).toEqual(second.cells[index]);
});

test("height-aware request cards keep title and action tail without changing row geometry", () => {
	const card = new RequestCard(permissionRequest("height-geometry"), createSemanticTheme());
	for (const height of [1, 2, 3, 4, 8, 12]) {
		const lines = card.renderForHeight(40, height);
		expect(lines).toHaveLength(Math.min(height, card.render(40).length));
		for (const line of lines) expect(visibleWidth(stripTerminalSequences(line))).toBe(40);
		if (height >= 2) expect(lines.some((line) => stripTerminalSequences(line).includes("Permission"))).toBe(true);
		if (height >= 1) expect(stripTerminalSequences(lines.at(-1) ?? "")).toMatch(/\d\s/);
	}
});

test("App renders owner-derived shortcuts for active and parked cards", async () => {
	const bus = new TestRequestBus();
	const app = new App({ terminal: new FakeTerminal(), port: idlePort(), requestBus: bus });
	await app.start();
	bus.push(permissionRequest("shortcuts"));
	await Bun.sleep(0);

	const active = app.tui.render(120).join("\n");
	expect(active).toContain("Tab");
	expect(active).toContain("choose");
	expect(active).toContain("Esc");
	expect(active).toContain("scrollback");
	(app.terminal as FakeTerminal).send("\u001b");
	const parked = app.tui.render(120).join("\n");
	expect(parked).toContain("Tab/Space");
	expect(parked).toContain("permission");
	await app.stop();
});

test("all request kinds remain actionable and respond once at short terminal heights", async () => {
	for (const rows of [8, 12, 16]) {
		for (const { request, parkedLabel } of requestFixtures()) {
			const terminal = new FakeTerminal(40, rows);
			const bus = new TestRequestBus();
			const app = new App({ terminal, port: idlePort(), requestBus: bus });
			app.editor.setText("hidden composer draft");
			await app.start();
			bus.push(request);
			await Bun.sleep(0);

			const focused = app.tui.render(40).join("\n");
			expect(focused).toContain("1 ");
			expect(focused).toContain("Esc");
			expect(focused).toContain("scrollback");
			expect(focused).not.toContain("hidden composer draft");

			terminal.send("\u001b");
			const parked = app.tui.render(40).join("\n");
			expect(bus.responses).toHaveLength(0);
			expect(parked).toContain("1 ");
			expect(parked).toContain("Tab/Space");
			expect(parked).toContain(parkedLabel);
			terminal.send("\r");
			expect(bus.responses).toHaveLength(0);

			terminal.send("\t");
			terminal.send("\r");
			terminal.send("\r");
			expect(bus.responses).toHaveLength(1);
			expect(bus.responses[0]?.id).toBe(request.id);
			await app.stop();
		}
	}
}, 20_000);

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

function requestFixtures(): Array<{ request: RequestEnvelopeUnion; parkedLabel: string }> {
	const detail = "detail one\ndetail two\ndetail three\ndetail four\ndetail five\ndetail six";
	return [
		{
			request: { ...permissionRequest("short-permission"), payload: { ...permissionRequest("short-permission").payload, reason: detail } },
			parkedLabel: "permission",
		},
		{
			request: { type: "request", id: "short-question", kind: "question", payload: { prompt: `Choose one\n${detail}`, choices: [{ id: "one", label: "One" }] } },
			parkedLabel: "question",
		},
		{
			request: { type: "request", id: "short-cancel", kind: "cancel_confirm", payload: { action: "cancel current turn", consequence: detail } },
			parkedLabel: "cancel turn",
		},
		{
			request: { type: "request", id: "short-plan", kind: "plan_approval", payload: { plan: detail } },
			parkedLabel: "plan approval",
		},
		{
			request: { type: "request", id: "short-oauth", kind: "oauth", payload: { provider: "GitHub", authorizationUrl: "https://example.test/oauth", instructions: detail } },
			parkedLabel: "oauth",
		},
	];
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

	push(request: RequestEnvelopeUnion): void {
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

class AsyncRequestQueue implements AsyncIterable<RequestEnvelopeUnion>, AsyncIterator<RequestEnvelopeUnion> {
	private readonly values: RequestEnvelopeUnion[] = [];
	private readonly waiters: Array<(result: IteratorResult<RequestEnvelopeUnion>) => void> = [];
	private closed = false;

	push(value: RequestEnvelopeUnion): void {
		const waiter = this.waiters.shift();
		if (waiter) waiter({ value, done: false });
		else this.values.push(value);
	}

	close(): void {
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
	}

	next(): Promise<IteratorResult<RequestEnvelopeUnion>> {
		const value = this.values.shift();
		if (value) return Promise.resolve({ value, done: false });
		if (this.closed) return Promise.resolve({ value: undefined, done: true });
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	[Symbol.asyncIterator](): AsyncIterator<RequestEnvelopeUnion> {
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
	constructor(public columns = 80, public rows = 24) {}
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
