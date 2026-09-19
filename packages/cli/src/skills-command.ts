import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent, AgentInput, SkillsOptions, SkillsSnapshot } from "@forge-agent/core/sdk";
import type { HarnessConfig } from "@forge-agent/core";
import { projectRoot } from "./session-host.ts";

export async function cliSkills(cwd: string, config: HarnessConfig["skills"], disabled: boolean): Promise<SkillsOptions> {
	if (disabled || config?.enabled === false) return { enabled: false, roots: {} };
	const defaults = { workspace: join(await projectRoot(cwd), ".forge/skills"), user: join(homedir(), ".forge/skills"), builtin: fileURLToPath(new URL("../builtin_skills/", import.meta.url)) };
	const roots: SkillsOptions["roots"] = {};
	for (const layer of ["workspace", "user", "builtin"] as const) roots[layer] = config?.roots?.[layer] !== undefined ? { path: config.roots[layer] } : { path: defaults[layer], optional: true };
	return { roots };
}
/** Consume command/name separators only. Everything after the first task separator is literal. */
export function skillInput(input: string): AgentInput {
	if (!/^\s*\/skill(?:\s|$)/.test(input)) return input;
	const match = /^\s*\/skill\s+(\S+)(?:[ \t\r\n]([\s\S]*))?$/.exec(input);
	if (!match) throw new Error("Usage: /skill <name> [task]");
	return { kind: "skill", name: match[1]!, task: match[2] ?? "" };
}
export function isSkillsCommand(input: string): boolean { return /^\s*\/skills(?:\s|$)/.test(input); }
export async function skillsCommand(agent: Pick<Agent, "getSkills" | "refreshSkills">, input: string, output: (value: object) => void): Promise<void> {
	const command = input.trim();
	if (command === "/skills") { output({ type: "skills", ...agent.getSkills() }); return; }
	if (command !== "/skills reload") throw new Error("Usage: /skills [reload]");
	const receipt = await agent.refreshSkills();
	output({ type: "skills", phase: "accepted", revision: receipt.revision });
	const applied = await receipt.applied;
	output({ type: "skills", phase: applied.status, revision: applied.revision, ...(applied.status === "applied" ? { snapshot: agent.getSkills() } : {}) });
}
export function skillsText(value: object): string {
	if ("phase" in value) return `Skills ${value.phase}${"revision" in value ? ` #${value.revision}` : ""}`;
	const snapshot = value as SkillsSnapshot;
	if (!snapshot.enabled) return "Skills disabled";
	return ["Skills", ...snapshot.entries.map(entry => `${entry.name ?? "(invalid)"} [${entry.layer}/${entry.status}${entry.disableModelInvocation ? "/explicit-only" : ""}] ${entry.description ?? ""}\n${entry.entry}${entry.reason ? ` — ${entry.reason}` : ""}`), ...snapshot.diagnostics.map(diagnostic => `${diagnostic.entry}: ${diagnostic.message}`), ...(!snapshot.entries.length ? ["No skills found"] : [])].join("\n");
}
