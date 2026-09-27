import { open, realpath, stat as pathStat } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { parse } from "yaml";
import { SkillError } from "./types.ts";

const HEADER_LIMIT = 64 * 1024;
export const BODY_LIMIT = 50 * 1024;
/** Discovery hashes the full file without retaining its body. Activation stops at limit + 1. */
export async function readSkillFile(entry: string, activation: boolean, signal?: AbortSignal) {
	signal?.throwIfAborted();
	const realEntry = await realpath(entry);
	const file = await open(entry, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stat = await file.stat();
		if (!stat.isFile()) throw new SkillError("invalid-skill", "SKILL.md must be a regular file");
		const fileIdentity = `${stat.dev}:${stat.ino}`;
		const hash = createHash("sha256");
		let header = Buffer.alloc(0), bodyBytes = 0, headerDone = false;
		let yamlStart = 0, yamlEnd = 0;
		const body: Buffer[] = [];
		const addBody = (chunk: Buffer) => {
			bodyBytes += chunk.length;
			if (activation && bodyBytes > BODY_LIMIT) throw new SkillError("too-large", "Skill body exceeds 50 KiB; split instructions into references.");
			if (activation) body.push(Buffer.from(chunk));
		};
		while (true) {
			signal?.throwIfAborted();
			const size = activation && headerDone ? Math.min(8192, BODY_LIMIT + 1 - bodyBytes) : 8192;
			const buffer = Buffer.alloc(size);
			const { bytesRead } = await file.read(buffer, 0, size, null);
			if (!bytesRead) break;
			const chunk = buffer.subarray(0, bytesRead); hash.update(chunk);
			if (headerDone) { addBody(chunk); continue; }
			header = Buffer.concat([header, chunk]);
			// Latin-1 keeps byte offsets intact, including multibyte UTF-8 in YAML.
			const raw = header.toString("latin1");
			if (!/^(?:\xef\xbb\xbf)?---(?:\r\n|\n|\r)/.test(raw)) throw new SkillError("invalid-skill", "YAML frontmatter is required");
			yamlStart = raw.indexOf("---") + 3;
			const end = /(?:\r\n|\n|\r)---(?:\r\n|\n|\r(?!$|\n))/g; end.lastIndex = yamlStart;
			const match = end.exec(raw);
			if (!match) { if (header.length > HEADER_LIMIT) throw new SkillError("invalid-skill", "Frontmatter exceeds Forge's 64 KiB limit"); continue; }
			const boundary = match.index + match[0].length;
			if (boundary > HEADER_LIMIT) throw new SkillError("invalid-skill", "Frontmatter exceeds Forge's 64 KiB limit");
			yamlEnd = match.index;
			addBody(header.subarray(boundary)); header = header.subarray(0, boundary); headerDone = true;
		}
		if (!headerDone) {
			// A closing delimiter may end at EOF without a trailing newline.
			const match = /(?:\r\n|\n|\r)---\r?$/.exec(header.toString("latin1"));
			if (match) yamlEnd = match.index;
			else throw new SkillError("invalid-skill", "Unclosed YAML frontmatter");
		}
		signal?.throwIfAborted();
		if (await realpath(entry) !== realEntry) throw new SkillError("changed", "Skill path changed; refresh Skills.");
		const current = await pathStat(entry);
		if (`${current.dev}:${current.ino}` !== fileIdentity) throw new SkillError("changed", "Skill file replaced; refresh Skills.");
		let metadata: Record<string, unknown>;
		// Only normalize YAML; the body retains its exact UTF-8 bytes.
		try { metadata = parse(header.subarray(yamlStart, yamlEnd).toString("utf8").replace(/\r\n?/g, "\n")) ?? {}; JSON.stringify(metadata); }
		catch (error) { throw new SkillError("invalid-skill", `Invalid YAML metadata: ${error}`); }
		if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new SkillError("invalid-skill", "Frontmatter must be a mapping");
		return { metadata, body: Buffer.concat(body).toString("utf8"), contentRevision: `sha256:${hash.digest("hex")}`, realEntry, baseDirectory: dirname(realEntry), fileIdentity };
	} finally { await file.close(); }
}
