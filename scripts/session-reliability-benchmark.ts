import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestBus, SessionStore, messageEntry } from "../packages/core/src/index.ts";
import type { SessionMessage } from "../packages/protocol/src/index.ts";
import { App } from "../packages/tui/src/app.ts";
import { createFrame } from "../packages/tui/src/frame.ts";
import { createTheme } from "../packages/tui/src/theme.ts";
import { TranscriptBrowser } from "../packages/tui/src/transcript/browser.ts";
import { TranscriptProjector } from "../packages/tui/src/transcript/projector.ts";

const samples = 7;
function fixture(count: number): SessionMessage[] {
	return Array.from({ length: count }, (_, index) => {
		const timestamp = 1_700_000_000_000 + index;
		switch (index % 5) {
			case 0: return { role: "user", timestamp, content: [{ type: "text", text: `Inspect module ${index}. Preserve its existing contract and report evidence.` }] };
			case 1: return { role: "assistant", timestamp, stopReason: "stop", content: [{ type: "text", text: `## Module ${index}\n\nA **stable** interface with [source](src/module-${index}.ts).\n\n- Preserve inputs\n- Validate results\n\n| Field | Value |\n| --- | --- |\n| revision | ${index} |\n\n\`\`\`ts\nexport function module${index}(value: string) {\n  return value.trim();\n}\n\`\`\`\n` }] };
			case 2: return { role: "assistant", timestamp, stopReason: "stop", content: [{ type: "thinking", thinking: `Check the ownership and submission boundary for module ${index}.`, thinkingSignature: `signature-${index}` }] };
			case 3: return { role: "assistant", timestamp, stopReason: "tool_use", content: [{ type: "tool_call", id: `call-${index}`, name: "read", arguments: { path: `src/module-${index}.ts` } }] };
			default: return { role: "toolResult", timestamp, toolCallId: `call-${index - 1}`, toolName: "read", content: [{ type: "text", text: `export const revision = ${index};\n// retained original evidence` }], isError: false, details: null };
		}
	});
}
function measure(action: () => unknown, runs = samples) {
	const values: number[] = [];
	for (let index = 0; index < runs; index++) { const start = performance.now(); action(); values.push(performance.now() - start); }
	return { medianMs: [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!, samplesMs: values };
}

const root = await mkdtemp(join(tmpdir(), "forge-reliability-bench-"));
try {
	const fixtures = [];
	for (const count of [100, 1000]) {
		const history = fixture(count);
		const projector = new TranscriptProjector();
		for (const message of history) projector.apply({ type: "message_end", message, timestamp: message.timestamp });
		const browser = new TranscriptBrowser(projector, createTheme({ mode: "truecolor" }));
		const coldLayout = measure(() => browser.update(100, 24), 1);
		browser.update(100, 24);
		const hotLayout = measure(() => browser.update(100, 24));
		const layoutAndPaint = measure(() => { browser.update(100, 24); browser.paint(createFrame(100, 24), 0, false); });
		const bus = new RequestBus({ timeoutMs: null });
		const app = new App({ history, port: { runTurn() { throw new Error("Benchmark never requests a model"); } }, requestBus: bus, host: "alt", cwd: "/fixture", homeDir: "/fixture", stdout: { columns: 100, rows: 24, write() {} }, env: { COLORTERM: "truecolor" } });
		const coldFrame = measure(() => app.composeFrameForTest(), 1);
		app.composeFrameForTest();
		const hotFrame = measure(() => app.composeFrameForTest());
		projector.apply({ type: "message_start", message: { role: "assistant", timestamp: 1_800_000_000_000, content: [] }, timestamp: 1_800_000_000_000 });
		const streaming = measure(() => { projector.apply({ type: "message_delta", contentIndex: 0, contentType: "text", delta: "next word ", timestamp: 1_800_000_000_001 }); browser.update(100, 24); browser.paint(createFrame(100, 24), 0, false); });
		const store = SessionStore.create(join(root, `${count}.jsonl`), root);
		for (const message of history) await store.append(messageEntry(message, store.getLeafId()));
		store.messages();
		const historyQuery = measure(() => store.messages());
		bus.close();
		fixtures.push({ count, sha256: createHash("sha256").update(JSON.stringify(history)).digest("hex"), coldLayout, hotLayout, layoutAndPaint, coldFrame, hotFrame, streaming, historyQuery });
	}
	const report = { fixtureVersion: 1, bun: Bun.version, platform: process.platform, arch: process.arch, viewport: { columns: 100, rows: 24 }, samples, fixtures };
	const output = process.argv.indexOf("--output");
	if (output !== -1) await Bun.write(process.argv[output + 1]!, JSON.stringify(report, null, 2) + "\n");
	console.log(JSON.stringify(report, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
