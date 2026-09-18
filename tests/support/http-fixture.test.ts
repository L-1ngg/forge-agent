import { expect, test } from "bun:test";
import { HttpFixture } from "./http-fixture.ts";
import { connect } from "node:net";
import { bounded } from "./scenario.ts";

test("strict HTTP replay rejects mismatched bodies and reports missing exchanges", async () => {
	const fixture = new HttpFixture("strict-body", [{
		id: "answer", method: "POST", path: "/messages",
		match(body) { expect(body).toEqual({ input: "expected" }); },
		response: { chunks: ["ok"], headers: { "content-type": "text/plain" } },
	}]);
	try {
		const response = await fetch(`${fixture.url}messages`, { method: "POST", body: JSON.stringify({ input: "wrong" }) });
		expect(response.status).toBe(400);
		expect(() => fixture.assertComplete()).toThrow("strict-body/answer");
	} finally { fixture.close(); }
});

test("concurrent requests cannot both consume the same exchange and hide a missing request", async () => {
	const fixture = new HttpFixture("concurrent", ["first", "second"].map(input => ({ id: input, method: "POST", path: "/messages", match(body: unknown) { expect(body).toEqual({ input }); }, response: { chunks: ["ok"] } })));
	const sockets: ReturnType<typeof connect>[] = [];
	try {
		const body = JSON.stringify({ input: "first" });
		const pending = await Promise.all([0, 1].map(() => new Promise<{ done: Promise<string>; send(): void }>((resolve, reject) => {
			const socket = connect({ host: "127.0.0.1", port: Number(new URL(fixture.url).port) }); sockets.push(socket);
			let output = "";
			const done = new Promise<string>((resolveDone, rejectDone) => { socket.on("data", bytes => { output += bytes.toString(); }); socket.on("end", () => resolveDone(output)); socket.on("error", rejectDone); });
			socket.on("error", reject);
			socket.on("connect", () => {
				socket.write(`POST /messages HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n`);
				resolve({ done, send: () => { socket.write(body); } });
			});
		})));
		// Both headers are submitted before either body. Exercise the await request.json boundary.
		await fixture.received(2, "headers");
		for (const request of pending) request.send();
		const responses = await bounded(Promise.all(pending.map(request => request.done)), "concurrent requests");
		expect(responses.filter(response => response.startsWith("HTTP/1.1 200"))).toHaveLength(1);
		expect(() => fixture.assertComplete()).toThrow("concurrent/second");
	} finally { for (const socket of sockets) socket.destroy(); fixture.close(); }
});

test("strict replay fails on missing, extra and wrong-path requests", async () => {
	for (const mode of ["missing", "extra", "path"] as const) {
		const fixture = new HttpFixture(mode, [{ id: "one", method: "POST", path: "/messages", match(body) { expect(body).toEqual({}); }, response: { chunks: ["ok"] } }]);
		try {
			if (mode !== "missing") await fetch(`${fixture.url}${mode === "path" ? "wrong" : "messages"}`, { method: "POST", body: "{}" });
			if (mode === "extra") await fetch(`${fixture.url}messages`, { method: "POST", body: "{}" });
			expect(() => fixture.assertComplete()).toThrow(mode === "missing" ? "missing exchanges: one" : mode === "extra" ? "exhausted" : "Unexpected POST /wrong");
		} finally { fixture.close(); }
	}
});

test("complete replay preserves byte contents and counts requests", async () => {
	const fixture = new HttpFixture("complete", [{ id: "one", method: "POST", path: "/messages", match(body) { expect(body).toEqual({ input: "你好" }); }, response: { chunks: [new Uint8Array([228, 189]), new Uint8Array([160, 229, 165, 189])] } }]);
	try {
		const response = await fetch(`${fixture.url}messages`, { method: "POST", body: JSON.stringify({ input: "你好" }) });
		expect(await response.text()).toBe("你好");
		expect(fixture.count).toBe(1);
		fixture.assertComplete();
	} finally { fixture.close(); }
});
