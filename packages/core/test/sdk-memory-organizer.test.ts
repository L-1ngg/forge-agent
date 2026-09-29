import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventType, type AdapterYieldChunk } from "@tanstack/ai";
import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import type { SessionEvent } from "@forge-agent/protocol";
import { createAgent, LongTermMemory } from "../src/sdk.ts";
import { getCatalogModel } from "../src/model-catalog.ts";
import type { Model } from "../src/model-types.ts";
import { processConverseStream } from "../node_modules/@tanstack/ai-bedrock/dist/esm/converse/stream-processor.js";
import { nativeAdapter, type NativeStream } from "./helpers/native-adapter.ts";
import { isMemoryOrganizerRequest, nativeReply } from "./helpers/native-reply.ts";

const model = getCatalogModel("openai", "gpt-5.4")!;
const validPlan = JSON.stringify({ updates: [{ action: "write", scope: "project", path: "topic.md", content: "Durable note" }], indexes: [] });

async function exerciseOrganizer(stream: NativeStream, inspect: (root: string, events: SessionEvent[], calls: number) => Promise<void>, selectedModel: Model = model): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "forge-organizer-protocol-"));
	let calls = 0;
	const adapter = nativeAdapter(selectedModel, async function* (request) {
		if (isMemoryOrganizerRequest(request)) {
			calls++;
			yield* stream(request);
		} else yield* nativeReply({ text: "Task complete" });
	});
	try {
		const agent = await createAgent({ cwd: root, systemPrompt: "BASE", model: selectedModel, adapter, memory: { store: new LongTermMemory({ project: root }) } });
		try {
			const turn = agent.runTurn("Remember the durable note.");
			const events: SessionEvent[] = [];
			for await (const event of turn) events.push(event);
			expect(await turn.result).toEqual({ status: "success" });
			await inspect(root, events, calls);
		} finally { await agent.dispose(); }
	} finally { await rm(root, { recursive: true, force: true }); }
}

const noWrite = async (root: string, events: SessionEvent[], calls: number) => {
	expect(calls).toBe(1);
	expect(events.find(event => event.type === "memory" && event.phase === "save")).toMatchObject({ status: "failed", calls: 1, receipts: [{ ok: false, error: expect.any(String) }] });
	expect(await readdir(root)).toEqual([]);
};

test("incomplete, late-failed, truncated, canceled and tool-proposing organizer streams cannot write memory", async () => {
	const streams: Record<string, NativeStream> = {
		"missing terminal": async function* () { for await (const chunk of nativeReply({ text: validPlan })) if (chunk.type !== EventType.RUN_FINISHED) yield chunk; },
		"late adapter failure": async function* () { yield* nativeReply({ text: validPlan }); throw new Error("late transport failure"); },
		"late RUN_ERROR": async function* () { yield* nativeReply({ text: validPlan }); yield { type: EventType.RUN_ERROR, code: "503", message: "late provider error" }; },
		"length terminal": () => nativeReply({ text: validPlan, finishReason: "length" }),
		"deferred terminal": () => nativeReply({ text: validPlan, metadata: { forge: { stopReason: "deferred" } } }),
		"canceled request": () => nativeReply({ text: validPlan, error: { code: "aborted", message: "organizer canceled" } }),
		"tool proposal": () => nativeReply({ text: validPlan, toolCalls: [{ id: "call", name: "write_memory", arguments: { path: "topic.md" } }] }),
		"empty text": () => nativeReply({ text: "" }),
	};
	for (const [name, stream] of Object.entries(streams)) {
		try { await exerciseOrganizer(stream, noWrite); }
		catch (error) { throw new Error(`${name}: ${String(error)}`); }
	}
});

test("failed organizer plans retain reported usage without writing memory", async () => {
	await exerciseOrganizer(() => nativeReply({ text: "not JSON", usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 } }), async (root, events, calls) => {
		expect(calls).toBe(1);
		expect(events.find(event => event.type === "memory" && event.phase === "save")).toMatchObject({ status: "failed", calls: 1, usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 } });
		expect(await readdir(root)).toEqual([]);
	});
});

test("organizer rejects trailing JSON, missing content, unknown keys and unauthorized scopes", async () => {
	const plans = [
		`${validPlan}\n{}`,
		JSON.stringify({ updates: [{ action: "write", scope: "project", path: "topic.md" }], indexes: [] }),
		JSON.stringify({ updates: [], indexes: [], extra: true }),
		JSON.stringify({ updates: [{ action: "write", scope: "global", path: "topic.md", content: "wrong scope" }], indexes: [] }),
		JSON.stringify({ updates: [{ action: "write", scope: "user", path: "topic.md", content: "wrong scope" }], indexes: [] }),
		JSON.stringify({ updates: [], indexes: [{ scope: "project", content: "index", extra: true }] }),
		JSON.stringify({ updates: [
			{ action: "write", scope: "project", path: "topic.md", content: "Should not persist" },
			{ action: "write", scope: "project", path: "MEMORY.md", content: "Wrong operation" },
		], indexes: [] }),
		JSON.stringify({ updates: [
			{ action: "write", scope: "project", path: "topic.md", content: "Should not persist" },
			{ action: "write", scope: "project", path: "large.md", content: "x".repeat(256 * 1024) },
		], indexes: [] }),
	];
	for (const plan of plans) await exerciseOrganizer(() => nativeReply({ text: plan }), noWrite);
});

function bedrockStream(complete: boolean): NativeStream {
	return async function* () {
		const events = (async function* (): AsyncGenerator<ConverseStreamOutput> {
			yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: validPlan } } };
			yield { contentBlockStop: { contentBlockIndex: 0 } };
			if (complete) yield { messageStop: { stopReason: "end_turn" } };
		})();
		let id = 0;
		yield* processConverseStream(events, () => `bedrock_${++id}`);
	};
}

test("Bedrock JSON without messageStop does not persist but the complete Converse response does", async () => {
	const bedrock = getCatalogModel("amazon-bedrock", "anthropic.claude-sonnet-4-5-20250929-v1:0")!;
	await exerciseOrganizer(bedrockStream(false), noWrite, bedrock);
	await exerciseOrganizer(bedrockStream(true), async (root, events, calls) => {
		expect(calls).toBe(1);
		expect(events.find(event => event.type === "memory" && event.phase === "save")).toMatchObject({ status: "saved", calls: 1 });
		expect(await readdir(root)).toEqual(["topic.md"]);
	}, bedrock);
});
