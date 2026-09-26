import { expect, test } from "bun:test";
import { validateToolArguments } from "../src/tool-arguments.ts";

const parameters = {
	type: "object",
	properties: { value: { type: "integer" } },
	required: ["value"],
	additionalProperties: false,
};

test("custom validators cannot coerce invalid input or return invalid output", () => {
	let calls = 0;
	const tool = {
		name: "count", parameters,
		validateArguments(args: unknown) {
			calls++;
			return { value: String((args as { value: number }).value) };
		},
	};
	expect(() => validateToolArguments(tool, { value: "3" })).toThrow("Validation failed");
	expect(calls).toBe(0);
	expect(() => validateToolArguments(tool, { value: 3 })).toThrow("Validation failed");
	expect(calls).toBe(1);
});

test("JSON Schema rejects missing and extra fields before any custom validator", () => {
	const tool = { name: "count", parameters };
	expect(() => validateToolArguments(tool, {})).toThrow("Validation failed");
	expect(() => validateToolArguments(tool, { value: 3, extra: true })).toThrow("Validation failed");
	expect(validateToolArguments(tool, { value: 3 })).toEqual({ value: 3 });
});
