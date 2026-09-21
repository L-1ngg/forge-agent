import { formatSkillsForPrompt } from "./skills/upstream/skills.ts";
import { emptySkills, type SkillsSnapshot } from "./skills/types.ts";
import { InMemoryCredentialStore, getSupportedThinkingLevels, isRetryableAssistantError, isContextOverflow, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { adjustMaxTokensForThinking } from "@earendil-works/pi-ai/api/simple-options";
export { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import type { SessionMessage } from "@forge-agent/protocol";
import { randomUUID } from "node:crypto";
import { fromSessionMessage, toSessionMessage } from "./event-projection.ts";
import { SUMMARY_SYSTEM, resolveRetryPolicy, validateRequestLimits, type SummaryDriver } from "./context/compaction.ts";
import type { SessionAssembly } from "./configuration.ts";
import type { PiPortOptions, ModelPortOptions } from "./pi-port.ts";
import { validateSessionTools } from "./session-tools.ts";

/** Prepared configuration owns no execution resources. The session binds tools at application. */
export async function prepareSessionConfiguration(options: PiPortOptions, skills: SkillsSnapshot = emptySkills()): Promise<SessionAssembly> {
	const configuration = snapshotConfiguration(options);
	if (typeof configuration.systemPrompt !== "string" || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(configuration.thinkingLevel)) throw new Error("Invalid model configuration");
	validateSessionTools(configuration);
	if (skills.enabled && configuration.tools?.some(tool => tool.name === "load_skill")) throw new Error("load_skill is reserved when Skills are enabled");
	configuration.systemPrompt += formatSkillsForPrompt(skills.entries.filter(entry => entry.status === "available"));
	const resolved = await resolveModelOptions(configuration);
	return { options: resolved, driver: createSummaryDriver(resolved), skills };
}

async function resolveModelOptions(options: PiPortOptions): Promise<ModelPortOptions> {
	resolveRetryPolicy(options.retry);
	validateRequestLimits(options);
	if (options.transformContext !== undefined && typeof options.transformContext !== "function") throw new TypeError("transformContext must be a function");
	if (options.streamFn != null && typeof options.streamFn !== "function") throw new Error("streamFn must be a function or null");
	if (typeof options.model !== "string") {
		if (!options.streamFn) throw new Error("A model object requires streamFn");
		const model = options.model;
		if (!model || !model.id || !model.provider || !model.api || !Number.isFinite(model.contextWindow) || model.contextWindow <= 0 || !Number.isFinite(model.maxTokens) || model.maxTokens <= 0) throw new Error("Invalid model metadata");
		validateOutputLimit(options.maxTokens, model.maxTokens);
		if (options.provider !== undefined && options.provider !== model.provider) throw new Error("provider must match model.provider");
		return { ...options, builtinStream: false, sessionId: options.sessionId ?? randomUUID(), model: options.baseUrl ? { ...model, baseUrl: options.baseUrl } : model, streamFn: options.streamFn };
	}
	if (!options.provider) throw new Error("A catalog model requires provider");
	const credentials = new InMemoryCredentialStore();
	const apiKey = options.apiKey;
	if (apiKey) await credentials.modify(options.provider, async () => ({ type: "api_key", key: apiKey }));
	const models = builtinModels({ credentials });
	const catalogModel = models.getModel(options.provider, options.model);
	if (!catalogModel) throw new Error(`Unknown model ${options.provider}/${options.model}`);
	if (!options.streamFn && !await models.checkAuth(options.provider)) {
		throw new Error(`Provider is not configured: ${options.provider}. Set apiKey in .forge-agent/config.json, FORGE_AGENT_API_KEY, or the provider's API key environment variable.`);
	}
	validateOutputLimit(options.maxTokens, catalogModel.maxTokens);
	const model = options.baseUrl ? { ...catalogModel, baseUrl: options.baseUrl } : catalogModel;
	return { ...options, builtinStream: options.streamFn == null, sessionId: options.sessionId ?? randomUUID(), model, streamFn: options.streamFn ?? models.streamSimple.bind(models) };
}

export function createSummaryDriver(options: ModelPortOptions): SummaryDriver & { isOverflow(message: SessionMessage): boolean } {
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
		isOverflow: message => isContextOverflow(fromSessionMessage(message, options.model) as AssistantMessage, options.contextWindow ?? options.model.contextWindow),
		isRetryable: message => isRetryableAssistantError(fromSessionMessage(message, options.model) as AssistantMessage),
		async summarize(request, signal) {
			const thinking = summaryThinking(request.reasoning);
			const stream = await options.streamFn(options.model, { systemPrompt: SUMMARY_SYSTEM, messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }] }, { signal, ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}), ...(options.sessionId ? { sessionId: options.sessionId } : {}), maxTokens: request.maxTokens, maxRetries: 0, cacheRetention: "none", ...(thinking.level !== "off" ? { reasoning: thinking.level } : {}) });
			for await (const _event of stream) { }
			const result = toSessionMessage(await stream.result());
			if (!result) throw new Error("Provider did not return a summary");
			return result;
		},
	};
}

export function snapshotConfiguration<T extends Partial<PiPortOptions>>(options: T): T {
	return { ...options, ...(options.mcp ? { mcp: { ...options.mcp, servers: structuredClone(options.mcp.servers) } } : {}), ...(typeof options.model === "object" ? { model: structuredClone(options.model) } : {}), ...(options.skills ? { skills: structuredClone(options.skills) } : {}), ...(options.context ? { context: { ...options.context } } : {}), ...(options.retry ? { retry: { ...options.retry } } : {}), ...(options.tools ? { tools: options.tools.map(tool => ({ ...tool, parameters: structuredClone(tool.parameters) })) } : {}) };
}

function validateOutputLimit(requested: number | undefined, maximum: number): void {
	if (requested !== undefined && requested > maximum) throw new RangeError("maxTokens exceeds model.maxTokens");
}

/** Mirrors the locked simple stream output mapping, before context-dependent clamping. */
export function effectiveOutputTokens(model: Model<string>, requested: number, reasoning: string): number {
	const compat: unknown = Reflect.get(model, "compat");
	const bedrockNames = [model.id, model.name].flatMap(value => [value.toLowerCase(), value.toLowerCase().replace(/[\s_.:]+/g, "-")]);
	// Locked Bedrock adapter also identifies inference profiles by their display name.
	const bedrockClaude = [model.id, model.name].some(value => /anthropic[./]claude/i.test(value)) || /claude/i.test(model.name);
	const adaptive = model.api === "bedrock-converse-stream"
		? bedrockNames.some(value => ["opus-4-6", "opus-4-7", "opus-4-8", "opus-5", "sonnet-4-6", "sonnet-5", "fable-5"].some(name => value.includes(name)))
		: !!compat && typeof compat === "object" && "forceAdaptiveThinking" in compat && compat.forceAdaptiveThinking === true;
	const budgeted = model.api === "anthropic-messages" || (model.api === "bedrock-converse-stream" && bedrockClaude);
	return budgeted && reasoning !== "off" && !adaptive
		? adjustMaxTokensForThinking(requested, model.maxTokens, reasoning as "minimal" | "low" | "medium" | "high" | "xhigh" | "max").maxTokens
		: requested;
}
