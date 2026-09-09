import { App, type AppPort, type AppRequestBus } from "../packages/tui/src/index.ts";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
	console.error("Run in an interactive terminal: bun scripts/markdown-preview.ts");
	process.exit(1);
}
const markdown = await Bun.file(new URL("./fixtures/markdown-preview.md", import.meta.url)).text();
let aborted = false;
const port: AppPort = {
	async *runTurn() {
		aborted = false;
		const timestamp = Date.now();
		yield { type: "message_start", timestamp, message: { role: "assistant", content: [], timestamp } };
		let received = "";
		for (let offset = 0; offset < markdown.length && !aborted; offset += 12) {
			const delta = markdown.slice(offset, offset + 12);
			received += delta;
			yield { type: "message_delta", timestamp: Date.now(), contentIndex: 0, contentType: "text", delta };
			await Bun.sleep(60);
		}
		yield { type: "message_end", timestamp: Date.now(), message: { role: "assistant", content: [{ type: "text", text: received }], timestamp } };
	},
	abort() { aborted = true; },
};
const requestBus: AppRequestBus = { async *requests() {}, async *terminals() {}, respond() { return false; }, close() {} };
const app = new App({ port, requestBus, host: "alt", cwd: process.cwd(), homeDir: process.env.HOME ?? "", history: [
	{ role: "assistant", content: [{ type: "text", text: markdown }], timestamp: Date.now() },
] });
await app.start();
await app.waitUntilStopped();
