import { readSkillFile } from "./files.ts";
import { validateMetadata } from "./upstream/skills.ts";
import { SkillError, type SkillsSnapshot } from "./types.ts";

export async function loadSkill(snapshot: SkillsSnapshot, name: string, explicit = false, signal?: AbortSignal) {
	try {
		signal?.throwIfAborted();
		if (!snapshot.enabled) throw new SkillError("skills-disabled", "Skills are disabled");
		const entry = snapshot.entries.find(item => item.status === "available" && item.name === name);
		if (!entry) throw new SkillError("unknown-skill", `Unknown skill: ${name}`);
		if (entry.disableModelInvocation && !explicit) throw new SkillError("explicit-only", `Skill ${name} requires explicit user selection`);
		const file = await readSkillFile(entry.entry, true, signal);
		if (file.realEntry !== entry.realEntry || file.baseDirectory !== entry.baseDirectory || file.fileIdentity !== entry.fileIdentity || file.contentRevision !== entry.contentRevision) throw new SkillError("changed", `Skill ${name} changed; refresh Skills before loading.`);
		const errors = validateMetadata(file.metadata, file.baseDirectory);
		if (errors.length) throw new SkillError("invalid-skill", errors.join("; "));
		return { name, layer: entry.layer, entry: entry.entry, baseDirectory: file.baseDirectory, contentRevision: file.contentRevision, metadata: file.metadata, body: file.body };
	} catch (error) {
		if (signal?.aborted) throw new SkillError("canceled", "Skill loading canceled");
		if (error instanceof SkillError) {
			// This catalog entry passed discovery: invalid bytes now indicate change.
			// Do not reread unbounded content just to finish hashing a malformed file.
			if (error.code === "invalid-skill") throw new SkillError("changed", `Skill ${name} changed and is no longer valid; refresh Skills. ${error.message}`);
			throw error;
		}
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SkillError("missing", `Skill ${name} is missing; refresh Skills.`);
		throw new SkillError("read-failed", `Unable to read skill ${name}: ${error}`);
	}
}
