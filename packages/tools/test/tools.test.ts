import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bashTool, editTool, readTool, writeTool } from "../src/index.ts";
import { createBashTool } from "../src/bash.ts";

function errorDetails(result: { isError?: boolean; content: Array<{ type: string; text?: string }> }): unknown {
 expect(result.isError).toBe(true);
 const first = result.content[0];
 expect(first?.type).toBe("text");
 return JSON.parse(first!.text!);
}

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "forge-agent-tools-"));
	temporaryDirectories.push(path);
	return path;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("read", () => {
	test("bounded preview returns a usable next offset and diagnoses an oversized first line", async () => {
		const cwd = await temporaryDirectory();
		await writeFile(join(cwd, "many.txt"), Array.from({ length: 2002 }, (_, index) => String(index + 1)).join("\n"));
		const first = await readTool.execute({ path: "many.txt" }, { cwd });
		expect(first).toMatchObject({ isError: false, details: { truncated: true, nextOffset: 2001 } });
		if (!first.isError) expect(first.details!.content.split("\n")).toHaveLength(2000);
		expect(await readTool.execute({ path: "many.txt", offset: 2001 }, { cwd })).toMatchObject({ isError: false, details: { content: "2001\n2002" } });
		await writeFile(join(cwd, "long.txt"), "中".repeat(20000));
		const long = await readTool.execute({ path: "long.txt" }, { cwd });
		expect(long).toMatchObject({ isError: false, details: { content: "", truncated: true } });
		if (!long.isError) { expect(long.details!.nextOffset).toBeUndefined(); expect(long.details!.notice).toContain("Bash"); }
	});
	test("reads an inclusive line range", async () => {
		const cwd = await temporaryDirectory();
		await writeFile(join(cwd, "input.txt"), "one\ntwo\nthree");
		const result = await readTool.execute({ path: "input.txt", offset: 2, limit: 2 }, { cwd });
		expect(result).toMatchObject({ isError: false, details: { content: "two\nthree", totalLines: 3 } });
	});

	test.each([
		[{ path: "missing.txt" }, "PATH_NOT_FOUND"],
		[{ path: "." }, "PATH_IS_DIRECTORY"],
		[{ path: "x", offset: 3, limit: 0 }, "INVALID_ARGUMENT"],
	] as const)("returns structured error %#", async (input, code) => {
		const cwd = await temporaryDirectory();
		const result = await readTool.execute(input, { cwd });
		expect(errorDetails(result)).toMatchObject({ error_code: code, retryable: false });
	});
});

describe("write", () => {
	test("writes a UTF-8 file", async () => {
		const cwd = await temporaryDirectory();
		const result = await writeTool.execute({ path: "output.txt", content: "hello" }, { cwd });
		expect(result).toMatchObject({ isError: false, details: { bytesWritten: 5 } });
		expect(await readFile(join(cwd, "output.txt"), "utf8")).toBe("hello");
	});

	test("rejects create mode for an existing file", async () => {
		const cwd = await temporaryDirectory();
		await writeFile(join(cwd, "exists.txt"), "old");
		const result = await writeTool.execute({ path: "exists.txt", content: "new", mode: "create" }, { cwd });
		expect(errorDetails(result)).toMatchObject({ error_code: "ALREADY_EXISTS", retryable: false });
	});

	test.each([
		[{ path: "missing/output.txt", content: "x" }, "PARENT_NOT_FOUND"],
		[{ path: "", content: "x" }, "INVALID_ARGUMENT"],
	] as const)("returns structured error %#", async (input, code) => {
		const cwd = await temporaryDirectory();
		const result = await writeTool.execute(input, { cwd });
		expect(errorDetails(result)).toMatchObject({ error_code: code, retryable: false });
	});
});

describe("edit", () => {
	test("replacement text is literal even when it contains replacement tokens", async () => {
		const cwd = await temporaryDirectory();
		await writeFile(join(cwd, "literal.txt"), "before");
		const text = "$& $$ $` $'";
		const result = await editTool.execute({ path: "literal.txt", old_text: "before", new_text: text }, { cwd });
		expect(!result.isError).toBe(true);
		expect(await readFile(join(cwd, "literal.txt"), "utf8")).toBe(text);
	});
	test("replaces one exact match", async () => {
		const cwd = await temporaryDirectory();
		await writeFile(join(cwd, "edit.txt"), "before");
		const result = await editTool.execute({ path: "edit.txt", old_text: "before", new_text: "after" }, { cwd });
		expect(result).toMatchObject({ isError: false, details: { replacements: 1 } });
		expect(await readFile(join(cwd, "edit.txt"), "utf8")).toBe("after");
	});

	test("rejects a missing exact match", async () => {
		const cwd = await temporaryDirectory();
		await writeFile(join(cwd, "edit.txt"), "current");
		const result = await editTool.execute({ path: "edit.txt", old_text: "old", new_text: "new" }, { cwd });
		expect(errorDetails(result)).toMatchObject({ error_code: "EDIT_NOT_FOUND", retryable: false });
	});

	test("rejects an ambiguous exact match", async () => {
		const cwd = await temporaryDirectory();
		await writeFile(join(cwd, "edit.txt"), "same same");
		const result = await editTool.execute({ path: "edit.txt", old_text: "same", new_text: "next" }, { cwd });
		expect(errorDetails(result)).toMatchObject({ error_code: "EDIT_AMBIGUOUS", retryable: false });
	});

	test("rejects an invalid old_text", async () => {
		const cwd = await temporaryDirectory();
		const result = await editTool.execute({ path: "edit.txt", old_text: "", new_text: "new" }, { cwd });
		expect(errorDetails(result)).toMatchObject({ error_code: "INVALID_ARGUMENT", retryable: false });
	});
});

describe("bash", () => {
	test("log write failure closes the writer and terminates capture with available tail", async () => {
		let closed = false;
		const tool = createBashTool(async () => ({ async write() { throw new Error("disk full"); }, async close() { closed = true; } }));
		const result = await tool.execute({ command: "yes capture", timeout_ms: 5000 }, { cwd: await temporaryDirectory() });
		expect(errorDetails(result)).toMatchObject({ error_code: "IO_ERROR" });
		expect(closed).toBe(true);
		if (result.isError) { expect(result.details?.stdout).toContain("capture"); expect(result.details?.notice).toContain("incomplete"); }
	});
	test("nonzero exit retains its temporary log and a missing log is an ordinary read error", async () => {
		const cwd = await temporaryDirectory();
		const result = await bashTool.execute({ command: "yes x | head -c 60000; exit 7" }, { cwd });
		expect(!result.isError).toBe(false);
		if (!result.isError || !result.details?.logPath) throw new Error("missing failed output log");
		const logPath = result.details.logPath;
		try { expect((await readFile(logPath)).length).toBe(60000); }
		finally { await rm(logPath); }
		expect(errorDetails(await readTool.execute({ path: logPath }, { cwd }))).toMatchObject({ error_code: "PATH_NOT_FOUND" });
	});
	test("cancellation escalates for a shell and child that ignore SIGTERM", async () => {
		const cwd = await temporaryDirectory();
		const controller = new AbortController();
		const started = performance.now();
		const timer = setTimeout(() => controller.abort(), 100);
		try {
			const result = await bashTool.execute({ command: "trap '' TERM; sleep 1.5 & wait", timeout_ms: 2_000 }, { cwd, signal: controller.signal, env: { SHELL: "/bin/bash" } });
			expect(errorDetails(result)).toMatchObject({ error_code: "ABORTED" });
			expect(performance.now() - started).toBeLessThan(1_000);
		} finally { clearTimeout(timer); }
	});
	test("captures output and honors the working directory", async () => {
		const cwd = await temporaryDirectory();
		const result = await bashTool.execute({ command: "pwd" }, { cwd });
		expect(result).toMatchObject({ isError: false, details: { exitCode: 0, truncated: false } });
		if (!result.isError) expect(await realpath(result.details!.stdout.trim())).toBe(await realpath(cwd));
	});

	test.each([
		[{ command: "" }, "INVALID_ARGUMENT", false],
		[{ command: "exit 7" }, "COMMAND_FAILED", true],
		[{ command: "sleep 1", timeout_ms: 5 }, "COMMAND_TIMEOUT", true],
	] as const)("returns structured error %#", async (input, code, retryable) => {
		const cwd = await temporaryDirectory();
		const result = await bashTool.execute(input, { cwd });
		expect(errorDetails(result)).toMatchObject({ error_code: code, retryable });
	});

	test("retains the tail and lazily spills complete output for ordinary Read", async () => {
		const cwd = await temporaryDirectory();
		const result = await bashTool.execute({ command: "printf 'BEGIN\\n'; yes x | head -c 60000; printf 'END\\n'" }, { cwd });
		expect(!result.isError && result.details!.truncated).toBe(true);
		if (result.isError || !result.details!.logPath) throw new Error("missing full output");
		try {
			expect(Buffer.byteLength(result.details!.stdout)).toBeLessThanOrEqual(50 * 1024);
			expect(result.details!.stdout.endsWith("END\n")).toBe(true);
			const full = await readFile(result.details!.logPath, "utf8");
			expect(full.startsWith("BEGIN\n")).toBe(true);
			expect(full.endsWith("END\n")).toBe(true);
			expect(Buffer.byteLength(full)).toBe(60010);
			expect(await readTool.execute({ path: result.details!.logPath, limit: 1 }, { cwd })).toMatchObject({ isError: false, details: { content: "BEGIN" } });
		} finally { await rm(result.details!.logPath); }
	});
});
