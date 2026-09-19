import { InMemoryCredentialStore, getSupportedThinkingLevels, isRetryableAssistantError, isContextOverflow, type AssistantMessage } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { thinkingBudgetForLevel } from "@earendil-works/pi-ai/api/simple-options";
import type { SessionMessage } from "@forge-agent/protocol";
import { randomUUID } from "node:crypto";
import { fromSessionMessage, toSessionMessage } from "./event-projection.ts";
import { SUMMARY_SYSTEM, resolveRetryPolicy, validateRequestLimits, type SummaryDriver } from "./context/compaction.ts";
import type { SessionAssembly } from "./configuration.ts";
import type { PiPortOptions, ModelPortOptions } from "./pi-port.ts";
import { validateSessionTools } from "./session-tools.ts";

/** Prepared configuration owns no execution resources. The session binds tools at application. */
export async function prepareSessionConfiguration(options: PiPortOptions): Promise<SessionAssembly> {
	const configuration = snapshotConfiguration(options);
	if (typeof configuration.systemPrompt !== "string" || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(configuration.thinkingLevel)) throw new Error("Invalid model configuration");
	validateSessionTools(configuration);
	const resolved = await resolveModelOptions(configuration);
	return { options: resolved, driver: createSummaryDriver(resolved) };
}

async function resolveModelOptions(options: PiPortOptions): Promise<ModelPortOptions> {
	resolveRetryPolicy(options.retry);
	validateRequestLimits(options);
	const credentials = new InMemoryCredentialStore();
	const apiKey = options.apiKey;
	if (apiKey) await credentials.modify(options.provider, async () => ({ type: "api_key", key: apiKey }));
	const models = builtinModels({ credentials });
	const catalogModel = models.getModel(options.provider, options.model);
	if (!catalogModel) throw new Error(`Unknown model ${options.provider}/${options.model}`);
	if (!await models.checkAuth(options.provider)) {
		throw new Error(`Provider is not configured: ${options.provider}. Set apiKey in .forge-agent/config.json, FORGE_AGENT_API_KEY, or the provider's API key environment variable.`);
	}
	const model = options.baseUrl ? { ...catalogModel, baseUrl: options.baseUrl } : catalogModel;
	return { ...options, sessionId: options.sessionId ?? randomUUID(), model, stream: models.streamSimple.bind(models) };
}

export function createSummaryDriver(options: ModelPortOptions): SummaryDriver & { isOverflow(message: SessionMessage): boolean } {
	const summaryThinking = (requested: "inherit" | "off") => requested === "off" && !getSupportedThinkingLevels(options.model).includes("off")
		? { level: options.thinkingLevel, fallback: "Model does not support reasoning off; inherited task reasoning" }
		: { level: requested === "off" ? "off" as const : options.thinkingLevel };
	return {
		maxTokens: options.model.maxTokens,
		outputTokens(requested, reasoning) {
			const level = summaryThinking(reasoning).level;
			const compat: unknown = Reflect.get(options.model, "compat");
			const adaptiveThinking = !!compat && typeof compat === "object" && "forceAdaptiveThinking" in compat && compat.forceAdaptiveThinking === true;
			const budgeted = options.model.api === "anthropic-messages" || (options.model.api === "bedrock-converse-stream" && options.model.id.includes("anthropic"));
			return Math.min(options.model.maxTokens, requested + (budgeted && level !== "off" && !adaptiveThinking ? thinkingBudgetForLevel(level) : 0));
		},
		...(options.retry ? { retry: options.retry } : {}),
		isOverflow: message => isContextOverflow(fromSessionMessage(message, options.model) as AssistantMessage, options.contextWindow ?? options.model.contextWindow),
		isRetryable: message => isRetryableAssistantError(fromSessionMessage(message, options.model) as AssistantMessage),
		async summarize(request, signal) {
			const thinking = summaryThinking(request.reasoning);
			const stream = options.stream(options.model, { systemPrompt: SUMMARY_SYSTEM, messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }] }, { signal, ...(options.sessionId ? { sessionId: options.sessionId } : {}), maxTokens: request.maxTokens, maxRetries: 0, cacheRetention: "none", ...(thinking.level !== "off" ? { reasoning: thinking.level } : {}) });
			for await (const _event of stream) { }
			const result = toSessionMessage(await stream.result());
			if (!result) throw new Error("Provider did not return a summary");
			return result;
		},
	};
}

export function snapshotConfiguration<T extends Partial<PiPortOptions>>(options: T): T {
	return { ...options, ...(options.context ? { context: { ...options.context } } : {}), ...(options.retry ? { retry: { ...options.retry } } : {}), ...(options.tools ? { tools: options.tools.map(tool => ({ ...tool, parameters: structuredClone(tool.parameters) })) } : {}) };
}
