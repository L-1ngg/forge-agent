import { permissionScopeForToolCall, response, type RequestEnvelopeUnion, type RequestOutcome, type RequestKind, type ResponseEnvelope } from "@forge-agent/protocol";
import { defaultStyle, fillRect, writeText, type CellStyle, type TerminalFrame } from "./frame.ts";
import type { Theme } from "./theme.ts";
import { truncateToWidth, wrapText } from "./width.ts";
import { backspace, createEditor, editorText, insertText, moveLeft, moveRight } from "./editor.ts";
import type { Key } from "./keys.ts";
import type { FocusCard } from "./focus-stack.ts";
import type { EntryRow } from "./transcript/types.ts";

export type RequestCardAction = "allow_once" | "allow_always" | "deny" | "cancel" | "confirm" | "reject" | "answer_text" | `choice:${number}` | `field:${number}` | "open_url";
export type RequestCardState = "active" | "parked" | "resolved" | "dismissed";

export interface RequestCardRecord extends FocusCard {
	request: RequestEnvelopeUnion;
	state: RequestCardState;
	result?: unknown;
}

/** Blocking card model: state transitions and the response builder. Paint is separate. */
export class RequestCard {
	readonly record: RequestCardRecord;
	readonly selectedChoices = new Set<string>();
	readonly answerDraft = createEditor();
	readonly fields = new Map<string, ReturnType<typeof createEditor>>();
	validationError = "";
	bodyOffset = 0;

	constructor(request: RequestEnvelopeUnion) {
		this.record = {
			id: request.id,
			request,
			state: "active",
			focusableCount: requestCardActions(request).length,
		};
	}

	get focusedActionIndexCount(): number {
		return this.record.focusableCount ?? 1;
	}

	park(): void {
		if (this.record.state === "active") this.record.state = "parked";
	}

	resume(): void {
		if (this.record.state === "parked") this.record.state = "active";
	}

	/** Bus terminal outcome arrived without a UI response; archive, never re-answer. */
	terminal(outcome: RequestOutcome<RequestKind>): void {
		if ((this.record.state !== "active" && this.record.state !== "parked") || outcome.requestId !== this.record.id) return;
		this.record.state = outcome.status === "response" ? "resolved" : "dismissed";
		this.record.result = outcome;
	}

	/** The only path that answers a request: an explicit action on an active card. */
	responseFor(action: RequestCardAction): ResponseEnvelope | undefined {
		if (this.record.state !== "active") return undefined;
		const request = this.record.request;
		if (request.kind === "mcp_elicitation" && action === "confirm" && request.payload.mode === "form") {
            try {
                const content: Record<string, unknown> = {};
                const schema = request.payload.requestedSchema ?? {};
                const required = Array.isArray(schema.required) ? schema.required : [];
                for (const [name, definition] of formFields(request)) {
                    const editor = this.fields.get(name); const value = editor ? editorText(editor) : "";
                    if (!value && !required.includes(name)) continue;
                    if (!value && required.includes(name)) throw new Error(`${name} is required`);
                    const type = definition.type;
                    if (!["string", "number", "integer", "boolean", "array"].includes(String(type))) throw new Error(`${name}: unsupported field type`);
                    const typed: unknown = type === "string" ? value : JSON.parse(value);
                    if (type === "boolean" && typeof typed !== "boolean" || ["number", "integer"].includes(String(type)) && (typeof typed !== "number" || !Number.isFinite(typed) || type === "integer" && !Number.isInteger(typed)) || type === "array" && (!Array.isArray(typed) || typed.some(item => typeof item !== "string"))) throw new Error(`${name}: expected ${String(type)}`);
                    if (Array.isArray(definition.enum) && !definition.enum.includes(typed)) throw new Error(`${name}: select a listed value`);
                    if (typeof typed === "number") {
                        if (typeof definition.minimum === "number" && typed < definition.minimum || typeof definition.maximum === "number" && typed > definition.maximum) throw new Error(`${name}: outside the allowed range`);
                    }
                    if (typeof typed === "string") {
                        const length = [...typed].length;
                        if (typeof definition.minLength === "number" && length < definition.minLength || typeof definition.maxLength === "number" && length > definition.maxLength) throw new Error(`${name}: invalid length`);
                        if (Array.isArray(definition.oneOf) && !definition.oneOf.some(option => option && typeof option === "object" && "const" in option && option.const === typed)) throw new Error(`${name}: select a listed option`);
                    }
                    if (Array.isArray(typed)) {
                        if (typeof definition.minItems === "number" && typed.length < definition.minItems || typeof definition.maxItems === "number" && typed.length > definition.maxItems || definition.uniqueItems === true && new Set(typed).size !== typed.length) throw new Error(`${name}: invalid selection count`);
                        const items = definition.items as { enum?: unknown[]; anyOf?: Array<{ const?: unknown }> } | undefined;
                        const allowed = items?.enum ?? items?.anyOf?.map(option => option.const);
                        if (allowed && typed.some(value => !allowed.includes(value))) throw new Error(`${name}: select listed options`);
                    }
                    content[name] = typed;
                }
                this.validationError = ""; return response(request.id, { decision: "accept", content });
            } catch (error) { this.validationError = error instanceof Error ? error.message : "Invalid input"; return undefined; }
        }
        if (request.kind === "question") {
			const choice = action.startsWith("choice:") ? request.payload.choices?.[Number(action.slice(7))] : undefined;
			if (choice) {
				if (!request.payload.multiple) return response(request.id, { decision: "answer", answers: [choice.id] });
				if (this.selectedChoices.has(choice.id)) this.selectedChoices.delete(choice.id);
				else this.selectedChoices.add(choice.id);
				return undefined;
			}
			if (action === "confirm") {
				const answers = (request.payload.choices ?? []).filter((entry) => this.selectedChoices.has(entry.id)).map((entry) => entry.id);
				const text = editorText(this.answerDraft).trim();
				if (text) answers.push(text);
				return answers.length > 0 ? response(request.id, { decision: "answer", answers }) : undefined;
			}
		}
		return responseForRequestAction(this.record.request, action);
	}

	handleTextKey(key: Key, focusIndex: number): boolean {
		const action = requestCardActions(this.record.request)[focusIndex];
        if (action?.startsWith("field:") && this.record.request.kind === "mcp_elicitation") {
            const field = formFields(this.record.request)[Number(action.slice(6))]; if (!field) return false;
            let editor = this.fields.get(field[0]); if (!editor) { editor = createEditor(); this.fields.set(field[0], editor); }
            if (key.type === "char" || key.type === "paste") insertText(editor, key.text);
            else if (key.type === "backspace") backspace(editor);
            else if (key.type === "arrow" && key.direction === "left") moveLeft(editor);
            else if (key.type === "arrow" && key.direction === "right") moveRight(editor);
            else return false;
            return true;
        }
        if (action !== "answer_text") return false;
		if (key.type === "char" || key.type === "paste") insertText(this.answerDraft, key.text);
		else if (key.type === "backspace") backspace(this.answerDraft);
		else if (key.type === "arrow" && key.direction === "left") moveLeft(this.answerDraft);
		else if (key.type === "arrow" && key.direction === "right") moveRight(this.answerDraft);
		else return false;
		return true;
	}

	markResolved(result: unknown): void {
		if (this.record.state !== "active") return;
		this.record.state = "resolved";
		this.record.result = result;
	}
}

export function requestCardActions(request: RequestEnvelopeUnion): readonly RequestCardAction[] {
	switch (request.kind) {
		case "mcp_elicitation":
			return request.payload.mode === "form" ? [...formFields(request).map((_, index): RequestCardAction => `field:${index}`), "confirm", "reject", "cancel"] : ["open_url", "confirm", "reject", "cancel"];
		case "permission":
			return request.payload.rememberRule ? ["allow_once", "allow_always", "deny"] : ["allow_once", "deny"];
		case "cancel_confirm":
			return ["confirm", "cancel"];
		case "question": {
			const choices = (request.payload.choices ?? []).map((_, index): RequestCardAction => `choice:${index}`);
			const freeText = request.payload.allowFreeText ?? choices.length === 0;
			return [...choices, ...(freeText ? ["answer_text" as const] : []), ...(freeText || request.payload.multiple ? ["confirm" as const] : []), "cancel"];
		}
		case "plan_approval":
			return ["confirm", "reject"];
		case "oauth":
			return ["confirm", "cancel"];
	}
}

/** User-facing labels are deliberately separate from protocol action ids. */
export function requestCardActionLabel(request: RequestEnvelopeUnion, action: RequestCardAction): string {
	if (request.kind === "mcp_elicitation" && action.startsWith("field:")) { const field = formFields(request)[Number(action.slice(6))]; return field ? `${field[0]} (${String(field[1].type)}): ` : ""; }
	if (action === "open_url") return "Open URL";
	if (request.kind === "question") {
		if (action.startsWith("choice:")) return request.payload.choices?.[Number(action.slice(7))]?.label ?? "";
		if (action === "answer_text") return "Answer: ";
	}
	if (request.kind === "cancel_confirm") return action === "confirm" ? "Yes, cancel" : "Keep running";
	if (request.kind === "permission") {
		const tool = request.payload.toolCall.name;
		if (action === "allow_once") return tool === "bash" ? "Yes, proceed" : "Yes, allow once";
		if (action === "allow_always") return `Always allow: ${tool}`;
		if (action === "deny") return "No, reject";
	}
	switch (action) {
		case "confirm":
			return request.kind === "plan_approval" ? "Approve" : request.kind === "oauth" ? "Continue" : "Confirm";
		case "cancel":
			return "Cancel";
		case "reject":
			return "Reject";
		default:
			return action;
	}
}

export function responseForRequestAction(request: RequestEnvelopeUnion, action: RequestCardAction): ResponseEnvelope | undefined {
	switch (request.kind) {
		case "mcp_elicitation":
			if (action === "cancel") return response(request.id, { decision: "cancel" });
			if (action === "reject") return response(request.id, { decision: "decline" });
			if (action === "confirm" && request.payload.mode === "url") return response(request.id, { decision: "accept" });
			return undefined;
		case "permission": {
			if (action === "allow_once") return response(request.id, { decision: "allow_once" });
			if (action === "deny") return response(request.id, { decision: "deny", reason: "Denied by user" });
			if (action === "allow_always" && request.payload.rememberRule) {
				return response(request.id, { decision: "allow_always", scope: permissionScopeForToolCall(request.payload.toolCall) });
			}
			return undefined;
		}
		case "cancel_confirm":
			if (action === "cancel") return response(request.id, { decision: "keep_running" });
			if (action === "confirm") return response(request.id, { decision: "cancel" });
			return undefined;
		case "question":
			if (action === "cancel") return response(request.id, { decision: "cancel" });
			return undefined;
		case "plan_approval":
			if (action === "reject") return response(request.id, { decision: "reject", feedback: "Rejected by user" });
			if (action === "confirm") return response(request.id, { decision: "approve" });
			return undefined;
		case "oauth":
			if (action === "cancel") return response(request.id, { decision: "cancel" });
			if (action === "confirm") return response(request.id, { decision: "completed" });
			return undefined;
	}
}

/** Compact one-line form of a tool call: the command for bash, the path for file tools. */
export function summarizeToolCall(toolCall: { name: string; arguments: Record<string, unknown> }): string {
	const args = toolCall.arguments;
	if (toolCall.name === "bash" && typeof args.command === "string") return `bash ${args.command}`;
	if ((toolCall.name === "write" || toolCall.name === "edit" || toolCall.name === "read") && typeof args.path === "string") return `${toolCall.name} ${args.path}`;
	return `${toolCall.name} ${formatArgumentsCompact(args)}`;
}

function formatArgumentsCompact(value: Record<string, unknown>): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

/** One-line transcript record for a card that has left the blocking region. */
export function archivedCardLine(record: RequestCardRecord): string {
	const status = archivedStatus(record);
	switch (record.request.kind) {
		case "mcp_elicitation": return `MCP ${record.request.payload.serverId}: ${status}`;
		case "permission":
			return `Permission: ${summarizeToolCall(record.request.payload.toolCall)} — ${status}`;
		case "cancel_confirm":
			return `Cancel: ${record.request.payload.action} — ${status}`;
		case "question":
			return `Question: ${record.request.payload.prompt} — ${status}`;
		case "plan_approval":
			return `Plan approval — ${status}`;
		case "oauth":
			return `OAuth: ${record.request.payload.provider} — ${status}`;
	}
}

function archivedStatus(record: RequestCardRecord): string {
	const result = record.result as { decision?: unknown; status?: unknown; result?: { decision?: unknown } } | undefined;
	if (typeof result?.decision === "string") return result.decision;
	if (result?.status === "response" && typeof result.result?.decision === "string") return result.result.decision;
	if (result?.status === "timeout") return "timed out";
	if (result?.status === "cancelled") return "cancelled";
	return record.state;
}

type CardTone = "title" | "body" | "accent";

/** Card body rows as styled spans (title / accent / body tones), wrapped to width. */
export function cardBodyRows(request: RequestEnvelopeUnion, width: number, theme: Theme): EntryRow[] {
	const rows: EntryRow[] = [];
	const add = (value: string | undefined, tone: CardTone = "body"): void => {
		if (!value) return;
		const style = cardTextStyle(tone, theme);
		for (const line of value.split("\n")) {
			for (const wrapped of wrapText(line, width)) rows.push({ spans: wrapped ? [{ text: wrapped, style }] : [] });
		}
	};
	switch (request.kind) {
		case "mcp_elicitation":
			add(`MCP ${request.payload.serverId}`, "title"); add(request.payload.message); add(request.payload.url, "accent");
			for (const [name, definition] of formFields(request)) { add(`${name}: ${String(definition.description ?? "")}`); if (definition.enum || definition.oneOf || definition.items) add(JSON.stringify(definition.enum ?? definition.oneOf ?? definition.items)); }
			break;
		case "permission":
			add(`Permission: ${request.payload.toolCall.name}`, "title");
			add(summarizeToolCall(request.payload.toolCall), "accent");
			for (const [name, value] of Object.entries(request.payload.toolCall.arguments)) {
				add(`${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
			}
			add(request.payload.reason);
			add(request.payload.rememberRule, "body");
			break;
		case "cancel_confirm":
			add(`Cancel: ${request.payload.action}`, "title");
			add(request.payload.consequence);
			break;
		case "question":
			add("Question", "title");
			add(request.payload.prompt);
			for (const choice of request.payload.choices ?? []) {
				add(`• ${choice.label}${choice.description ? ` — ${choice.description}` : ""}`, "body");
			}
			break;
		case "plan_approval":
			add("Plan approval", "title");
			add(request.payload.plan);
			break;
		case "oauth":
			add(`OAuth: ${request.payload.provider}`, "title");
			add(request.payload.authorizationUrl, "accent");
			add(request.payload.instructions);
			break;
	}
	return rows;
}

function cardTextStyle(tone: CardTone, theme: Theme): CellStyle {
	const base = defaultStyle();
	if (tone === "title") return { ...base, foreground: theme.color("status"), attributes: { ...base.attributes, bold: true } };
	if (tone === "accent") return { ...base, foreground: theme.color("accent_user") };
	return { ...base, foreground: theme.color("muted") };
}

export interface CardPaintInput {
	frame: TerminalFrame;
	y: number;
	height: number;
	card: RequestCard;
	focusIndex: number;
	focused: boolean;
	theme: Theme;
}

const CARD_RAIL = "┃";
const CARD_LEFT_PADDING = 2;

/** Paint the card into the interactive slot; title and actions survive short slots. */
export function paintRequestCard(input: CardPaintInput): void {
	const { frame, y, height, card, focusIndex, focused, theme } = input;
	if (height <= 0 || y >= frame.rows) return;
	const width = frame.columns;
	const contentX = CARD_RAIL.length + CARD_LEFT_PADDING;
	const contentWidth = Math.max(1, width - contentX - 2);
	const surface = theme.color("surface");
	const surfaceFocus = theme.color("surface_focus");
	const railStyle: CellStyle = { ...defaultStyle(), foreground: theme.color("accent_user"), background: surface };

	const body = cardBodyRows(card.record.request, contentWidth, theme);
	if (card.validationError) body.push({ spans: [{ text: card.validationError, style: cardTextStyle("accent", theme) }] });
	if (!focused && body[0]) body[0].spans.push({ text: " (parked)", style: { ...defaultStyle(), foreground: theme.color("muted") } });
	const actions = requestCardActions(card.record.request);
	const actionRows: EntryRow[] = actions.map((action, index) => {
		const selected = focused && index === focusIndex;
		const choice = card.record.request.kind === "question" && action.startsWith("choice:") ? card.record.request.payload.choices?.[Number(action.slice(7))] : undefined;
		const checked = choice && card.selectedChoices.has(choice.id);
		const numberStyle: CellStyle = { ...defaultStyle(), foreground: theme.color("accent_user"), background: selected ? surfaceFocus : surface };
		const markerStyle: CellStyle = { ...defaultStyle(), foreground: selected ? theme.color("status") : theme.color("muted"), background: selected ? surfaceFocus : surface, attributes: { ...defaultStyle().attributes, bold: selected } };
		return {
			spans: [
				{ text: `${index + 1} `, style: numberStyle },
				{ text: choice && card.record.request.kind === "question" && card.record.request.payload.multiple ? checked ? "[x] " : "[ ] " : selected ? "(●) " : "(○) ", style: markerStyle },
				{ text: requestCardActionLabel(card.record.request, action) + (action === "answer_text" ? editorText(card.answerDraft) : action.startsWith("field:") ? editorText(card.fields.get(formFields(card.record.request)[Number(action.slice(6))]?.[0] ?? "") ?? createEditor()) : ""), style: markerStyle },
			],
		};
	});

	const blank: EntryRow = { spans: [] };
	let rows: EntryRow[] = [blank, ...body, blank, ...actionRows];
	let actionStart = 0;
	let actionTop = 2 + body.length;
	if (rows.length > height || card.bodyOffset > 0) {
		const titleHeight = height >= 2 ? 1 : 0;
		const actionCount = Math.min(actionRows.length, height - titleHeight - (height >= 4 ? 1 : 0));
		actionStart = Math.max(0, Math.min(focusIndex - actionCount + 1, actionRows.length - actionCount));
		const bodyBudget = Math.max(0, height - titleHeight - actionCount);
		card.bodyOffset = Math.min(card.bodyOffset, Math.max(0, body.length - 1 - bodyBudget));
		const visibleBody = body.slice(1 + card.bodyOffset, 1 + card.bodyOffset + bodyBudget);
		rows = [...(titleHeight ? body.slice(0, 1) : []), ...visibleBody, ...actionRows.slice(actionStart, actionStart + actionCount)];
		actionTop = titleHeight + visibleBody.length;
	}

	for (const [index, entryRow] of rows.entries()) {
		const lineY = y + index;
		if (lineY < 0 || lineY >= frame.rows) continue;
		const selectedAction = focused && index >= actionTop && index - actionTop + actionStart === focusIndex;
		fillRect(frame, 0, lineY, width, 1, { ...defaultStyle(), background: selectedAction ? surfaceFocus : surface });
		writeText(frame, 0, lineY, CARD_RAIL, railStyle);
		let x = contentX;
		for (const span of entryRow.spans) {
			if (x >= width - 2) break;
			x = writeText(frame, x, lineY, truncateToWidth(span.text, width - 2 - x), span.style);
		}
	}
}

/** Height the card wants for full presentation; the slot may give less. */
export function cardDesiredHeight(request: RequestEnvelopeUnion, width: number, theme: Theme): number {
	const contentWidth = Math.max(1, width - CARD_RAIL.length - CARD_LEFT_PADDING - 2);
	return 2 + cardBodyRows(request, contentWidth, theme).length + requestCardActions(request).length;
}

function formFields(request: RequestEnvelopeUnion): Array<[string, Record<string, unknown>]> {
 if (request.kind !== "mcp_elicitation" || request.payload.mode !== "form") return [];
 const fields = request.payload.requestedSchema?.properties;
 if (!fields || typeof fields !== "object") return [];
 return Object.entries(fields).filter((entry): entry is [string, Record<string, unknown>] => !!entry[1] && typeof entry[1] === "object" && !Array.isArray(entry[1]));
}
