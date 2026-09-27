import type { Model, ThinkingLevel } from "./model-types.ts";
import { adjustMaxTokensForThinking } from "./model-policy.ts";
import type { AnyTextAdapter } from "@tanstack/ai";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { Readable } from "node:stream";
import type { ConverseStreamCommandInput, ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicChat, createAnthropicChatWithClient, type AnthropicChatModel } from "@tanstack/ai-anthropic";
import { BedrockConverseTextAdapter, type BedrockConverseModels, type ResolvedBedrockAuth } from "@tanstack/ai-bedrock";
import { createGeminiChat, type GeminiTextModel } from "@tanstack/ai-gemini";
import { openaiCompatibleText } from "@tanstack/ai-openai/compatible";
import { createOpenaiChat, type OpenAIChatModel } from "@tanstack/ai-openai";
import { vertexText } from "@tanstack/ai-vertex";
import { effectiveOutputTokens, isBedrockClaude, usesAdaptiveThinking } from "./model-output.ts";
import { resolveCatalogAuth, type ModelAuth } from "./model-auth.ts";

type Auth = ModelAuth;
export type ModelAdapter = AnyTextAdapter;

/** One committed request snapshot, shared by task and summary adapters. */
export interface ModelRequestSettings {
	signal: AbortSignal;
	maxTokens: number;
	reasoning?: ThinkingLevel;
	apiKey?: string;
	sessionId?: string;
	env?: Record<string, string>;
}

class AbortableBedrockHttpHandler extends NodeHttpHandler {
	constructor(private readonly signal?: AbortSignal) { super(); }

	override async handle(...args: Parameters<NodeHttpHandler["handle"]>) {
		const result = await super.handle(...args);
		const body = result.response.body;
		if (this.signal && body instanceof Readable) {
			const signal = this.signal;
			const abort = () => body.destroy(new Error("Request aborted"));
			if (signal.aborted) abort();
			else {
				signal.addEventListener("abort", abort, { once: true });
				body.once("close", () => signal.removeEventListener("abort", abort));
			}
		}
		return result;
	}
}

class BunBedrockConverseAdapter extends BedrockConverseTextAdapter<BedrockConverseModels> {
	constructor(config: ConstructorParameters<typeof BedrockConverseTextAdapter>[0], model: BedrockConverseModels, private readonly credentialEnv: Record<string, string>, private readonly signal?: AbortSignal) {
		super(config, model);
	}

	protected override async sendStream(input: ConverseStreamCommandInput): Promise<AsyncIterable<ConverseStreamOutput>> {
		const { ConverseStreamCommand } = await this.importBedrockRuntime();
		const client = await this.getClient();
		const response = await client.send(new ConverseStreamCommand(input), this.signal ? { abortSignal: this.signal } : {});
		if (!response.stream) throw new Error("Bedrock Converse: empty stream response");
		return response.stream;
	}

	protected override buildClientConfig(resolved: ResolvedBedrockAuth, region: string, endpoint: string | undefined) {
		const config = super.buildClientConfig(resolved, region, endpoint);
		if (resolved.kind === "sigv4") {
			const accessKeyId = this.credentialEnv.AWS_ACCESS_KEY_ID;
			const secretAccessKey = this.credentialEnv.AWS_SECRET_ACCESS_KEY;
			if (accessKeyId && secretAccessKey) {
				config.credentials = async () => ({ accessKeyId, secretAccessKey, ...(this.credentialEnv.AWS_SESSION_TOKEN ? { sessionToken: this.credentialEnv.AWS_SESSION_TOKEN } : {}) });
			} else if (this.credentialEnv.AWS_PROFILE) {
				const profile = this.credentialEnv.AWS_PROFILE;
				const filepath = this.credentialEnv.AWS_SHARED_CREDENTIALS_FILE;
				const configFilepath = this.credentialEnv.AWS_CONFIG_FILE;
				config.credentials = async () => {
					const { fromNodeProviderChain } = await import("@aws-sdk/credential-providers");
					return fromNodeProviderChain({ profile, ...(filepath ? { filepath } : {}), ...(configFilepath ? { configFilepath } : {}) })();
				};
			} else if (this.credentialEnv.AWS_CONTAINER_CREDENTIALS_FULL_URI || this.credentialEnv.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) {
				const env = this.credentialEnv;
				config.credentials = async () => {
					const { fromHttp } = await import("@aws-sdk/credential-providers");
					return fromHttp({
						...(env.AWS_CONTAINER_CREDENTIALS_FULL_URI ? { awsContainerCredentialsFullUri: env.AWS_CONTAINER_CREDENTIALS_FULL_URI } : {}),
						...(env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ? { awsContainerCredentialsRelativeUri: env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI } : {}),
						...(env.AWS_CONTAINER_AUTHORIZATION_TOKEN ? { awsContainerAuthorizationToken: env.AWS_CONTAINER_AUTHORIZATION_TOKEN } : {}),
						...(env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE ? { awsContainerAuthorizationTokenFile: env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE } : {}),
					})();
				};
			} else if (this.credentialEnv.AWS_WEB_IDENTITY_TOKEN_FILE && this.credentialEnv.AWS_ROLE_ARN) {
				const env = this.credentialEnv;
				const webIdentityTokenFile = env.AWS_WEB_IDENTITY_TOKEN_FILE!;
				const roleArn = env.AWS_ROLE_ARN!;
				config.credentials = async () => {
					const { fromTokenFile } = await import("@aws-sdk/credential-providers");
					return fromTokenFile({
						webIdentityTokenFile,
						roleArn,
						...(env.AWS_ROLE_SESSION_NAME ? { roleSessionName: env.AWS_ROLE_SESSION_NAME } : {}),
						clientConfig: { region, ...(env.AWS_ENDPOINT_URL_STS ? { endpoint: env.AWS_ENDPOINT_URL_STS } : {}) },
					})();
				};
			}
		}
		return { ...config, maxAttempts: 1, requestHandler: new AbortableBedrockHttpHandler(this.signal) };
	}
}

const supportedApis = new Set([
	"openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai",
	"google-vertex", "bedrock-converse-stream", "azure-openai-responses",
]);

export function assertBuiltinTransport(model: Model<string>): void {
	if (!supportedApis.has(model.api)) throw new Error(`No TanStack transport for ${model.provider}/${model.id} (${model.api})`);
}

function requiredKey(model: Model<string>, auth: Auth): string {
	const key = auth.auth.apiKey;
	if (key) return key;
	if (auth.auth.headers && Object.keys(auth.auth.headers).some(name => /^(authorization|cf-aig-authorization)$/i.test(name))) return "unused";
	throw new Error(`Provider is not configured: ${model.provider}`);
}

function headers(auth: Auth): Record<string, string> {
	return Object.fromEntries(Object.entries(auth.auth.headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function suppressedHeaderFetch(auth: Auth) {
	const suppressed = Object.entries(auth.auth.headers ?? {}).flatMap(([name, value]) => value === null ? [name] : []);
	if (!suppressed.length) return {};
	return { fetch: (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		for (const name of suppressed) request.headers.delete(name);
		return fetch(request);
	} };
}

function baseUrl(model: Model<string>, auth: Auth): string {
	return (auth.auth.baseUrl ?? model.baseUrl).replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
		const value = name === "location"
			? auth.env?.GOOGLE_CLOUD_LOCATION ?? auth.env?.GOOGLE_VERTEX_LOCATION ?? process.env.GOOGLE_CLOUD_LOCATION ?? process.env.GOOGLE_VERTEX_LOCATION
			: auth.env?.[name] ?? process.env[name];
		if (!value) throw new Error(`Missing ${name} for ${model.provider} endpoint`);
		return encodeURIComponent(value);
	});
}

function geminiThinkingConfig(model: Model<string>, reasoning: ModelRequestSettings["reasoning"]): Record<string, unknown> | undefined {
	if (!model.reasoning) return undefined;
	const id = model.id.toLowerCase();
	const pro = /gemini-3(?:\.\d+)?-pro/.test(id);
	const flash = /gemini-3(?:\.\d+)?-flash/.test(id) || id === "gemini-flash-latest" || id === "gemini-flash-lite-latest";
	const gemma = /gemma-?4/.test(id);
	if (!reasoning) return pro ? { thinkingLevel: "LOW" } : flash || gemma ? { thinkingLevel: "MINIMAL" } : { thinkingBudget: 0 };
	const level = reasoning === "xhigh" || reasoning === "max" ? "high" : reasoning;
	if (pro || flash || gemma) return { includeThoughts: true, thinkingLevel: pro ? (level === "minimal" || level === "low" ? "LOW" : "HIGH") : gemma ? (level === "minimal" || level === "low" ? "MINIMAL" : "HIGH") : level.toUpperCase() };
	const budgets = id.includes("2.5-pro") ? [128, 2048, 8192, 32768] : id.includes("2.5-flash-lite") ? [512, 2048, 8192, 24576] : [128, 2048, 8192, 24576];
	return { includeThoughts: true, thinkingBudget: budgets[["minimal", "low", "medium", "high"].indexOf(level)] };
}

export function providerModelOptions(model: Model<string>, options: ModelRequestSettings): Record<string, unknown> {
	switch (model.api) {
		case "anthropic-messages": {
			const requested = options.maxTokens ?? model.maxTokens;
			const adaptive = usesAdaptiveThinking(model);
			if (!options.reasoning) return { max_tokens: requested, ...(adaptive ? {} : { thinking: { type: "disabled" } }) };
			if (adaptive) return { max_tokens: requested, thinking: { type: "adaptive" }, output_config: { effort: options.reasoning === "minimal" ? "low" : options.reasoning } };
			const { maxTokens, thinkingBudget } = adjustMaxTokensForThinking(requested, model.maxTokens, options.reasoning);
			return { max_tokens: maxTokens, thinking: { type: "enabled", budget_tokens: thinkingBudget } };
		}
		case "google-generative-ai":
		case "google-vertex": {
			const thinkingConfig = geminiThinkingConfig(model, options.reasoning);
			return { ...(options.maxTokens === undefined ? {} : { maxOutputTokens: options.maxTokens }), ...(thinkingConfig ? { thinkingConfig } : {}) };
		}
		case "bedrock-converse-stream": {
			const requested = options.maxTokens ?? model.maxTokens;
			const reasoning = options.reasoning && isBedrockClaude(model) ? options.reasoning : undefined;
			const adaptive = usesAdaptiveThinking(model);
			const fields = reasoning ? adaptive
				? { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: reasoning === "minimal" ? "low" : reasoning } }
				: { thinking: { type: "enabled", budget_tokens: adjustMaxTokensForThinking(requested, model.maxTokens, reasoning).thinkingBudget, display: "summarized" }, anthropic_beta: ["interleaved-thinking-2025-05-14"] }
				: undefined;
			return { max_completion_tokens: effectiveOutputTokens(model, requested, reasoning ?? "off"), ...(fields ? { additionalModelRequestFields: fields } : {}) };
		}
		case "openai-completions": {
			const compat = model.compat as { thinkingFormat?: string; maxTokensField?: string; supportsReasoningEffort?: boolean; supportsStore?: boolean; supportsUsageInStreaming?: boolean } | undefined;
			const mapped = options.reasoning ? model.thinkingLevelMap?.[options.reasoning] ?? options.reasoning : model.thinkingLevelMap?.off;
			const effort = typeof mapped === "string" ? mapped : undefined;
			let thinking: Record<string, unknown> = {};
			if (model.reasoning) switch (compat?.thinkingFormat) {
				case "deepseek": thinking = mapped !== null ? { thinking: { type: options.reasoning ? "enabled" : "disabled" } } : {}; break;
				case "zai": thinking = { thinking: options.reasoning ? { type: "enabled", clear_thinking: false } : { type: "disabled" } }; break;
				case "qwen": thinking = { enable_thinking: !!options.reasoning }; break;
				case "qwen-chat-template": thinking = { chat_template_kwargs: { enable_thinking: !!options.reasoning, preserve_thinking: true } }; break;
				case "openrouter": if (mapped !== null) thinking = { reasoning: { effort: effort ?? "none" } }; break;
				case "together": thinking = { reasoning: { enabled: !!options.reasoning } }; break;
				case "ant-ling": if (options.reasoning && effort) thinking = { reasoning: { effort } }; break;
		}
			return { ...(options.maxTokens === undefined ? {} : { [compat?.maxTokensField === "max_tokens" ? "max_tokens" : "max_completion_tokens"]: options.maxTokens }),
				...(compat?.supportsStore ? { store: false } : {}),
				...(compat?.supportsUsageInStreaming === false ? { stream_options: null } : {}),
				...thinking,
				...(compat?.supportsReasoningEffort && effort ? { reasoning_effort: effort } : {}),
			};
		}
		default: return { store: false, ...(options.maxTokens === undefined ? {} : { max_output_tokens: options.maxTokens }), ...(options.reasoning ? { reasoning: { effort: options.reasoning } } : {}) };
	}
}

function makeAdapter(model: Model<string>, auth: Auth, signal?: AbortSignal): ModelAdapter {
	const apiKey = model.api === "google-vertex" || model.api === "bedrock-converse-stream" ? auth.auth.apiKey : requiredKey(model, auth);
	const url = baseUrl(model, auth);
	const defaultHeaders = headers(auth);
	const project = auth.env?.GOOGLE_CLOUD_PROJECT ?? auth.env?.GOOGLE_VERTEX_PROJECT;
	const location = auth.env?.GOOGLE_CLOUD_LOCATION ?? auth.env?.GOOGLE_VERTEX_LOCATION;
	const region = auth.env?.AWS_REGION ?? auth.env?.AWS_DEFAULT_REGION;
	switch (model.api) {
		case "openai-responses":
			if (model.provider === "openai") return createOpenaiChat(model.id as OpenAIChatModel, apiKey!, { baseURL: url, defaultHeaders, ...suppressedHeaderFetch(auth), maxRetries: 0 });
			return openaiCompatibleText(model.id, { name: model.provider, api: "responses", baseURL: url, apiKey: apiKey!, defaultHeaders, ...suppressedHeaderFetch(auth), maxRetries: 0 });
		case "openai-completions": return openaiCompatibleText(model.id, { name: model.provider, api: "chat-completions", baseURL: url, apiKey: apiKey!, defaultHeaders, ...suppressedHeaderFetch(auth), maxRetries: 0 }) as ModelAdapter;
		case "anthropic-messages": {
			const token = model.provider === "github-copilot" || model.provider === "anthropic" && apiKey?.includes("sk-ant-oat")
				? apiKey
				: Object.entries(auth.auth.headers ?? {}).find(([name, value]) => name.toLowerCase() === "authorization" && value?.startsWith("Bearer "))?.[1]?.slice(7);
			if (token) {
				const client = new Anthropic({ apiKey: null, authToken: token, baseURL: url, defaultHeaders, ...suppressedHeaderFetch(auth), maxRetries: 0 });
				return createAnthropicChatWithClient(model.id as AnthropicChatModel, client) as ModelAdapter;
			}
			return createAnthropicChat(model.id as AnthropicChatModel, apiKey!, { baseURL: url, defaultHeaders, ...suppressedHeaderFetch(auth), maxRetries: 0 }) as ModelAdapter;
		}
		case "google-generative-ai": return createGeminiChat(model.id as GeminiTextModel, apiKey!, { baseURL: url, defaultHeaders }) as ModelAdapter;
		case "google-vertex": return vertexText(model.id as GeminiTextModel, { ...(auth.auth.apiKey ? { apiKey: auth.auth.apiKey } : auth.env?.GOOGLE_APPLICATION_CREDENTIALS ? { googleAuthOptions: { keyFile: auth.env.GOOGLE_APPLICATION_CREDENTIALS } } : {}), ...(project ? { project } : {}), ...(location ? { location } : {}), baseURL: url, defaultHeaders }) as ModelAdapter;
		case "bedrock-converse-stream": return new BunBedrockConverseAdapter({ ...(auth.auth.apiKey ? { apiKey: auth.auth.apiKey, auth: "apikey" as const } : { auth: "sigv4" as const }), ...(region ? { region } : {}), baseURL: url, defaultHeaders }, model.id as BedrockConverseModels, auth.env ?? {}, signal) as ModelAdapter;
		case "azure-openai-responses": {
			const env = auth.env ?? {};
			const endpoint = url || env.AZURE_OPENAI_BASE_URL || (env.AZURE_OPENAI_RESOURCE_NAME ? `https://${env.AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com` : "");
			if (!endpoint) throw new Error("Azure OpenAI endpoint is not configured");
			const baseURL = endpoint.replace(/\/+$/, "").replace(/\/openai\/v1\/responses$/, "/openai/v1");
			const deployment = env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP?.split(",").map(item => item.trim().split("=")).find(([name]) => name === model.id)?.[1] ?? model.id;
			return openaiCompatibleText(deployment, { name: model.provider, api: "responses", baseURL: baseURL.endsWith("/openai/v1") ? baseURL : `${baseURL}/openai/v1`, apiKey: apiKey!, defaultHeaders: { ...defaultHeaders, "api-key": apiKey! }, ...suppressedHeaderFetch(auth), defaultQuery: { "api-version": env.AZURE_OPENAI_API_VERSION ?? "v1" }, maxRetries: 0 }) as ModelAdapter;
		}
		default: throw new Error(`No TanStack transport for ${model.provider}/${model.id} (${model.api})`);
	}
}

/** Resolve provider authentication and return its native TanStack adapter. */
export async function resolveProviderAdapter(model: Model, settings: ModelRequestSettings): Promise<ModelAdapter> {
	assertBuiltinTransport(model);
	settings.signal.throwIfAborted();
	const auth = await resolveCatalogAuth(model, {
		...(settings.apiKey !== undefined ? { apiKey: settings.apiKey } : {}),
		...(settings.env ? { env: settings.env } : {}),
		signal: settings.signal,
	});
	if (!auth) throw new Error(`Provider is not configured: ${model.provider}`);
	settings.signal.throwIfAborted();
	return makeAdapter(model, auth, settings.signal);
}
