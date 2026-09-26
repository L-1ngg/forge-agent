import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";

interface ToolArgumentSchema {
	name: string;
	parameters: object;
	validateArguments?: ((args: unknown) => unknown) | undefined;
}

const validators = new WeakMap<object, ReturnType<AjvJsonSchemaValidator["getValidator"]>>();

export function validateToolArguments(tool: ToolArgumentSchema, args: unknown): Record<string, unknown> {
	let validate = validators.get(tool.parameters);
	if (!validate) {
		validate = new AjvJsonSchemaValidator().getValidator(tool.parameters as Parameters<AjvJsonSchemaValidator["getValidator"]>[0]);
		validators.set(tool.parameters, validate);
	}
	const initial = validate(args);
	if (!initial.valid) throw new Error(`Validation failed for tool "${tool.name}": ${initial.errorMessage}`);
	const validated: unknown = tool.validateArguments ? tool.validateArguments(initial.data) : initial.data;
	const final = validate(validated);
	if (!final.valid) throw new Error(`Validation failed for tool "${tool.name}": ${final.errorMessage}`);
	if (validated === null || typeof validated !== "object" || Array.isArray(validated)) {
		throw new TypeError(`Validation failed for tool "${tool.name}": expected an object`);
	}
	return final.data as Record<string, unknown>;
}
