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
