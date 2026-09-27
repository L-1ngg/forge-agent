import { randomUUID } from "node:crypto";
import type { CreateAgentOptions, Agent } from "./agent.ts";
import { AgentSession } from "./agent-session.ts";
import { McpManager } from "./mcp/manager.ts";
import { discoverSkills } from "./skills/catalog.ts";
import { snapshotConfiguration, prepareSessionConfiguration } from "./session-configuration.ts";
import type { ConfigurationPatch } from "./configuration.ts";
import type { RequestBus } from "./request-bus.ts";
import type { SessionStorage, SessionState } from "./session-storage.ts";

export async function assembleAgent(options: CreateAgentOptions, storage: SessionStorage, requestBus: RequestBus, state: SessionState): Promise<Agent> {
	const manager = new McpManager(options.mcp, { cwd: options.cwd, ...(options.permission ? { permission: options.permission } : {}), requestBus });
	let desired = snapshotConfiguration({ ...options, sessionId: options.sessionId ?? randomUUID(), thinkingLevel: options.thinkingLevel ?? "off", requestBus });
	try {
		let catalog = await discoverSkills(desired.skills, desired.cwd);
		const prepare = async (next: CreateAgentOptions, nextCatalog: typeof catalog, signal?: AbortSignal) => {
			const assembly = await prepareSessionConfiguration(next, nextCatalog);
			const mcpConfig = next.mcp ? { enabled: next.mcp.enabled ?? true, servers: next.mcp.servers } : next.mcp;
			const mcp = await manager.prepare(mcpConfig, [...(next.tools ?? []).map(tool => tool.name), "load_skill", "read_context", "search_context"], signal);
			assembly.mcp = mcp; assembly.options.mcpManager = manager;
			if (mcp.instructions) assembly.options.systemPrompt += "\n\n" + mcp.instructions;
			assembly.options.tools = [...assembly.options.tools ?? [], ...mcp.tools];
			return assembly;
		};
		const initial = await prepare(desired, catalog);
		initial.mcp!.commit(0);
		const session = new AgentSession(initial, storage, requestBus, state, async (patch: ConfigurationPatch, refresh = false, signal?: AbortSignal) => {
			const next = snapshotConfiguration({ ...desired, ...patch });
			const nextCatalog = refresh || "skills" in patch ? await discoverSkills(next.skills, next.cwd, signal) : catalog;
			const assembly = await prepare(next, nextCatalog, signal);
			if (signal?.aborted) { await assembly.mcp?.discard(); signal.throwIfAborted(); }
			catalog = nextCatalog; desired = next;
			return assembly;
		});
		manager.bind(patch => session.updateConfiguration(patch));
		return session;
	} catch (error) {
		try { await manager.dispose(); }
		catch (cleanup) { throw new AggregateError([error, cleanup], "Agent creation failed and cleanup was incomplete", { cause: error }); }
		throw error;
	}
}
