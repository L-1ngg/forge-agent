import type { SessionMessage } from "@forge-agent/protocol";
import type { Model } from "../pi-port.ts";
import type { RequestBudget } from "./request-budget.ts";
import { freeze, cancellable } from "../host-callback.ts";

type Snapshot<T> = T extends object ? { readonly [K in keyof T]: Snapshot<T[K]> } : T;

export interface TransformContextContext {
	readonly messages: readonly Snapshot<SessionMessage>[];
	readonly model: Snapshot<Model<string>>;
	readonly configurationRevision: number;
	readonly budget: RequestBudget;
}

/** Creation-only request projection. Throws fail this invocation without provider retry. */
export type TransformContext = (context: TransformContextContext, signal: AbortSignal) => readonly Snapshot<SessionMessage>[] | Promise<readonly Snapshot<SessionMessage>[]>;

export async function transformMessages(callback: TransformContext, context: TransformContextContext, signal: AbortSignal): Promise<SessionMessage[]> {
	const snapshot = structuredClone(context);
	// Transport headers can contain credentials; the host receives model metadata only.
	Reflect.deleteProperty(snapshot.model, "headers");
	try {
		const result = await cancellable(async () => {
			const returned = await callback(freeze(snapshot), signal);
			signal.throwIfAborted();
			const messages: unknown = structuredClone(returned);
			validateProjection(messages);
			return messages;
		}, signal);
		signal.throwIfAborted();
		return result;
	} catch (error) {
		signal.throwIfAborted();
		throw new Error(`transformContext failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function invalid(): never { throw new TypeError("Invalid transformContext message projection"); }
function json(value: unknown, seen = new Set<object>()): void {
	if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
	if (typeof value !== "object" || !value || seen.has(value) || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) invalid();
	seen.add(value);
	for (const child of Object.values(value)) json(child, seen);
	seen.delete(value);
}

/** Validate before projectMessages can repair/filter a host-created broken transcript. */
function validateProjection(value: unknown): asserts value is SessionMessage[] {
	if (!Array.isArray(value) || !value.length) invalid();
	const pending = new Map<string, string>(), used = new Set<string>();
	for (const message of value) {
		if (!object(message) || typeof message.role !== "string" || !["user", "assistant", "toolResult"].includes(String(message.role)) || !Array.isArray(message.content) || !Number.isFinite(message.timestamp)) invalid();
		for (const key of ["provider", "model", "api", "errorMessage", "toolCallId", "toolName"]) if (message[key] !== undefined && typeof message[key] !== "string") invalid();
		for (const key of ["isError", "contextExcluded"]) if (message[key] !== undefined && typeof message[key] !== "boolean") invalid();
		if (message.role === "toolResult") {
			if (typeof message.toolCallId !== "string" || !pending.has(message.toolCallId) || pending.get(message.toolCallId) !== message.toolName) invalid();
			pending.delete(message.toolCallId);
		} else if (pending.size) invalid();
		if (message.stopReason !== undefined && (typeof message.stopReason !== "string" || !["stop", "tool_use", "length", "error", "aborted", "deferred"].includes(message.stopReason))) invalid();
		if (message.role === "assistant" && (["error", "aborted"].includes(String(message.stopReason)) || message.contextExcluded === true)) invalid();
		for (const block of message.content) {
			if (!object(block)) invalid();
			if (block.type === "text") { if (typeof block.text !== "string") invalid(); }
			else if (block.type === "image") { if (message.role === "assistant" || typeof block.data !== "string" || typeof block.mimeType !== "string") invalid(); }
			else if (block.type === "thinking") { if (message.role !== "assistant" || typeof block.thinking !== "string") invalid(); }
			else if (block.type === "tool_call") {
				if (message.role !== "assistant" || message.stopReason === "length" || typeof block.id !== "string" || !block.id || used.has(block.id) || typeof block.name !== "string" || !block.name || !object(block.arguments)) invalid();
				json(block.arguments); used.add(block.id); pending.set(block.id, block.name);
			} else invalid();
			for (const key of ["textSignature", "thinkingSignature", "thoughtSignature", "namespace"]) if (block[key] !== undefined && typeof block[key] !== "string") invalid();
			if (block.redacted !== undefined && typeof block.redacted !== "boolean") invalid();
		}
	}
	if (pending.size || value.at(-1).role === "assistant") invalid();
}
