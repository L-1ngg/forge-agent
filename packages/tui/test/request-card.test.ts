import { expect, test } from "bun:test";
import { request, type RequestEnvelopeUnion, type RequestKind } from "@forge-agent/protocol";
import {
	RequestCard,
	createFrame,
	createTheme,
	frameToText,
	paintRequestCard,
	requestCardActions,
	cardBodyRows,
	responseForRequestAction,
} from "../src/index.ts";

const theme = createTheme({ mode: "truecolor" });

const kinds: { kind: RequestKind; envelope: RequestEnvelopeUnion }[] = [
	{ kind: "permission", envelope: request("p", "permission", { toolCall: { type: "tool_call", id: "t", name: "bash", arguments: { command: "ls" } } }) },
	{ kind: "cancel_confirm", envelope: request("c", "cancel_confirm", { action: "abort" }) },
	{ kind: "question", envelope: request("q", "question", { prompt: "pick" }) },
	{ kind: "plan_approval", envelope: request("pl", "plan_approval", { plan: "do it" }) },
	{ kind: "oauth", envelope: request("o", "oauth", { provider: "xai", authorizationUrl: "https://x" }) },
];

test("AC-12: five request kinds share the same action contract", () => {
	for (const { envelope } of kinds) {
		const actions = requestCardActions(envelope);
		expect(actions.length).toBeGreaterThanOrEqual(2);
		const card = new RequestCard(envelope);
		if (envelope.kind !== "question") expect(card.responseFor(actions[0]!)).toBeDefined();
		card.park();
		expect(card.responseFor(actions[0]!)).toBeUndefined(); // parked cards cannot answer
		card.resume();
		if (envelope.kind !== "question") expect(card.responseFor(actions[0]!)?.id).toBe(envelope.id);
	}
});

test("park never produces a response envelope", () => {
	const envelope = kinds[0]!.envelope;
	const card = new RequestCard(envelope);
	card.park();
	expect(card.record.state).toBe("parked");
	expect(card.responseFor("deny")).toBeUndefined();
	expect(card.responseFor("allow_once")).toBeUndefined();
});

test("permission allow_always is only offered when a remember rule exists", () => {
	const plain = request("p", "permission", { toolCall: { type: "tool_call", id: "t", name: "edit", arguments: { path: "a.ts" } } });
	expect(requestCardActions(plain)).toEqual(["allow_once", "deny"]);
	const remember = request("p2", "permission", { toolCall: { type: "tool_call", id: "t", name: "edit", arguments: { path: "a.ts" } }, rememberRule: "edit *" });
	expect(requestCardActions(remember)).toEqual(["allow_once", "allow_always", "deny"]);
	expect(responseForRequestAction(remember, "allow_always")?.result).toMatchObject({ decision: "allow_always" });
});

test("card paint uses a rail and keeps the selected action visible", () => {
	const card = new RequestCard(kinds[0]!.envelope);
	const frame = createFrame(40, 8);
	paintRequestCard({ frame, y: 0, height: 8, card, focusIndex: 1, focused: true, theme });
	const text = frameToText(frame);
	expect(text).toContain("Permission: bash");
	expect(text).toContain("Yes, proceed");
	expect(text).toContain("No, reject");
	expect(frame.cells[0]![0]!.grapheme).toBe("┃");
});

test("permission body includes the complete authorized arguments", () => {
	const envelope = request("write", "permission", { toolCall: { type: "tool_call", id: "write", name: "write", arguments: { path: "file.ts", content: "AUTHORIZED_CONTENT", mode: "overwrite" } } });
	const text = cardBodyRows(envelope, 80, theme).flatMap((row) => row.spans.map((span) => span.text)).join("\n");
	expect(text).toContain("AUTHORIZED_CONTENT");
	expect(text).toContain("overwrite");
});

test("selected actions stay visible even in a three-row card slot", () => {
	const card = new RequestCard(kinds[0]!.envelope);
	const frame = createFrame(40, 3);
	paintRequestCard({ frame, y: 0, height: 3, card, focusIndex: 1, focused: true, theme });
	expect(frameToText(frame)).toContain("No, reject");
});

test("confirming a question never invents a selection", () => {
	const envelope = request("q", "question", { prompt: "Pick", multiple: true, choices: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] });
	expect(responseForRequestAction(envelope, "confirm")).toBeUndefined();
});
