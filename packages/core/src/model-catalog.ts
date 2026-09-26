import type { Model } from "./model-types.ts";
import amazonBedrock from "./model-data/amazon-bedrock.json" with { type: "json" };
import antLing from "./model-data/ant-ling.json" with { type: "json" };
import anthropic from "./model-data/anthropic.json" with { type: "json" };
import azureOpenaiResponses from "./model-data/azure-openai-responses.json" with { type: "json" };
import baseten from "./model-data/baseten.json" with { type: "json" };
import cerebras from "./model-data/cerebras.json" with { type: "json" };
import cloudflareAiGateway from "./model-data/cloudflare-ai-gateway.json" with { type: "json" };
import cloudflareWorkersAi from "./model-data/cloudflare-workers-ai.json" with { type: "json" };
import deepseek from "./model-data/deepseek.json" with { type: "json" };
import fireworks from "./model-data/fireworks.json" with { type: "json" };
import githubCopilot from "./model-data/github-copilot.json" with { type: "json" };
import googleVertex from "./model-data/google-vertex.json" with { type: "json" };
import google from "./model-data/google.json" with { type: "json" };
import groq from "./model-data/groq.json" with { type: "json" };
import huggingface from "./model-data/huggingface.json" with { type: "json" };
import kimiCoding from "./model-data/kimi-coding.json" with { type: "json" };
import minimaxCn from "./model-data/minimax-cn.json" with { type: "json" };
import minimax from "./model-data/minimax.json" with { type: "json" };
import moonshotaiCn from "./model-data/moonshotai-cn.json" with { type: "json" };
import moonshotai from "./model-data/moonshotai.json" with { type: "json" };
import nvidia from "./model-data/nvidia.json" with { type: "json" };
import openai from "./model-data/openai.json" with { type: "json" };
import opencodeGo from "./model-data/opencode-go.json" with { type: "json" };
import opencode from "./model-data/opencode.json" with { type: "json" };
import openrouter from "./model-data/openrouter.json" with { type: "json" };
import qwenTokenPlanCn from "./model-data/qwen-token-plan-cn.json" with { type: "json" };
import qwenTokenPlanIndividual from "./model-data/qwen-token-plan-individual.json" with { type: "json" };
import qwenTokenPlan from "./model-data/qwen-token-plan.json" with { type: "json" };
import together from "./model-data/together.json" with { type: "json" };
import vercelAiGateway from "./model-data/vercel-ai-gateway.json" with { type: "json" };
import xai from "./model-data/xai.json" with { type: "json" };
import xiaomiTokenPlanAms from "./model-data/xiaomi-token-plan-ams.json" with { type: "json" };
import xiaomiTokenPlanCn from "./model-data/xiaomi-token-plan-cn.json" with { type: "json" };
import xiaomiTokenPlanSgp from "./model-data/xiaomi-token-plan-sgp.json" with { type: "json" };
import xiaomi from "./model-data/xiaomi.json" with { type: "json" };
import zaiCodingCn from "./model-data/zai-coding-cn.json" with { type: "json" };
import zai from "./model-data/zai.json" with { type: "json" };

// Pinned catalog snapshot from @earendil-works/pi-ai 0.85.1 (2026-09-26).
const data = {
	"amazon-bedrock": amazonBedrock,
	"ant-ling": antLing,
	"anthropic": anthropic,
	"azure-openai-responses": azureOpenaiResponses,
	"baseten": baseten,
	"cerebras": cerebras,
	"cloudflare-ai-gateway": cloudflareAiGateway,
	"cloudflare-workers-ai": cloudflareWorkersAi,
	"deepseek": deepseek,
	"fireworks": fireworks,
	"github-copilot": githubCopilot,
	"google-vertex": googleVertex,
	"google": google,
	"groq": groq,
	"huggingface": huggingface,
	"kimi-coding": kimiCoding,
	"minimax-cn": minimaxCn,
	"minimax": minimax,
	"moonshotai-cn": moonshotaiCn,
	"moonshotai": moonshotai,
	"nvidia": nvidia,
	"openai": openai,
	"opencode-go": opencodeGo,
	"opencode": opencode,
	"openrouter": openrouter,
	"qwen-token-plan-cn": qwenTokenPlanCn,
	"qwen-token-plan-individual": qwenTokenPlanIndividual,
	"qwen-token-plan": qwenTokenPlan,
	"together": together,
	"vercel-ai-gateway": vercelAiGateway,
	"xai": xai,
	"xiaomi-token-plan-ams": xiaomiTokenPlanAms,
	"xiaomi-token-plan-cn": xiaomiTokenPlanCn,
	"xiaomi-token-plan-sgp": xiaomiTokenPlanSgp,
	"xiaomi": xiaomi,
	"zai-coding-cn": zaiCodingCn,
	"zai": zai,
} as unknown as Record<string, Record<string, Record<string, Model<string>>>>;

const models = Object.fromEntries(
	Object.entries(data).map(([provider, groups]) => [provider, Object.assign({}, ...Object.values(groups))]),
) as Record<string, Record<string, Model<string>>>;

export function listCatalogProviders(): string[] {
	return Object.keys(models);
}

export function listCatalogModels(provider?: string): Model<string>[] {
	return provider ? Object.values(models[provider] ?? {}) : Object.values(models).flatMap(group => Object.values(group));
}

export function getCatalogModel(provider: string, id: string): Model<string> | undefined {
	const model = models[provider]?.[id];
	return model ? structuredClone(model) : undefined;
}
