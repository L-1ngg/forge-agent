import { expect, test } from "bun:test";
import fc from "fast-check";
import type { AgentTurn } from "../../packages/core/src/sdk.ts";
import type { Exchange } from "../support/http-fixture.ts";
import { withScenario, bounded } from "../support/scenario.ts";
import { frames, settings, path } from "../fixtures/protocol.ts";

const operations = ["run", "unstarted-cancel", "stream-cancel", "steer", "follow-up", "stale", "dispose"] as const;
type Operation = typeof operations[number];

test("generated operations drive the real SDK: ownership, cancellation, reuse and disposal", async () => {
	const seed = Number(process.env.FORGE_TEST_SEED ?? 33004);
	const replayPath = process.env.FORGE_TEST_PATH;
	await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom(...operations), { minLength: 1, maxLength: 20 }), async commands => {
		await withScenario("sdk-sequence", async scenario => {
			scenario.trace.record("reproduction", { seed, path: replayPath ?? "", commands });
			const script: Exchange[] = [];
			const fixture = scenario.httpFixture(scenario.id, script);
			const agent = await scenario.agent({ ...settings("anthropic"), baseUrl: fixture.url, tools: [] });
			let disposed = false;
			let old: AgentTurn | undefined;
			let oldIterator: AsyncIterator<unknown> | undefined;
			const forbidden: string[] = [];
			const execute = async (operation: Operation, index: number) => {
				scenario.trace.record("operation", { operation, index });
				if (disposed) { expect(() => agent.runTurn("after-dispose")).toThrow("disposed"); await agent.dispose(); return; }
				if (operation === "dispose") { await agent.dispose(); disposed = true; expect(() => agent.runTurn("after-dispose")).toThrow("disposed"); return; }
				const prompt = `input-${index}`;
				const turn = agent.runTurn(prompt);
				const iterator = turn[Symbol.asyncIterator]();
				if (operation === "unstarted-cancel") {
					const before = await scenario.storage.load(); const requests = fixture.count;
					agent.abort(); expect((await iterator.next()).done).toBe(true);
					expect(await turn.result).toEqual({ status: "aborted" });
					expect(await scenario.storage.load()).toEqual(before); expect(fixture.count).toBe(requests);
					forbidden.push(prompt); old = turn; oldIterator = iterator; return;
				}
				const release = scenario.gate(`release-${index}`);
				const match = (body: unknown) => {
					const request = body as { messages: unknown[] };
					expect(JSON.stringify(request.messages)).toContain(prompt);
					for (const text of forbidden) expect(JSON.stringify(request.messages)).not.toContain(`"${text}"`);
				};
				const count = fixture.count;
				script.push({ id: prompt, method: "POST", path: path("anthropic"), match, response: { chunks: frames("anthropic"), beforeChunk: i => i === 0 ? release.wait() : Promise.resolve() } });
				const running = (async () => { while (true) { const event = await iterator.next(); if (event.done) break; scenario.trace.record("event", event.value); } })();
				// Start consuming before waiting at the model request boundary.
				try {
					await fixture.received(count + 1);
					let receipt;
					if (operation === "steer" || operation === "follow-up") {
						const input = `${operation}-${index}`;
						receipt = operation === "steer" ? agent.steer(input, turn.id) : agent.followUp(input, turn.id);
						expect(receipt.accepted).toBe(true);
						script.push({ id: input, method: "POST", path: path("anthropic"), match(body) { match(body); expect(JSON.stringify(body)).toContain(input); }, response: { chunks: frames("anthropic") } });
					}
					if (operation === "stale" && old) {
						const marker = `rejected-${index}`; forbidden.push(marker);
						expect(agent.steer(marker, old.id)).toEqual({ accepted: false });
						expect(agent.followUp(marker, old.id)).toEqual({ accepted: false });
						await oldIterator?.return?.(); // Closing an old turn cannot abort the current one.
					}
					if (operation === "stream-cancel") agent.abort();
					release.release(); await bounded(running, "sequence turn");
					expect(await turn.result).toEqual({ status: operation === "stream-cancel" ? "aborted" : "success" });
					if (receipt?.accepted) expect(await receipt.processed).toBe(true);
					await agent.waitForIdle();
					old = turn; oldIterator = iterator;
				} finally { release.release(); agent.abort(); await bounded(running, "sequence cleanup"); }
			};
			// Ensure an old invocation exists; the random suffix is what fast-check shrinks.
			await execute("run", -1);
			for (const [index, operation] of commands.entries()) await execute(operation, index);
			await agent.dispose();
			expect(() => agent.runTurn("closed")).toThrow("disposed");
		});
	}), { seed, numRuns: 50, ...(replayPath !== undefined ? { path: replayPath } : {}), endOnFailure: false });
}, 30_000);
