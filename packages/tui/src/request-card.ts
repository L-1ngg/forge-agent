import { permissionScopeForToolCall, response, type RequestEnvelopeUnion, type ResponseEnvelope } from "@myh/protocol";
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

	constructor(request: RequestEnvelopeUnion) {
		const actions = requestCardActions(request);
		this.record = {
			id: request.id,
			request,
			state: "active",
			focusableCount: actions.length,
			shortcuts: ["Tab next", "Enter choose", "Esc dismiss"],
		};
		this.text = new Text(`${renderRequestCardText(request)}\n\n${actions.map((action, index) => `${index + 1}. ${action}`).join("  ")}`, 1, 1);
	}

	resolve(response: ResponseEnvelope): void {
		if (response.id !== this.record.id || this.record.state !== "active") return;
		this.record.state = "resolved";
		this.record.result = response.result;
	}

	 dismiss(): void {
		if (this.record.state === "active") this.record.state = "dismissed";
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
			return response(request.id, { decision: action === "cancel" ? "cancel" : "keep_running" });
		case "question":
			if (action === "cancel") return response(request.id, { decision: "cancel" });
			if (!request.payload.choices?.length) return response(request.id, { decision: "answer", answers: [] });
			return response(request.id, {
				decision: "answer",
				answers: (request.payload.multiple ? request.payload.choices : request.payload.choices.slice(0, 1)).map((choice) => choice.id),
			});
		case "plan_approval":
			return response(request.id, action === "reject" ? { decision: "reject", feedback: "Rejected by user" } : { decision: "approve" });
		case "oauth":
			return response(request.id, { decision: action === "cancel" ? "cancel" : "completed" });
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
