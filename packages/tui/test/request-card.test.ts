import { expect, test } from "bun:test";
import type { RequestEnvelopeFor, ResponseEnvelope } from "@myh/protocol";
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

test("Enter resolves the focused action without advancing the card selection", async () => {
	const terminal = new FakeTerminal();
	const bus = new TestRequestBus();
	const app = new App({ terminal, port: idlePort(), requestBus: bus });
	await app.start();
	bus.push(permissionRequest("selected"));
	await Bun.sleep(0);

	terminal.send("\t");
	expect(app.focusStack.focusIndex).toBe(1);
	terminal.send("\r");
	expect(bus.responses).toEqual([{ type: "response", id: "selected", result: { decision: "deny", reason: "Denied by user" } }]);
	await app.stop();
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

	close(): void {
		this.queue.close();
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
