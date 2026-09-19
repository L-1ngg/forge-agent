export type SkillLayer = "workspace" | "user" | "builtin";
export interface SkillRoot { path: string; optional?: boolean; }
export interface SkillsOptions { enabled?: boolean; roots: Partial<Record<SkillLayer, SkillRoot>>; }
export type { SkillInvocation, AgentInput } from "@forge-agent/protocol";
export interface SkillDiagnostic { layer: SkillLayer; entry: string; code: string; message: string; }
export interface SkillEntry {
	name?: string; description?: string; layer: SkillLayer; entry: string;
	realEntry?: string; baseDirectory?: string; contentRevision?: string; fileIdentity?: string;
	disableModelInvocation?: boolean; metadata?: Record<string, unknown>;
	status: "available" | "shadowed" | "invalid" | "duplicate"; reason?: string; winnerEntry?: string;
}
export interface SkillsSnapshot { enabled: boolean; revision: number; entries: SkillEntry[]; diagnostics: SkillDiagnostic[]; }
export type SkillErrorCode = "skills-disabled" | "unknown-skill" | "explicit-only" | "permission-denied" | "missing" | "changed" | "too-large" | "invalid-skill" | "read-failed" | "canceled";
export class SkillError extends Error {
	constructor(readonly code: SkillErrorCode, message: string) { super(message); this.name = "SkillError"; }
}
export const emptySkills = (): SkillsSnapshot => ({ enabled: false, revision: 0, entries: [], diagnostics: [] });
