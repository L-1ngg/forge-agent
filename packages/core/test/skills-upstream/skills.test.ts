// Adapted from Pi's 28 skills tests at the commit in src/skills/upstream.json.
// The original fixture bytes are retained; strict-validation differences are intentional.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills } from "../../src/skills/catalog.ts";
import { readSkillFile } from "../../src/skills/files.ts";
import { formatSkillsForPrompt } from "../../src/skills/upstream/skills.ts";
const fixtures = join(import.meta.dir, "fixtures");
describe("Pi fixtures with Forge strict adaptations", () => {
	for (const name of ["valid-skill", "unknown-field", "disable-model-invocation", "multiline-description"]) test(name, async () => {
		const snapshot = await discoverSkills({ roots: { workspace: { path: join(fixtures, "skills", name) } } }, fixtures);
		expect(snapshot.entries.filter(item => item.status === "available")).toHaveLength(1);
		expect(snapshot.diagnostics).toHaveLength(0);
	});
	for (const name of ["name-mismatch", "invalid-name-chars", "long-name", "missing-description", "invalid-yaml", "no-frontmatter", "consecutive-hyphens"]) test(`strictly rejects ${name}`, async () => {
		const snapshot = await discoverSkills({ roots: { workspace: { path: join(fixtures, "skills", name) } } }, fixtures);
		expect(snapshot.entries.filter(item => item.status === "available")).toHaveLength(0);
		expect(snapshot.diagnostics.length).toBeGreaterThan(0);
	});
	test("root entry terminates recursion and nested groups are discovered", async () => {
		const snapshot = await discoverSkills({ roots: { workspace: { path: join(fixtures, "skills") } } }, fixtures);
		expect(snapshot.entries.some(item => item.name === "child-skill")).toBe(true);
		expect(snapshot.entries.some(item => item.entry.includes("nested-child"))).toBe(false);
	});
	test("first source wins collisions", async () => {
		const snapshot = await discoverSkills({ roots: { workspace: { path: join(fixtures, "skills-collision/first") }, user: { path: join(fixtures, "skills-collision/second") } } }, fixtures);
		expect(snapshot.entries.map(item => item.status)).toEqual(["available", "shadowed"]);
	});
	for (const newline of ["\n", "\r\n", "\r"]) test(`file reader parses YAML while preserving body bytes with ${JSON.stringify(newline)}`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-skill-parser-"));
		try {
			const entry = join(directory, "SKILL.md");
			const body = " \n  原始正文\r\n\rKeep spaces.  \n\n";
			await writeFile(entry, "\uFEFF" + ["---", "name: guide", "description: |", "  One", "  Two", "unknown: yes", "---extension: custom", "disable-model-invocation: true", "---", ""].join(newline) + body);
			const value = await readSkillFile(entry, true);
			expect(value.metadata).toEqual({ name: "guide", description: "One\nTwo\n", unknown: "yes", "---extension": "custom", "disable-model-invocation": true });
			expect(value.body).toBe(body);
			await writeFile(entry, ["---", "name: guide", "description: Ends at EOF", "---"].join(newline));
			const empty = await readSkillFile(entry, true);
			expect(empty.metadata).toEqual({ name: "guide", description: "Ends at EOF" });
			expect(empty.body).toBe("");
		} finally { await rm(directory, { recursive: true, force: true }); }
	});
	test("formatter escapes metadata, omits paths and excludes explicit-only entries", () => {
		expect(formatSkillsForPrompt([])).toBe("");
		expect(formatSkillsForPrompt([{ name: "manual", description: "hidden", disableModelInvocation: true }])).toBe("");
		const text = formatSkillsForPrompt([{ name: "guide", description: '<tag> & "quote"' }]);
		expect(text).toContain("&lt;tag&gt; &amp; &quot;quote&quot;"); expect(text).toContain("load_skill"); expect(text).not.toContain("<location>");
	});
});
