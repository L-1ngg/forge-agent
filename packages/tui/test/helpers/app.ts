import { type RequestEnvelopeUnion, type RequestKind, type RequestOutcome, type ResponseEnvelope, type SessionEvent, type SessionMessage } from "@forge-agent/protocol";
import { scriptedTurn } from "../../../../tests/support/turn.ts";
import { App, type AppCompletionSource, type AppPort, type AppRequestBus } from "../../src/index.ts";

import { afterEach } from "bun:test";
import { TestInput as FakeInput, TestOutput as FakeOutput } from "../../../../tests/support/app-driver.ts";
const active = new Set<App>();
afterEach(async () => { const apps = [...active]; active.clear(); const results = await Promise.allSettled(apps.map(app => app.stop())); const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []); if (errors.length) throw new AggregateError(errors, "App cleanup failed"); });

export class FakeBus implements AppRequestBus {
	acceptResponses = true;
	private closed = false;
	readonly responses: ResponseEnvelope[] = [];
	private readonly envelopes: RequestEnvelopeUnion[] = [];
	private readonly terminalOutcomes: RequestOutcome<RequestKind>[] = [];
	private notify: (() => void) | undefined;
	private notifyTerminal: (() => void) | undefined;

	push(envelope: RequestEnvelopeUnion): void {
		this.envelopes.push(envelope);
		this.notify?.();
	}

	pushTerminal(outcome: RequestOutcome<RequestKind>): void {
		this.terminalOutcomes.push(outcome);
		this.notifyTerminal?.();
	}

	respond(value: unknown): boolean {
		this.responses.push(value as ResponseEnvelope);
		return this.acceptResponses;
	}

	close(): void {
		this.closed = true;
		this.notify?.();
		this.notifyTerminal?.();
	}

	getTerminal(id: string): RequestOutcome<RequestKind> | undefined {
		return this.terminalOutcomes.find((outcome) => outcome.requestId === id);
	}

	async *requests(): AsyncIterable<RequestEnvelopeUnion> {
		let index = 0;
		while (!this.closed) {
			if (index < this.envelopes.length) {
				yield this.envelopes[index]!;
				index++;
			} else {
				await new Promise<void>((resolve) => {
					this.notify = resolve;
				});
			}
		}
	}

	async *terminals(): AsyncIterable<RequestOutcome<RequestKind>> {
		let index = 0;
		while (!this.closed) {
			if (index < this.terminalOutcomes.length) {
				yield this.terminalOutcomes[index]!;
				index++;
			} else {
				await new Promise<void>((resolve) => {
					this.notifyTerminal = resolve;
				});
			}
		}
	}
}

export function fakePort(events: SessionEvent[]): AppPort {
	return {
		runTurn() { return scriptedTurn((async function* (): AsyncIterable<SessionEvent> {
			for (const event of events) yield event;
		})()); },
	};
}

export function createApp(options: { port?: AppPort; bus?: FakeBus; completionSource?: AppCompletionSource; showWelcome?: boolean; history?: readonly SessionMessage[] } = {}) {
	const input = new FakeInput();
	const output = new FakeOutput();
	const bus = options.bus ?? new FakeBus();
	const app = new App({
		port: options.port ?? fakePort([]),
		host: "alt",
		requestBus: bus,
		cwd: "/tmp/proj",
		homeDir: "/tmp",
		getStatus: () => ({ provider: "faux", model: "faux-1" }),
		stdin: input,
		stdout: output,
		env: { COLORTERM: "truecolor" },
		...(options.completionSource ? { completionSource: options.completionSource } : {}),
		...(options.showWelcome ? { showWelcome: true } : {}),
		...(options.history ? { history: options.history } : {}),
	});
	active.add(app);
	return { app, input, output, bus };
}
