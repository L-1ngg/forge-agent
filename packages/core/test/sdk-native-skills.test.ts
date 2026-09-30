import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMessage } from "@forge-agent/protocol";
import { createAgent, MemorySessionStorage } from "../src/sdk.ts";
import { getCatalogModel } from "../src/model-catalog.ts";
import { sessionMessages } from "../src/session-storage.ts";
import { nativeAdapter, responseChunks } from "../../../tests/fixtures/native-adapter.ts";

const model = getCatalogModel("openai", "gpt-5.4")!;
const answer: SessionMessage = { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 1, stopReason: "stop" };

test("official Skills load and resource tools run once through the public batch without approval", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-native-skills-"));
	const project = join(cwd, "project"), user = join(cwd, "user");
	const storage = new MemorySessionStorage();
	const requests: Array<{ system: string; tools: string[] }> = [];
	try {
		await writeFile(join(cwd, "secret.md"), "OUTSIDE SECRET");
		for (const root of [project, user]) {
			await mkdir(join(root, "guide", "references"), { recursive: true });
			await writeFile(join(root, "guide", "SKILL.md"), `---\nname: guide\ndescription: Guide workflow\n---\n${root === project ? "PROJECT BODY" : "USER BODY"}`);
			await writeFile(join(root, "guide", "references", "note.md"), root === project ? "PROJECT REFERENCE" : "USER REFERENCE");
		}
		let calls = 0;
		const agent = await createAgent({ cwd, systemPrompt: "BASE", model, storage, skills: { roots: { workspace: { path: project }, user: { path: user } } },
			adapter: nativeAdapter(model, async function* (request) {
				requests.push({ system: JSON.stringify(request.systemPrompts), tools: request.tools?.map(tool => tool.name) ?? [] });
				const call = ++calls === 1 ? { id: "load", name: "load_skill", arguments: { name: "guide" } } : calls === 2 ? { id: "resource", name: "read_skill_resource", arguments: { skill: "guide", path: "references/note.md" } } : calls === 3 ? { id: "escape", name: "read_skill_resource", arguments: { skill: "guide", path: "../../secret.md" } } : undefined;
				yield* responseChunks(call ? { role: "assistant", content: [{ type: "tool_call", ...call }], timestamp: calls, stopReason: "tool_use" } : answer);
			}),
		});
		try {
			const turn = agent.runTurn("Use guide");
			for await (const _ of turn) {}
			expect({ result: await turn.result, history: sessionMessages(await storage.load()).map(message => message.errorMessage).filter(Boolean) }).toEqual({ result: { status: "success" }, history: [] });
			expect(requests).toHaveLength(4);
			expect(requests[0]?.system).toContain("Guide workflow");
			expect(requests[0]?.system).not.toContain("PROJECT BODY");
			expect(requests[0]?.tools).toContain("load_skill");
			expect(requests[0]?.tools).toContain("read_skill_resource");
			const results = sessionMessages(await storage.load()).filter(message => message.role === "toolResult");
			expect(JSON.stringify(results)).toContain("PROJECT BODY");
			expect(JSON.stringify(results)).toContain("PROJECT REFERENCE");
			expect(JSON.stringify(results)).not.toContain("USER BODY");
			expect(results.find(message => message.toolCallId === "escape")?.isError).toBe(true);
			expect(JSON.stringify(results)).not.toContain("OUTSIDE SECRET");
		} finally { await agent.dispose(); }
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("host tools cannot impersonate official Skills or memory tools", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-native-collision-"));
	const root = join(cwd, "skills");
	await mkdir(join(root, "guide"), { recursive: true });
	await writeFile(join(root, "guide", "SKILL.md"), "---\nname: guide\ndescription: Guide\n---\nGUIDE BODY");
	const fake = (name: string) => ({ name, label: name, description: "fake", parameters: { type: "object" as const, properties: {}, required: [], additionalProperties: false as const }, async execute() { return { content: [], details: {} }; } });
	try {
		await expect(createAgent({ cwd, systemPrompt: "BASE", model, adapter: nativeAdapter(model, async function* () { yield* responseChunks(answer); }), skills: { roots: { workspace: { path: root } } }, tools: [fake("load_skill")] })).rejects.toThrow("reserved");
		await expect(createAgent({ cwd, systemPrompt: "BASE", model, adapter: nativeAdapter(model, async function* () { yield* responseChunks(answer); }), memory: { store: new (await import("../src/sdk.ts")).LongTermMemory({ project: cwd }) }, tools: [fake("write_memory")] })).rejects.toThrow("reserved");
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("a skill accepted by the official lenient parser remains available", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-lenient-skill-"));
	const root = join(cwd, "skills");
	await mkdir(join(root, "nested", "guide"), { recursive: true });
	await writeFile(join(root, "nested", "guide", "SKILL.md"), "---\nname: guide\ndescription: workflow: review\n---\nGUIDE BODY");
	try {
		const agent = await createAgent({ cwd, systemPrompt: "BASE", model, adapter: nativeAdapter(model, async function* () { yield* responseChunks(answer); }), skills: { roots: { workspace: { path: root } } } });
		try { expect(agent.getSkills().entries).toContainEqual(expect.objectContaining({ name: "guide", status: "available", entry: root })); }
		finally { await agent.dispose(); }
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("explicit-only Skills stay out of the automatic catalog but remain available to /skill", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-explicit-skills-"));
	const root = join(cwd, "skills");
	try {
		await mkdir(join(root, "manual"), { recursive: true });
		await writeFile(join(root, "manual", "SKILL.md"), "---\nname: manual\ndescription: Manual workflow\ndisable-model-invocation: true\n---\nMANUAL BODY");
		const seen: string[] = [];
		const agent = await createAgent({ cwd, systemPrompt: "BASE", model, skills: { roots: { workspace: { path: root } } }, adapter: nativeAdapter(model, async function* (request) {
			seen.push(JSON.stringify(request));
			yield* responseChunks(answer);
		}) });
		try {
			const first = agent.runTurn("ordinary"); for await (const _ of first) {}
			expect(await first.result).toEqual({ status: "success" });
			expect(seen[0]).not.toContain("Manual workflow");
			const selected = agent.runTurn({ kind: "skill", name: "manual", task: "literal task" }); for await (const _ of selected) {}
			expect(await selected.result).toEqual({ status: "success" });
			expect(seen[1]).toContain("MANUAL BODY");
			expect(seen[1]).toContain("literal task");
		} finally { await agent.dispose(); }
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test.each(["\n", "\r\n"])("an explicit-only skill resource is reachable only after explicit selection (%s)", async newline => {
	const cwd = await mkdtemp(join(tmpdir(), "forge-explicit-resource-"));
	const root = join(cwd, "skills");
	const storage = new MemorySessionStorage();
	try {
		await mkdir(join(root, "manual", "references"), { recursive: true });
		await writeFile(join(root, "manual", "SKILL.md"), "---\nname: manual\ndescription: Manual workflow\ndisable-model-invocation: true\n---\nMANUAL BODY".replaceAll("\n", newline));
		await writeFile(join(root, "manual", "references", "details.md"), "MANUAL REFERENCE");
		let calls = 0;
		const agent = await createAgent({ cwd, systemPrompt: "BASE", model, storage, skills: { roots: { workspace: { path: root } } }, adapter: nativeAdapter(model, async function* () {
			const number = ++calls;
			yield* responseChunks(number === 1 || number === 3 ? { role: "assistant", content: [{ type: "tool_call", id: `resource-${number}`, name: "read_skill_resource", arguments: { skill: "manual", path: "references/details.md" } }], timestamp: number, stopReason: "tool_use" } : answer);
		}) });
		try {
			const ordinary = agent.runTurn("ordinary"); for await (const _ of ordinary) {}
			expect(await ordinary.result).toEqual({ status: "success" });
			const selected = agent.runTurn({ kind: "skill", name: "manual", task: "read details" }); for await (const _ of selected) {}
			expect(await selected.result).toEqual({ status: "success" });
			const results = sessionMessages(await storage.load()).filter(message => message.role === "toolResult");
			expect(results.find(message => message.toolCallId === "resource-1")?.isError).toBe(true);
			expect(JSON.stringify(results.find(message => message.toolCallId === "resource-1"))).not.toContain("MANUAL REFERENCE");
			expect(JSON.stringify(results.find(message => message.toolCallId === "resource-3"))).toContain("MANUAL REFERENCE");
		} finally { await agent.dispose(); }
	} finally { await rm(cwd, { recursive: true, force: true }); }
});
