import type { AgentInput, ContextUsageSnapshot, InputCompletionItem, InputCompletionSuggestions, RequestEnvelopeUnion, RequestKind, RequestOutcome, SessionEvent, SessionMessage, SessionTurn } from "@forge-agent/protocol";

export interface InteractionRequestBus {
	requests(): AsyncIterable<RequestEnvelopeUnion>;
	respond(response: unknown): boolean;
	terminals(): AsyncIterable<RequestOutcome<RequestKind>>;
	close(): void;
	getTerminal?(requestId: string): RequestOutcome<RequestKind> | undefined;
	isPending?(requestId: string): boolean;
}

export interface InteractionPort {
	mcp?: { subscribe(listener: (event: { type: string; serverId: string; state?: string; message?: string }) => void): () => void };
	compact?(instructions?: string, emit?: (event: SessionEvent) => void): Promise<unknown>;
	runTurn(input: AgentInput): SessionTurn;
	abort?(): void;
	getUsage?(): ContextUsageSnapshot | undefined;
}

export interface CompletionSource {
	getSuggestions(input: string, cursor: number, options?: { signal?: AbortSignal }): InputCompletionSuggestions | null | Promise<InputCompletionSuggestions | null>;
	applyCompletion(input: string, cursor: number, item: InputCompletionItem, prefix: string): { input: string; cursor: number };
}

export interface SessionBinding<P extends InteractionPort = InteractionPort> {
	readonly port: P;
	readonly requestBus: InteractionRequestBus;
	readonly sessionId?: string;
}
export interface SessionView<P extends InteractionPort = InteractionPort> {
	readonly id: string;
	readonly port: P;
	readonly requestBus: InteractionRequestBus;
	readonly history: readonly SessionMessage[];
	hasHistory(): boolean;
}
export interface SessionSummary { id: string; title: string; updatedAt: number; }
export interface SessionPreview { id: string; revision: string; messages: { role: "user" | "assistant"; text: string; truncated: boolean; stopReason?: string }[]; }
export interface InteractionHost<P extends InteractionPort = InteractionPort> {
	readonly current: SessionView<P>;
	list(): Promise<{ sessions: SessionSummary[]; diagnostics: string[] }>;
	preview?(id: string, cached?: SessionPreview): Promise<SessionPreview>;
	switchTo(id?: string, beforeRelease?: () => Promise<void>): Promise<SessionView<P>>;
	dispose(): Promise<void>;
}

export interface InteractionOptions<P extends InteractionPort = InteractionPort> {
	port: P;
	requestBus: InteractionRequestBus;
	sessions?: InteractionHost<P>;
	history?: readonly SessionMessage[];
	prepareInput?: (input: string) => AgentInput;
	mcpCommand?: (input: string, report: (text: string) => void, signal: AbortSignal, session: SessionBinding<P>) => Promise<void>;
	skillsCommand?: (input: string, report: (text: string) => void, signal: AbortSignal, session: SessionBinding<P>) => Promise<void>;
	memoryCommand?: (input: string, signal: AbortSignal, session: SessionBinding<P>) => Promise<{ text: string; prompt?: string }>;
	completionSource?: CompletionSource | undefined;
	createCompletionSource?: (session: SessionBinding<P>) => CompletionSource;
}

export type SubmitMode = "queue" | "replace";
export type InteractionPhase = "active" | "switching" | "closing" | "closed";
export interface InteractionSnapshot {
	readonly sessionId?: string;
	readonly hasHistory?: boolean;
	readonly canSwitch: boolean;
	readonly phase: InteractionPhase;
	readonly activity: "idle" | "working" | "stopping" | "compacting";
	readonly hasPendingInputs: boolean;
	readonly queuedCount: number;
	readonly inputLabels: readonly string[];
	readonly requests: readonly RequestEnvelopeUnion[];
	readonly usage?: ContextUsageSnapshot;
}

export type InteractionRead =
	| { kind: "suggestions"; input: string; cursor: number }
	| { kind: "sessions" }
	| { kind: "preview"; id: string; cached?: SessionPreview };
export type DataResult =
	| { kind: "suggestions"; status: "success"; value: InputCompletionSuggestions | null }
	| { kind: "sessions"; status: "success"; value: { sessions: SessionSummary[]; diagnostics: string[] } }
	| { kind: "preview"; status: "success"; id: string; value: SessionPreview }
	| { kind: InteractionRead["kind"]; status: "error" | "unavailable"; message: string };
export type InteractionEvent =
	| { type: "state_changed"; snapshot: InteractionSnapshot }
	| { type: "session_event"; event: SessionEvent }
	| { type: "notice"; text: string }
	| { type: "restore_inputs"; inputs: readonly string[] }
	| { type: "interaction_invalidated" | "interaction_ready" }
	| { type: "session_activated"; sessionId?: string; history: readonly SessionMessage[]; hasHistory?: boolean; previous?: { id: string; hasHistory: boolean } }
	| { type: "data_result"; result: DataResult }
	| { type: "request_added"; request: RequestEnvelopeUnion }
	| { type: "request_ended"; requestId: string; outcome?: RequestOutcome<RequestKind> }
	| { type: "view_command"; command: "clear" | "help" | "new" | "resume" | "quit" };
