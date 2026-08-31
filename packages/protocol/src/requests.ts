export interface RequestEnvelope<TKind extends string = string, TPayload = unknown> {
	type: "request";
	id: string;
	kind: TKind;
	payload: TPayload;
}

export interface ResponseEnvelope<TResult = unknown> {
	type: "response";
	id: string;
	result: TResult;
}

export function request<TKind extends string, TPayload>(
	id: string,
	kind: TKind,
	payload: TPayload,
): RequestEnvelope<TKind, TPayload> {
	return { type: "request", id, kind, payload };
}

export function response<TResult>(id: string, result: TResult): ResponseEnvelope<TResult> {
	return { type: "response", id, result };
}
