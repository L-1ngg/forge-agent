import { stat, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { scanSkillEntries, validateMetadata } from "./upstream/skills.ts";
import { readSkillFile } from "./files.ts";
import { emptySkills, type SkillsOptions, type SkillsSnapshot, type SkillEntry, type SkillLayer } from "./types.ts";

export async function discoverSkills(options: SkillsOptions | false | undefined, cwd: string, signal?: AbortSignal): Promise<SkillsSnapshot> {
	if (!options || options.enabled === false) return emptySkills();
	if (!options.roots || typeof options.roots !== "object" || Array.isArray(options.roots) || (options.enabled !== undefined && typeof options.enabled !== "boolean")) throw new Error("Invalid Skills options");
	if (Object.keys(options.roots).some(layer => !["workspace", "user", "builtin"].includes(layer))) throw new Error("Invalid Skills layer");
	const snapshot: SkillsSnapshot = { ...emptySkills(), enabled: true };
	const names = new Map<string, SkillEntry>(), realPaths = new Map<string, SkillEntry>();
	for (const layer of ["workspace", "user", "builtin"] satisfies SkillLayer[]) {
		signal?.throwIfAborted();
		const root = options.roots[layer]; if (!root) continue;
		if (typeof root.path !== "string" || !root.path.trim() || (root.optional !== undefined && typeof root.optional !== "boolean")) throw new Error(`Invalid Skills root: ${layer}`);
		const path = resolve(cwd, root.path);
		try { if (!(await stat(path)).isDirectory()) throw new Error("not a directory"); }
		catch (error) { if (root.optional && (error as NodeJS.ErrnoException).code === "ENOENT") {
				const link = await lstat(path).catch((cause: NodeJS.ErrnoException) => { if (cause.code === "ENOENT") return undefined; throw cause; });
				if (!link) continue;
			} throw new Error(`Unable to scan Skills source ${path}: ${error}`); }
		for (const entry of await scanSkillEntries(path, layer, snapshot.diagnostics, signal)) {
			const item: SkillEntry = { layer, entry, status: "invalid" }; snapshot.entries.push(item);
			try {
				const { body: _, ...file } = await readSkillFile(entry, false, signal);
				Object.assign(item, file);
				const errors = validateMetadata(file.metadata, file.baseDirectory);
				if (typeof file.metadata.name === "string") item.name = file.metadata.name;
				if (typeof file.metadata.description === "string") item.description = file.metadata.description;
				if (errors.length) throw new Error(errors.join("; "));
				item.disableModelInvocation = file.metadata["disable-model-invocation"] === true;
				const duplicate = realPaths.get(file.realEntry), winner = names.get(item.name!);
				if (duplicate || winner) {
					item.status = duplicate ? "duplicate" : "shadowed";
					item.winnerEntry = (duplicate ?? winner)!.entry;
					item.reason = `${item.status} by ${item.winnerEntry}`;
				} else { item.status = "available"; names.set(item.name!, item); }
				if (!duplicate) realPaths.set(file.realEntry, item);
			} catch (error) {
				signal?.throwIfAborted();
				item.reason = String(error);
				snapshot.diagnostics.push({ layer, entry, code: "invalid-skill", message: item.reason });
			}
		}
	}
	return snapshot;
}
