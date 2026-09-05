import type { InputCompletionItem, InputCompletionSuggestions } from "@forge-agent/protocol";
import { activeMention } from "./mention.ts";
import { slashCommandPrefix } from "./slash.ts";

export interface InputCommand {
	name: string;
	description?: string;
}

export interface InputCompletionSourceOptions {
	commands?: readonly InputCommand[];
	listFiles?: (prefix: string) => readonly string[] | Promise<readonly string[]>;
}

export interface InputCompletionSource {
	getSuggestions(
		input: string,
		cursor: number,
		options?: { signal?: AbortSignal; force?: boolean },
	): InputCompletionSuggestions | null | Promise<InputCompletionSuggestions | null>;
	applyCompletion(input: string, cursor: number, item: InputCompletionItem, prefix: string): { input: string; cursor: number };
	isFileContext?(input: string, cursor: number): boolean;
}

/**
 * Compose parser results into a transport-neutral completion source. The UI
 * adapter decides how suggestions are displayed; this source owns ranges and
 * text replacement so another client can reuse the same behavior.
 */
export function createInputCompletionSource(options: InputCompletionSourceOptions = {}): InputCompletionSource {
	const commands = [...(options.commands ?? [])];
	return {
		async getSuggestions(input, cursor) {
			const boundedCursor = clampCursor(input, cursor);
			const beforeCursor = input.slice(0, boundedCursor);
			const slash = slashCommandPrefix(beforeCursor);
			if (slash) {
				const items = commands
					.filter((command) => command.name.startsWith(slash.prefix))
					.map((command) => toCommandItem(command));
				return items.length > 0 ? { items, prefix: `/${slash.prefix}` } : null;
			}

			const mention = activeMention(input, boundedCursor);
			if (!mention || !options.listFiles) return null;
			const files = await options.listFiles(mention.path);
			if (files.length === 0) return null;
			const items = files.map((path) => ({ value: `@${path}`, label: `@${path}` }));
			return { items, prefix: mention.raw };
		},
		applyCompletion(input, cursor, item, prefix) {
			const boundedCursor = clampCursor(input, cursor);
			if (prefix.startsWith("/")) return applySlashCompletion(input, boundedCursor, item);
			if (prefix.startsWith("@")) return applyMentionCompletion(input, boundedCursor, item);
			const start = Math.max(0, boundedCursor - prefix.length);
			const value = item.value;
			return { input: `${input.slice(0, start)}${value}${input.slice(boundedCursor)}`, cursor: start + value.length };
		},
		isFileContext(input, cursor) {
			return activeMention(input, clampCursor(input, cursor)) !== undefined;
		},
	};
}

export const createCompletionSource = createInputCompletionSource;

function toCommandItem(command: InputCommand): InputCompletionItem {
	return {
		value: command.name,
		label: `/${command.name}`,
		...(command.description === undefined ? {} : { description: command.description }),
	};
}

function applySlashCompletion(input: string, cursor: number, item: InputCompletionItem): { input: string; cursor: number } {
	const slash = slashCommandPrefix(input.slice(0, cursor));
	if (!slash) return applyPrefixCompletion(input, cursor, item, "/");
	const command = item.value.startsWith("/") ? item.value.slice(1) : item.value;
	const inserted = `/${command} `;
	const next = `${input.slice(0, slash.start)}${inserted}${input.slice(cursor)}`;
	return { input: next, cursor: slash.start + inserted.length };
}

function applyMentionCompletion(input: string, cursor: number, item: InputCompletionItem): { input: string; cursor: number } {
	const mention = activeMention(input, cursor);
	if (!mention) return applyPrefixCompletion(input, cursor, item, "@");
	const value = item.value.startsWith("@") ? item.value : `@${item.value}`;
	const suffix = item.label.endsWith("/") ? "" : " ";
	const next = `${input.slice(0, mention.start)}${value}${suffix}${input.slice(mention.end)}`;
	return { input: next, cursor: mention.start + value.length + suffix.length };
}

function applyPrefixCompletion(input: string, cursor: number, item: InputCompletionItem, marker: string): { input: string; cursor: number } {
	const lineStart = Math.max(input.lastIndexOf("\n", cursor - 1) + 1, 0);
	const markerStart = input.lastIndexOf(marker, cursor - 1);
	const start = markerStart >= lineStart ? markerStart : Math.max(0, cursor - 1);
	const value = item.value.startsWith(marker) ? item.value : `${marker}${item.value}`;
	const next = `${input.slice(0, start)}${value}${input.slice(cursor)}`;
	return { input: next, cursor: start + value.length };
}

function clampCursor(input: string, cursor: number): number {
	if (!Number.isFinite(cursor)) return input.length;
	return Math.max(0, Math.min(input.length, Math.floor(cursor)));
}
