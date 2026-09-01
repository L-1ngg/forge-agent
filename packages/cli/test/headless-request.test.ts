import { expect, test } from "bun:test";
import {
	HEADLESS_REQUEST_EXIT_CODES,
	headlessRequestDecision,
	runHeadless,
} from "../src/headless.ts";
import { RequestBus } from "@myh/core";
import type { RequestEnvelopeFor, RequestKind } from "@myh/protocol";
import { block } from "@myh/protocol";

const requests: { [K in RequestKind]: RequestEnvelopeFor<K> } = {
	permission: {
		type: "request",
		id: "permission-id",
		kind: "permission",
		payload: { toolCall: { type: "tool_call", id: "call", name: "bash", arguments: { command: "echo ok" } } },
	},
	cancel_confirm: {
		type: "request",
		id: "cancel-id",
		kind: "cancel_confirm",
		payload: { action: "cancel turn" },
	},
	question: {
		type: "request",
		id: "question-id",
		kind: "question",
		payload: { prompt: "continue?" },
	},
	plan_approval: {
		type: "request",
		id: "plan-id",
		kind: "plan_approval",
		payload: { plan: "run tests" },
	},
	oauth: {
		type: "request",
		id: "oauth-id",
		kind: "oauth",
		payload: { provider: "example", authorizationUrl: "https://example.test/login" },
	},
};

test("headless policy returns a conservative response and stable code for every kind", () => {
	expect(headlessRequestDecision(requests.permission)).toEqual({
		response: {
			type: "response",
			id: "permission-id",
			result: { decision: "deny", reason: "Interactive request is not available in headless mode" },
		},
		exitCode: 20,
	});
	expect(headlessRequestDecision(requests.cancel_confirm).response.result).toEqual({ decision: "cancel" });
	expect(headlessRequestDecision(requests.question).response.result).toEqual({ decision: "cancel" });
	expect(headlessRequestDecision(requests.plan_approval).response.result).toEqual({
		decision: "reject",
		feedback: "Interactive request is not available in headless mode",
	});
	expect(headlessRequestDecision(requests.oauth).response.result).toEqual({ decision: "cancel" });
	expect(Object.values(HEADLESS_REQUEST_EXIT_CODES)).toEqual([20, 21, 22, 23, 24]);
});

test("runHeadless drains a blocking request and returns its deterministic exit code", async () => {
	for (const kind of Object.keys(requests) as RequestKind[]) {
		const bus = new RequestBus({ idPrefix: `headless-${kind}`, timeoutMs: 1_000 });
		let outcome: unknown;
		const port = {
			async *runTurn(): AsyncIterable<{ type: "agent_start" | "agent_end"; timestamp: number }> {
				outcome = await bus.ask(kind, requests[kind].payload as never);
				yield { type: "agent_start", timestamp: 1 };
				yield { type: "agent_end", timestamp: 2 };
			},
			steer() {},
			followUp() {},
			abort() {},
		};
		const lines: string[] = [];
		const exitCode = await runHeadless(port, "headless request", (line) => lines.push(line), { requestBus: bus });
		expect(exitCode).toBe(HEADLESS_REQUEST_EXIT_CODES[kind]);
		expect(outcome).toMatchObject({ status: "response" });
		expect(lines).toHaveLength(2);
	}
});

test("headless preserves the same structured block envelope consumed by TUI", async () => {
	const richBlock = block({ id: "exec-1", kind: "execute", lifecycle: "complete" }, { command: "echo ok", stdout: "ok" });
	const lines: string[] = [];
	await runHeadless({
		async *runTurn() {
			yield { type: "tool_execution_end", timestamp: 1, toolCallId: "exec-1", toolName: "bash", content: "ok", isError: false, block: richBlock };
		},
		steer() {},
		followUp() {},
		abort() {},
	}, "block", (line) => lines.push(line));
	expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ block: richBlock });
});
