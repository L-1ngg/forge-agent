import { expect, test } from "bun:test";
import { controlledTool } from "./controlled-tool.ts";

test("undeclared or mismatched tools fail before side effects and remain failures after being caught", async () => {
	let effects = 0;
	for (const calls of [[], [{ args: { value: "expected" }, async result() { effects++; return { content: [], details: {} }; } }]]) {
		const tool = controlledTool("write", { type: "object", properties: {}, required: [], additionalProperties: false }, calls);
		await expect(tool.tool.execute({ value: "wrong" }, { cwd: process.cwd() })).rejects.toThrow();
		expect(effects).toBe(0);
		expect(() => tool.assertComplete()).toThrow("controlled tool failed");
	}
});
