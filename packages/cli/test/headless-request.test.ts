import { scriptedTurn } from "../../../tests/support/turn.ts";
import type { SessionEvent } from "@forge-agent/protocol";
import { expect, test } from "bun:test";
import {
	HEADLESS_REQUEST_EXIT_CODES,
	headlessRequestDecision,
	runHeadless,
} from "../src/headless.ts";
import { RequestBus } from "@forge-agent/core";
import type { RequestEnvelopeFor, RequestKind } from "@forge-agent/protocol";
import { block } from "@forge-agent/protocol";
import { withScenario, bounded } from "../../../tests/support/scenario.ts";
import { modelResponse } from "../../../tests/fixtures/model-response.ts";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

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
	mcp_elicitation: { type: "request", id: "mcp", kind: "mcp_elicitation", payload: { serverId: "fixture", operationId: "op", message: "Confirm", mode: "url", url: "https://example.test" } },
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
	expect(Object.values(HEADLESS_REQUEST_EXIT_CODES)).toEqual([20, 21, 22, 23, 24, 25]);
});

test("runHeadless drains a blocking request and returns its deterministic exit code", async () => {
	for (const kind of Object.keys(requests) as RequestKind[]) {
		const bus = new RequestBus({ idPrefix: `headless-${kind}`, timeoutMs: 1_000 });
		let outcome: unknown;
		const port = {
			runTurn() { return scriptedTurn((async function* (): AsyncIterable<SessionEvent> {
				outcome = await bus.ask(kind, requests[kind].payload as never);
				yield { type: "agent_start", timestamp: 1 };
				yield { type: "agent_end", timestamp: 2 };
			})()); },
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
		runTurn() { return scriptedTurn((async function* (): AsyncIterable<SessionEvent> {
			yield { type: "tool_execution_end", timestamp: 1, toolCallId: "exec-1", toolName: "bash", content: "ok", isError: false, block: richBlock };
		})()); },
	}, "block", (line) => lines.push(line));
	expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ block: richBlock });
});

test("real CLI headless approval denies without a prompt or tool effect", () => withScenario("headless-native-approval", async scenario => {
	const proposal = await modelResponse([{ id: "write-one", name: "write", arguments: { path: "result.txt", content: "forbidden" } }]).text();
	const fixture = scenario.httpFixture(scenario.id, [
		{ id: "proposal", method: "POST", path: "/v1/messages", match(body) { expect(JSON.stringify(body)).toContain("headless ask"); }, response: { chunks: [proposal] } },
		{ id: "continuation", method: "POST", path: "/v1/messages", match(body) { expect(JSON.stringify(body)).toContain("Interactive request is not available in headless mode"); }, response: { chunks: [await modelResponse([], "end_turn", "DENIED_COMPLETE").text()] } },
	]);
	await mkdir(join(scenario.cwd, ".forge-agent"));
	await Bun.write(join(scenario.cwd, ".forge-agent/config.json"), JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "local-test", baseUrl: fixture.url, thinkingLevel: "off", retry: { enabled: false }, memory: { autoUpdate: false, injection: false } }));
	const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/main.ts"), "--json", "-p", "headless ask"], {
		cwd: scenario.cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...scenario.env, FORGE_AGENT_API_KEY: "", FORGE_AGENT_PROVIDER: "", FORGE_AGENT_MODEL: "" },
	});
	scenario.defer(async () => { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; });
	const output = await bounded(new Response(child.stdout).text(), "headless output", 6000);
	const stderr = await new Response(child.stderr).text();
	expect(await child.exited).toBe(HEADLESS_REQUEST_EXIT_CODES.permission);
	expect(stderr).toBe("");
	expect(output).toContain("DENIED_COMPLETE");
	expect(await Bun.file(join(scenario.cwd, "result.txt")).exists()).toBe(false);
}), 15_000);
