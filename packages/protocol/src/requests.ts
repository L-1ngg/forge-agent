import type { ToolCallBlock } from "./events.ts";

export const REQUEST_KINDS = ["permission", "cancel_confirm", "question", "plan_approval", "oauth"] as const;

export type RequestKind = (typeof REQUEST_KINDS)[number];

export interface PermissionRequestPayload {
	toolCall: ToolCallBlock;
	reason?: string;
	rememberRule?: string;
}

export interface PermissionScope {
	tool: string;
	argsPattern: string;
}

export interface CancelConfirmRequestPayload {
	action: string;
	consequence?: string;
}

export interface QuestionChoice {
	id: string;
	label: string;
	description?: string;
}

export interface QuestionRequestPayload {
	prompt: string;
	choices?: QuestionChoice[];
	allowFreeText?: boolean;
	multiple?: boolean;
}

export interface PlanApprovalRequestPayload {
	plan: string;
}

export interface OAuthRequestPayload {
	provider: string;
	authorizationUrl: string;
	instructions?: string;
}

export interface RequestPayloadByKind {
	permission: PermissionRequestPayload;
	cancel_confirm: CancelConfirmRequestPayload;
	question: QuestionRequestPayload;
	plan_approval: PlanApprovalRequestPayload;
	oauth: OAuthRequestPayload;
}

export type PermissionResponseResult =
	| { decision: "allow_once" }
	| { decision: "allow_always"; scope: PermissionScope }
	| { decision: "deny"; reason?: string };

export type CancelConfirmResponseResult = { decision: "cancel" } | { decision: "keep_running" };

export type QuestionResponseResult = { decision: "answer"; answers: string[] } | { decision: "cancel" };

export type PlanApprovalResponseResult = { decision: "approve" } | { decision: "reject"; feedback?: string };

export type OAuthResponseResult = { decision: "completed" } | { decision: "cancel" };

export interface ResponseResultByKind {
	permission: PermissionResponseResult;
	cancel_confirm: CancelConfirmResponseResult;
	question: QuestionResponseResult;
	plan_approval: PlanApprovalResponseResult;
	oauth: OAuthResponseResult;
}

export type RequestResponseResult = ResponseResultByKind[RequestKind];

/** The original transport envelope remains generic for protocol compatibility. */
export interface RequestEnvelope<TKind extends string = string, TPayload = unknown> {
	type: "request";
	id: string;
	kind: TKind;
	payload: TPayload;
}

export type RequestEnvelopeFor<TKind extends RequestKind> = TKind extends RequestKind
	? RequestEnvelope<TKind, RequestPayloadByKind[TKind]>
	: never;

export type RequestEnvelopeUnion = RequestEnvelopeFor<RequestKind>;

/** The response envelope keeps its original unconstrained result generic. */
export interface ResponseEnvelope<TResult = unknown> {
	type: "response";
	id: string;
	result: TResult;
}

export type ResponseEnvelopeFor<TKind extends RequestKind> = ResponseEnvelope<ResponseResultByKind[TKind]>;

export type RequestTerminalStatus = "response" | "cancelled" | "timeout";

export type RequestOutcome<TKind extends RequestKind> =
	| { status: "response"; requestId: string; result: ResponseResultByKind[TKind] }
	| { status: "cancelled"; requestId: string; reason: "aborted" | "bus_closed" | "cancelled" }
	| { status: "timeout"; requestId: string };

export function request<TKind extends RequestKind>(
	id: string,
	kind: TKind,
	payload: RequestPayloadByKind[TKind],
): RequestEnvelopeFor<TKind> {
	return { type: "request", id, kind, payload } as RequestEnvelopeFor<TKind>;
}

export function response<TResult>(id: string, result: TResult): ResponseEnvelope<TResult> {
	return { type: "response", id, result };
}
