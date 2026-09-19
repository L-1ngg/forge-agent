import { expect, test } from "bun:test";
import { response } from "../../packages/protocol/src/index.ts";
import { frames, settings, path } from "../fixtures/protocol.ts";
import { controlledTool } from "../support/controlled-tool.ts";
import { withScenario, bounded } from "../support/scenario.ts";

const parameters = { type: "object" as const, properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false as const };
for (const stage of ["permission", "tool", "save"] as const) test(`real SDK cancellation at ${stage} waits for cleanup and rejects late ownership`, () => withScenario(`cancel-${stage}`, async scenario => {
	const started = scenario.gate("started"); const release = scenario.gate("release");
	const fixture = scenario.httpFixture(scenario.id, [
		{ id: "tool", method: "POST", path: path("anthropic"), match(body) { expect(JSON.stringify(body)).toContain("first"); }, response: { chunks: frames("anthropic", true) } },
		{ id: "next", method: "POST", path: path("anthropic"), match(body) { expect(JSON.stringify(body)).toContain("second"); expect(JSON.stringify(body)).not.toContain("stale-input"); }, response: { chunks: frames("anthropic") } },
	]);
	let effects = 0;
	const tool = controlledTool("capture", parameters, stage === "tool" ? [{ args: { value: "你好" }, async result() { effects++; started.release(); await release.wait(); return { content: [{ type: "text", text: "late-completed-result" }], details: {} }; } }] : [], scenario.trace);
	const agent = await scenario.agent({ ...settings("anthropic"), baseUrl: fixture.url, tools: [tool.tool],
		...(stage !== "permission" ? { permission: { hooks: [{ evaluate: () => ({ kind: "allow" as const, source: "hook" as const }) }] } } : {}),
	}, async entry => {
		if (stage === "save" && entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "tool_use") { started.release(); await release.wait(); }
	});
	const old = agent.runTurn("first");
	let ended = false;
	const running = scenario.collect(old).then(events => { ended = true; return events; });
	let permissionId: string | undefined;
	try {
		if (stage === "permission") {
			const request = await bounded(agent.requests[Symbol.asyncIterator]().next(), "permission");
			if (request.done || request.value.kind !== "permission") throw new Error("Missing permission request");
			permissionId = request.value.id;
		} else await started.wait();
		expect(effects).toBe(stage === "tool" ? 1 : 0);
		agent.abort();
		expect(agent.steer("stale-input", old.id)).toEqual({ accepted: false });
		if (stage !== "permission") { await Promise.resolve(); expect(ended).toBe(false); }
		release.release(); await bounded(running, "canceled turn");
		expect(await old.result).toEqual({ status: "aborted" });
		const saved = await scenario.storage.load();
		expect(JSON.stringify(saved)).toContain("first");
		if (stage === "tool") expect(JSON.stringify(saved)).toContain("late-completed-result");
		const next = agent.runTurn("second");
		const consuming = scenario.collect(next);
		if (permissionId) expect(agent.respond(response(permissionId, { decision: "allow_once" }))).toBe(false);
		expect(agent.followUp("stale-input", old.id)).toEqual({ accepted: false });
		await consuming; expect(await next.result).toEqual({ status: "success" });
		expect(effects).toBe(stage === "tool" ? 1 : 0);
		tool.assertComplete();
	} finally { release.release(); agent.abort(); await bounded(running, "cancel cleanup"); }
}));
