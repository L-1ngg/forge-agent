import { response, type RequestEnvelopeFor, type RequestKind, type ResponseEnvelope, type ResponseResultByKind, type SessionEvent } from "@myh/protocol";
import type { AgentPort, RequestBus } from "@myh/core";

export const HEADLESS_REQUEST_EXIT_CODES: Record<RequestKind, number> = {
	permission: 20,
	cancel_confirm: 21,
	question: 22,
	plan_approval: 23,
	oauth: 24,
};

const HEADLESS_INTERACTION_REASON = "Interactive request is not available in headless mode";

export interface HeadlessRequestDecision<K extends RequestKind = RequestKind> {
	response: ResponseEnvelope<ResponseResultByKind[K]>;
	exitCode: number;
}

/** Return the deterministic conservative response for a blocking request. */
export function headlessRequestDecision<K extends RequestKind>(request: RequestEnvelopeFor<K>): HeadlessRequestDecision<K> {
	const exitCode = HEADLESS_REQUEST_EXIT_CODES[request.kind];
	switch (request.kind) {
		case "permission":
			return { response: response(request.id, { decision: "deny", reason: HEADLESS_INTERACTION_REASON }), exitCode } as HeadlessRequestDecision<K>;
		case "cancel_confirm":
			return { response: response(request.id, { decision: "cancel" }), exitCode } as HeadlessRequestDecision<K>;
		case "question":
			return { response: response(request.id, { decision: "cancel" }), exitCode } as HeadlessRequestDecision<K>;
		case "plan_approval":
			return { response: response(request.id, { decision: "reject", feedback: HEADLESS_INTERACTION_REASON }), exitCode } as HeadlessRequestDecision<K>;
		case "oauth":
			return { response: response(request.id, { decision: "cancel" }), exitCode } as HeadlessRequestDecision<K>;
	}
}

export const headlessResponseFor = headlessRequestDecision;

export interface RunHeadlessOptions {
	requestBus?: RequestBus;
}

type HeadlessOutput = (line: string) => void;
type HeadlessPort = Pick<AgentPort, "runTurn">;

export function runHeadless(port: HeadlessPort, prompt: string, output?: HeadlessOutput, options?: RunHeadlessOptions): Promise<number>;
export function runHeadless(port: HeadlessPort, prompt: string, options?: RunHeadlessOptions): Promise<number>;
export async function runHeadless(
	port: HeadlessPort,
	prompt: string,
	outputOrOptions: HeadlessOutput | RunHeadlessOptions | undefined = console.log,
	maybeOptions: RunHeadlessOptions = {},
): Promise<number> {
	const output = typeof outputOrOptions === "function" ? outputOrOptions : console.log;
	const options = typeof outputOrOptions === "function" ? maybeOptions : (outputOrOptions ?? maybeOptions);
	let requestExitCode = 0;
	let runExitCode = 0;
	const responder = options.requestBus
		? (async () => {
				for await (const request of options.requestBus!.requests()) {
					const decision = headlessRequestDecision(request);
					if (requestExitCode === 0) requestExitCode = decision.exitCode;
					options.requestBus!.respond(decision.response);
				}
		  })()
		: undefined;
	try {
		for await (const event of port.runTurn(prompt)) {
			if (event.type === "turn_end" || event.type === "message_end") {
				const reason = event.type === "turn_end" ? event.stopReason : event.message.stopReason;
				if (reason === "error") runExitCode = 1;
				else if (reason === "aborted" && runExitCode === 0) runExitCode = 130;
			}
			output(JSON.stringify(event));
		}
	} finally {
		if (options.requestBus) options.requestBus.close();
		await responder;
	}
	return requestExitCode || runExitCode;
}

export function jsonError(message: string, code = "CONFIGURATION_ERROR"): string {
	return JSON.stringify({ type: "error", error_code: code, message });
}

export type HeadlessEvent = SessionEvent;
