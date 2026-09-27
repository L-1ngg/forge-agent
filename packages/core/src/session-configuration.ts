import { emptySkills, type SkillsSnapshot } from "./skills/types.ts";
import { getSupportedThinkingLevels, isRetryableAssistantError, isContextOverflow } from "./model-policy.ts";
import type { CreateAgentOptions } from "./agent.ts";
import type { SessionMessage } from "@forge-agent/protocol";
import { randomUUID } from "node:crypto";
import { callModel } from "./model-call.ts";
import { SUMMARY_SYSTEM, resolveRetryPolicy, validateRequestLimits, type SummaryDriver } from "./context/compaction.ts";
import type { SessionAssembly, SessionConfiguration } from "./configuration.ts";

import { validateSessionTools } from "./session-tools.ts";
import { assertBuiltinTransport } from "./model-adapter.ts";
import { effectiveOutputTokens } from "./model-output.ts";
import { getCatalogModel } from "./model-catalog.ts";
import { resolveCatalogAuth } from "./model-auth.ts";
export { effectiveOutputTokens } from "./model-output.ts";

/** Prepared configuration owns no execution resources. The session binds tools at application. */
export async function prepareSessionConfiguration(options: CreateAgentOptions, skills: SkillsSnapshot = emptySkills()): Promise<SessionAssembly> {
	const configuration = snapshotConfiguration(options);
	configuration.thinkingLevel ??= "off";
	if ("streamFn" in configuration) throw new TypeError("streamFn was removed; supply a native TanStack adapter");
	if (typeof configuration.systemPrompt !== "string" || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(configuration.thinkingLevel)) throw new Error("Invalid model configuration");
	validateSessionTools(configuration);
	if (skills.enabled && configuration.tools?.some(tool => tool.name === "load_skill")) throw new Error("load_skill is reserved when Skills are enabled");
	const resolved = await resolveModelOptions(configuration);
	return { options: resolved, driver: createSummaryDriver(resolved), skills };
}

async function resolveModelOptions(options: CreateAgentOptions): Promise<SessionConfiguration> {
	resolveRetryPolicy(options.retry);
	validateRequestLimits(options);
	if (options.transformContext !== undefined && typeof options.transformContext !== "function") throw new TypeError("transformContext must be a function");
	if (options.adapter != null && (typeof options.adapter !== "object" || options.adapter.kind !== "text" || typeof options.adapter.chatStream !== "function")) throw new Error("adapter must be a native TanStack text adapter or null");
	if (typeof options.model !== "string") {
		if (!options.adapter) throw new Error("A model object requires adapter");
		const model = options.model;
		if (!model || !model.id || !model.provider || !model.api || !Number.isFinite(model.contextWindow) || model.contextWindow <= 0 || !Number.isFinite(model.maxTokens) || model.maxTokens <= 0) throw new Error("Invalid model metadata");
		validateOutputLimit(options.maxTokens, model.maxTokens);
		if (options.provider !== undefined && options.provider !== model.provider) throw new Error("provider must match model.provider");
		return { ...options, thinkingLevel: options.thinkingLevel ?? "off", sessionId: options.sessionId ?? randomUUID(), model: options.baseUrl ? { ...model, baseUrl: options.baseUrl } : model, adapter: options.adapter };
	}
	if (!options.provider) throw new Error("A catalog model requires provider");
	const catalogModel = getCatalogModel(options.provider, options.model);
	if (!catalogModel) throw new Error(`Unknown model ${options.provider}/${options.model}`);
	if (!options.adapter) assertBuiltinTransport(catalogModel);
	const model = options.baseUrl ? { ...catalogModel, baseUrl: options.baseUrl } : catalogModel;
	const auth = !options.adapter ? await resolveCatalogAuth(model, options.apiKey ? { apiKey: options.apiKey } : {}) : undefined;
	if (!options.adapter && !auth) {
		throw new Error(`Provider is not configured: ${options.provider}. Set apiKey in .forge-agent/config.json, FORGE_AGENT_API_KEY, or the provider's API key environment variable.`);
	}
	if (!options.adapter && model.api === "azure-openai-responses") {
		const endpoint = model.baseUrl || auth?.env?.AZURE_OPENAI_BASE_URL || (auth?.env?.AZURE_OPENAI_RESOURCE_NAME ? `https://${auth.env.AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com` : "");
		if (!URL.canParse(endpoint) || !["http:", "https:"].includes(new URL(endpoint).protocol)) throw new Error("Azure OpenAI endpoint is not configured or invalid");
	}
	validateOutputLimit(options.maxTokens, catalogModel.maxTokens);
	const { adapter, ...rest } = options;
	return { ...rest, thinkingLevel: options.thinkingLevel ?? "off", sessionId: options.sessionId ?? randomUUID(), model, ...(adapter ? { adapter } : {}) };
}

export function createSummaryDriver(options: SessionConfiguration): SummaryDriver & { isOverflow(message: SessionMessage): boolean } {
	const summaryThinking = (requested: "inherit" | "off") => requested === "off" && !getSupportedThinkingLevels(options.model).includes("off")
		? { level: options.thinkingLevel, fallback: "Model does not support reasoning off; inherited task reasoning" }
		: { level: requested === "off" ? "off" as const : options.thinkingLevel };
	return {
		maxTokens: options.model.maxTokens,
		outputTokens(requested, reasoning) {
			const level = summaryThinking(reasoning).level;
			return effectiveOutputTokens(options.model, requested, level);
		},
		...(options.retry ? { retry: options.retry } : {}),
		isOverflow: message => isContextOverflow(message, options.contextWindow ?? options.model.contextWindow),
		isRetryable: message => isRetryableAssistantError(message),
		async summarize(request, signal) {
			const thinking = summaryThinking(request.reasoning);
			return callModel(options, [{ role: "user", content: [{ type: "text", text: request.prompt }], timestamp: Date.now() }], SUMMARY_SYSTEM, { signal, ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}), ...(options.sessionId ? { sessionId: options.sessionId } : {}), maxTokens: request.maxTokens, ...(thinking.level !== "off" ? { reasoning: thinking.level } : {}) });
		},
	};
}

export function snapshotConfiguration<T extends Partial<CreateAgentOptions>>(options: T): T {
	return { ...options, ...(options.mcp ? { mcp: { ...options.mcp, servers: structuredClone(options.mcp.servers) } } : {}), ...(typeof options.model === "object" ? { model: structuredClone(options.model) } : {}), ...(options.skills ? { skills: structuredClone(options.skills) } : {}), ...(options.memory ? { memory: { ...options.memory } } : {}), ...(options.context ? { context: { ...options.context } } : {}), ...(options.retry ? { retry: { ...options.retry } } : {}), ...(options.tools ? { tools: options.tools.map(tool => ({ ...tool, parameters: structuredClone(tool.parameters) })) } : {}) };
}

function validateOutputLimit(requested: number | undefined, maximum: number): void {
	if (requested !== undefined && requested > maximum) throw new RangeError("maxTokens exceeds model.maxTokens");
}
