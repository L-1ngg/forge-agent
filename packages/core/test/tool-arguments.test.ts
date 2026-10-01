import { expect, test } from "bun:test";
import { toolInputSchema, validateToolArguments } from "../src/tool-arguments.ts";
import { convertSchemaToJsonSchema, parseWithStandardSchema } from "@tanstack/ai";

const parameters = {
	type: "object",
	properties: { value: { type: "integer" } },
	required: ["value"],
	additionalProperties: false,
};

test("dynamic JSON Schema shares native validation without coercion", () => {
	const schema = toolInputSchema({ name: "count", parameters });
	expect(convertSchemaToJsonSchema(schema)).toEqual(parameters);
	expect(() => parseWithStandardSchema(schema, { value: "3" })).toThrow("Validation failed");
	expect(parseWithStandardSchema<object>(schema, { value: 3 })).toEqual({ value: 3 });
});

test("JSON Schema rejects missing and extra fields", () => {
	const tool = { name: "count", parameters };
	expect(() => validateToolArguments(tool, {})).toThrow("Validation failed");
	expect(() => validateToolArguments(tool, { value: 3, extra: true })).toThrow("Validation failed");
	expect(validateToolArguments(tool, { value: 3 })).toEqual({ value: 3 });
});
