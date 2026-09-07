import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, dumpFrame } from "../../packages/tui/src/index.ts";
import { createAgent, createInputCompletionSource, createPiTestPort, RequestBus, SessionStore } from "../../packages/core/src/index.ts";
import { builtinTools } from "../../packages/tools/src/index.ts";
import type { PermissionContext } from "../../packages/core/src/permission/index.ts";

const directory = await mkdtemp(join(tmpdir(), "forge-main-workflow-"));
for (let file = 0; file < 10; file++) {
	await writeFile(join(directory, `sample-${file}.ts`), Array.from({ length: 90 }, (_, line) => `FILE_${file}_LINE_${line + 1} ${line === 32 ? "中文内容" : "const value = true;"}`).join("\n"));
}
const bus = new RequestBus({ timeoutMs: null });
const permission: PermissionContext = { rules: builtinTools.map((tool) => ({ tool: tool.name, argsPattern: "*", effect: "allow" })) };
const store = await SessionStore.open(join(directory, "session.jsonl"), directory);
const agent = await createAgent({
	provider: "faux", model: "faux-1", systemPrompt: "TUI workflow fixture", thinkingLevel: "off",
	storage: store.asStorage(), cwd: directory, tools: builtinTools, permission, requestBus: bus,
}, async (options) => createPiTestPort({
	...options, tools: builtinTools, permission, requestBus: bus, cwd: directory,
	responses: [
		{ text: "I will inspect the project files before making the change.", toolCalls: Array.from({ length: 10 }, (_, index) => ({ id: `read-${index}`, name: "read", arguments: { path: index === 9 ? "missing.ts" : `sample-${index}.ts`, offset: 11, limit: 70 } })) },
		{ text: "The sample files are ready. One optional file was not found." },
		{ text: "I will update the sample, check the command output, and write the result.", toolCalls: [
			{ id: "edit", name: "edit", arguments: { path: "sample-0.ts", old_text: "FILE_0_LINE_1 ", new_text: "UPDATED_LINE_1 " } },
			{ id: "run", name: "bash", arguments: { command: "printf 'EXECUTE_OUTPUT\\n'", description: "Check preview response" } },
			{ id: "write", name: "write", arguments: { path: "created.txt", content: "GENERIC_TOOL_BODY" } },
		] },
		{ text: "The sample is updated and the command completed successfully." },
	],
}));
const app = new App({
	port: { async *runTurn(input) { yield* agent.runTurn(input); process.send?.({ completed: input }); }, abort() { agent.abort(); } },
	host: "alt", requestBus: bus, cwd: directory, homeDir: directory, showWelcome: true,
	...(process.connected ? { stdout: process.stdout } : {}),
	getStatus: () => ({ provider: "faux", model: "faux-1" }),
	completionSource: createInputCompletionSource({ commands: [{ name: "help", description: "Commands" }], listFiles: async () => [] }),
});
const capture = (message: unknown) => {
	if (message === "capture") process.send?.({ frame: dumpFrame(app.composeFrameForTest()) });
};
process.on("message", capture);
try {
	await app.start(); process.send?.("ready");
	await app.waitUntilStopped();
} finally {
	await agent.dispose();
	await rm(directory, { recursive: true, force: true });
	process.off("message", capture);
	process.send?.({ raw: process.stdin.isRaw });
	if (process.connected) process.disconnect?.();
}
