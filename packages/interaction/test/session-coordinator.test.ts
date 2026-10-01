import { expect, test } from "bun:test";
import { request, type SessionEvent } from "@forge-agent/protocol";
import { barrier, bounded, nextTurn, waitFor } from "../../../tests/support/control.ts";
import { scriptedTurn } from "../../../tests/support/turn.ts";
import { SessionCoordinator, type InteractionEvent, type InteractionHost, type InteractionPort, type InteractionRequestBus, type SessionView } from "../src/index.ts";

function bus(): InteractionRequestBus {
	return { async *requests() {}, async *terminals() {}, respond: () => false, close() {} };
}
function view(id: string): SessionView<InteractionPort & { label: string }> {
	return { id, history: [], hasHistory: () => true, requestBus: bus(), port: { label: id, runTurn: () => scriptedTurn((async function* () {})()) } };
}
function host(initial = view("A")): InteractionHost<typeof initial.port> {
	let current = initial;
	return { get current() { return current; }, list: async () => ({ sessions: [], diagnostics: [] }), async switchTo(id, beforeRelease) { const target = view(id ?? "B"); await beforeRelease?.(); current = target; return target; }, async dispose() { current.requestBus.close(); } };
}

test("a terminal-free data consumer submits, stops, switches and reads stable snapshots", async () => {
	const sessions = host(), calls: string[] = [], gate = barrier("authoritative result");
	sessions.current.port.runTurn = input => { calls.push(String(input)); return scriptedTurn((async function* (): AsyncIterable<SessionEvent> { yield { type: "message_start", timestamp: 1, message: { role: "user", content: [{ type: "text", text: String(input) }], timestamp: 1 } }; })(), gate.wait().then(() => ({ status: "success" as const }))); };
	let aborts = 0; sessions.current.port.abort = () => { aborts++; };
	const coordinator = new SessionCoordinator({ port: sessions.current.port, requestBus: sessions.current.requestBus, sessions });
	const events: InteractionEvent[] = []; coordinator.subscribe(event => events.push(event)); coordinator.start();
	try {
		coordinator.submit("first"); coordinator.submit("queued");
		expect(coordinator.snapshot().inputLabels).toEqual(["Queued 1: queued"]);
		const snapshot = coordinator.snapshot();
		expect(Reflect.set(snapshot.inputLabels, "0", "tampered")).toBe(false);
		expect(coordinator.snapshot()).toBe(snapshot);
		coordinator.interrupt(); coordinator.switchTo("B"); await nextTurn();
		expect(aborts).toBeGreaterThan(0); expect(sessions.current.id).toBe("A");
		gate.release(); await waitFor(() => coordinator.snapshot().sessionId === "B", "target activated");
		expect(calls).toEqual(["first"]);
		expect(events.some(event => event.type === "restore_inputs" && event.inputs.includes("queued"))).toBe(true);
	} finally { gate.release(); await coordinator.close(); }
});

test("A to B to A does not revive old commands, progress, query results or their slots", async () => {
	const sessions = host(), old = barrier("old command"), fresh = barrier("fresh command"), query = barrier("old query");
	const events: InteractionEvent[] = [], captured: string[] = [];
	let calls = 0, queryStarted = false;
	const coordinator = new SessionCoordinator({ port: sessions.current.port, requestBus: sessions.current.requestBus, sessions,
		memoryCommand: async (_input, signal, session) => { const index = calls++; captured.push(session.port.label); await (index ? fresh : old).wait(); captured.push(session.port.label); if (!index) { expect(signal.aborted).toBe(true); throw new Error("OLD_ERROR"); } return { text: "CURRENT_RESULT" }; },
		createCompletionSource: session => ({ async getSuggestions() { queryStarted = true; await query.wait(); return { items: [{ value: session.port.label, label: "OLD_QUERY" }], prefix: "" }; }, applyCompletion: (input, cursor) => ({ input, cursor }) }),
	});
	coordinator.subscribe(event => events.push(event)); coordinator.start();
	try {
		coordinator.submit("/memory import"); coordinator.requestData({ kind: "suggestions", input: "old", cursor: 3 });
		await waitFor(() => calls === 1 && queryStarted, "old work started");
		coordinator.switchTo("B"); await waitFor(() => coordinator.snapshot().sessionId === "B", "B activated");
		coordinator.switchTo("A"); await waitFor(() => coordinator.snapshot().sessionId === "A", "A reactivated");
		coordinator.submit("/memory list"); await waitFor(() => calls === 2, "fresh command started");
		old.release(); query.release(); await nextTurn(); coordinator.submit("/memory list");
		expect(calls).toBe(2); expect(captured).toEqual(["A", "A", "A"]);
		expect(events.some(event => event.type === "notice" && event.text === "OLD_ERROR" || event.type === "data_result")).toBe(false);
		fresh.release(); await waitFor(() => events.some(event => event.type === "notice" && event.text === "CURRENT_RESULT"), "fresh result");
	} finally { old.release(); fresh.release(); query.release(); await coordinator.close(); }
});

test("preparation failure preserves execution while permanently retiring auxiliary work", async () => {
	const sessions = host(), prepare = barrier("target prepare"), work = barrier("old management");
	let aborts = 0, started = false;
	sessions.current.port.abort = () => { aborts++; };
	sessions.switchTo = async () => { await prepare.wait(); throw new Error("prepare failed"); };
	const events: InteractionEvent[] = [];
	const coordinator = new SessionCoordinator({ port: sessions.current.port, requestBus: sessions.current.requestBus, sessions, memoryCommand: async () => { started = true; await work.wait(); return { text: "OLD_RESULT", prompt: "OLD_PROMPT" }; } });
	coordinator.subscribe(event => events.push(event)); coordinator.start();
	try {
		coordinator.submit("/memory import"); await waitFor(() => started, "management started");
		coordinator.switchTo("B"); await nextTurn(); expect(aborts).toBe(0);
		prepare.release(); await waitFor(() => coordinator.snapshot().phase === "active", "prepare failure recovered");
		work.release(); await nextTurn();
		expect(events.some(event => event.type === "notice" && event.text === "OLD_RESULT")).toBe(false);
		expect(coordinator.snapshot().sessionId).toBe("A");
	} finally { prepare.release(); work.release(); await coordinator.close(); }
});

test("closing is reentrant and consumes auxiliary rejection without waiting for it", async () => {
	const pending = barrier("noncooperative work"), started = barrier("work started");
	let coordinator!: SessionCoordinator;
	const port: InteractionPort = { runTurn: () => scriptedTurn((async function* () {})()), abort: () => { expect(coordinator.close()).toBe(closing); } };
	let closing: Promise<void>;
	coordinator = new SessionCoordinator({ port, requestBus: bus(), memoryCommand: async () => { started.release(); await pending.wait(); throw new Error("late rejection"); } });
	coordinator.start(); coordinator.submit("/memory import"); await started.wait();
	// The callback observes the published close promise, even inside abort().
	port.abort = () => { const first = coordinator.close(); expect(coordinator.close()).toBe(first); };
	closing = coordinator.close(); expect(coordinator.close()).toBe(closing);
	await bounded(closing, "close ignores auxiliary promise", 500); pending.release(); await nextTurn();
	expect(coordinator.snapshot().phase).toBe("closed");
});

test("a rejected stream still waits for the authoritative result before refusing activation", async () => {
	const sessions = host(), result = barrier("result after rejected stream");
	let streamed = false;
	sessions.current.port.runTurn = () => scriptedTurn((async function* () { streamed = true; throw new Error("stream failed"); })(), result.wait().then(() => ({ status: "success" as const })));
	const coordinator = new SessionCoordinator({ port: sessions.current.port, requestBus: sessions.current.requestBus, sessions });
	coordinator.start();
	try {
		coordinator.submit("work"); await waitFor(() => streamed, "stream failed"); coordinator.switchTo("B"); await nextTurn();
		expect(coordinator.snapshot().phase).toBe("switching"); expect(sessions.current.id).toBe("A");
		result.release(); await waitFor(() => coordinator.snapshot().phase === "active", "settlement failure surfaced");
		expect(sessions.current.id).toBe("A");
	} finally { result.release(); await coordinator.close(); }
});

test("manual compaction waits for a turn and sends only an explicit replacement after settling", async () => {
	const turn = barrier("turn result"), compact = barrier("compact result");
	const calls: string[] = [];
	const port: InteractionPort = {
		runTurn(input) { calls.push(String(input)); return scriptedTurn((async function* () {})(), calls.length === 1 ? turn.wait().then(() => ({ status: "success" as const })) : { status: "success" }); },
		async compact() { calls.push("compact"); await compact.wait(); },
	};
	const coordinator = new SessionCoordinator({ port, requestBus: bus() }); coordinator.start();
	try {
		coordinator.submit("first"); coordinator.submit("/compact"); await nextTurn(); expect(calls).toEqual(["first"]);
		turn.release(); await waitFor(() => calls.includes("compact"), "compaction started after settlement");
		coordinator.submit("queued"); coordinator.submit("replacement", "replace"); expect(calls).toEqual(["first", "compact"]);
		compact.release(); await waitFor(() => calls.includes("replacement"), "replacement after compaction");
		expect(calls).toEqual(["first", "compact", "replacement"]);
	} finally { turn.release(); compact.release(); await coordinator.close(); }
});

test("a finished compact emitter cannot publish into a later foreground task", async () => {
	const events: InteractionEvent[] = []; let emit!: (event: SessionEvent) => void;
	const coordinator = new SessionCoordinator({ requestBus: bus(), port: { runTurn: () => scriptedTurn((async function* () {})()), compact: async (_instructions, listener) => { emit = listener!; } } });
	coordinator.subscribe(event => events.push(event)); coordinator.start(); coordinator.submit("/compact");
	await waitFor(() => coordinator.snapshot().activity === "idle", "compaction settled");
	coordinator.submit("next"); emit({ type: "recovery", operationId: "old", reason: "OLD_COMPACT", attempt: 1, timestamp: 1 });
	expect(events.some(event => event.type === "session_event" && event.event.type === "recovery")).toBe(false); await coordinator.close();
});

test("old request and MCP subscription callbacks cannot paint or close a new activation", async () => {
	const sessions = host(), late = barrier("old request delivery");
	let oldListener!: (event: { type: string; serverId: string; message?: string }) => void;
	let unsubscribed = false;
	sessions.current.port.mcp = { subscribe(listener) { oldListener = listener; return () => { unsubscribed = true; }; } };
	sessions.current.requestBus.requests = async function* () { await late.wait(); yield request("old", "question", { prompt: "OLD_REQUEST" }); throw new Error("old bus failed"); };
	const events: InteractionEvent[] = [];
	const coordinator = new SessionCoordinator({ port: sessions.current.port, requestBus: sessions.current.requestBus, sessions });
	coordinator.subscribe(event => events.push(event)); coordinator.start();
	try {
		coordinator.switchTo("B"); await waitFor(() => coordinator.snapshot().sessionId === "B", "new activation"); expect(unsubscribed).toBe(true);
		oldListener({ type: "diagnostic", serverId: "old", message: "OLD_MCP" }); late.release(); await nextTurn();
		expect(events.some(event => event.type === "request_added" || event.type === "notice" && event.text.includes("OLD_MCP") || event.type === "view_command" && event.command === "quit")).toBe(false);
		expect(coordinator.snapshot().phase).toBe("active");
	} finally { late.release(); await coordinator.close(); }
});
