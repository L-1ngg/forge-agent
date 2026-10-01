import { dumpFrame, type App } from "../../packages/tui/src/index.ts";
import { bounded, nextTurn, waitFor } from "./control.ts";

/** Fixture-only synchronization. Input still travels through the actual PTY. */
export function installPtyControl(app: Pick<App, "composeFrameForTest">, onCapture?: (frame: ReturnType<typeof dumpFrame>) => void): () => void {
	let expected = Buffer.alloc(0), received = Buffer.alloc(0);
	let consumed: Promise<void> = Promise.resolve();
	let release: (() => void) | undefined;
	const onData = (bytes: Buffer) => {
		if (!release) return;
		received = Buffer.concat([received, bytes]);
		if (received.length >= expected.length) { release(); release = undefined; }
	};
	const onMessage = async (message: unknown) => {
		if (!message || typeof message !== "object" || !("ptyRequest" in message) || !("command" in message)) return;
		const request = message as { ptyRequest: number; command: string; bytes?: string; columns?: number; rows?: number };
		try {
			let frame: ReturnType<typeof dumpFrame> | undefined;
			if (request.command === "arm") {
				expected = Buffer.from(request.bytes!, "base64"); received = Buffer.alloc(0);
				consumed = new Promise(resolve => { release = resolve; });
			} else if (request.command === "consumed") {
				await bounded(consumed, "PTY input consumed");
				if (!received.equals(expected)) throw new Error("PTY input differs from the armed byte sequence");
				// Host intentionally waits 25 ms to disambiguate a trailing bare Escape.
				if (expected.at(-1) === 27) await Bun.sleep(30);
				await nextTurn();
			} else if (request.command === "resized") {
				await waitFor(() => process.stdout.columns === request.columns && process.stdout.rows === request.rows, "PTY dimensions applied");
				await nextTurn();
			} else if (request.command === "capture") {
				await nextTurn(); frame = dumpFrame(app.composeFrameForTest()); onCapture?.(frame);
			} else if (request.command === "drain") {
				await nextTurn();
			} else throw new Error(`Unknown PTY request: ${request.command}`);
			const marker = `\x1b]777;forge-test-${request.ptyRequest}\x07`;
			process.stdout.write(marker);
			process.send?.({ ptyReply: request.ptyRequest, marker, ...(frame ? { frame } : {}) });
		} catch (error) { process.send?.({ ptyReply: request.ptyRequest, error: String(error) }); }
	};
	process.stdin.on("data", onData); process.on("message", onMessage);
	return () => { process.stdin.off("data", onData); process.off("message", onMessage); };
}
