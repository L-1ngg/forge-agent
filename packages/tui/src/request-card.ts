import { permissionScopeForToolCall, response, type RequestEnvelopeUnion, type RequestKind, type RequestOutcome, type ResponseEnvelope } from "@myh/protocol";
import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { FocusCard } from "./focus-stack.ts";
import { identityTheme, type SemanticTheme } from "./theme.ts";

export type RequestCardAction = "allow_once" | "allow_always" | "deny" | "cancel" | "confirm" | "reject";

export interface RequestCardRecord extends FocusCard {
	request: RequestEnvelopeUnion;
	state: "active" | "parked" | "resolved" | "dismissed";
	result?: unknown;
}

/** Pure request-card model shared by the four blocking card layouts. */
export class RequestCard implements Component {
	readonly record: RequestCardRecord;
	private readonly theme: SemanticTheme;
	private focusIndex = 0;
	private isFocused = false;

	constructor(request: RequestEnvelopeUnion, theme: SemanticTheme = identityTheme) {
		const actions = requestCardActions(request);
		this.theme = theme;
		this.record = {
			id: request.id,
			request,
			state: "active",
			focusableCount: actions.length,
			shortcuts: ["Tab next", "Enter choose", "Esc scrollback"],
		};
	}

	get focused(): boolean {
		return this.isFocused;
	}

	set focused(value: boolean) {
		if (value === this.isFocused) return;
		this.isFocused = value;
	}

	resolve(response: ResponseEnvelope): void {
		if (response.id !== this.record.id || this.record.state !== "active") return;
		this.record.state = "resolved";
		this.record.result = response.result;
	}

	dismiss(response?: ResponseEnvelope): void {
		if (this.record.state !== "active" && this.record.state !== "parked") return;
		this.record.state = "dismissed";
		if (response) this.record.result = response.result;
	}

	park(): void {
		if (this.record.state !== "active") return;
		this.record.state = "parked";
	}

	resume(): void {
		if (this.record.state !== "parked") return;
		this.record.state = "active";
	}

	/** Keep the visual selection in lockstep with the shared FocusStack. */
	setFocusIndex(index: number): void {
		const count = normalizedFocusableCount(this.record.focusableCount);
		const next = Number.isFinite(index) ? Math.max(0, Math.min(count - 1, Math.floor(index))) : 0;
		if (next === this.focusIndex) return;
		this.focusIndex = next;
	}

	terminal(outcome: RequestOutcome<RequestKind>): void {
		if ((this.record.state !== "active" && this.record.state !== "parked") || outcome.requestId !== this.record.id) return;
		this.record.state = outcome.status === "response" ? "resolved" : "dismissed";
		this.record.result = outcome;
	}

	responseFor(action: RequestCardAction): ResponseEnvelope | undefined {
		if (this.record.state !== "active") return undefined;
		return responseForRequestAction(this.record.request, action);
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		// Grok's permission panel is laid out as
		// `rail(1) + left inset(2) + content + right inset(2)`.
		// Keep this arithmetic explicit so every painted row has exactly
		// `safeWidth` cells, including narrow terminals.
		const contentWidth = Math.max(1, safeWidth - 1 - 2 - 2);
		const active = this.record.state === "active" || this.record.state === "parked";
		const body = requestCardBody(this.record.request, contentWidth, this.theme);
		const lines = ["", ...body];
		if (active) {
			lines.push("");
			for (const [index, action] of requestCardActions(this.record.request).entries()) {
				const selected = this.isFocused && index === this.focusIndex;
				lines.push(renderAction(this.record.request, action, index, selected, this.theme));
			}
		} else {
			const outcome = this.record.result as Partial<RequestOutcome<RequestKind>> | undefined;
			lines.push("", `Status: ${outcome?.status ?? this.record.state}`);
		}
		return lines.map((line, index) => this.paintRow(line, safeWidth, index === body.length + 1 + this.focusIndex + 1));
	}

	/** Height-aware card projection keeps the title and choices visible together. */
	renderForHeight(width: number, height: number): string[] {
		const safeHeight = Math.max(0, Math.floor(height));
		const full = this.render(width);
		if (safeHeight === 0 || full.length <= safeHeight) return full.slice(0, safeHeight);
		if (safeHeight === 1) return [full[full.length - 1] ?? ""];
		const first = full.findIndex((line) => cardRowText(line).length > 0);
		const last = full.length - 1;
		const actionStart = full.findIndex((line, index) => index > first && /^\d+\s/.test(cardRowText(line)));
		const actionCount = actionStart >= 0 ? full.length - actionStart : 1;
		const actionBudget = Math.min(actionCount, Math.max(0, safeHeight - 1));
		const tail = actionBudget > 0 ? full.slice(last - actionBudget + 1) : [];
		const head = first >= 0 ? full[first] ?? "" : full[0] ?? "";
		if (safeHeight === 2) return [head, tail.at(-1) ?? this.paintRow("… Ctrl-F to expand", width, false)];
		const marker = this.paintRow("… Ctrl-F to expand", width, false);
		const remaining = safeHeight - 2;
		return [head, marker, ...tail.slice(-remaining)].slice(0, safeHeight);
	}

	invalidate(): void {
		// Render is derived entirely from record/focus state; no child component cache
		// needs invalidation.
	}

	private paintRow(line: string, width: number, selected: boolean): string {
		const background = selected ? this.theme.surface_focus : this.theme.surface;
		const railWidth = 1;
		const leftPadding = Math.min(2, Math.max(0, width - railWidth));
		const rightPadding = Math.min(2, Math.max(0, width - railWidth - leftPadding));
		const textWidth = Math.max(1, width - railWidth - leftPadding - rightPadding);
		const fitted = truncateToWidth(line, textWidth, "", true);
		const content = `${" ".repeat(leftPadding)}${fitted}${" ".repeat(rightPadding)}`;
		const accent = applyTheme(this.theme.accent_user, "┃");
		// The row background is the focus affordance.  Keep body/title/action
		// foreground styles intact instead of repainting the whole row as status.
		return applyTheme(background, `${accent}${content}`);
	}
}

function cardRowText(line: string): string {
	const plain = stripTerminalSequences(line);
	return plain.startsWith("┃") ? plain.slice(1).trim() : plain.trim();
}

/** User-facing labels are deliberately separate from protocol action ids. */
export function requestCardActionLabel(request: RequestEnvelopeUnion, action: RequestCardAction): string {
	if (request.kind === "permission") {
		const tool = request.payload.toolCall.name;
		if (action === "allow_once") return tool === "bash" ? "Yes, proceed" : "Yes, allow once";
		if (action === "allow_always") return `Always allow: ${tool}`;
		if (action === "deny") return "No, reject (type to add feedback)";
	}
	switch (action) {
		case "confirm":
			return request.kind === "plan_approval" ? "Approve" : request.kind === "cancel_confirm" ? "Yes, continue" : request.kind === "oauth" ? "Continue" : "Confirm";
		case "cancel":
			return request.kind === "cancel_confirm" ? "No, keep running" : "Cancel";
		case "reject":
			return "Reject";
		default:
			return action;
	}
}

function renderAction(request: RequestEnvelopeUnion, action: RequestCardAction, index: number, selected: boolean, theme: SemanticTheme): string {
	const number = applyTheme(theme.accent_user, `${index + 1} `);
	const marker = selected ? boldStyled(theme.status("(●)")) : applyTheme(theme.muted, "(○)");
	const label = selected
		? boldStyled(theme.status(requestCardActionLabel(request, action)))
		: applyTheme(theme.muted, requestCardActionLabel(request, action));
	return `${number}${marker} ${label}`;
}

function boldStyled(value: string): string {
	// Identity themes intentionally remain ANSI-free for deterministic unit tests.
	return stripTerminalSequences(value) === value ? value : `\u001b[1m${value}\u001b[22m`;
}

function requestCardBody(request: RequestEnvelopeUnion, width: number, theme: SemanticTheme): string[] {
	const rows: string[] = [];
	const add = (value: string | undefined, tone: "title" | "body" | "accent" = "body"): void => {
		if (!value) return;
		for (const line of value.split("\n")) {
			const wrapped = wrapTextWithAnsi(styleCardText(line, tone, theme), width);
			rows.push(...(wrapped.length > 0 ? wrapped : [""]));
		}
	};
	switch (request.kind) {
		case "permission":
			add(`Permission: ${request.payload.toolCall.name}`, "title");
			add(summarizeToolCall(request.payload.toolCall), "accent");
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

function styleCardText(value: string, tone: "title" | "body" | "accent", theme: SemanticTheme): string {
	if (tone === "title") return boldStyled(theme.status(value));
	if (tone === "accent") return applyTheme(theme.accent_user, value);
	return theme.muted(value);
}

function applyTheme(color: ((text: string) => string) | undefined, text: string): string {
	return color?.(text) ?? text;
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
	// result holds either a bare response result (user action) or a terminal outcome.
	const result = record.result as { decision?: unknown; status?: unknown; result?: { decision?: unknown } } | undefined;
	if (typeof result?.decision === "string") return result.decision;
	if (result?.status === "response" && typeof result.result?.decision === "string") return result.result.decision;
	if (result?.status === "timeout") return "timed out";
	if (result?.status === "cancelled") return "cancelled";
	return record.state;
}

function normalizedFocusableCount(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value) || value < 1) return 1;
	return Math.max(1, Math.floor(value));
}

export function responseForRequestAction(request: RequestEnvelopeUnion, action: RequestCardAction): ResponseEnvelope | undefined {
	switch (request.kind) {
		case "permission": {
			if (action === "allow_once") return response(request.id, { decision: "allow_once" });
			if (action === "deny") return response(request.id, { decision: "deny", reason: "Denied by user" });
			if (action === "allow_always" && request.payload.rememberRule) {
				return response(request.id, { decision: "allow_always", scope: permissionScopeForToolCall(request.payload.toolCall) });
			}
			return undefined;
		}
		case "cancel_confirm":
			if (action === "cancel") return response(request.id, { decision: "cancel" });
			if (action === "confirm") return response(request.id, { decision: "keep_running" });
			return undefined;
		case "question":
			if (action === "cancel") return response(request.id, { decision: "cancel" });
			if (action !== "confirm") return undefined;
			if (!request.payload.choices?.length) return response(request.id, { decision: "answer", answers: [] });
			return response(request.id, {
				decision: "answer",
				answers: (request.payload.multiple ? request.payload.choices : request.payload.choices.slice(0, 1)).map((choice) => choice.id),
			});
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

/** Conservative response used when Esc removes a blocking card from focus. */
export function responseForRequestDismiss(request: RequestEnvelopeUnion): ResponseEnvelope {
	switch (request.kind) {
		case "permission":
			return response(request.id, { decision: "deny", reason: "Dismissed by user" });
		case "cancel_confirm":
			return response(request.id, { decision: "cancel" });
		case "question":
			return response(request.id, { decision: "cancel" });
		case "plan_approval":
			return response(request.id, { decision: "reject", feedback: "Dismissed by user" });
		case "oauth":
			return response(request.id, { decision: "cancel" });
	}
}

export function requestCardActions(request: RequestEnvelopeUnion): readonly RequestCardAction[] {
	switch (request.kind) {
		case "permission":
			return request.payload.rememberRule ? ["allow_once", "allow_always", "deny"] : ["allow_once", "deny"];
		case "cancel_confirm":
			return ["confirm", "cancel"];
		case "question":
			return ["confirm", "cancel"];
		case "plan_approval":
			return ["confirm", "reject"];
		case "oauth":
			return ["confirm", "cancel"];
	}
}

export function renderRequestCardText(request: RequestEnvelopeUnion): string {
	switch (request.kind) {
		case "permission": {
			return [
				`Permission: ${request.payload.toolCall.name}`,
				summarizeToolCall(request.payload.toolCall),
				request.payload.reason,
				request.payload.rememberRule,
			].filter(Boolean).join("\n");
		}
		case "cancel_confirm":
			return [`Cancel: ${request.payload.action}`, request.payload.consequence].filter(Boolean).join("\n");
		case "question":
			return request.payload.prompt;
		case "plan_approval":
			return `Plan approval\n${request.payload.plan}`;
		case "oauth":
			return [`OAuth: ${request.payload.provider}`, request.payload.authorizationUrl, request.payload.instructions].filter(Boolean).join("\n");
	}
}
