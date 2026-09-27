import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { aggregate, dedupe, filter, parseSkill, type SkillSource } from "@tanstack/ai-skills";
import { skillDirectory } from "@tanstack/ai-skills/node";
import { emptySkills, type SkillLayer, type SkillsOptions, type SkillsSnapshot } from "./types.ts";

export interface PreparedSkills {
	snapshot: SkillsSnapshot;
	all?: SkillSource;
	automatic?: SkillSource;
}

export async function prepareSkills(options: SkillsOptions | false | undefined, cwd: string, signal?: AbortSignal): Promise<PreparedSkills> {
	if (!options || options.enabled === false) return { snapshot: emptySkills() };
	if (!options.roots || typeof options.roots !== "object" || Array.isArray(options.roots) || (options.enabled !== undefined && typeof options.enabled !== "boolean")) throw new Error("Invalid Skills options");
	if (Object.keys(options.roots).some(layer => !["workspace", "user", "builtin"].includes(layer))) throw new Error("Invalid Skills layer");
	const layers: Array<{ layer: SkillLayer; root: string; source: SkillSource }> = [];
	for (const layer of ["workspace", "user", "builtin"] satisfies SkillLayer[]) {
		signal?.throwIfAborted();
		const configured = options.roots[layer];
		if (!configured) continue;
		if (typeof configured.path !== "string" || !configured.path.trim() || (configured.optional !== undefined && typeof configured.optional !== "boolean")) throw new Error(`Invalid Skills root: ${layer}`);
		const root = resolve(cwd, configured.path);
		try { if (!(await stat(root)).isDirectory()) throw new Error("not a directory"); }
		catch (error) { if (configured.optional && (error as NodeJS.ErrnoException).code === "ENOENT") continue; throw new Error(`Unable to scan Skills source ${root}: ${error}`); }
		layers.push({ layer, root, source: skillDirectory(root) });
	}
	const all = dedupe(aggregate(layers.map(item => item.source)), () => {});
	const snapshot: SkillsSnapshot = { ...emptySkills(), enabled: true };
	const seen = new Set<string>();
	const explicitOnly = new Set<string>();
	for (const { layer, root, source } of layers) {
		for (const skill of await source.list()) {
			signal?.throwIfAborted();
			const status = seen.has(skill.name) ? "shadowed" : "available";
			seen.add(skill.name);
			const raw = await source.load(skill.name);
			const frontmatter = /^\s*---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw.replace(/^\uFEFF/, ""))?.[1];
			const disableModelInvocation = frontmatter ? /^disable-model-invocation:[ \t]*true[ \t]*(?:#.*)?$/m.test(frontmatter) : false;
			if (status === "available" && disableModelInvocation) explicitOnly.add(skill.name);
			snapshot.entries.push({ name: skill.name, description: skill.description, layer, entry: root, status, disableModelInvocation });
		}
	}
	return { snapshot, all, automatic: filter(all, skill => !explicitOnly.has(skill.name)) };
}

export function explicitSkillBody(raw: string): string { return parseSkill(raw).body; }
