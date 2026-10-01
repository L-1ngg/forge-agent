import { createInputCompletionSource, type Agent, type HarnessConfig } from "@forge-agent/core";
import type { InteractionOptions } from "@forge-agent/interaction";
import { scanFiles } from "@forge-agent/tui";
import { mcpCommand, mcpCompletions, parseMcpCommand, persistMcpEnabled } from "./mcp-command.ts";
import type { MemoryManager } from "./memory-command.ts";
import { skillsCommand, skillsText } from "./skills-command.ts";

type CommandOptions = Pick<InteractionOptions<Agent>, "mcpCommand" | "skillsCommand" | "memoryCommand" | "createCompletionSource">;

/** Production callbacks take their captured instance from the interaction layer. */
export function interactionOptions(cwd: string, config: HarnessConfig, memory: MemoryManager): CommandOptions {
	return {
		mcpCommand: async (input, report, signal, session) => {
			const controller = session.port.mcp;
			signal.throwIfAborted();
			const command = parseMcpCommand(input);
			if (command.scope && ["enable", "disable"].includes(command.action)) await persistMcpEnabled(cwd, config, command, signal);
			signal.throwIfAborted();
			await mcpCommand(controller, input, value => report(JSON.stringify(value, null, 2)), { signal, credentialStore: config.mcp?.credentialStore ?? "system" });
		},
		skillsCommand: (input, report, signal, session) => skillsCommand(session.port, input, value => report(skillsText(value)), signal),
		memoryCommand: (input, signal, session) => memory.execute(input, { signal, apply: async options => {
			signal.throwIfAborted();
			const receipt = await session.port.updateConfiguration({ memory: options });
			if ((await receipt.applied).status !== "applied") throw new Error("Memory configuration was not applied");
		} }),
		createCompletionSource: session => createInputCompletionSource({
			completeInput: (input, signal) => mcpCompletions(session.port.mcp, input, signal),
			listSkills: () => session.port.getSkills().entries.filter(entry => entry.status === "available").map(entry => ({ name: entry.name!, description: entry.description! })),
			commands: [
				{ name: "help", description: "Show commands" },
				{ name: "clear", description: "Clear display; keep context" },
				{ name: "new", description: "Start a new conversation" },
				{ name: "resume", description: "Resume a project conversation" },
				{ name: "compact", description: "Compact context" },
				{ name: "memory", description: "Manage persistent memory" },
				{ name: "mcp", description: "Manage MCP servers, resources, prompts and authentication" },
				{ name: "skills", description: "List skills; reload to refresh" },
				{ name: "skill", description: "Select a skill explicitly" },
				{ name: "quit", description: "Exit" },
			],
			listFiles: prefix => scanFiles(cwd, prefix),
		}),
	};
}
