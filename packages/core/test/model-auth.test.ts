import { expect, test } from "bun:test";
import { getCatalogModel } from "../src/model-catalog.ts";
import { resolveCatalogAuth } from "../src/model-auth.ts";

function model(provider: string, id: string) {
	const result = getCatalogModel(provider, id);
	if (!result) throw new Error(`Missing fixture model ${provider}/${id}`);
	return result;
}

test("explicit API key wins over ambient provider key", async () => {
	const auth = await resolveCatalogAuth(model("openai", "gpt-4o-mini"), { apiKey: "explicit", env: { OPENAI_API_KEY: "ambient" } });
	expect(auth?.auth.apiKey).toBe("explicit");
});

test("Anthropic bearer token and Cloudflare gateway preserve request headers", async () => {
	const anthropic = await resolveCatalogAuth(model("anthropic", "claude-sonnet-4-5"), { env: { ANTHROPIC_AUTH_TOKEN: "bearer", ANTHROPIC_API_KEY: "other" } });
	expect(anthropic?.auth).toEqual({ headers: { Authorization: "Bearer bearer" } });
	const gateway = await resolveCatalogAuth(model("cloudflare-ai-gateway", "claude-fable-5"), { apiKey: "gateway-key", env: { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_GATEWAY_ID: "gateway" } });
	expect(gateway?.auth.headers).toMatchObject({ "cf-aig-authorization": "Bearer gateway-key", Authorization: null, "x-api-key": null });
	expect(gateway?.env).toMatchObject({ CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_GATEWAY_ID: "gateway" });
});

test("cloud providers accept configured credentials without a generic API key", async () => {
	const bedrock = await resolveCatalogAuth(model("amazon-bedrock", "amazon.nova-2-lite-v1:0"), { env: { AWS_PROFILE: "fixture", AWS_REGION: "us-east-1" } });
	expect(bedrock?.auth).toEqual({});
	expect(bedrock?.env?.AWS_PROFILE).toBe("fixture");
	const vertex = await resolveCatalogAuth(model("google-vertex", "gemini-2.5-flash"), { env: { GOOGLE_CLOUD_PROJECT: "project", GOOGLE_CLOUD_LOCATION: "us-central1", GOOGLE_APPLICATION_CREDENTIALS: "/fixture.json" }, fileExists: async path => path === "/fixture.json" });
	expect(vertex?.auth).toEqual({});
	expect(vertex?.env?.GOOGLE_CLOUD_PROJECT).toBe("project");
});

test("incomplete gateway and cloud settings fail closed", async () => {
	expect(await resolveCatalogAuth(model("cloudflare-ai-gateway", "claude-fable-5"), { apiKey: "key", env: { CLOUDFLARE_ACCOUNT_ID: "account" } })).toBeUndefined();
	expect(await resolveCatalogAuth(model("google-vertex", "gemini-2.5-flash"), { env: { GOOGLE_CLOUD_PROJECT: "project", GOOGLE_CLOUD_LOCATION: "us-central1" }, fileExists: async () => false })).toBeUndefined();
	expect(await resolveCatalogAuth(model("amazon-bedrock", "amazon.nova-2-lite-v1:0"), { env: { AWS_WEB_IDENTITY_TOKEN_FILE: "/fixture-token" } })).toBeUndefined();
});
