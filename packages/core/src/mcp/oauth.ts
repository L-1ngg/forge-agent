import { awaitMcpOperation } from "./operation.ts";
import { createHash, randomUUID } from "node:crypto";
import { auth, extractWWWAuthenticateParams, StreamableHTTPClientTransport, SSEClientTransport, type AuthProvider, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/client";
import { McpError, type McpCredentialRecord, type McpCredentialStore, type McpInteraction, type McpServerConfiguration } from "./types.ts";

/** All token read/refresh/write transactions and logout share a resource/profile lock.
 * Issuer-specific records prevent a newly discovered issuer reusing old credentials. */
export class McpOAuth {
	private readonly responses = new WeakMap<Response, string | undefined>();
	readonly fetch: import("@modelcontextprotocol/client").FetchLike = async (input, init) => { const response = await fetch(input, init); const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)); this.responses.set(response, headers.get("authorization")?.replace(/^Bearer /i, "")); return response; };
	private readonly resource: string;
	private readonly profile: string;
	private readonly key: string;
	constructor(private server: McpServerConfiguration, private store: McpCredentialStore, private interaction?: McpInteraction, private observe?: (operation: Promise<unknown>) => void) {
		this.resource = new URL(server.url!).href; this.profile = server.auth?.profile ?? "default";
		this.key = createHash("sha256").update(`${this.resource}\0${this.profile}`).digest("hex");
	}
	private grant(issuer: string) { return createHash("sha256").update(`${this.key}\0${issuer}`).digest("hex"); }
	private async record(issuer?: string) {
		issuer ??= (await this.store.read(this.key))?.issuer;
		return issuer ? await this.store.read(this.grant(issuer)) : undefined;
	}
	private provider(redirectUri: string | undefined, signal: AbortSignal, interactive = redirectUri !== undefined) {
		let verifier = "", redirect: URL | undefined, discovery: OAuthDiscoveryState | undefined;
		const state = randomUUID();
		const save = async (issuer: string, update: Partial<McpCredentialRecord>) => {
			signal.throwIfAborted();
			const base = { schemaVersion: 1 as const, resource: this.resource, issuer, authProfile: this.profile };
			const record = { ...base, ...await this.record(issuer), ...update };
			await this.store.write(this.key, base);
			signal.throwIfAborted(); await this.store.write(this.grant(issuer), record);
		};
		const provider: OAuthClientProvider = {
			redirectUrl: redirectUri,
			clientMetadata: { client_name: "Forge Agent", redirect_uris: redirectUri ? [redirectUri] : [], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", ...(this.server.auth?.scopes ? { scope: this.server.auth.scopes.join(" ") } : {}) },
			state: () => state,
			clientInformation: async ctx => (await this.record(ctx?.issuer))?.client,
			saveClientInformation: async (client, ctx) => { const issuer = ctx?.issuer ?? client.issuer; if (!issuer) throw new McpError("issuer-missing", "OAuth issuer is missing"); await save(issuer, { client }); },
			tokens: async ctx => (await this.record(ctx?.issuer))?.tokens,
			saveTokens: async (tokens, ctx) => { const issuer = ctx?.issuer ?? tokens.issuer; if (!issuer) throw new McpError("issuer-missing", "OAuth issuer is missing"); await save(issuer, { tokens }); },
			redirectToAuthorization: url => { if (!interactive) throw new McpError("auth-required", "Explicit MCP login is required"); redirect = url; },
			saveCodeVerifier: value => { verifier = value; }, codeVerifier: () => verifier,
			saveDiscoveryState: value => { discovery = value; }, discoveryState: () => discovery,
			invalidateCredentials: async scope => {
				if (scope === "verifier") { verifier = ""; return; }
				if (scope === "discovery") { discovery = undefined; return; }
				const record = await this.record(); if (!record) return;
				signal.throwIfAborted();
				if (scope === "all") { await this.store.delete(this.grant(record.issuer)); await this.store.delete(this.key); }
				else { if (scope === "tokens") delete record.tokens; else delete record.client; await this.store.write(this.grant(record.issuer), record); }
			},
		};
		return { provider, state, redirect: () => redirect, clear: () => { verifier = ""; discovery = undefined; redirect = undefined; } };
	}
	business(signal: AbortSignal): AuthProvider {
		return {
			token: async () => { signal.throwIfAborted(); return (await this.record())?.tokens?.access_token; },
			onUnauthorized: async ctx => { const operation = this.store.withLock(this.key, async lockSignal => {
				const active = AbortSignal.any([signal, lockSignal]); active.throwIfAborted();
				const current = (await this.record())?.tokens;
				if (current?.access_token && current.access_token !== this.responses.get(ctx.response)) return;
				if (!current?.refresh_token) throw new McpError("auth-required", "Explicit MCP login is required");
				const flow = this.provider("http://127.0.0.1/callback", active, false);
				try { const result = await auth(flow.provider, { ...extractWWWAuthenticateParams(ctx.response), serverUrl: ctx.serverUrl, fetchFn: (input, init) => ctx.fetchFn(input, { ...init, signal: active }) }); if (result !== "AUTHORIZED") throw new McpError("auth-required", "Explicit MCP login is required"); }
				finally { flow.clear(); }
			}, signal); this.observe?.(operation); await awaitMcpOperation(operation, signal, "credential-outcome-unknown"); },
		};
	}
	async login(serverId: string, signal: AbortSignal) {
		if (!this.interaction) throw new McpError("auth-required", "MCP authorization interaction is unavailable");
		await this.store.read(this.key); signal.throwIfAborted();
		const interaction = await this.interaction.beginAuthorization({ serverId, operationId: randomUUID(), signal });
		const flow = this.provider(interaction.redirectUri, signal);
		const fetchFn: import("@modelcontextprotocol/client").FetchLike = (input, init) => fetch(input, { ...init, signal });
		try {
            signal.throwIfAborted();
			await this.store.withLock(this.key, async lockSignal => {
				lockSignal.throwIfAborted();
				await auth(flow.provider, { serverUrl: this.resource, forceReauthorization: true, fetchFn, ...(this.server.auth?.scopes ? { scope: this.server.auth.scopes.join(" ") } : {}) });
			}, signal);
			const url = flow.redirect();
			if (url) {
				const params = await awaitMcpOperation(interaction.authorize(url), signal); signal.throwIfAborted();
				if (params.get("state") !== flow.state) throw new McpError("oauth-state", "OAuth state does not match this operation");
				if (params.has("error") || !params.get("code")) throw new McpError("oauth-denied", "OAuth authorization was not granted");
				await this.store.withLock(this.key, async lockSignal => {
					lockSignal.throwIfAborted();
					const transport = this.server.transport === "sse" ? new SSEClientTransport(new URL(this.resource), { authProvider: flow.provider, fetch: fetchFn }) : new StreamableHTTPClientTransport(new URL(this.resource), { authProvider: flow.provider, fetch: fetchFn });
					try { await transport.finishAuth(params); } finally { await transport.close(); }
				}, signal);
			}
			if (!(await this.record())?.tokens) throw new McpError("credential-storage", "OAuth credentials were not saved");
		} finally { flow.clear(); await interaction.close(); }
	}
	async logout(signal: AbortSignal) {
		await this.store.withLock(this.key, async lockSignal => { lockSignal.throwIfAborted(); signal.throwIfAborted(); const record = await this.record(); if (record) await this.store.delete(this.grant(record.issuer)); await this.store.delete(this.key); }, signal);
	}
}
