import { expect, test } from "bun:test";
import { LongTermMemory, type MemoryOptions } from "@forge-agent/core/sdk";
import { App, frameToText } from "@forge-agent/tui";
import { TestInput, TestOutput } from "../../../tests/support/app-driver.ts";
import { barrier, nextTurn, waitFor } from "../../../tests/support/control.ts";
import { withScenario } from "../../../tests/support/scenario.ts";
import { interactionOptions } from "../src/interaction-options.ts";
import { MemoryManager } from "../src/memory-command.ts";
import { SessionHost } from "../src/session-host.ts";

for (const kind of ["memory", "skills", "mcp"] as const) test(`production ${kind} callback remains bound to its original SDK instance after switching`, async () => withScenario(`production ${kind} captured instance`, async scenario => {
	const cwd = scenario.cwd, gate = barrier("old SDK operation"), started = barrier("SDK operation started");
	const memory: MemoryOptions = { store: new LongTermMemory({ project: cwd }), autoUpdate: false, injection: false };
	const manager = new MemoryManager(memory);
	const sessions = await SessionHost.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "fixture", systemPrompt: "test", memory });
	scenario.defer(() => sessions.dispose());
	const original = sessions.current, oldPort = original.port;
	let oldCalls = 0, newCalls = 0;
	if (kind === "memory") {
		const apply = oldPort.updateConfiguration.bind(oldPort);
		oldPort.updateConfiguration = async options => { oldCalls++; started.release(); await gate.wait(); return apply(options); };
	} else if (kind === "skills") {
		const refresh = oldPort.refreshSkills.bind(oldPort);
		oldPort.refreshSkills = async () => { oldCalls++; started.release(); await gate.wait(); return refresh(); };
	} else {
		oldPort.mcp.listResources = async (_server, options) => { oldCalls++; started.release(); await gate.wait(); expect(options?.signal?.aborted).toBe(true); return []; };
	}
	const input = new TestInput(), output = new TestOutput(110, 32);
	const app = new App({ ...interactionOptions(cwd, { systemPrompt: "test", thinkingLevel: "off", permissionMode: "default", ui: { host: "alt" } }, manager), port: oldPort, requestBus: original.requestBus, sessions, host: "alt", cwd, homeDir: cwd, stdin: input, stdout: output });
	scenario.defer(() => app.stop());
	try {
		await app.start();
		input.send(kind === "memory" ? "/memory auto on\r" : kind === "skills" ? "/skills reload\r" : "/mcp resources fixture\r");
		await started.wait(); input.send("/new\r"); await waitFor(() => sessions.current.id !== original.id, "new SDK activated");
		const current = sessions.current.port;
		const apply = current.updateConfiguration.bind(current), refresh = current.refreshSkills.bind(current);
		current.updateConfiguration = async options => { newCalls++; return apply(options); };
		current.refreshSkills = async () => { newCalls++; return refresh(); };
		current.mcp.listResources = async () => { newCalls++; return []; };
		gate.release(); await nextTurn(); await nextTurn();
		expect(oldCalls).toBe(1); expect(newCalls).toBe(0);
		expect(memory.autoUpdate).toBe(false);
		expect(frameToText(app.composeFrameForTest())).not.toContain("auto=on");
		expect(frameToText(app.composeFrameForTest())).not.toContain('"command": "resources"');
	} finally { gate.release(); }
}));
