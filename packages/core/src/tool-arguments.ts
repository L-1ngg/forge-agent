import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";

interface ToolArgumentSchema {
	name: string;
	parameters: object;
}

const validators = new WeakMap<object, ReturnType<AjvJsonSchemaValidator["getValidator"]>>();

export function validateToolArguments(tool: ToolArgumentSchema, args: unknown): Record<string, unknown> {
	let validate = validators.get(tool.parameters);
	if (!validate) {
		validate = new AjvJsonSchemaValidator().getValidator(tool.parameters as Parameters<AjvJsonSchemaValidator["getValidator"]>[0]);
		validators.set(tool.parameters, validate);
	}
	const result = validate(args);
	if (!result.valid) throw new Error(`Validation failed for tool "${tool.name}": ${result.errorMessage}`);
	if (result.data === null || typeof result.data !== "object" || Array.isArray(result.data)) {
		throw new TypeError(`Validation failed for tool "${tool.name}": expected an object`);
	}
	return result.data as Record<string, unknown>;
}

/** Let native tool and edited-approval validation share the dynamic schema. */
export function toolInputSchema(tool: ToolArgumentSchema) {
	return { "~standard": {
		version: 1 as const, vendor: "forge-json-schema",
		validate(input: unknown) {
			try { return { value: validateToolArguments(tool, input) }; }
			catch (error) { return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }; }
		},
		jsonSchema: { input: () => tool.parameters, output: () => tool.parameters },
	} };
}
