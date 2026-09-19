import type { HarnessTool } from "@forge-agent/tools";
import { loadSkill } from "./load.ts";
import { SkillError, type SkillsSnapshot } from "./types.ts";
export function skillLoader(snapshot: SkillsSnapshot): HarnessTool<object, unknown> {
	return { name: "load_skill", label: "Load skill", description: "Load complete instructions by catalog name. Does not execute scripts or read references. Relative references use the returned baseDirectory.",
		parameters: { type: "object", properties: { name: { type: "string", minLength: 1 } }, required: ["name"], additionalProperties: false },
		async execute(input, context) {
			try {
				validateSkillArguments(input);
				const result = await loadSkill(snapshot, input.name, false, context.signal);
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
			} catch (error) {
				const code = error instanceof SkillError ? error.code : "invalid-skill";
				const result = { code, message: String(error) };
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, isError: true };
			}
		},
	};
}
export function validateSkillArguments(input: unknown): asserts input is { name: string } {
	if (!input || typeof input !== "object" || Array.isArray(input) || !("name" in input) || typeof input.name !== "string" || !input.name || Object.keys(input).some(key => key !== "name")) throw new SkillError("invalid-skill", "load_skill accepts only a non-empty name");
}
