import type { SessionMessage } from "@forge-agent/protocol";
import type { Model } from "../model-types.ts";
import type { RequestBudget } from "./request-budget.ts";
import { freeze, cancellable } from "../host-callback.ts";
import { validateSessionMessage } from "../message-codec.ts";

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

function invalid(): never { throw new TypeError("Invalid transformContext message projection"); }

/** Validate before projectMessages can repair/filter a host-created broken transcript. */
function validateProjection(value: unknown): asserts value is SessionMessage[] {
	if (!Array.isArray(value) || !value.length) invalid();
	const pending = new Map<string, string>(), used = new Set<string>();
	for (const [index, message] of value.entries()) {
		validateSessionMessage(message, `transformContext.messages[${index}]`);
		if (message.role === "toolResult") {
			if (typeof message.toolCallId !== "string" || !pending.has(message.toolCallId) || pending.get(message.toolCallId) !== message.toolName) invalid();
			pending.delete(message.toolCallId);
		} else if (pending.size) invalid();
		if (message.role === "assistant" && (["error", "aborted"].includes(String(message.stopReason)) || message.contextExcluded === true)) invalid();
		for (const block of message.content) {
			if (block.type === "image" && message.role === "assistant") invalid();
			if (block.type === "tool_call") {
				if (message.stopReason === "length" || used.has(block.id)) invalid();
				used.add(block.id); pending.set(block.id, block.name);
			}
		}
	}
	if (pending.size || value.at(-1)?.role === "assistant") invalid();
}
