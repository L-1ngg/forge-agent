import { expect, test } from "bun:test";
import { wrapTool } from "../src/index.ts";

interface CaptureInput {
	path: string;
}

test("tool wrapper rewrites input before execute", async () => {
	let observed = "";
	const tool = wrapTool<CaptureInput, string>(
		{
			name: "capture",
			label: "Capture",
			description: "Capture a value",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
				additionalProperties: false,
			},
			async execute(input) {
				observed = input.path;
				return { ok: true, value: input.path };
			},
		},
		{
			rewriteInput: (input) => ({ ...input, path: input.path.replaceAll("\\", "/").replace(/^\.\//, "") }),
		},
	);

	const result = await tool.execute({ path: "./src\\index.ts" }, { cwd: "/tmp" });
	expect(result).toEqual({ ok: true, value: "src/index.ts" });
	expect(observed).toBe("src/index.ts");
});

test("tool wrapper authorizes the rewritten input before execute", async () => {
	let observed = "";
	let checked = "";
	const tool = wrapTool<CaptureInput, string>(
		{
			name: "capture",
			label: "Capture",
			description: "Capture a value",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
				additionalProperties: false,
			},
			async execute(input) {
				observed = input.path;
				return { ok: true, value: input.path };
			},
		},
		{
			rewriteInput: (input) => ({ ...input, path: input.path.replace(/^\//, "") }),
			authorizeInput: (input) => {
				checked = input.path;
				if (input.path !== "tmp/file.ts") throw new Error("unexpected final path");
			},
		},
	);

	await tool.execute({ path: "/tmp/file.ts" }, { cwd: "/" });
	expect(checked).toBe("tmp/file.ts");
	expect(observed).toBe("tmp/file.ts");
});

test("a rejected rewritten input never reaches the underlying tool", async () => {
	let executions = 0;
	const tool = wrapTool<CaptureInput, string>(
		{
			name: "capture",
			label: "Capture",
			description: "Capture a value",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
				additionalProperties: false,
			},
			async execute() {
				executions++;
				return { ok: true, value: "executed" };
			},
		},
		{
			authorizeInput: () => {
				throw new Error("blocked by policy");
			},
		},
	);

	let failure: unknown;
	try {
		await tool.execute({ path: "blocked" }, { cwd: "/" });
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(Error);
	expect((failure as Error).message).toBe("blocked by policy");
	expect(executions).toBe(0);
});
