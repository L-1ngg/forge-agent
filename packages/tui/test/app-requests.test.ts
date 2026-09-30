import { request, type SessionEvent } from "@forge-agent/protocol";
import { expect, test } from "bun:test";
import { scriptedTurn } from "../../../tests/support/turn.ts";
import { frameToText, type AppPort } from "../src/index.ts";

import { nextTurn, waitFor } from "../../../tests/support/control.ts";
import { createApp, FakeBus } from "./helpers/app.ts";

test("question subinput Escape leaves text before parking and browsing cannot answer it", async () => {
	const { app, input, bus } = createApp();
	const send = (text: string) => input.emit(Buffer.from(text));
	await app.start();
	try {
		bus.push(request("free", "question", { prompt: "Choose a name", allowFreeText: true }));
		await waitFor(() => frameToText(app.composeFrameForTest()).includes("Choose a name"), "() => frameToText(app.composeFrameForTest()).includes(\"Choose a name\")");
		send("draft answer\x1b"); await Bun.sleep(35); // Host's bare-Escape ambiguity timer.
		expect(frameToText(app.composeFrameForTest())).not.toContain("parked");
		send("\x1b"); await Bun.sleep(35);
		expect(frameToText(app.composeFrameForTest())).toContain("parked");
		send("\x1b[200~ignore\x1b[201~\x1b"); await Bun.sleep(35);
		expect(bus.responses).toHaveLength(0);
		send("i");
		expect(frameToText(app.composeFrameForTest())).toContain("draft answer");
		expect(frameToText(app.composeFrameForTest())).not.toContain("parked");
	} finally { await app.stop(); }
});

test("parking a request from the composer shows the keyboard-selected history entry", async () => {
	const { app, input, bus } = createApp({ history: [
		{ role: "assistant", timestamp: 1, content: [{ type: "text", text: "older message" }] },
		{ role: "assistant", timestamp: 2, content: [{ type: "text", text: "newer message" }] },
	] });
	await app.start();
	try {
		bus.push(request("permission", "permission", { toolCall: { type: "tool_call", id: "call", name: "bash", arguments: { command: "pwd" } } }));
		await waitFor(() => frameToText(app.composeFrameForTest()).includes("Permission: bash"), "() => frameToText(app.composeFrameForTest()).includes(\"Permission: bash\")");
		input.emit(Buffer.from("\x1b")); await Bun.sleep(35);
		input.emit(Buffer.from("k"));
		expect(frameToText(app.composeFrameForTest())).toContain("> older message");
		expect(bus.responses).toHaveLength(0);
	} finally { await app.stop(); }
});

test("a permission card replaces the composer and only answers on an explicit action", async () => {
	const bus = new FakeBus();
	const { app, input } = createApp({ bus });
	await app.start();
	bus.push(request("r-1", "permission", { toolCall: { type: "tool_call", id: "t-1", name: "bash", arguments: { command: "ls" } } }));
	await waitFor(() => frameToText(app.composeFrameForTest()).includes("Permission: bash"), "() => frameToText(app.composeFrameForTest()).includes(\"Permission: bash\")");
	const withCard = frameToText(app.composeFrameForTest());
	expect(withCard).toContain("Yes, proceed");
	expect(withCard).not.toContain("╭"); // composer is not painted in the same slot
	expect(bus.responses).toEqual([]);
	input.emit(Buffer.from("\r")); // Enter chooses the focused allow_once
	await waitFor(() => bus.responses.length === 1, "() => bus.responses.length === 1");
	expect(bus.responses[0]).toEqual({ type: "response", id: "r-1", result: { decision: "allow_once" } });
	expect(frameToText(app.composeFrameForTest())).toContain("╭"); // composer returns
	await app.stop();
});

test("AC-33: Esc parks a card without calling respond(); Tab resumes it", async () => {
	const bus = new FakeBus();
	const { app, input } = createApp({ bus });
	await app.start();
	bus.push(request("r-park", "permission", { toolCall: { type: "tool_call", id: "t-1", name: "bash", arguments: { command: "ls" } } }));
	await waitFor(() => frameToText(app.composeFrameForTest()).includes("Permission: bash"), "() => frameToText(app.composeFrameForTest()).includes(\"Permission: bash\")");
	input.emit(Buffer.from("\x1b"));
	await new Promise((resolve) => setTimeout(resolve, 30)); // escape delay
	expect(bus.responses).toEqual([]); // park must not answer
	expect(frameToText(app.composeFrameForTest())).toContain("Permission: bash"); // still painted
	expect(frameToText(app.composeFrameForTest())).toContain("permission"); // shortcuts show the return route
	input.emit(Buffer.from("\t"));
	await waitFor(() => frameToText(app.composeFrameForTest()).includes("esc"), "() => frameToText(app.composeFrameForTest()).includes(\"esc\")");
	input.emit(Buffer.from("2")); // digit chooses deny
	await waitFor(() => bus.responses.length === 1, "() => bus.responses.length === 1");
	expect(bus.responses[0]).toMatchObject({ id: "r-park", result: { decision: "deny" } });
	await app.stop();
});

test("a parked permission lets the host keep a draft without starting another turn", async () => {
	const bus = new FakeBus(), calls: string[] = [];
	let release: (() => void) | undefined;
	const { app, input } = createApp({ bus, port: { runTurn(value) {
		calls.push(String(value));
		return scriptedTurn((async function* () { yield { type: "agent_start" as const, timestamp: 1 }; await new Promise<void>(resolve => { release = resolve; }); })());
	}, abort() { release?.(); } } });
	await app.start();
	try {
		input.emit(Buffer.from("initial\r"));
		await waitFor(() => calls.length === 1, "() => calls.length === 1");
		bus.push(request("r-draft", "permission", { toolCall: { type: "tool_call", id: "t-1", name: "bash", arguments: { command: "pwd" } } }));
		await waitFor(() => frameToText(app.composeFrameForTest()).includes("Permission: bash"), "() => frameToText(app.composeFrameForTest()).includes(\"Permission: bash\")");
		input.emit(Buffer.from("\x1b")); await Bun.sleep(35);
		input.emit(Buffer.from("cqueued draft"));
		expect(frameToText(app.composeFrameForTest())).toContain("queued draft");
		expect(calls).toEqual(["initial"]);
		expect(bus.responses).toEqual([]);
		input.emit(Buffer.from("\t"));
		expect(frameToText(app.composeFrameForTest())).toContain("Permission: bash");
		input.emit(Buffer.from("2"));
		await waitFor(() => bus.responses.length === 1, "() => bus.responses.length === 1");
		expect(frameToText(app.composeFrameForTest())).toContain("queued draft");
	} finally { release?.(); await app.stop(); }
});

test("AC-34: parked Esc does not abort the turn", async () => {
	let aborted = 0;
	let release: (() => void) | undefined;
	const port: AppPort = {
		runTurn() { return scriptedTurn((async function* (): AsyncIterable<SessionEvent> {
			yield { type: "turn_start", timestamp: 1 };
			await new Promise<void>((resolve) => { release = resolve; });
		})()); },
		abort() {
			aborted++;
			release?.();
		},
	};
	const bus = new FakeBus();
	const { app, input } = createApp({ port, bus });
	await app.start();
	input.emit(Buffer.from("go"));
	input.emit(Buffer.from("\r"));
	await waitFor(() => release !== undefined, "() => release !== undefined");
	bus.push(request("r-esc", "question", { prompt: "pick one" }));
	await waitFor(() => frameToText(app.composeFrameForTest()).includes("Question"), "() => frameToText(app.composeFrameForTest()).includes(\"Question\")");
	input.emit(Buffer.from("\x1b"));
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(aborted).toBe(0);
	input.emit(Buffer.from("\x1b")); // parked: still no abort
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(aborted).toBe(0);
	expect(bus.responses).toEqual([]);
	await app.stop();
});

test("a late bus terminal archives the card without a second respond()", async () => {
	const bus = new FakeBus();
	const { app } = createApp({ bus });
	await app.start();
	bus.push(request("r-late", "oauth", { provider: "xai", authorizationUrl: "https://example.test" }));
	await waitFor(() => frameToText(app.composeFrameForTest()).includes("OAuth: xai"), "() => frameToText(app.composeFrameForTest()).includes(\"OAuth: xai\")");
	bus.pushTerminal({ status: "cancelled", requestId: "r-late", reason: "aborted" });
	await waitFor(() => frameToText(app.composeFrameForTest()).includes("cancelled"), "() => frameToText(app.composeFrameForTest()).includes(\"cancelled\")");
	expect(bus.responses).toEqual([]);
	expect(frameToText(app.composeFrameForTest())).toContain("╭");
	await app.stop();
});

test("welcome is painted on an empty transcript when requested", async () => {
	const { app } = createApp({ showWelcome: true });
	await app.start();
	expect(frameToText(app.composeFrameForTest())).toMatch(/[▀▄█]/);
	await app.stop();
});

test("a rejected card response cannot be archived as an authorization", async () => {
	const { app, input, bus } = createApp();
	bus.acceptResponses = false;
	await app.start();
	try {
		bus.push(request("late", "permission", { toolCall: { type: "tool_call", id: "t", name: "bash", arguments: { command: "ls" } } }));
		await waitFor(() => frameToText(app.composeFrameForTest()).includes("Permission: bash"), "() => frameToText(app.composeFrameForTest()).includes(\"Permission: bash\")");
		input.emit(Buffer.from("\r"));
		bus.pushTerminal({ status: "timeout", requestId: "late" });
		await nextTurn();
		const text = frameToText(app.composeFrameForTest());
		expect(text).toContain("timed out");
		expect(text).not.toContain("allow_once");
	} finally { await app.stop(); }
});

test("question cards accept a chosen option and free text without using the composer", async () => {
	const { app, input, bus } = createApp();
	await app.start();
	try {
		bus.push(request("choice", "question", { prompt: "Pick", choices: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] }));
		await waitFor(() => frameToText(app.composeFrameForTest()).includes("Question"), "() => frameToText(app.composeFrameForTest()).includes(\"Question\")");
		input.emit(Buffer.from("\t\r"));
		expect(bus.responses[0]?.result).toEqual({ decision: "answer", answers: ["b"] });
		bus.push(request("text", "question", { prompt: "Name", allowFreeText: true }));
		await waitFor(() => frameToText(app.composeFrameForTest()).includes("Name"), "() => frameToText(app.composeFrameForTest()).includes(\"Name\")");
		input.emit(Buffer.from("my answer\t\r"));
		expect(bus.responses[1]?.result).toEqual({ decision: "answer", answers: ["my answer"] });
	} finally { await app.stop(); }
});

test("question multiple selection records only the choices explicitly toggled", async () => {
	const { app, input, bus } = createApp();
	await app.start();
	try {
		bus.push(request("multi", "question", { prompt: "Pick", multiple: true, choices: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] }));
		await waitFor(() => frameToText(app.composeFrameForTest()).includes("Question"), "() => frameToText(app.composeFrameForTest()).includes(\"Question\")");
		input.emit(Buffer.from("\t \t\r"));
		expect(bus.responses[0]?.result).toEqual({ decision: "answer", answers: ["b"] });
	} finally { await app.stop(); }
});

test("permission body can be scrolled without hiding the selected action", async () => {
	const { app, input, bus } = createApp();
	await app.start();
	try {
		bus.push(request("long", "permission", { toolCall: { type: "tool_call", id: "t", name: "write", arguments: { path: "file", content: "line ".repeat(200) + "END_OF_CHANGE" } } }));
		await waitFor(() => frameToText(app.composeFrameForTest()).includes("Permission: write"), "() => frameToText(app.composeFrameForTest()).includes(\"Permission: write\")");
		for (let index = 0; index < 30; index++) input.emit(Buffer.from("\x1b[6~"));
		const text = frameToText(app.composeFrameForTest());
		expect(text).toContain("END_OF_CHANGE");
		expect(text).toContain("Yes, allow once");
	} finally { await app.stop(); }
});

test("a terminal arriving before its request cannot leave a blocking card", async () => {
	const { app, bus } = createApp();
	await app.start();
	try {
		bus.pushTerminal({ status: "timeout", requestId: "already-done" });
		await nextTurn();
		bus.push(request("already-done", "question", { prompt: "expired" }));
		await nextTurn();
		const text = frameToText(app.composeFrameForTest());
		expect(text).toContain("timed out");
		expect(text).toContain("╭");
		expect(bus.responses).toEqual([]);
	} finally { await app.stop(); }
});
