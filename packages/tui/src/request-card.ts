import { permissionScopeForToolCall, response, type RequestEnvelopeUnion, type RequestKind, type RequestOutcome, type ResponseEnvelope } from "@myh/protocol";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { FocusCard } from "./focus-stack.ts";

export type RequestCardAction = "allow_once" | "allow_always" | "deny" | "cancel" | "confirm" | "reject";

export interface RequestCardRecord extends FocusCard {
	request: RequestEnvelopeUnion;
	state: "active" | "resolved" | "dismissed";
	result?: unknown;
}

/** Pure request-card model shared by the four blocking card layouts. */
export class RequestCard implements Component {
	readonly record: RequestCardRecord;
	private readonly text: Text;
	private focusIndex = 0;
	private isFocused = false;

	constructor(request: RequestEnvelopeUnion) {
		const actions = requestCardActions(request);
		this.record = {
			id: request.id,
			request,
			state: "active",
			focusableCount: actions.length,
			shortcuts: ["Tab next", "Enter choose", "Esc dismiss"],
		};
		this.text = new Text("", 1, 1);
		this.refreshText();
	}

	get focused(): boolean {
		return this.isFocused;
	}

	set focused(value: boolean) {
		if (value === this.isFocused) return;
		this.isFocused = value;
		if (this.record.state === "active") this.refreshText();
	}

	resolve(response: ResponseEnvelope): void {
		if (response.id !== this.record.id || this.record.state !== "active") return;
		this.record.state = "resolved";
		this.record.result = response.result;
		this.refreshText();
	}

	dismiss(response?: ResponseEnvelope): void {
		if (this.record.state !== "active") return;
		this.record.state = "dismissed";
		if (response) this.record.result = response.result;
		this.refreshText();
	}

	/** Keep the visual selection in lockstep with the shared FocusStack. */
	setFocusIndex(index: number): void {
		const count = Math.max(1, this.record.focusableCount ?? 1);
		const next = Number.isFinite(index) ? Math.max(0, Math.min(count - 1, Math.floor(index))) : 0;
		if (next === this.focusIndex) return;
		this.focusIndex = next;
		if (this.record.state === "active") this.refreshText();
	}

	terminal(outcome: RequestOutcome<RequestKind>): void {
		if (this.record.state !== "active" || outcome.requestId !== this.record.id) return;
		this.record.state = outcome.status === "response" ? "resolved" : "dismissed";
		this.record.result = outcome;
		this.refreshText();
	}

	responseFor(action: RequestCardAction): ResponseEnvelope | undefined {
		if (this.record.state !== "active") return undefined;
		return responseForRequestAction(this.record.request, action);
	}

	render(width: number): string[] {
		return this.text.render(width);
	}

	invalidate(): void {
		this.text.invalidate();
	}

	private refreshText(): void {
		const body = renderRequestCardText(this.record.request);
		if (this.record.state === "active") {
			const actions = requestCardActions(this.record.request);
			this.text.setText(`${body}\n\n${actions.map((action, index) => `${this.isFocused && index === this.focusIndex ? ">" : " "} ${index + 1}. ${action}`).join("  ")}`);
			return;
		}
		const outcome = this.record.result as Partial<RequestOutcome<RequestKind>> | undefined;
		const status = outcome?.status ?? this.record.state;
		this.text.setText(`${body}\n\nStatus: ${status}`);
	}
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
		case "permission":
			return [`Permission: ${request.payload.toolCall.name}`, request.payload.reason, request.payload.rememberRule].filter(Boolean).join("\n");
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
