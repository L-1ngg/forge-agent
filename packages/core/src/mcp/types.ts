import type { ConfigurationReceipt } from "../configuration.ts";
import type { TextBlock, ImageBlock, McpInputContext } from "@forge-agent/protocol";
import type { OAuthClientInformationMixed, StoredOAuthTokens, Resource, ResourceTemplateType, Prompt, CompleteRequestParams } from "@modelcontextprotocol/client";

export interface McpServerConfiguration {
	transport: "stdio" | "http" | "sse";
	enabled?: boolean;
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	protocol?: "legacy" | "auto" | "2026-07-28";
	auth?: { type: "none" | "header" | "oauth"; profile?: string; scopes?: string[] };
	tools?: { include?: string[]; exclude?: string[] };
	timeouts?: { connect?: number; request?: number; tool?: number; total?: number; interaction?: number; cleanup?: number };
	source?: string;
}
export interface McpConfiguration { enabled?: boolean; servers: Record<string, McpServerConfiguration>; }
export interface McpCredentialRecord {
	schemaVersion: 1; resource: string; issuer: string; authProfile: string;
	client?: OAuthClientInformationMixed;
	tokens?: StoredOAuthTokens;
}
export interface McpCredentialStore {
	read(key: string): Promise<McpCredentialRecord | undefined>;
	write(key: string, record: McpCredentialRecord): Promise<void>;
	delete(key: string): Promise<void>;
	withLock<T>(key: string, operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>;
}
export interface McpArtifactReference { id: string; mimeType: string; size: number; name?: string; }
export interface McpArtifactStore {
	put(bytes: Uint8Array, metadata: { mimeType: string; name?: string }, signal?: AbortSignal): Promise<McpArtifactReference>;
	read(id: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; metadata: McpArtifactReference }>;
	delete?(id: string): Promise<void>;
}
export interface McpInteraction {
	beginAuthorization(input: { serverId: string; operationId: string; signal: AbortSignal }): Promise<{
		redirectUri: string;
		authorize(url: URL): Promise<URLSearchParams>;
		close(): Promise<void> | void;
	}>;
}
export interface McpOptions extends McpConfiguration {
	credentials?: McpCredentialStore;
	artifacts?: McpArtifactStore;
	interaction?: McpInteraction;
}
export type McpServerState = "disabled" | "connecting" | "ready" | "auth-required" | "reconnecting" | "failed" | "closing" | "closed";
export interface McpServerSnapshot {
	serverId: string; state: McpServerState; connectionGeneration: number;
	transport: McpServerConfiguration["transport"]; protocol?: string; source?: string;
	capabilities: Record<string, unknown>;
	tools: Array<{ name: string; remoteName: string; description?: string }>;
	resources: Resource[]; templates: ResourceTemplateType[]; prompts: Prompt[];
	diagnostics: string[];
}
export interface McpSnapshot { enabled: boolean; revision: number; servers: McpServerSnapshot[]; }
export type McpEvent = {
	type: "state" | "catalog" | "authentication" | "subscription" | "diagnostic";
	serverId: string; operationId: string; connectionGeneration: number; timestamp: number;
	state?: McpServerState; message?: string; uri?: string;
};
export interface McpContentSnapshot {
	serverId: string; remoteName: string; fetchedAt: number; catalogRevision: number;
	content: (TextBlock | ImageBlock)[];
	original: unknown;
	artifacts: McpArtifactReference[];
	structuredContent?: unknown;
	diagnostics: string[];
}
export interface McpRequestOptions { signal?: AbortSignal; }
export interface McpController {
	snapshot(): McpSnapshot;
	subscribe(listener: (event: McpEvent) => void): () => void;
	refresh(serverId?: string): Promise<ConfigurationReceipt>;
	reconnect(serverId: string): Promise<ConfigurationReceipt>;
	setEnabled(serverId: string, enabled: boolean): Promise<ConfigurationReceipt>;
	login(serverId: string, options?: McpRequestOptions): Promise<{ status: "authenticated"; receipt: ConfigurationReceipt }>;
	logout(serverId: string, options?: McpRequestOptions): Promise<{ status: "logged-out"; receipt: ConfigurationReceipt }>;
	listResources(serverId: string, options?: McpRequestOptions): Promise<Resource[]>;
	listResourceTemplates(serverId: string, options?: McpRequestOptions): Promise<ResourceTemplateType[]>;
	listPrompts(serverId: string, options?: McpRequestOptions): Promise<Prompt[]>;
	complete(serverId: string, ref: CompleteRequestParams["ref"], argument: CompleteRequestParams["argument"], context?: CompleteRequestParams["context"], options?: McpRequestOptions): Promise<string[]>;
	readResource(serverId: string, uri: string, options?: McpRequestOptions): Promise<McpContentSnapshot>;
	getPrompt(serverId: string, name: string, args?: Record<string, string>, options?: McpRequestOptions): Promise<McpInputContext>;
	subscribeResource(serverId: string, uri: string): Promise<void>;
	unsubscribeResource(serverId: string, uri: string): Promise<void>;
	readArtifact(id: string, options?: McpRequestOptions): Promise<{ bytes: Uint8Array; metadata: McpArtifactReference }>;
}
export class McpError extends Error {
	constructor(readonly code: string, message: string) { super(message); this.name = "McpError"; }
}
