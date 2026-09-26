import { access } from "node:fs/promises";
import { homedir } from "node:os";
import type { Model } from "./model-types.ts";

export interface ModelAuth {
	auth: { apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string };
	env?: Record<string, string>;
	source?: string;
}

export interface AuthOptions {
	apiKey?: string;
	env?: Record<string, string>;
	signal?: AbortSignal;
	fileExists?: (path: string) => Promise<boolean>;
}

const envKeys: Record<string, string[]> = {
	"ant-ling": ["ANT_LING_API_KEY"], anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
	"azure-openai-responses": ["AZURE_OPENAI_API_KEY"], baseten: ["BASETEN_API_KEY"], cerebras: ["CEREBRAS_API_KEY"],
	deepseek: ["DEEPSEEK_API_KEY"], fireworks: ["FIREWORKS_API_KEY"], "github-copilot": ["COPILOT_GITHUB_TOKEN"],
	google: ["GEMINI_API_KEY"], groq: ["GROQ_API_KEY"], huggingface: ["HF_TOKEN"], "kimi-coding": ["KIMI_API_KEY"],
	minimax: ["MINIMAX_API_KEY"], "minimax-cn": ["MINIMAX_CN_API_KEY"], mistral: ["MISTRAL_API_KEY"],
	moonshotai: ["MOONSHOT_API_KEY"], "moonshotai-cn": ["MOONSHOT_API_KEY"], nvidia: ["NVIDIA_API_KEY"],
	openai: ["OPENAI_API_KEY"], "openai-codex": ["OPENAI_API_KEY"], opencode: ["OPENCODE_API_KEY"],
	"opencode-go": ["OPENCODE_API_KEY"], openrouter: ["OPENROUTER_API_KEY"], "qwen-token-plan": ["QWEN_TOKEN_PLAN_API_KEY"],
	"qwen-token-plan-cn": ["QWEN_TOKEN_PLAN_CN_API_KEY"], "qwen-token-plan-individual": ["QWEN_TOKEN_PLAN_API_KEY"],
	radius: ["RADIUS_API_KEY"], together: ["TOGETHER_API_KEY"], "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
	xai: ["XAI_API_KEY"], xiaomi: ["XIAOMI_API_KEY"], "xiaomi-token-plan-cn": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
	"xiaomi-token-plan-ams": ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"], "xiaomi-token-plan-sgp": ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
	zai: ["ZAI_API_KEY"], "zai-coding-cn": ["ZAI_CODING_CN_API_KEY"],
};

async function fileExists(path: string): Promise<boolean> {
	try { await access(path.startsWith("~/") ? homedir() + path.slice(1) : path); return true; }
	catch { return false; }
}

export async function resolveCatalogAuth(model: Model<string>, options: AuthOptions = {}): Promise<ModelAuth | undefined> {
	options.signal?.throwIfAborted();
	const env = { ...process.env, ...options.env } as Record<string, string>;
	const value = (name: string) => env[name]?.trim() || undefined;
	const explicit = options.apiKey?.trim() || undefined;
	let result: ModelAuth | undefined;
	if (model.provider === "azure-openai-responses") {
		const key = explicit ?? value("AZURE_OPENAI_API_KEY");
		if (key) result = {
			auth: { apiKey: key, headers: { Authorization: null } },
			env: Object.fromEntries(["AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_RESOURCE_NAME", "AZURE_OPENAI_DEPLOYMENT_NAME_MAP", "AZURE_OPENAI_API_VERSION"].flatMap(name => value(name) ? [[name, value(name)!]] : [])),
			source: explicit ? "explicit key" : "AZURE_OPENAI_API_KEY",
		};
	} else if (model.provider === "cloudflare-ai-gateway" || model.provider === "cloudflare-workers-ai") {
		const key = explicit ?? value("CLOUDFLARE_API_KEY");
		const account = value("CLOUDFLARE_ACCOUNT_ID");
		const gateway = value("CLOUDFLARE_GATEWAY_ID");
		if (key && account && (model.provider === "cloudflare-workers-ai" || gateway)) result = {
			auth: model.provider === "cloudflare-ai-gateway"
				? { headers: { "cf-aig-authorization": `Bearer ${key}`, Authorization: null, "x-api-key": null } }
				: { apiKey: key },
			env: { CLOUDFLARE_ACCOUNT_ID: account, ...(gateway ? { CLOUDFLARE_GATEWAY_ID: gateway } : {}) },
			source: explicit ? "explicit key" : "CLOUDFLARE_API_KEY",
		};
	} else if (model.provider === "amazon-bedrock") {
		const key = explicit ?? value("AWS_BEARER_TOKEN_BEDROCK") ?? value("BEDROCK_API_KEY");
		const cloud = value("AWS_PROFILE") || value("AWS_ACCESS_KEY_ID") && value("AWS_SECRET_ACCESS_KEY") || value("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") || value("AWS_CONTAINER_CREDENTIALS_FULL_URI") || value("AWS_WEB_IDENTITY_TOKEN_FILE") && value("AWS_ROLE_ARN");
		if (key || cloud) result = { auth: key ? { apiKey: key } : {}, env: Object.fromEntries(["AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONFIG_FILE", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_AUTHORIZATION_TOKEN", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN", "AWS_ROLE_SESSION_NAME", "AWS_ENDPOINT_URL_STS"].flatMap(name => value(name) ? [[name, value(name)!]] : [])), source: key ? "Bedrock bearer" : "AWS credentials" };
	} else if (model.provider === "google-vertex") {
		const key = explicit ?? value("GOOGLE_CLOUD_API_KEY");
		if (key) result = { auth: { apiKey: key }, env: { ...(value("GOOGLE_CLOUD_PROJECT") ? { GOOGLE_CLOUD_PROJECT: value("GOOGLE_CLOUD_PROJECT")! } : {}), ...(value("GOOGLE_CLOUD_LOCATION") ? { GOOGLE_CLOUD_LOCATION: value("GOOGLE_CLOUD_LOCATION")! } : {}) }, source: explicit ? "explicit key" : "GOOGLE_CLOUD_API_KEY" };
		else {
			const project = value("GOOGLE_CLOUD_PROJECT") ?? value("GCLOUD_PROJECT");
			const location = value("GOOGLE_CLOUD_LOCATION");
			const credentials = value("GOOGLE_APPLICATION_CREDENTIALS") ?? "~/.config/gcloud/application_default_credentials.json";
			const credentialPath = credentials.startsWith("~/") ? homedir() + credentials.slice(1) : credentials;
			if (project && location && await (options.fileExists ?? fileExists)(credentialPath)) result = { auth: {}, env: { GOOGLE_CLOUD_PROJECT: project, GOOGLE_CLOUD_LOCATION: location, GOOGLE_APPLICATION_CREDENTIALS: credentialPath }, source: "Google ADC" };
		}
	} else if (model.provider === "anthropic" && !explicit && value("ANTHROPIC_AUTH_TOKEN")) {
		result = { auth: { headers: { Authorization: `Bearer ${value("ANTHROPIC_AUTH_TOKEN")}` } }, source: "ANTHROPIC_AUTH_TOKEN" };
	} else {
		const source = (envKeys[model.provider] ?? []).find(name => value(name));
		const key = explicit ?? (source ? value(source) : undefined);
		const label = explicit ? "explicit key" : source;
		if (key) result = { auth: { apiKey: key }, ...(label ? { source: label } : {}) };
	}
	options.signal?.throwIfAborted();
	if (!result) return undefined;
	const modelHeaders = model.headers as Record<string, string | null> | undefined;
	if (modelHeaders) result.auth.headers = { ...result.auth.headers, ...modelHeaders };
	return result;
}
