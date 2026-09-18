import { Trace, bounded } from "./scenario.ts";

export interface Exchange {
	id: string;
	method: string;
	path: string;
	match(body: unknown): void;
	response: {
		status?: number;
		headers?: Record<string, string>;
		chunks: Array<string | Uint8Array>;
		beforeChunk?: (index: number) => Promise<void>;
		end?: "close" | "disconnect" | "hold";
	};
}

/** Strict in-order replay. A miss never falls through to any network provider. */
export class HttpFixture {
	private readonly server: ReturnType<typeof Bun.serve>;
	private cursor = 0;
	private readonly errors: Error[] = [];
	private readonly controllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
	private readonly requests: unknown[] = [];
	private headerRequests = 0;
	private readonly waiters = new Map<string, () => void>();
	private closed = false;
	constructor(readonly id: string, private readonly exchanges: readonly Exchange[], readonly trace = new Trace()) {
		this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => this.fetch(request) });
	}
	get url(): string { return this.server.url.toString(); }
	get count(): number { return this.requests.length; }
	async received(count: number, stage: "headers" | "body" = "body"): Promise<void> {
		if ((stage === "headers" ? this.headerRequests : this.count) >= count) return;
		const key = `${stage}:${count}`;
		try { await bounded(new Promise<void>(resolve => { this.waiters.set(key, resolve); }), `${this.id}/request:${key}`); }
		finally { this.waiters.delete(key); }
	}
	private async fetch(request: Request): Promise<Response> {
		this.waiters.get(`headers:${++this.headerRequests}`)?.();
		let label = `${this.id}/request-body`;
		try {
			const body = await request.json();
			// Complete request bodies are matched atomically in arrival order. Never
			// capture the cursor across an await: concurrent requests could reuse it.
			const exchange = this.exchanges[this.cursor];
			label = `${this.id}/${exchange?.id ?? "exhausted"}`;
			this.requests.push(body);
			this.trace.record("request", { fixture: label, method: request.method, path: new URL(request.url).pathname, body });
			this.waiters.get(`body:${this.count}`)?.();
			if (!exchange) throw new Error("Unexpected request: script exhausted");
			if (request.method !== exchange.method || new URL(request.url).pathname !== exchange.path) throw new Error(`Unexpected ${request.method} ${new URL(request.url).pathname}`);
			exchange.match(body);
			this.cursor++;
			const response = exchange.response;
			const stream = new ReadableStream<Uint8Array>({
				start: controller => {
					this.controllers.add(controller);
					void (async () => {
						try {
							for (const [index, chunk] of response.chunks.entries()) {
								await response.beforeChunk?.(index);
								if (this.closed || request.signal.aborted || !this.controllers.has(controller)) return;
								controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
								this.trace.record("send", { fixture: label, index });
							}
							if (response.end === "hold") return;
							if (response.end === "disconnect") controller.error(new Error("Fixture connection interrupted"));
							else controller.close();
							this.controllers.delete(controller);
						} catch (error) {
							if (!this.closed && !request.signal.aborted) this.errors.push(new Error(`${label}: ${error}`, { cause: error }));
							if (this.controllers.delete(controller)) controller.error(error);
						}
					})();
				},
				cancel: () => { this.trace.record("cancel", label); },
			});
			return new Response(stream, { status: response.status ?? 200, headers: response.headers ?? { "content-type": "text/event-stream" } });
		} catch (cause) {
			this.errors.push(new Error(`${label}: ${cause}`, { cause }));
			return Response.json({ error: { message: `Fixture mismatch: ${label}` } }, { status: 400 });
		}
	}
	assertComplete(): void {
		if (this.errors.length) throw new AggregateError(this.errors, this.errors.map(error => error.message).join("\n"));
		if (this.cursor !== this.exchanges.length) throw new Error(`${this.id}: missing exchanges: ${this.exchanges.slice(this.cursor).map(step => step.id).join(", ")}`);
	}
	close(): void {
		this.closed = true;
		for (const controller of this.controllers) { try { controller.close(); } catch { /* Already canceled by the client. */ } }
		this.controllers.clear();
		this.server.stop(true);
	}
}
