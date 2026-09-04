import {
	block,
	type AnyBlockEnvelope,
	type DiffHunk,
	type RequestEnvelopeUnion,
	type SessionEvent,
	type SessionMessage,
	type RequestKind,
} from "@myh/protocol";
import { Container, stripTerminalSequences, truncateToWidth, visibleWidth, type Component, type Terminal } from "@earendil-works/pi-tui";
import {
	RequestCard,
	StreamRenderer,
	Composer,
	createSemanticTheme,
	createEditor,
	createTuiHost,
	frameFromLines,
	ScreenLayout,
	serializeTerminalFrame,
	sha256,
	shortcutRoutes,
	TranscriptScrollView,
	renderShortcutHints,
	HeaderBar,
	StatusLine,
	canvasStyle,
	type ScreenLayoutPlan,
	type TerminalFrame,
	type TuiHostMode,
	type StatusLineState,
} from "../src/index.ts";

export const CANONICAL_COLUMNS = [40, 60, 80, 120] as const;
export const CANONICAL_ROWS = [8, 12, 16, 20, 24, 40] as const;

export type CanonicalScenarioId =
	| "idle-empty"
	| "user-assistant-markdown"
	| "thinking-streaming"
	| "thinking-complete"
	| "thinking-folded"
	| "execute-running"
	| "execute-success"
	| "execute-failure"
	| "edit-single-hunk"
	| "edit-collapsed"
	| "edit-multi-hunk"
	| "status-composer"
	| "permission-focused"
	| "permission-parked"
	| "question-focused"
	| "question-parked"
	| "cancel-confirm-focused"
	| "cancel-confirm-parked"
	| "plan-approval-focused"
	| "plan-approval-parked"
	| "oauth-focused"
	| "oauth-parked"
	| "main-idle"
	| "alt-idle";

export type CardState = "focused" | "parked";

export interface CanonicalScenarioFixture {
	id: CanonicalScenarioId;
	label: string;
	events: readonly SessionEvent[];
	request?: RequestEnvelopeUnion;
	cardState?: CardState;
	header?: { cwd: string; homeDir?: string; usage?: { contextTokens: number; contextWindow?: number } };
	status?: StatusLineState;
	composerText?: string;
	toggleLatestAfterEvent?: number;
	host: TuiHostMode;
	requiredText: readonly string[];
	forbiddenText: readonly string[];
}

export interface CanonicalScenarioOptions {
	columns: number;
	rows: number;
	host?: TuiHostMode;
}

export interface CanonicalSemanticAssertions {
	requiredText: readonly string[];
	forbiddenText: readonly string[];
	owner: "composer" | "card";
	cardState?: CardState;
	maxLineWidth: number;
	layout: ScreenLayoutPlan;
}

export interface CanonicalScenarioRender {
	fixture: CanonicalScenarioFixture;
	fixtureJson: string;
	fixtureSha256: string;
	host: TuiHostMode;
	columns: number;
	rows: number;
	renderedLines: readonly string[];
	frame: TerminalFrame;
	hash: string;
	semantic: CanonicalSemanticAssertions;
}

const THEME = createSemanticTheme();
const FIXED_TIME = (): string => "12:00 PM";

/** Return fresh fixture copies so a test cannot mutate the canonical source. */
export function canonicalScenarios(): readonly CanonicalScenarioFixture[] {
	return SCENARIOS.map((scenario) => structuredClone(scenario));
}

export function getCanonicalScenario(id: CanonicalScenarioId): CanonicalScenarioFixture {
	const scenario = SCENARIOS.find((value) => value.id === id);
	if (!scenario) throw new Error(`unknown canonical scenario: ${id}`);
	return structuredClone(scenario);
}

/** Render one canonical fixture through the same entry, dock, and row-budget components used by the app. */
export function renderCanonicalScenario(id: CanonicalScenarioId | CanonicalScenarioFixture, options: CanonicalScenarioOptions): CanonicalScenarioRender {
	const fixture = typeof id === "string" ? getCanonicalScenario(id) : structuredClone(id);
	const columns = positiveDimension(options.columns, "columns");
	const rows = positiveDimension(options.rows, "rows");
	const host = options.host ?? fixture.host;

	const renderer = new StreamRenderer({ theme: THEME, formatTime: FIXED_TIME, compact: rows <= 20 });
	for (const [index, event] of fixture.events.entries()) {
		renderer.apply(event);
		if (fixture.toggleLatestAfterEvent === index) renderer.toggleLatestBlock();
	}

	const terminal = new CanonicalTerminal(columns, rows);
	const hostScreen = createTuiHost({ terminal, mode: host });
	const transcriptContent = new Container();
	transcriptContent.addChild(renderer);
	const transcript = new TranscriptScrollView(transcriptContent, { clipToViewport: true, entrySpans: (width) => renderer.getEntrySpans(width) });
	const card = fixture.request === undefined ? undefined : new RequestCard(fixture.request, THEME);
	if (card) {
		card.focused = fixture.cardState === "focused";
		if (fixture.cardState === "parked") card.park();
	}
	const editor = createEditor(hostScreen, () => undefined, { theme: THEME });
	const composer = new Composer(editor, THEME, {
		getInfo: () => ({ modelName: fixture.status?.model ?? "grok-3" }),
	});
	const composerText = fixture.composerText?.replace(/^[›❯]\s*/, "") ?? "";
	editor.setText(composerText);
	const interactiveComponent: Component = card ?? composer;
	const owner = fixture.request === undefined ? "composer" : "card";
	const shortcuts: Component = {
		render(width: number): string[] {
			const routes = shortcutRoutes({
				cardFocused: fixture.cardState === "focused",
				cardParked: fixture.cardState === "parked",
				...(fixture.request === undefined ? {} : { cardKind: fixture.request.kind }),
				editorFocused: fixture.request === undefined,
			});
			const line = renderShortcutHints(routes, Math.max(1, Math.floor(width)), THEME);
			return line ? [line] : [];
		},
		invalidate(): void {},
	};

	const header = fixture.header === undefined
		? undefined
		: new HeaderBar({ ...fixture.header, getUsage: () => fixture.header?.usage, theme: THEME });
	const status = fixture.status === undefined ? undefined : new StatusLine({ state: fixture.status, theme: THEME });
	const layout = new ScreenLayout({
		terminal,
		header: header ?? { render: () => [], invalidate(): void {} },
		transcript,
		interactive: interactiveComponent,
		interactiveOwner: () => owner,
		...(status === undefined ? {} : { status }),
		shortcuts,
		transcriptDesired: () => Math.max(1, renderer.render(columns).length),
		canvasStyle: (value: string) => canvasStyle(THEME, value),
	});
	if (host === "alt" && "setLayoutRoot" in hostScreen && typeof hostScreen.setLayoutRoot === "function") hostScreen.setLayoutRoot(layout);
	else hostScreen.addChild(layout);
	if (fixture.request === undefined) hostScreen.setFocus(composer);
	else if (fixture.cardState === "focused" && card) hostScreen.setFocus(card);
	else hostScreen.setFocus(null);
	const normalizedLines = fitRegion(hostScreen.render(columns), rows, columns);
	const plan = layout.plan;
	if (!plan) throw new Error(`${fixture.id} did not produce a screen layout plan`);
	const frame = frameFromLines(normalizedLines, columns, rows);
	const fixtureJson = stableFixtureJson(fixture);
	return {
		fixture,
		fixtureJson,
		fixtureSha256: sha256(fixtureJson),
		host,
		columns,
		rows,
		renderedLines: normalizedLines,
		frame,
		hash: sha256(serializeTerminalFrame(frame)),
		semantic: {
			requiredText: fixture.requiredText,
			forbiddenText: fixture.forbiddenText,
			owner: fixture.request === undefined ? "composer" : "card",
			...(fixture.cardState === undefined ? {} : { cardState: fixture.cardState }),
			maxLineWidth: columns,
			layout: plan,
		},
	};
}

export function assertCanonicalScenario(rendered: CanonicalScenarioRender): void {
	const plain = stripTerminalSequences(rendered.renderedLines.join("\n"));
	for (const text of rendered.semantic.requiredText) {
		if (!text.split(/\s+/).every((part) => plain.includes(part))) throw new Error(`${rendered.fixture.id} is missing required text: ${text}`);
	}
	for (const text of rendered.semantic.forbiddenText) {
		if (plain.includes(text)) throw new Error(`${rendered.fixture.id} contains forbidden text: ${text}`);
	}
	for (const line of rendered.renderedLines) {
		if (visibleWidth(stripTerminalSequences(line)) > rendered.semantic.maxLineWidth) throw new Error(`${rendered.fixture.id} exceeds viewport width`);
	}
	if (rendered.frame.cells.length !== rendered.rows || rendered.frame.cells.some((row) => row.length !== rendered.columns)) throw new Error(`${rendered.fixture.id} has an invalid frame size`);
	if (rendered.semantic.layout.totalHeight > rendered.rows) throw new Error(`${rendered.fixture.id} overflows its viewport`);
}

function fitRegion(lines: readonly string[], height: number, width: number): string[] {
	const safeHeight = Math.max(0, Math.floor(height));
	const safeWidth = Math.max(1, Math.floor(width));
	const fitted = lines.slice(0, safeHeight).map((line) => truncateToWidth(line, safeWidth, "", true));
	while (fitted.length < safeHeight) fitted.push(" ".repeat(safeWidth));
	return fitted;
}

/** Terminal adapter used for deterministic host renders; it never touches the process terminal. */
class CanonicalTerminal implements Terminal {
	kittyProtocolActive = false;

	constructor(public columns: number, public rows: number) {}

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

function positiveDimension(value: number, name: string): number {
	if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
	return value;
}

function stableFixtureJson(fixture: CanonicalScenarioFixture): string {
	return JSON.stringify(sortJsonValue(fixture));
}

function sortJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJsonValue);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sortJsonValue(child)]));
}

function message(role: SessionMessage["role"], content: SessionMessage["content"], timestamp: number): SessionMessage {
	return { role, content, timestamp };
}

function streamEvents(messageValue: SessionMessage, deltas: readonly Extract<SessionEvent, { type: "message_delta" }>[], endTimestamp = messageValue.timestamp + 1): SessionEvent[] {
	return [
		{ type: "message_start", timestamp: messageValue.timestamp, message: { ...messageValue, content: [] } },
		...deltas,
		{ type: "message_end", timestamp: endTimestamp, message: messageValue },
	];
}

function executeBlock(id: string, lifecycle: "streaming" | "complete" | "failed", data: { command: string; stdout?: string; stderr?: string; exitCode?: number; isError?: boolean }): AnyBlockEnvelope {
	return block({ id, kind: "execute", lifecycle, currentDisplayMode: "expanded" }, data, { defaultDisplayMode: "expanded", firstLines: 2, lastLines: 2 });
}

function editBlock(id: string, hunks: DiffHunk[], path = "src/demo.ts", currentDisplayMode: "expanded" | "collapsed" = "expanded"): AnyBlockEnvelope {
	return block({ id, kind: "edit", lifecycle: "complete", currentDisplayMode }, { path, language: "typescript", hunks, additions: hunks.reduce((sum, hunk) => sum + hunk.additions, 0), removals: hunks.reduce((sum, hunk) => sum + hunk.removals, 0) }, { defaultDisplayMode: currentDisplayMode });
}

function requestFor(kind: RequestKind, id: string): RequestEnvelopeUnion {
	switch (kind) {
		case "permission":
			return { type: "request", id, kind, payload: { toolCall: { type: "tool_call", id: `call-${id}`, name: "write", arguments: { path: "src/demo.ts", content: "value" } }, reason: "Update the demo file" } };
		case "question":
			return { type: "request", id, kind, payload: { prompt: "Choose an environment", choices: [{ id: "dev", label: "Development" }, { id: "prod", label: "Production" }] } };
		case "cancel_confirm":
			return { type: "request", id, kind, payload: { action: "cancel current turn", consequence: "The active turn will stop" } };
		case "plan_approval":
			return { type: "request", id, kind, payload: { plan: "1. Inspect the file\n2. Apply the patch" } };
		case "oauth":
			return { type: "request", id, kind, payload: { provider: "GitHub", authorizationUrl: "https://example.test/oauth", instructions: "Open the URL to continue" } };
	}
}

const USER = message("user", [{ type: "text", text: "Inspect the release notes" }], 1_000);
const ASSISTANT = message("assistant", [{ type: "text", text: "## Release notes\n\n- Tests pass" }], 2_000);
const THINKING = message("assistant", [{ type: "thinking", thinking: "Compare the current state with the requested layout" }, { type: "text", text: "The layout is ready." }], 2_000);

const SCENARIOS: readonly CanonicalScenarioFixture[] = [
	{ id: "idle-empty", label: "Idle empty transcript", events: [], composerText: "› ", host: "main", requiredText: ["❯"], forbiddenText: [] },
	{
		id: "user-assistant-markdown",
		label: "User and assistant markdown",
		events: [
			...streamEvents(USER, [], 1_001),
			...streamEvents(ASSISTANT, [{ type: "message_delta", timestamp: 2_001, contentIndex: 0, contentType: "text", delta: ASSISTANT.content[0]?.type === "text" ? ASSISTANT.content[0].text : "" }], 2_002),
		],
		host: "main",
		requiredText: ["Inspect the release notes", "Release notes", "Tests pass"],
		forbiddenText: ["thinking:", "v Run", "> Run"],
	},
	{
		id: "thinking-streaming",
		label: "Thinking streaming",
		events: [
			{ type: "message_start", timestamp: 3_000, message: { role: "assistant", content: [], timestamp: 3_000 } },
			{ type: "message_delta", timestamp: 3_001, contentIndex: 0, contentType: "thinking", delta: "Compare the current state" },
		],
		host: "main",
		requiredText: ["Thinking"],
		forbiddenText: ["thinking:", "v Run", "> Run"],
	},
	{
		id: "thinking-complete",
		label: "Thinking complete",
		events: streamEvents(THINKING, [
			{ type: "message_delta", timestamp: 2_001, contentIndex: 0, contentType: "thinking", delta: "Compare the current state with the requested layout" },
			{ type: "message_delta", timestamp: 2_002, contentIndex: 1, contentType: "text", delta: "The layout is ready." },
		], 2_700),
		host: "main",
		requiredText: ["Thought for", "The layout is ready"],
		forbiddenText: ["thinking:", "v Run", "> Run"],
	},
	{
		id: "thinking-folded",
		label: "Thinking manually folded",
		events: streamEvents(THINKING, [{ type: "message_delta", timestamp: 2_001, contentIndex: 0, contentType: "thinking", delta: THINKING.content[0]?.type === "thinking" ? THINKING.content[0].thinking : "" }], 2_700),
		toggleLatestAfterEvent: 1,
		host: "main",
		requiredText: ["Thought"],
		forbiddenText: ["Compare the current state with the requested layout", "v Run", "> Run"],
	},
	{
		id: "execute-running",
		label: "Execute running",
		events: [{ type: "tool_execution_start", timestamp: 4_000, toolCallId: "exec-running", toolName: "bun test", args: { command: "bun test" }, block: executeBlock("exec-running", "streaming", { command: "bun test", stdout: "running" }) }],
		host: "main",
		requiredText: ["bun test", "running"],
		forbiddenText: ["v Run", "> Run", "stderr:", "exit: 0"],
	},
	{
		id: "execute-success",
		label: "Execute success",
		events: [{ type: "tool_execution_end", timestamp: 4_100, toolCallId: "exec-success", toolName: "bun test", content: "185 tests passed", isError: false, block: executeBlock("exec-success", "complete", { command: "bun test", stdout: "185 tests passed", exitCode: 0 }) }],
		host: "main",
		requiredText: ["bun test", "185 tests passed"],
		forbiddenText: ["v Run", "> Run", "stderr:", "exit: 0"],
	},
	{
		id: "execute-failure",
		label: "Execute failure",
		events: [{ type: "tool_execution_end", timestamp: 4_100, toolCallId: "exec-failure", toolName: "bun test", content: "1 test failed", isError: true, block: executeBlock("exec-failure", "failed", { command: "bun test", stderr: "1 test failed", exitCode: 1, isError: true }) }],
		host: "main",
		requiredText: ["bun test", "1 test failed"],
		forbiddenText: ["v Run", "> Run", "stderr:", "exit: 0"],
	},
	{
		id: "edit-single-hunk",
		label: "Edit single hunk",
		events: [{ type: "tool_execution_end", timestamp: 5_000, toolCallId: "edit-single", toolName: "edit", content: "updated", isError: false, block: editBlock("edit-single", [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, additions: 1, removals: 1, lines: [{ type: "remove", content: "old", oldLine: 1 }, { type: "add", content: "new", newLine: 1 }] }]) }],
		host: "main",
		requiredText: ["demo.ts", "old", "new"],
		forbiddenText: ["+1/-1", "@@", "\n+", "\n-", "v Run", "> Run"],
	},
	{
		id: "edit-collapsed",
		label: "Edit collapsed",
		events: [{ type: "tool_execution_end", timestamp: 5_000, toolCallId: "edit-collapsed", toolName: "edit", content: "updated", isError: false, block: editBlock("edit-collapsed", [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, additions: 1, removals: 1, lines: [{ type: "remove", content: "old", oldLine: 1 }, { type: "add", content: "new", newLine: 1 }] }], "src/deep/demo.ts", "collapsed") }],
		host: "main",
		requiredText: ["demo.ts", "+1/-1"],
		forbiddenText: ["src/deep/demo.ts", "old", "new", "@@", "v Run", "> Run"],
	},
	{
		id: "edit-multi-hunk",
		label: "Edit multi hunk",
		events: [{ type: "tool_execution_end", timestamp: 5_000, toolCallId: "edit-multi", toolName: "edit", content: "updated", isError: false, block: editBlock("edit-multi", [
			{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, additions: 1, removals: 1, lines: [{ type: "context", content: "const a = 1", oldLine: 1, newLine: 1 }, { type: "remove", content: "const b = 1", oldLine: 2 }, { type: "add", content: "const b = 2", newLine: 2 }] },
			{ oldStart: 10, oldLines: 1, newStart: 10, newLines: 2, additions: 2, removals: 1, lines: [{ type: "remove", content: "return false", oldLine: 10 }, { type: "add", content: "return true", newLine: 10 }, { type: "add", content: "// verified", newLine: 11 }] },
		]) }],
		host: "main",
		requiredText: ["demo.ts", "const b = 2", "return true"],
		forbiddenText: ["+3/-2", "@@", "\n+", "\n-", "v Run", "> Run"],
	},
	{
		id: "status-composer",
		label: "Status and composer",
		events: [],
		header: { cwd: "/home/demo/project", homeDir: "/home/demo", usage: { contextTokens: 12_000, contextWindow: 32_000 } },
		status: { provider: "xai", model: "grok", costUsd: 0.012, turn: 2 },
		composerText: "› draft response",
		host: "main",
		requiredText: ["~/project", "draft response", "xai/grok", "$0.012"],
		forbiddenText: [],
	},
	...cardScenarios("permission", requestFor("permission", "permission")),
	...cardScenarios("question", requestFor("question", "question")),
	...cardScenarios("cancel_confirm", requestFor("cancel_confirm", "cancel")),
	...cardScenarios("plan_approval", requestFor("plan_approval", "plan")),
	...cardScenarios("oauth", requestFor("oauth", "oauth")),
	{ id: "main-idle", label: "Main host idle", events: [], composerText: "› ", host: "main", requiredText: ["❯"], forbiddenText: [] },
	{ id: "alt-idle", label: "Alt host idle", events: [], composerText: "› ", host: "alt", requiredText: ["❯"], forbiddenText: [] },
];

function cardScenarios(kind: RequestKind, request: RequestEnvelopeUnion): CanonicalScenarioFixture[] {
	const label = kind === "cancel_confirm" ? "cancel turn" : kind === "plan_approval" ? "plan approval" : kind;
	const slug = kind === "cancel_confirm" ? "cancel-confirm" : kind === "plan_approval" ? "plan-approval" : kind;
	const bodyText = kind === "permission" ? "Permission: write" : kind === "question" ? "Choose an environment" : kind === "cancel_confirm" ? "Cancel: cancel current turn" : kind === "plan_approval" ? "Plan approval" : "OAuth: GitHub";
	const required = [bodyText, "1 "];
	return [
		{ id: `${slug}-focused` as CanonicalScenarioId, label: `${label} focused`, events: [], request, cardState: "focused", host: "main", requiredText: required, forbiddenText: [] },
		{ id: `${slug}-parked` as CanonicalScenarioId, label: `${label} parked`, events: [], request, cardState: "parked", host: "main", requiredText: [bodyText], forbiddenText: [] },
	];
}
