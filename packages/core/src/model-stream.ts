import type { AssistantMessage, AssistantMessageEvent } from "./model-types.ts";
export type { AssistantMessage, AssistantMessageEvent } from "./model-types.ts";

export class EventStream<T, R = T> implements AsyncIterable<T> {
	private readonly queue: T[] = [];
	private readonly waiting: Array<(value: IteratorResult<T>) => void> = [];
	private done = false;
	private readonly finalResult: Promise<R>;
	private readonly resolveResult: (result: R) => void;

	constructor(private readonly isComplete: (event: T) => boolean, private readonly extractResult: (event: T) => R) {
		let resolve!: (result: R) => void;
		this.finalResult = new Promise<R>(settle => { resolve = settle; });
		this.resolveResult = resolve;
	}

	push(event: T): void {
		if (this.done) return;
		if (this.isComplete(event)) { this.done = true; this.resolveResult(this.extractResult(event)); }
		const waiter = this.waiting.shift();
		if (waiter) waiter({ value: event, done: false });
		else this.queue.push(event);
		if (this.done) this.wakeWaiting();
	}

	end(result: R): void {
		if (this.done) return;
		this.done = true;
		this.resolveResult(result);
		this.wakeWaiting();
	}

	private wakeWaiting(): void {
		for (const waiter of this.waiting.splice(0)) waiter({ value: undefined, done: true });
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length) yield this.queue.shift()!;
			else if (this.done) return;
			else {
				const next = await new Promise<IteratorResult<T>>(resolve => this.waiting.push(resolve));
				if (next.done) return;
				yield next.value;
			}
		}
	}

	result(): Promise<R> { return this.finalResult; }
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(event => event.type === "done" || event.type === "error", event => {
			if (event.type === "done") return event.message;
			if (event.type === "error") return event.error;
			throw new Error("Unexpected non-terminal event");
		});
	}
}

export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
