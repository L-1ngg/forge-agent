// Derived from Pi skills.ts; pinned source and all adaptations: ../upstream.json, ../LOCAL_CHANGES.md.
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import ignore from "ignore";
import { basename, join, relative, sep } from "node:path";
import type { SkillDiagnostic, SkillLayer } from "../types.ts";
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];
type IgnoreMatcher = ReturnType<typeof ignore>;
const toPosixPath = (path: string) => path.split(sep).join("/");
function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;

	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

function validateName(name: string): string[] {
	const errors: string[] = [];

	if (name.length > MAX_NAME_LENGTH) {
		errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	}

	if (!/^[a-z0-9-]+$/.test(name)) {
		errors.push(`name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`);
	}

	if (name.startsWith("-") || name.endsWith("-")) {
		errors.push(`name must not start or end with a hyphen`);
	}

	if (name.includes("--")) {
		errors.push(`name must not contain consecutive hyphens`);
	}

	return errors;
}

/**
	* Validate description per Agent Skills spec.
	*/
function validateDescription(description: unknown): string[] {
	const errors: string[] = [];

	if (typeof description !== "string" || description.trim() === "") {
		errors.push("description is required");
	} else if (description.length > MAX_DESCRIPTION_LENGTH) {
		errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
	}

	return errors;
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}


export function validateMetadata(metadata: Record<string, unknown>, baseDirectory: string): string[] {
	const errors = typeof metadata.name === "string" ? validateName(metadata.name) : ["name is required and must be a string"];
	if (metadata.name !== basename(baseDirectory)) errors.push("name does not match actual parent directory");
	errors.push(...validateDescription(metadata.description));
	for (const key of ["license", "allowed-tools"]) if (key in metadata && typeof metadata[key] !== "string") errors.push(`${key} must be a string`);
	if ("compatibility" in metadata && (typeof metadata.compatibility !== "string" || metadata.compatibility.length < 1 || metadata.compatibility.length > 500)) errors.push("compatibility must contain 1-500 characters");
	if ("metadata" in metadata && (!metadata.metadata || typeof metadata.metadata !== "object" || Array.isArray(metadata.metadata) || Object.values(metadata.metadata).some(value => typeof value !== "string"))) errors.push("metadata must map strings to strings");
	if ("disable-model-invocation" in metadata && typeof metadata["disable-model-invocation"] !== "boolean") errors.push("disable-model-invocation must be boolean");
	return errors;
}

/** Pi directory/ignore traversal, made asynchronous, deterministic and failure-transparent. */
export async function scanSkillEntries(root: string, layer: SkillLayer, diagnostics: SkillDiagnostic[], signal?: AbortSignal): Promise<string[]> {
	const paths: string[] = [], visited = new Set<string>();
	const warn = (entry: string, error: unknown) => diagnostics.push({ layer, entry, code: "read-failed", message: String(error) });
	async function visit(dir: string, inherited: IgnoreMatcher): Promise<void> {
		signal?.throwIfAborted();
		const real = await realpath(dir);
		if (visited.has(real)) return;
		visited.add(real);
		try {
		const ig = ignore().add(inherited);
		const relativeDir = relative(root, dir);
		const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";
		for (const name of IGNORE_FILE_NAMES) {
			const path = join(dir, name);
			try {
				const content = await readFile(path, "utf8");
				ig.add(content.split(/\r?\n/).map(line => prefixIgnorePattern(line, prefix)).filter((line): line is string => line !== null));
			} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") warn(path, error); }
		}
		// Enumeration errors reject the whole scan instead of publishing incomplete catalogs.
		const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
		if (entries.some(entry => entry.name === "SKILL.md")) {
			const path = join(dir, "SKILL.md");
			if (!ig.ignores(toPosixPath(relative(root, path)))) paths.push(path);
			return;
		}
		for (const entry of entries) {
			signal?.throwIfAborted();
			if (entry.name === ".git" || entry.name === "node_modules") continue;
			const path = join(dir, entry.name);
			let isDirectory = entry.isDirectory();
			if (entry.isSymbolicLink()) {
				try { isDirectory = (await stat(path)).isDirectory(); } catch (error) { warn(path, error); continue; }
			}
			if (!isDirectory || ig.ignores(`${toPosixPath(relative(root, path))}/`)) continue;
			await visit(path, ig);
		}
		} finally { visited.delete(real); }
	}
	await visit(root, ignore());
	return paths.sort((a, b) => { const x = toPosixPath(relative(root, a)), y = toPosixPath(relative(root, b)); return x < y ? -1 : x > y ? 1 : 0; });
}

export function formatSkillsForPrompt(skills: Array<{ name?: string; description?: string; disableModelInvocation?: boolean }>): string {
	const visibleSkills = skills.filter(skill => !skill.disableModelInvocation);
	if (!visibleSkills.length) return "";
	const lines = ["\n\nThe following skills provide specialized instructions for specific tasks.",
		"Use load_skill with a name to load complete instructions. Additional references require reading tools supplied by your host; do not assume read or bash exists.",
		"Resolve relative references against the loaded baseDirectory. Skills do not grant tool permissions.", "", "<available_skills>"];
	for (const skill of visibleSkills) {
		lines.push("  <skill>", `    <name>${escapeXml(skill.name!)}</name>`, `    <description>${escapeXml(skill.description!)}</description>`, "  </skill>");
	}
	lines.push("</available_skills>"); return lines.join("\n");
}
