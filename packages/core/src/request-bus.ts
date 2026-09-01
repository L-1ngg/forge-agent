import {
	request as makeRequest,
	type RequestEnvelopeUnion,
	type RequestKind,
	type RequestOutcome,
	type RequestPayloadByKind,
	type ResponseEnvelope,
	type ResponseResultByKind,
} from "@myh/protocol";

const DEFAULT_TIMEOUT_MS = 30_000;

export type RequestBusDropReason = "unknown_id" | "late_response" | "duplicate_response" | "invalid_response";

export interface DroppedResponse {
	response: unknown;
	reason: RequestBusDropReason;
	timestamp: number;
}

export interface RequestBusOptions {
	timeoutMs?: number;
	idPrefix?: string;
	idFactory?: (sequence: number, prefix: string) => string;
	now?: () => number;
	onDrop?: (record: DroppedResponse) => void;
}

export interface AskOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

interface QueueWaiter<T> {
	resolve(result: IteratorResult<T>): void;
}

class AsyncQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
	private readonly values: T[] = [];
	private readonly waiters: QueueWaiter<T>[] = [];
	private closed = false;

	push(value: T): boolean {
		if (this.closed) return false;
		const waiter = this.waiters.shift();
		if (waiter) waiter.resolve({ value, done: false });
		else this.values.push(value);
		return true;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
	}

	next(): Promise<IteratorResult<T>> {
		const value = this.values.shift();
		if (value !== undefined) return Promise.resolve({ value, done: false });
		if (this.closed) return Promise.resolve({ value: undefined, done: true });
		return new Promise((resolve) => this.waiters.push({ resolve }));
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return this;
	}
}

interface PendingRequest<K extends RequestKind> {
	kind: K;
	resolve(outcome: RequestOutcome<K>): void;
	timer?: ReturnType<typeof setTimeout>;
	signal?: AbortSignal;
	abortListener?: () => void;
}

function isResponseEnvelope(value: unknown): value is ResponseEnvelope {
	return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "response" && typeof (value as { id?: unknown }).id === "string";
}

function isValidResponseResult(kind: RequestKind, result: unknown): boolean {
	if (typeof result !== "object" || result === null || typeof (result as { decision?: unknown }).decision !== "string") return false;
	const decision = (result as { decision: string }).decision;
	switch (kind) {
		case "permission": {
			if (decision === "allow_once") return true;
			if (decision === "deny") return !("reason" in result) || typeof (result as { reason?: unknown }).reason === "string";
			if (decision !== "allow_always") return false;
			const scope = (result as { scope?: unknown }).scope;
			return (
				typeof scope === "object" &&
				scope !== null &&
				typeof (scope as { tool?: unknown }).tool === "string" &&
				(scope as { tool: string }).tool.length > 0 &&
				typeof (scope as { argsPattern?: unknown }).argsPattern === "string" &&
				(scope as { argsPattern: string }).argsPattern.length > 0
			);
		}
		case "cancel_confirm":
			return decision === "cancel" || decision === "keep_running";
		case "question":
			return decision === "cancel" || (decision === "answer" && Array.isArray((result as { answers?: unknown }).answers) && (result as { answers: unknown[] }).answers.every((answer) => typeof answer === "string"));
		case "plan_approval":
			return decision === "approve" || (decision === "reject" && (!("feedback" in result) || typeof (result as { feedback?: unknown }).feedback === "string"));
		case "oauth":
			return decision === "completed" || decision === "cancel";
	}
}

/**
 * Transport-neutral request/response coordination for blocking interactions.
 *
 * The bus owns request ids and pending state. A client consumes `requests()`
 * and calls `respond()`; core never needs a reference to that client.
 */
export class RequestBus {
	private readonly requestQueue = new AsyncQueue<RequestEnvelopeUnion>();
	private readonly responseQueue = new AsyncQueue<ResponseEnvelope>();
	private readonly terminalQueue = new AsyncQueue<RequestOutcome<RequestKind>>();
	private readonly pending = new Map<string, PendingRequest<RequestKind>>();
	private readonly settled = new Map<string, RequestOutcome<RequestKind>>();
	private readonly dropped: DroppedResponse[] = [];
	private readonly timeoutMs: number;
	private readonly idPrefix: string;
	private readonly idFactory: (sequence: number, prefix: string) => string;
	private readonly now: () => number;
	private readonly onDrop: ((record: DroppedResponse) => void) | undefined;
	private readonly idNamespace: string;
	private sequence = 0;
	private closed = false;

	constructor(options: RequestBusOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 0) throw new Error("Request bus timeoutMs must be a non-negative finite number");
		this.idNamespace = crypto.randomUUID();
		this.idPrefix = options.idPrefix ?? "r";
		this.idFactory = options.idFactory ?? ((sequence, prefix) => `${prefix}-${this.idNamespace}-${sequence}`);
		this.now = options.now ?? Date.now;
		this.onDrop = options.onDrop;
	}

	/** Stream of requests for the UI or another transport client. */
	requests(): AsyncIterable<RequestEnvelopeUnion> {
		return this.requestQueue;
	}

	get requestStream(): AsyncIterable<RequestEnvelopeUnion> {
		return this.requestQueue;
	}

	/** Stream of all responses submitted to the bus, including rejected ones. */
	responses(): AsyncIterable<ResponseEnvelope> {
		return this.responseQueue;
	}

	/** Stream of terminal outcomes so clients can retire timed-out cards. */
	terminals(): AsyncIterable<RequestOutcome<RequestKind>> {
		return this.terminalQueue;
	}

	get responseStream(): AsyncIterable<ResponseEnvelope> {
		return this.responseQueue;
	}

	get outgoingRequests(): AsyncIterable<RequestEnvelopeUnion> {
		return this.requests();
	}

	requestEvents(): AsyncIterable<RequestEnvelopeUnion> {
		return this.requests();
	}

	get incomingResponses(): AsyncIterable<ResponseEnvelope> {
		return this.responses();
	}

	responseEvents(): AsyncIterable<ResponseEnvelope> {
		return this.responses();
	}

	/**
	 * Create a request and wait for its single terminal outcome.
	 * Cancellation and timeout resolve as explicit outcomes rather than hanging.
	 */
	ask<K extends RequestKind>(kind: K, payload: RequestPayloadByKind[K], options: AskOptions = {}): Promise<RequestOutcome<K>> {
		const timeoutMs = options.timeoutMs ?? this.timeoutMs;
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError("Request timeoutMs must be a non-negative finite number");
		if (this.closed) {
			const id = this.allocateId();
			const outcome: RequestOutcome<K> = { status: "cancelled", requestId: id, reason: "bus_closed" };
			this.settled.set(id, outcome as RequestOutcome<RequestKind>);
			this.terminalQueue.push(outcome as RequestOutcome<RequestKind>);
			return Promise.resolve(outcome);
		}

		const id = this.allocateId();
		const envelope = makeRequest(id, kind, payload);
		return new Promise<RequestOutcome<K>>((resolve) => {
			const pending: PendingRequest<K> = { kind, resolve };
			this.pending.set(id, pending as PendingRequest<RequestKind>);

			if (options.signal?.aborted) {
				this.settleCancelled(id, pending, "aborted");
				return;
			}
			pending.timer = setTimeout(() => this.settleTimeout(id, pending), timeoutMs);

			if (options.signal) {
				pending.signal = options.signal;
				pending.abortListener = () => this.settleCancelled(id, pending, "aborted");
				options.signal.addEventListener("abort", pending.abortListener, { once: true });
				if (options.signal.aborted) {
					pending.abortListener();
					return;
				}
			}

			this.requestQueue.push(envelope);
		});
	}

	/** Convenience form for callers that only need the response result. */
	async askResult<K extends RequestKind>(kind: K, payload: RequestPayloadByKind[K], options: AskOptions = {}): Promise<ResponseResultByKind[K]> {
		const outcome = await this.ask(kind, payload, options);
		if (outcome.status === "response") return outcome.result;
		throw new RequestTerminalError(outcome);
	}

	/** Submit a UI/transport response. Returns false when it was dropped. */
	respond(response: unknown): boolean {
		if (isResponseEnvelope(response)) this.responseQueue.push(response);
		if (!isResponseEnvelope(response)) {
			this.recordDrop(response, "invalid_response");
			return false;
		}

		const pending = this.pending.get(response.id);
		if (!pending) {
			const previous = this.settled.get(response.id);
			this.recordDrop(response, previous ? (previous.status === "response" ? "duplicate_response" : "late_response") : "unknown_id");
			return false;
		}
		if (!isValidResponseResult(pending.kind, response.result)) {
			this.recordDrop(response, "invalid_response");
			return false;
		}

		const outcome: RequestOutcome<RequestKind> = { status: "response", requestId: response.id, result: response.result as ResponseResultByKind[RequestKind] };
		return this.settle(response.id, pending, outcome);
	}

	/** Alias used by transports that model the incoming side as `receive`. */
	receive(response: unknown): boolean {
		return this.respond(response);
	}

	submitResponse(response: unknown): boolean {
		return this.respond(response);
	}

	async consumeResponses(input: AsyncIterable<unknown>): Promise<void> {
		for await (const response of input) this.respond(response);
	}

	/** Cancel one pending request. */
	cancel(requestId: string): boolean {
		const pending = this.pending.get(requestId);
		return pending ? this.settleCancelled(requestId, pending, "cancelled") : false;
	}

	/** Cancel all requests belonging to the aborted turn. */
	abort(): number {
		let cancelled = 0;
		for (const [requestId, pending] of [...this.pending.entries()]) {
			if (this.settleCancelled(requestId, pending, "aborted")) cancelled++;
		}
		return cancelled;
	}

	/** Alias that makes the turn boundary explicit at call sites. */
	cancelPending(): number {
		return this.abort();
	}

	/** End the bus and cancel any remaining requests conservatively. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const [requestId, pending] of [...this.pending.entries()]) this.settleCancelled(requestId, pending, "bus_closed");
		this.requestQueue.close();
		this.responseQueue.close();
		this.terminalQueue.close();
	}

	isPending(requestId: string): boolean {
		return this.pending.has(requestId);
	}

	get pendingCount(): number {
		return this.pending.size;
	}

	getTerminal(requestId: string): RequestOutcome<RequestKind> | undefined {
		return this.settled.get(requestId);
	}

	getDroppedResponses(): readonly DroppedResponse[] {
		return this.dropped.map((record) => ({ ...record }));
	}

	private allocateId(): string {
		for (;;) {
			this.sequence++;
			const id = this.idFactory(this.sequence, this.idPrefix);
			if (!this.pending.has(id) && !this.settled.has(id)) return id;
			if (this.sequence >= 10_000) throw new RequestBusIdCollisionError(id);
		}
	}

	private settleTimeout<K extends RequestKind>(requestId: string, pending: PendingRequest<K>): boolean {
		return this.settle(requestId, pending as PendingRequest<RequestKind>, { status: "timeout", requestId });
	}

	private settleCancelled<K extends RequestKind>(requestId: string, pending: PendingRequest<K>, reason: "aborted" | "bus_closed" | "cancelled"): boolean {
		return this.settle(requestId, pending as PendingRequest<RequestKind>, { status: "cancelled", requestId, reason });
	}

	private settle(requestId: string, pending: PendingRequest<RequestKind>, outcome: RequestOutcome<RequestKind>): boolean {
		if (this.pending.get(requestId) !== pending) return false;
		this.pending.delete(requestId);
		if (pending.timer !== undefined) clearTimeout(pending.timer);
		if (pending.signal && pending.abortListener) pending.signal.removeEventListener("abort", pending.abortListener);
		this.settled.set(requestId, outcome);
		this.terminalQueue.push(outcome);
		pending.resolve(outcome);
		return true;
	}

	private recordDrop(response: unknown, reason: RequestBusDropReason): void {
		const record = { response, reason, timestamp: this.now() } satisfies DroppedResponse;
		this.dropped.push(record);
		try {
			this.onDrop?.(record);
		} catch {
			// A diagnostic callback must never change response semantics.
		}
	}
}

export class RequestBusIdCollisionError extends Error {
	readonly requestId: string;

	constructor(requestId: string) {
		super(`Request id collision: ${requestId}`);
		this.name = "RequestBusIdCollisionError";
		this.requestId = requestId;
	}
}

export class RequestTerminalError extends Error {
	readonly outcome: RequestOutcome<RequestKind>;

	constructor(outcome: RequestOutcome<RequestKind>) {
		super(`Request ${outcome.requestId} ended with ${outcome.status}`);
		this.name = "RequestTerminalError";
		this.outcome = outcome;
	}
}

/** Map a cancelled/timeout permission request to the conservative deny result. */
export function permissionResultFromOutcome(outcome: RequestOutcome<"permission">): ResponseResultByKind["permission"] {
	if (outcome.status === "response") return outcome.result;
	return { decision: "deny", reason: `Permission request ${outcome.status}: ${outcome.requestId}` };
}
