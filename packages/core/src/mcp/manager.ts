import { awaitMcpOperation } from "./operation.ts";
import { randomUUID } from "node:crypto";
import { InsufficientScopeError, Client, StreamableHTTPClientTransport, SSEClientTransport, UriTemplate, type Tool, type McpSubscription, type CompleteRequestParams } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import type { HarnessTool } from "@forge-agent/tools";
import { defineLocalTool } from "@forge-agent/tools/define-builtin";
import { z } from "zod";
import type { McpInputContext } from "@forge-agent/protocol";
import type { ConfigurationPatch, ConfigurationReceipt } from "../configuration.ts";
import type { PermissionContext } from "../permission/index.ts";
import type { RequestBus } from "../request-bus.ts";
import { checkPermission } from "../session-tools.ts";
import { normalizeMcpConfiguration, connectionIdentity, mcpToolName } from "./config.ts";
import { MemoryMcpArtifactStore } from "./artifacts.ts";
import { MemoryMcpCredentialStore } from "./credentials.ts";
import { normalizeMcpContent } from "./content.ts";
import { McpOAuth } from "./oauth.ts";
import { McpError, type McpConfiguration, type McpOptions, type McpController, type McpServerConfiguration, type McpServerSnapshot, type McpEvent, type McpRequestOptions, type McpArtifactStore } from "./types.ts";

interface Connection {
	id: string; generation: number; identity: string; config: McpServerConfiguration; client: Client;
	transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
	controller: AbortController; snapshot: McpServerSnapshot; tools: Tool[];
	requiredScopes?: string[]; refs: number; closing?: Promise<void>; subscriptions: Map<string, McpSubscription | null>;
}
export interface McpAssembly { instructions: string; tools: HarnessTool<object, unknown>[]; commit(revision: number): void; discard(): Promise<void>; }

const empty = (id: string, config: McpServerConfiguration, generation: number): McpServerSnapshot => ({ serverId: id, state: config.enabled === false ? "disabled" : "connecting", connectionGeneration: generation, transport: config.transport, ...(config.source ? { source: config.source } : {}), capabilities: {}, tools: [], resources: [], templates: [], prompts: [], diagnostics: [] });

export class McpManager implements McpController {
	private configuration: McpConfiguration = { enabled: false, servers: {} };
	private current = new Map<string, Connection>();
	private all = new Set<Connection>();
	private listeners = new Set<(event: McpEvent) => void>();
	private lifetime = new AbortController();
	private generation = 0;
	private revision = 0;
	private disposed = false;
	private cleanupErrors: unknown[] = [];
	private disposal?: Promise<void>;
	private operations = new Set<Promise<unknown>>();
	private dirty = new Set<string>();
	private force = new Set<string>();
	private revoking = new Set<string>();
	private update?: (patch: ConfigurationPatch) => Promise<ConfigurationReceipt>;
	private refreshQueued = false;
	readonly artifacts: McpArtifactStore;
	private credentials;
	constructor(private options: McpOptions | false | undefined, private host: { cwd: string; permission?: PermissionContext; requestBus?: RequestBus }) {
		this.artifacts = options && options.artifacts || new MemoryMcpArtifactStore();
		this.credentials = options && options.credentials || new MemoryMcpCredentialStore();
	}
	bind(update: (patch: ConfigurationPatch) => Promise<ConfigurationReceipt>) { this.update = update; }
	snapshot() { return structuredClone({ enabled: this.configuration.enabled !== false, revision: this.revision, servers: [...this.current.values()].map(connection => connection.snapshot).sort((a, b) => a.serverId.localeCompare(b.serverId)) }); }
	subscribe(listener: (event: McpEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
	private emit(connection: Connection, type: McpEvent["type"], details: Partial<Pick<McpEvent, "message" | "uri" | "state">> = {}) {
		const event: McpEvent = { type, serverId: connection.id, connectionGeneration: connection.generation, operationId: randomUUID(), timestamp: Date.now(), ...details };
		for (const listener of this.listeners) { try { listener(structuredClone(event)); } catch { /* observers do not own cleanup */ } }
	}
	private assertEnabled() { if (this.disposed) throw new McpError("disposed", "MCP manager has been disposed"); if (this.configuration.enabled === false) throw new McpError("mcp-disabled", "MCP is disabled"); }
	private get(id: string) { this.assertEnabled(); const connection = this.current.get(id); if (!connection) throw new McpError("unknown-server", `Unknown MCP server ${id}`); return connection; }
	private ready(id: string) { const connection = this.get(id); if (this.revoking.has(id)) throw new McpError("auth-required", "MCP logout is in progress"); if (connection.snapshot.state !== "ready") throw new McpError(connection.snapshot.state, `MCP ${id} is ${connection.snapshot.state}`); return connection; }
	private signal(connection: Connection, signal?: AbortSignal) { return AbortSignal.any([this.lifetime.signal, connection.controller.signal, ...(signal ? [signal] : [])]); }
	private request(connection: Connection, signal?: AbortSignal) { return { signal: this.signal(connection, signal), timeout: connection.config.timeouts?.request ?? 15000 }; }
	private failure(connection: Connection, error: unknown): never {
        if (error instanceof InsufficientScopeError) {
            connection.requiredScopes = error.requiredScope?.split(/\s+/).filter(Boolean) ?? [];
            connection.snapshot.state = "auth-required";
            this.emit(connection, "authentication", { state: "auth-required", message: "Additional OAuth scopes require explicit login" });
            throw new McpError("auth-required", "Additional OAuth scopes require explicit login");
        }
        if (error instanceof McpError) throw error;
        if (error instanceof Error && error.name === "UnauthorizedError") {
            connection.snapshot.state = "auth-required";
            throw new McpError("auth-required", "Explicit MCP login required");
        }
        // Transport error messages may contain response bodies, URLs or headers.
        throw new McpError("remote-error", "MCP request failed or was canceled; remote outcome may be unknown");
    }
    private async authorize(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
		const result = await checkPermission({ type: "tool_call", id: randomUUID(), name, arguments: args }, { context: this.host.permission ?? {}, ...(this.host.requestBus ? { requestBus: this.host.requestBus } : {}) }, signal);
		if (!result.allowed) throw new McpError("permission-denied", result.reason);
	}
	private oauth(config: McpServerConfiguration) { if (config.auth?.type !== "oauth") throw new McpError("not-oauth", "Server is not configured for OAuth"); return new McpOAuth(config, this.credentials, this.options && this.options.interaction || undefined, operation => { this.operations.add(operation); operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation)); }); }
	async prepare(raw: McpConfiguration | false | undefined, reserved: string[], signal?: AbortSignal): Promise<McpAssembly> {
		if (this.disposed) throw new McpError("disposed", "MCP manager has been disposed");
		const configuration = normalizeMcpConfiguration(raw, this.host.cwd, process.env, false);
		const candidates = new Map<string, Connection>();
		const catalogs = new Map<Connection, Pick<Connection, "tools" | "snapshot">>();
		const toolset: HarnessTool<object, unknown>[] = [];
		const names = new Set(reserved);
		try {
			const entries = Object.entries(configuration.servers).sort(([a], [b]) => a.localeCompare(b));
			let index = 0;
			const workers = Array.from({ length: Math.min(4, entries.length) }, async () => {
				while (index < entries.length) {
					const [id, configured] = entries[index++]!; const config = this.revoking.has(id) ? { ...configured, enabled: false } : configured; signal?.throwIfAborted();
					let connection = this.current.get(id);
					if (!connection || connection.closing || connection.identity !== connectionIdentity(config) || connection.config.enabled !== config.enabled || this.force.delete(id)) connection = await this.connect(id, config, signal);
					connection.refs++; candidates.set(id, connection);
					catalogs.set(connection, this.dirty.delete(id) && connection.snapshot.state === "ready" ? await this.catalog(connection, signal) : { tools: connection.tools, snapshot: structuredClone(connection.snapshot) });
				}
			});
			const results = await Promise.allSettled(workers); const failed = results.find(result => result.status === "rejected"); if (failed?.status === "rejected") throw failed.reason;
			signal?.throwIfAborted(); this.lifetime.signal.throwIfAborted();
			for (const [id, connection] of [...candidates].sort(([a], [b]) => a.localeCompare(b))) {
				const config = configuration.servers[id]!;
				const catalog = catalogs.get(connection)!;
                catalog.snapshot.tools = [];
				for (const name of [...config.tools?.include ?? [], ...config.tools?.exclude ?? []]) if (!catalog.tools.some(tool => tool.name === name)) catalog.snapshot.diagnostics.push(`Unknown tool filter: ${name}`);
				for (const definition of [...catalog.tools].sort((a, b) => a.name.localeCompare(b.name))) {
					if (connection.snapshot.state !== "ready" || config.tools?.exclude?.includes(definition.name) || (config.tools?.include && !config.tools.include.includes(definition.name))) continue;
					try {
						const mapped = this.tool(connection, structuredClone(definition));
						if (names.has(mapped.name)) throw new McpError("tool-collision", `Tool name collision: ${mapped.name}`);
						names.add(mapped.name); toolset.push(mapped); catalog.snapshot.tools.push({ name: mapped.name, remoteName: definition.name, ...(definition.description ? { description: definition.description } : {}) });
					} catch { catalog.snapshot.diagnostics.push(`Unsupported or conflicting tool: ${definition.name}`); }
				}
			}
			if (configuration.enabled !== false && candidates.size) for (const tool of this.bridgeTools()) { if (names.has(tool.name)) throw new McpError("tool-collision", `${tool.name} is reserved for MCP`); names.add(tool.name); toolset.push(tool); }
			let settled = false;
			return { instructions: [...candidates.values()].filter(connection => connection.snapshot.state === "ready" && connection.client.getInstructions()).map(connection => `External MCP usage notes (${connection.id}; service-supplied context):\n${connection.client.getInstructions()}`).join("\n\n"), tools: toolset,
				commit: revision => {
					if (settled) return; settled = true;
					const old = this.current; this.current = candidates; for (const [connection, catalog] of catalogs) Object.assign(connection, catalog); this.configuration = configuration; this.revision = revision;
					for (const [id, connection] of old) {
                        const replacement = candidates.get(id);
                        if (replacement !== connection) {
                            const uris = [...connection.subscriptions.keys()];
                            this.stopSubscriptions(connection);
                            if (replacement?.identity === connection.identity && replacement.snapshot.state === "ready" && !this.revoking.has(id)) for (const uri of uris) {
                                if (replacement.snapshot.resources.some(resource => resource.uri === uri) || replacement.snapshot.templates.some(template => new UriTemplate(template.uriTemplate).match(uri))) {
                                    void this.startSubscription(replacement, uri).catch(() => this.emit(replacement, "subscription", { uri, message: "terminated" }));
                                } else this.emit(replacement, "subscription", { uri, message: "terminated: resource no longer available" });
                            }
                        }
                        void this.release(connection).catch(() => this.emit(connection, "diagnostic", { message: "cleanup-timeout" }));
                    }
					for (const connection of candidates.values()) {
                        for (const uri of connection.subscriptions.keys()) {
                            if (!connection.snapshot.resources.some(resource => resource.uri === uri) && !connection.snapshot.templates.some(template => new UriTemplate(template.uriTemplate).match(uri))) {
                                void this.unsubscribeResource(connection.id, uri).catch(() => {});
                                this.emit(connection, "subscription", { uri, message: "terminated: resource no longer available" });
                            }
                        }
                        this.emit(connection, "catalog");
                    }
				},
				discard: async () => { if (settled) return; settled = true; await Promise.all([...candidates.values()].map(connection => this.release(connection))); },
			};
		} catch (error) { await Promise.allSettled([...candidates.values()].map(connection => this.release(connection))); throw error; }
	}
	private async connect(id: string, config: McpServerConfiguration, signal?: AbortSignal): Promise<Connection> {
		const identity = connectionIdentity(config);
		let environmentError: unknown;
        try { config = normalizeMcpConfiguration({ servers: { [id]: config } }, this.host.cwd).servers[id]!; }
        catch (error) { if (!(error instanceof McpError) || error.code !== "missing-env") throw error; environmentError = error; }
        const controller = new AbortController(); const active = AbortSignal.any([controller.signal, this.lifetime.signal, ...(signal ? [signal] : [])]);
		let connection!: Connection;
		const changed = () => { if (this.current.get(id) !== connection || this.disposed) return; this.dirty.add(id); if (this.refreshQueued) return; this.refreshQueued = true; queueMicrotask(() => { this.refreshQueued = false; void this.update?.({}).catch(() => this.emit(connection, "diagnostic", { message: "Catalog refresh failed" })); }); };
		const client = new Client({ name: "forge-agent", version: "0.1.0" }, { jsonSchemaValidator: { getValidator: schema => new AjvJsonSchemaValidator().getValidator(schema) }, capabilities: { elicitation: { form: {}, url: {} } }, versionNegotiation: { mode: config.protocol === "2026-07-28" ? { pin: "2026-07-28" } : config.protocol ?? "legacy", probe: { timeoutMs: 3000 } }, listChanged: { tools: { onChanged: changed }, resources: { onChanged: changed }, prompts: { onChanged: changed } } });
		const oauth = config.auth?.type === "oauth" ? this.oauth(config) : undefined;
		const remote = { requestInit: { ...(config.headers ? { headers: config.headers } : {}) }, ...(oauth ? { authProvider: oauth.business(active), fetch: oauth.fetch } : {}), onInsufficientScope: "throw" as const };
		const transport = config.transport === "stdio" ? new StdioClientTransport({ command: config.command!, ...(config.args ? { args: config.args } : {}), ...(config.cwd ? { cwd: config.cwd } : {}), ...(config.env ? { env: config.env } : {}), stderr: "pipe" }) : config.transport === "sse" ? new SSEClientTransport(new URL(config.url!), remote) : new StreamableHTTPClientTransport(new URL(config.url!), remote);
		connection = { id, generation: ++this.generation, identity, config, client, transport, controller, snapshot: empty(id, config, this.generation), tools: [], refs: 0, subscriptions: new Map() }; this.all.add(connection);
		client.setRequestHandler("elicitation/create", async (request, context) => {
			const params = request.params; const mode = params.mode ?? "form";
			if (!this.host.requestBus) return { action: "cancel" };
			const outcome = await this.host.requestBus.ask("mcp_elicitation", { serverId: id, operationId: randomUUID(), message: params.message, mode, ...(params.mode === "url" ? { url: params.url } : { requestedSchema: params.requestedSchema }) }, { signal: AbortSignal.any([active, context.mcpReq.signal]), timeoutMs: config.timeouts?.interaction ?? 300000 });
			if (outcome.status !== "response") return { action: "cancel" };
			const result = outcome.result;
			return { action: result.decision, ...(result.decision === "accept" && result.content ? { content: result.content } : {}) };
		});
		client.setNotificationHandler("notifications/resources/updated", notification => { if (this.current.get(id) === connection && connection.subscriptions.has(notification.params.uri)) this.emit(connection, "subscription", { uri: notification.params.uri }); });
		client.onclose = () => { if (!connection.closing && !this.disposed && connection.snapshot.state === "ready") { connection.snapshot.state = "failed"; this.emit(connection, "state", { state: "failed" }); this.scheduleRecovery(connection); } };
		client.onerror = () => this.emit(connection, "diagnostic", { message: "MCP protocol or transport error" });
		if (config.enabled === false) return connection;
		if (environmentError) { connection.snapshot.state = "failed"; connection.snapshot.diagnostics.push((environmentError as McpError).message); return connection; }
		this.emit(connection, "state", { state: "connecting" });
		try {
			const connectSignal = AbortSignal.any([active, AbortSignal.timeout(config.timeouts?.connect ?? 15000)]);
			await awaitMcpOperation(client.connect(transport, { signal: connectSignal, timeout: config.timeouts?.connect ?? 15000 }), connectSignal, "connection-timeout");
			if (transport instanceof StdioClientTransport) transport.stderr?.on("data", () => {});
			const protocol = client.getNegotiatedProtocolVersion(); if (protocol) connection.snapshot.protocol = protocol; connection.snapshot.capabilities = client.getServerCapabilities() ?? {};
			Object.assign(connection, await this.catalog(connection, active)); connection.snapshot.state = "ready"; this.emit(connection, "state", { state: "ready" });
		} catch (error) {
			if (error instanceof InsufficientScopeError) connection.requiredScopes = error.requiredScope?.split(/\s+/).filter(Boolean) ?? [];
            connection.snapshot.state = error instanceof InsufficientScopeError || error instanceof McpError && error.code === "auth-required" || (error instanceof Error && error.name === "UnauthorizedError") ? "auth-required" : "failed";
			connection.snapshot.diagnostics.push(connection.snapshot.state === "auth-required" ? "Explicit login required" : "Connection or catalog discovery failed");
			const canceled = active.aborted; await this.close(connection);
			if (canceled) { active.throwIfAborted(); }
		}
		return connection;
	}
	private async catalog(connection: Connection, signal?: AbortSignal) {
		const capabilities = connection.client.getServerCapabilities(); const options = this.request(connection, signal);
		const [tools, resources, templates, prompts] = await Promise.all([
			capabilities?.tools ? connection.client.listTools(undefined, options).then(result => result.tools) : [],
			capabilities?.resources ? connection.client.listResources(undefined, options).then(result => result.resources) : [],
			capabilities?.resources ? connection.client.listResourceTemplates(undefined, options).then(result => result.resourceTemplates) : [],
			capabilities?.prompts ? connection.client.listPrompts(undefined, options).then(result => result.prompts) : [],
		]);
		return { tools, snapshot: { ...connection.snapshot, resources, templates, prompts, tools: tools.map(tool => ({ name: mcpToolName(connection.id, tool.name), remoteName: tool.name, ...(tool.description ? { description: tool.description } : {}) })) } };
	}
	private tool(connection: Connection, definition: Tool): HarnessTool<object, unknown> {
		// The protocol exposes JSON-valued keywords; the validator has a narrower
        // declaration. Compilation below checks the actual dialect and references.
        // Use a fresh provider per immutable definition so identical $id values
        // from different servers/revisions cannot share validators.
        const validator = new AjvJsonSchemaValidator();
        validator.getValidator<object>(definition.inputSchema as Parameters<AjvJsonSchemaValidator["getValidator"]>[0]);
		return { name: mcpToolName(connection.id, definition.name), label: `${connection.id}/${definition.name}`, description: definition.description ?? `MCP tool ${connection.id}/${definition.name}`, parameters: definition.inputSchema,
			execute: async (args, context) => {
                if (this.revoking.has(connection.id)) throw new McpError("auth-required", "MCP authorization was revoked");
				const result = await connection.client.callTool({ name: definition.name, arguments: args as Record<string, unknown> }, { toolDefinition: definition, signal: this.signal(connection, context.signal), timeout: connection.config.timeouts?.tool ?? 60000, resetTimeoutOnProgress: true, maxTotalTimeout: connection.config.timeouts?.total ?? 300000, onprogress: progress => context.onUpdate?.({ content: [{ type: "text", text: JSON.stringify(progress) }], details: { serverId: connection.id, progress } }) }).catch(error => this.failure(connection, error));
				const snapshot = await normalizeMcpContent({ serverId: connection.id, remoteName: definition.name, catalogRevision: this.revision, content: result.content ?? [], ...("structuredContent" in result ? { structuredContent: result.structuredContent } : {}) }, this.artifacts, context.signal);
				return { content: snapshot.content, details: snapshot, ...(result.isError ? { isError: true } : {}) };
			},
		};
	}
	private bridgeTools(): HarnessTool<object, unknown>[] {
		const resourceSchema = z.xor([
			z.strictObject({ serverId: z.string().min(1), uri: z.string().min(1) }),
			z.strictObject({ serverId: z.string().min(1), template: z.string().min(1), arguments: z.record(z.string(), z.string()) }),
		]);
		const normalizeResource = (input: z.infer<typeof resourceSchema>) => {
			if ("template" in input) {
				const connection = this.ready(input.serverId);
				if (!connection.snapshot.templates.some(template => template.uriTemplate === input.template)) throw new McpError("unknown-template", "Unknown resource template");
				return { serverId: input.serverId, uri: new UriTemplate(input.template).expand(input.arguments ?? {}) };
			}
			return input;
		};
		return [
			defineLocalTool({
				name: "mcp_list_resources", label: "MCP resources", description: "List MCP resources and URI templates",
				inputSchema: z.strictObject({ serverId: z.string().min(1), kind: z.enum(["resources", "templates", "all"]).optional() }),
				execute: async (args, context) => {
					const { serverId, kind = "all" } = args;
                    const connection = this.ready(serverId);
                    const value = { resources: kind === "templates" ? [] : connection.snapshot.resources, templates: kind === "resources" ? [] : connection.snapshot.templates };
                    const snapshot = await normalizeMcpContent({ serverId, remoteName: "resources", catalogRevision: this.revision, content: [{ type: "text", text: JSON.stringify(value) }] }, this.artifacts, context.signal);
                    return { content: snapshot.content, details: snapshot };
                },
			}),
			defineLocalTool({
				name: "mcp_read_resource", label: "Read MCP resource", description: "Read a URI or expand a discovered URI template with arguments",
				inputSchema: resourceSchema,
				execute: async (args, context) => {
					const { serverId, uri } = normalizeResource(args);
					const result = await this.read(serverId, uri, context.signal);
					return { content: result.content, details: result };
				},
			}),
			defineLocalTool({
				name: "mcp_read_artifact", label: "Read MCP attachment", description: "Read saved original attachment bytes; offset/limit are byte offsets (maximum 64 KiB)",
				inputSchema: z.strictObject({ id: z.string().min(1), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(65536).optional() }),
				execute: async (args, context) => {
					this.assertEnabled();
					const result = await this.artifacts.read(args.id, context.signal);
					const bytes = result.bytes.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 16384));
					return { content: [{ type: "text", text: result.metadata.mimeType.startsWith("text/") ? Buffer.from(bytes).toString("utf8") : Buffer.from(bytes).toString("base64") }], details: result.metadata };
				},
			}),
        ];
    }
	async refresh(id?: string) { this.assertEnabled(); if (id) this.get(id); for (const key of id ? [id] : this.current.keys()) this.dirty.add(key); return this.submit({}); }
	async reconnect(id: string) { this.get(id); this.force.add(id); return this.submit({}); }
	async setEnabled(id: string, enabled: boolean) { this.get(id); const config = structuredClone(this.configuration); config.servers[id]!.enabled = enabled; return this.submit({ mcp: config }); }
	private track<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
        this.operations.add(operation); operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation));
        return awaitMcpOperation(operation, signal, "credential-outcome-unknown");
    }
    private submit(patch: ConfigurationPatch) { if (!this.update) throw new McpError("not-ready", "MCP configuration queue is not attached"); return this.update(patch); }
	async login(id: string, options: McpRequestOptions = {}) { const connection = this.get(id); const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(connection.config.timeouts?.interaction ?? 300000), ...(options.signal ? [options.signal] : [])]); await this.track(this.oauth({ ...connection.config, ...(connection.config.auth ? { auth: { ...connection.config.auth, scopes: [...new Set([...connection.config.auth.scopes ?? [], ...connection.requiredScopes ?? []])] } } : {}) }).login(id, signal), signal); this.revoking.delete(id); this.force.add(id); const receipt = await this.setEnabled(id, true); await receipt.applied; this.ready(id); this.emit(this.get(id), "authentication", { message: "authenticated" }); return { status: "authenticated" as const, receipt }; }
	async logout(id: string, options: McpRequestOptions = {}) { const connection = this.get(id); this.revoking.add(id); await this.close(connection); const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15000), ...(options.signal ? [options.signal] : [])]); await this.track(this.oauth(connection.config).logout(signal), signal); const receipt = await this.setEnabled(id, false); await receipt.applied; this.emit(connection, "authentication", { message: "logged-out" }); return { status: "logged-out" as const, receipt }; }
	async listResources(id: string, options: McpRequestOptions = {}) { options.signal?.throwIfAborted(); return structuredClone(this.ready(id).snapshot.resources); }
	async listResourceTemplates(id: string, options: McpRequestOptions = {}) { options.signal?.throwIfAborted(); return structuredClone(this.ready(id).snapshot.templates); }
	async listPrompts(id: string, options: McpRequestOptions = {}) { options.signal?.throwIfAborted(); return structuredClone(this.ready(id).snapshot.prompts); }
	async complete(id: string, ref: CompleteRequestParams["ref"], argument: CompleteRequestParams["argument"], context?: CompleteRequestParams["context"], options: McpRequestOptions = {}) { const connection = this.ready(id); return (await connection.client.complete({ ref, argument, ...(context ? { context } : {}) }, this.request(connection, options.signal)).catch(error => this.failure(connection, error))).completion.values; }
	async readResource(id: string, uri: string, options: McpRequestOptions = {}) { const connection = this.ready(id), revision = this.revision; const signal = this.signal(connection, options.signal); await this.authorize("mcp_read_resource", { serverId: id, uri }, signal); return this.read(id, uri, signal, connection, revision); }
	private async read(id: string, uri: string, signal?: AbortSignal, connection = this.ready(id), revision = this.revision) { const result = await connection.client.readResource({ uri }, this.request(connection, signal)).catch(error => this.failure(connection, error)); return normalizeMcpContent({ serverId: id, remoteName: uri, catalogRevision: revision, content: result.contents.map(resource => ({ type: "resource" as const, resource })) }, this.artifacts, signal); }
	async getPrompt(id: string, name: string, args: Record<string, string> = {}, options: McpRequestOptions = {}): Promise<McpInputContext> {
		const connection = this.ready(id), revision = this.revision;
        await this.authorize("mcp_get_prompt", { serverId: id, name, arguments: args }, this.signal(connection, options.signal));
		const result = await connection.client.getPrompt({ name, arguments: args }, this.request(connection, options.signal)).catch(error => this.failure(connection, error));
		if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024 * 1024) throw new McpError("content-too-large", "MCP prompt exceeds 16 MiB; original content was not retained");
		const envelope: McpInputContext = { originalMessages: structuredClone(result.messages), kind: "mcp_prompt", serverId: id, name, arguments: args, catalogRevision: revision, fetchedAt: Date.now(), messages: [], artifacts: [] };
		try { for (const message of result.messages) { const content = await normalizeMcpContent({ serverId: id, remoteName: name, catalogRevision: revision, content: [message.content] }, this.artifacts, options.signal); envelope.messages.push({ role: message.role, content: content.content.map(block => message.role === "assistant" && block.type === "image" ? { type: "text", text: "Template assistant image retained as attachment (see source envelope)." } : block) }); envelope.artifacts.push(...content.artifacts); } return envelope; }
		catch (error) { await Promise.allSettled(envelope.artifacts.map(ref => this.artifacts.delete?.(ref.id))); throw error; }
	}
	async readArtifact(id: string, options: McpRequestOptions = {}) { this.assertEnabled(); await this.authorize("mcp_read_artifact", { id }, options.signal); return this.artifacts.read(id, options.signal); }
	async subscribeResource(id: string, uri: string) {
        const connection = this.ready(id);
        await this.authorize("mcp_subscribe_resource", { serverId: id, uri });
        await this.startSubscription(connection, uri);
    }
    private async startSubscription(connection: Connection, uri: string, attempt = 0): Promise<void> {
        if (connection.subscriptions.has(uri) || connection.controller.signal.aborted) return;
        connection.subscriptions.set(uri, null);
        try {
            if (connection.client.getNegotiatedProtocolVersion() !== "2026-07-28") {
                await connection.client.subscribeResource({ uri }, this.request(connection));
                return;
            }
            const subscription = await connection.client.listen({ resourceSubscriptions: [uri] }, this.request(connection));
            if (!connection.subscriptions.has(uri) || connection.controller.signal.aborted) { await subscription.close(); return; }
            if (!subscription.honoredFilter.resourceSubscriptions?.includes(uri)) { await subscription.close(); throw new McpError("unsupported-subscription", "Server did not accept this resource subscription"); }
            connection.subscriptions.set(uri, subscription);
            this.emit(connection, "subscription", { uri, message: "active" });
            void subscription.closed.then(async reason => {
                if (connection.subscriptions.get(uri) !== subscription || this.current.get(connection.id) !== connection) return;
                if (reason === "remote" && !connection.controller.signal.aborted && attempt < 3) {
                    this.emit(connection, "subscription", { uri, message: "recovering" });
                    await new Promise<void>(resolve => {
                        const signal = connection.controller.signal;
                        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
                        const timer = setTimeout(done, 250 * 2 ** attempt); signal.addEventListener("abort", done, { once: true });
                    });
                    if (connection.subscriptions.get(uri) !== subscription || this.current.get(connection.id) !== connection) return;
                    connection.subscriptions.delete(uri);
                    await this.startSubscription(connection, uri, attempt + 1);
                } else { connection.subscriptions.delete(uri); this.emit(connection, "subscription", { uri, message: "terminated" }); }
            }).catch(() => this.emit(connection, "subscription", { uri, message: "terminated" }));
        } catch (error) { connection.subscriptions.delete(uri); throw error; }
    }
    async unsubscribeResource(id: string, uri: string) {
        const connection = this.get(id); const subscription = connection.subscriptions.get(uri);
        if (subscription === undefined) return;
        connection.subscriptions.delete(uri);
        if (subscription) await subscription.close(); else await connection.client.unsubscribeResource({ uri }, this.request(connection));
    }
    private stopSubscriptions(connection: Connection) {
        void connection.client.autoOpenedSubscription?.close().catch(() => {});
        for (const [uri, subscription] of connection.subscriptions) {
            if (subscription) void subscription.close().catch(() => {});
            else void connection.client.unsubscribeResource({ uri }, { timeout: 1000 }).catch(() => {});
            this.emit(connection, "subscription", { uri, message: "terminated" });
        }
        connection.subscriptions.clear();
    }
	private async release(connection: Connection) { connection.refs--; if (connection.refs <= 0) await this.close(connection); }
	private close(connection: Connection): Promise<void> {
		if (connection.closing) return connection.closing;
		const previousState = connection.snapshot.state;
        if (previousState === "ready") { connection.snapshot.state = "closing"; this.emit(connection, "state", { state: "closing" }); }
        connection.controller.abort(); this.stopSubscriptions(connection); const pid = connection.transport instanceof StdioClientTransport ? connection.transport.pid : undefined;
		connection.closing = (async () => { const deadline = Date.now() + (connection.config.timeouts?.cleanup ?? 5000); let timer: ReturnType<typeof setTimeout> | undefined;
			try { await Promise.race([connection.client.close(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new McpError("cleanup-timeout", "MCP cleanup timed out")), Math.max(1, deadline - Date.now())); })]);
				if (pid) while (true) { try { process.kill(pid, 0); } catch { break; } if (Date.now() >= deadline) throw new McpError("cleanup-timeout", "MCP direct child has not exited"); await new Promise(resolve => setTimeout(resolve, 10)); }
			} catch (error) { connection.snapshot.diagnostics.push("cleanup-timeout"); this.cleanupErrors.push(error); this.emit(connection, "diagnostic", { message: "cleanup-timeout" }); throw error; }
			finally { if (timer) clearTimeout(timer); this.all.delete(connection); if (previousState === "ready") { connection.snapshot.state = "closed"; this.emit(connection, "state", { state: "closed" }); } }
		})(); return connection.closing;
	}
	private scheduleRecovery(connection: Connection) { void (async () => { for (const delay of [1000, 2000, 4000]) { if (this.disposed || this.current.get(connection.id) !== connection) return; await new Promise<void>(resolve => { const timer = setTimeout(done, delay); const signal = this.lifetime.signal; function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); } signal.addEventListener("abort", done, { once: true }); }); if (this.disposed) return; try { const receipt = await this.reconnect(connection.id); await receipt.applied; if (this.current.get(connection.id)?.snapshot.state === "ready") return; connection = this.current.get(connection.id)!; } catch { /* only subsequent requests can use recovery */ } } })(); }
	dispose(): Promise<void> { if (this.disposal) return this.disposal; this.disposed = true; this.lifetime.abort(); this.disposal = (async () => { const results = await Promise.allSettled([...this.all].map(connection => this.close(connection)));
		await awaitMcpOperation(Promise.allSettled([...this.operations]), AbortSignal.timeout(5000), "credential-outcome-unknown"); this.current.clear(); this.listeners.clear(); if (!(this.options && this.options.artifacts) && this.artifacts instanceof MemoryMcpArtifactStore) this.artifacts.clear(); if (!(this.options && this.options.credentials) && this.credentials instanceof MemoryMcpCredentialStore) this.credentials.clear(); const failed = results.filter(result => result.status === "rejected"); if (failed.length || this.cleanupErrors.length) throw new AggregateError([...failed.map(result => result.reason), ...this.cleanupErrors], "MCP cleanup incomplete"); })(); return this.disposal; }
}
