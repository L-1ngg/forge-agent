import type { SessionEvent } from "@myh/protocol";
import type { AgentPort } from "@myh/core";

export async function runHeadless(port: AgentPort, prompt: string, output: (line: string) => void = console.log): Promise<void> {
	for await (const event of port.runTurn(prompt)) output(JSON.stringify(event));
}

export function jsonError(message: string, code = "CONFIGURATION_ERROR"): string {
	return JSON.stringify({ type: "error", error_code: code, message });
}

export type HeadlessEvent = SessionEvent;
