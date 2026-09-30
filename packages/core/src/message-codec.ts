import type { SessionMessage } from "@forge-agent/protocol";

export function isToolArgumentRevision(message: SessionMessage): boolean {
	return message.role === "assistant" && message.contextExcluded === true && message.content.length === 0 && !!message.toolCallId && message.toolArguments !== undefined;
}

function invalid(path: string, expected: string): never { throw new TypeError(`Invalid ${path}: expected ${expected}`); }
function object(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid(path, "an object");
	return value as Record<string, unknown>;
}
function text(value: unknown, path: string, nonempty = false): void {
	if (typeof value !== "string" || nonempty && !value) invalid(path, nonempty ? "a nonempty string" : "a string");
}
function number(value: unknown, path: string, nonnegative = false): void {
	if (typeof value !== "number" || !Number.isFinite(value) || nonnegative && value < 0) invalid(path, "a finite number");
}
function optionalStrings(value: Record<string, unknown>, keys: string[], path: string): void {
	for (const key of keys) if (value[key] !== undefined) text(value[key], `${path}.${key}`);
}

/** JSON-compatible data, with ordinary absent optional object fields allowed. */
export function validatePersistentValue(value: unknown, path: string, seen = new Set<object>()): void {
	if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return;
	if (!value || typeof value !== "object" || seen.has(value)) invalid(path, "acyclic JSON data");
	seen.add(value);
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) validatePersistentValue(value[index], `${path}[${index}]`, seen);
	} else {
		object(value, path);
		for (const [key, child] of Object.entries(value)) if (child !== undefined) validatePersistentValue(child, `${path}.${key}`, seen);
	}
	seen.delete(value);
}

function content(value: unknown, path: string, role: unknown, external = false): void {
	if (!Array.isArray(value)) invalid(path, "an array of content blocks");
	for (const [index, valueBlock] of value.entries()) {
		const location = `${path}[${index}]`, block = object(valueBlock, location);
		switch (block.type) {
			case "text": text(block.text, `${location}.text`); break;
			case "thinking":
				if (external || role !== "assistant") invalid(location, "assistant thinking content");
				text(block.thinking, `${location}.thinking`); break;
			case "image":
				if (external && role !== "user") invalid(location, "external user image content");
				text(block.data, `${location}.data`); text(block.mimeType, `${location}.mimeType`, true); break;
			case "tool_call":
				if (external || role !== "assistant") invalid(location, "assistant tool_call content");
				text(block.id, `${location}.id`, true); text(block.name, `${location}.name`, true);
				object(block.arguments, `${location}.arguments`); break;
			default: invalid(`${location}.type`, "text, thinking, image or tool_call");
		}
		optionalStrings(block, ["textSignature", "thinkingSignature", "thoughtSignature", "namespace"], location);
		if (block.redacted !== undefined && typeof block.redacted !== "boolean") invalid(`${location}.redacted`, "a boolean");
	}
}

/** Storage shape only. Interrupted tool pairing and branch provenance are separate contracts. */
export function validateSessionMessage(value: unknown, path = "message"): asserts value is SessionMessage {
	const message = object(value, path);
	if (typeof message.role !== "string" || !["user", "assistant", "toolResult"].includes(message.role)) invalid(`${path}.role`, "user, assistant or toolResult");
	number(message.timestamp, `${path}.timestamp`);
	if (!Number.isFinite(new Date(message.timestamp as number).getTime())) invalid(`${path}.timestamp`, "a representable timestamp");
	content(message.content, `${path}.content`, message.role);
	optionalStrings(message, ["provider", "model", "api", "errorMessage", "toolCallId", "toolName"], path);
	if (message.role === "toolResult") text(message.toolCallId, `${path}.toolCallId`, true);
	if (message.toolArguments !== undefined) object(message.toolArguments, `${path}.toolArguments`);
	for (const key of ["isError", "contextExcluded"]) if (message[key] !== undefined && typeof message[key] !== "boolean") invalid(`${path}.${key}`, "a boolean");
	if (message.stopReason !== undefined && (typeof message.stopReason !== "string" || !["stop", "tool_use", "length", "error", "aborted", "deferred"].includes(message.stopReason))) invalid(`${path}.stopReason`, "a known stop reason");
	if (message.usage !== undefined) {
		const usage = object(message.usage, `${path}.usage`);
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) number(usage[key], `${path}.usage.${key}`, true);
		if (usage.cost !== undefined) for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) number(object(usage.cost, `${path}.usage.cost`)[key], `${path}.usage.cost.${key}`, true);
	}
	if (message.inputContext !== undefined) {
		const location = `${path}.inputContext`, context = object(message.inputContext, location);
		if (message.role !== "user" || typeof context.kind !== "string" || !["mcp_prompt", "mcp_resource"].includes(context.kind)) invalid(location, "a user MCP input envelope");
		text(context.serverId, `${location}.serverId`, true); text(context.name, `${location}.name`, true);
		number(context.fetchedAt, `${location}.fetchedAt`);
		if (!Number.isSafeInteger(context.catalogRevision) || (context.catalogRevision as number) < 0) invalid(`${location}.catalogRevision`, "a nonnegative safe integer");
		if (context.task !== undefined) text(context.task, `${location}.task`);
		if (context.arguments !== undefined) for (const [key, value] of Object.entries(object(context.arguments, `${location}.arguments`))) text(value, `${location}.arguments.${key}`);
		if (!Array.isArray(context.messages)) invalid(`${location}.messages`, "an array");
		for (const [index, value] of context.messages.entries()) {
			const nestedPath = `${location}.messages[${index}]`, nested = object(value, nestedPath);
			if (nested.role !== "user" && nested.role !== "assistant") invalid(`${nestedPath}.role`, "user or assistant");
			content(nested.content, `${nestedPath}.content`, nested.role, true);
		}
		if (!Array.isArray(context.artifacts)) invalid(`${location}.artifacts`, "an array");
		for (const [index, value] of context.artifacts.entries()) {
			const artifactPath = `${location}.artifacts[${index}]`, artifact = object(value, artifactPath);
			text(artifact.id, `${artifactPath}.id`, true); text(artifact.mimeType, `${artifactPath}.mimeType`, true);
			if (!Number.isSafeInteger(artifact.size) || (artifact.size as number) < 0) invalid(`${artifactPath}.size`, "a nonnegative safe integer");
		}
	}
	validatePersistentValue(message, path);
}
