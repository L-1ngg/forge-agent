import { expect, test } from "bun:test";
import fc from "fast-check";
import type { AgentTurn } from "../../packages/core/src/sdk.ts";
import type { Exchange } from "../support/http-fixture.ts";
import { withScenario, bounded } from "../support/scenario.ts";
import { frames, settings, path } from "../fixtures/protocol.ts";
import { LongTermMemory, type Model } from "../../packages/core/src/sdk.ts";
import { nativeAdapter } from "../../packages/core/test/helpers/native-adapter.ts";
import { nativeReply, isMemoryOrganizerRequest } from "../../packages/core/test/helpers/native-reply.ts";
import { join } from "node:path";
import { readdir } from "node:fs/promises";

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

test("replayable SDK sequences combine deferred memory, configuration, approval and cancellation", async () => {
	const seed = Number(process.env.FORGE_TEST_SEED ?? 44017), replayPath = process.env.FORGE_TEST_PATH;
	const choices = ["save", "configure", "approve", "deny", "cancel-save"] as const;
	const model: Model = { id: "sequence", name: "Sequence", api: "faux", provider: "fixture", baseUrl: "https://unused.invalid", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom(...choices), { minLength: 1, maxLength: 8 }), async suffix => {
		await withScenario("sdk-memory-sequence", async scenario => {
			const commands = ["save", "configure", "approve", "cancel-save", ...suffix] as const;
			scenario.trace.record("reproduction", { seed, path: replayPath ?? "", commands });
			const store = new LongTermMemory({ project: join(scenario.cwd, "memory") });
			let index = 0, operation: typeof choices[number] = "save", proposed = false, effects = 0, expectedEffects = 0;
			let taskReady = scenario.gate("initial-task"), taskRelease = scenario.gate("initial-release"), saveReady = scenario.gate("initial-save"), saveRelease = scenario.gate("initial-save-release"), saveEnded = scenario.gate("initial-save-ended");
			const adapter = nativeAdapter(model, async function* (request) {
				if (isMemoryOrganizerRequest(request)) {
					saveReady.release();
					try { await saveRelease.wait(); yield* nativeReply({ text: JSON.stringify({ updates: [{ action: "write", scope: "project", path: `note-${index}.md`, content: `Durable preference ${index}` }], indexes: [] }) }); }
					finally { saveEnded.release(); }
					return;
				}
				taskReady.release(); await taskRelease.wait();
				if (!proposed && (operation === "approve" || operation === "deny")) { proposed = true; yield* nativeReply({ toolCalls: [{ id: `call-${index}`, name: "work", arguments: {} }] }); }
				else yield* nativeReply({ text: `Completed ${index}` });
			});
			const agent = await scenario.agent({ model, adapter, memory: { store }, tools: [{ name: "work", label: "Work", description: "count effect", parameters: { type: "object", properties: {}, additionalProperties: false }, async execute() { effects++; return { content: [], details: {} }; } }] });
			let old: AgentTurn | undefined, oldRequest: string | undefined;
			for (const command of commands) {
				operation = command; proposed = false;
				taskReady = scenario.gate(`task-${index}`); taskRelease = scenario.gate(`task-release-${index}`); saveReady = scenario.gate(`save-${index}`); saveRelease = scenario.gate(`save-release-${index}`); saveEnded = scenario.gate(`save-ended-${index}`);
				scenario.trace.record("operation", { index, command });
				const turn = agent.runTurn(`task-${index}`), running = scenario.collect(turn);
				await taskReady.wait();
				if (old) expect(agent.steer("stale-input", old.id)).toEqual({ accepted: false });
				const receipt = command === "configure" ? await agent.updateConfiguration({ systemPrompt: `Configuration ${index}` }) : undefined;
				let applied = false; if (receipt) void receipt.applied.then(() => { applied = true; });
				expect(applied).toBe(false);
				taskRelease.release();
				if (command === "approve" || command === "deny") {
					const request = await agent.requests[Symbol.asyncIterator]().next();
					if (request.done || request.value.kind !== "permission") throw new Error("Expected approval");
					if (oldRequest) expect(agent.respond({ type: "response", id: oldRequest, result: { decision: "allow_once" } })).toBe(false);
					expect(agent.respond({ type: "response", id: request.value.id, result: { decision: command === "approve" ? "allow_once" : "deny" } })).toBe(true);
					oldRequest = request.value.id; if (command === "approve") expectedEffects++;
				}
				await saveReady.wait();
				if (command === "cancel-save") agent.abort(); else saveRelease.release();
				const events = await bounded(running, "combined invocation");
				expect(await turn.result).toEqual({ status: command === "cancel-save" ? "aborted" : "success" });
				expect(events.filter(event => event.type === "memory" && event.phase === "save")).toMatchObject([{ status: command === "cancel-save" ? "failed" : "saved", calls: 1 }]);
				if (receipt) expect(await receipt.applied).toMatchObject({ status: "applied", revision: receipt.revision });
				saveRelease.release(); await saveEnded.wait();
				const files = await readdir(store.roots.project!);
				expect(files.includes(`note-${index}.md`)).toBe(command !== "cancel-save");
				expect(effects).toBe(expectedEffects); old = turn; index++;
			}
		});
	}), { seed, numRuns: 8, ...(replayPath !== undefined ? { path: replayPath } : {}) });
}, 30_000);
