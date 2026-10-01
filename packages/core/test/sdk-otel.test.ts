import { expect, spyOn, test } from "bun:test";
import { SpanStatusCode } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { AggregationTemporality, DataPointType, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { response } from "@forge-agent/protocol";
import { LongTermMemory, MemorySessionStorage } from "@forge-agent/core/sdk";
import type { AgentTurn, HarnessTool, Model, OtelMiddlewareOptions, OtelSpanInfo } from "@forge-agent/core/sdk";
import { replyAdapter, isMemoryOrganizerRequest, systemText } from "../../../tests/fixtures/native-reply.ts";
import { SUMMARY_SYSTEM } from "../src/context/compaction.ts";
import { join } from "node:path";
import { withScenario, type Scenario, bounded } from "../../../tests/support/scenario.ts";

const model: Model = { id: "otel-model", provider: "otel-provider", name: "OTel fixture", api: "faux", baseUrl: "", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const usage = { promptTokens: 11, completionTokens: 7, totalTokens: 18 };
const work = { name: "work", label: "Work", description: "Record", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } } satisfies Omit<HarnessTool<object, unknown>, "execute">;

function telemetry(s: Scenario) {
	const exporter = new InMemorySpanExporter();
	const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
	s.defer(() => provider.shutdown());
	return { exporter, provider, otel: { tracer: provider.getTracer("forge-test") } };
}
async function consume(turn: AgentTurn) { for await (const _event of turn) {} return turn.result; }

test("OTel exports native run/model/tool spans and metrics through an approval continuation", () => withScenario("otel-approval", async s => {
	const { exporter, otel } = telemetry(s);
	const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
	const meterProvider = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 60000 })] });
	s.defer(() => meterProvider.shutdown());
	let calls = 0, effects = 0;
	const agent = await s.agent({ model, sessionId: "otel-session", otel: { ...otel, meter: meterProvider.getMeter("forge-test") },
		adapter: replyAdapter(model, () => ++calls === 1 ? { toolCalls: [{ id: "call-1", name: "work", arguments: { value: "private-args" } }], usage } : { text: "private-answer", usage }),
		tools: [{ ...work, async execute() { effects++; return { content: [{ type: "text" as const, text: "private-result" }], details: {} }; } }],
	});
	const turn = agent.runTurn("private-prompt");
	const running = consume(turn);
	const next = await bounded(agent.requests[Symbol.asyncIterator]().next(), "otel permission");
	if (next.done || next.value.kind !== "permission") throw new Error("Expected permission request");
	expect(effects).toBe(0);
	agent.respond(response(next.value.id, { decision: "allow_once" }));
	expect(await running).toEqual({ status: "success" });
	expect(effects).toBe(1); expect(calls).toBe(2);
	const spans = exporter.getFinishedSpans();
	const roots = spans.filter(span => !span.parentSpanContext);
	const iterations = spans.filter(span => span.attributes["gen_ai.operation.name"] === "chat");
	const tools = spans.filter(span => span.attributes["gen_ai.tool.name"] === "work");
	expect(roots).toHaveLength(2); expect(iterations).toHaveLength(2); expect(tools).toHaveLength(1);
	const first = roots.find(span => !span.attributes["tanstack.ai.parent_run.id"])!;
	const resumed = roots.find(span => span.attributes["tanstack.ai.parent_run.id"])!;
	expect(first.attributes["tanstack.ai.outcome.type"]).toBe("interrupt");
	expect(resumed.attributes["tanstack.ai.parent_run.id"]).toBe(first.attributes["tanstack.ai.run.id"]);
	expect(tools[0]?.parentSpanContext?.spanId).toBe(resumed.spanContext().spanId);
	for (const span of iterations) {
		expect(roots.some(root => root.spanContext().spanId === span.parentSpanContext?.spanId)).toBe(true);
		expect(span.attributes).toMatchObject({ "gen_ai.system": model.provider, "gen_ai.request.model": model.id, "gen_ai.usage.input_tokens": 11, "gen_ai.usage.output_tokens": 7, "forge.session.id": "otel-session" });
	}
	expect(JSON.stringify(spans.map(span => ({ attrs: span.attributes, events: span.events })))).not.toContain("private-");
	await meterProvider.forceFlush();
	const metrics = metricExporter.getMetrics().flatMap(resource => resource.scopeMetrics.flatMap(scope => scope.metrics));
	const tokens = metrics.find(metric => metric.descriptor.name === "gen_ai.client.token.usage");
	if (tokens?.dataPointType !== DataPointType.HISTOGRAM) throw new Error("Expected token histogram");
	expect(tokens.dataPoints.find(point => point.attributes["gen_ai.token.type"] === "input")?.value.sum).toBe(22);
	expect(tokens.dataPoints.find(point => point.attributes["gen_ai.token.type"] === "output")?.value.sum).toBe(14);
	expect(tokens.dataPoints.every(point => point.attributes["gen_ai.system"] === model.provider)).toBe(true);
	expect(metrics.some(metric => metric.descriptor.name === "gen_ai.client.operation.duration")).toBe(true);
}));

test("OTel content capture uses the final provider projection, redaction and snapshotted options", () => withScenario("otel-content", async s => {
	const { exporter, otel } = telemetry(s);
	const options: OtelMiddlewareOptions = { ...otel, captureContent: true, redact: text => text.replaceAll("SECRET", "REDACTED"), attributeEnricher: () => ({ "host.tag": "custom" }) };
	const agent = await s.agent({ model, otel: options, transformContext: () => [{ role: "user", timestamp: 0, content: [{ type: "text", text: "projected SECRET" }] }],
		adapter: replyAdapter(model, request => { expect(JSON.stringify(request.messages)).toContain("projected SECRET"); return { text: "answer SECRET" }; }),
	});
	options.captureContent = false;
	expect(await consume(agent.runTurn("original SECRET"))).toEqual({ status: "success" });
	const iteration = exporter.getFinishedSpans().find(span => span.attributes["gen_ai.operation.name"] === "chat")!;
	expect(iteration.attributes["gen_ai.input.messages"]).toContain("projected REDACTED");
	expect(iteration.attributes["gen_ai.input.messages"]).not.toContain("original");
	expect(iteration.attributes["gen_ai.output.messages"]).toContain("answer REDACTED");
	expect(iteration.attributes["host.tag"]).toBe("custom");
	expect(JSON.stringify(iteration.attributes)).not.toContain("SECRET");
}));

test("OTel follows applied provider/model configuration across native tool continuation", () => withScenario("otel-configuration", async s => {
	const { exporter, otel } = telemetry(s);
	const entered = s.gate("model"), release = s.gate("release");
	const nextModel = { ...model, id: "next-model", provider: "next-provider" };
	let effects = 0;
	const agent = await s.agent({ model, otel, adapter: replyAdapter(model, async () => { entered.release(); await release.wait(); return { toolCalls: [{ id: "call", name: "work", arguments: { value: "x" } }] }; }),
		tools: [{ ...work, async execute() { effects++; return { content: [], details: {} }; } }], permission: { rules: [{ tool: "*", argsPattern: "*", effect: "allow" }] },
	});
	const running = consume(agent.runTurn("switch model"));
	await entered.wait();
	const receipt = await agent.updateConfiguration({ model: nextModel, adapter: replyAdapter(nextModel, () => ({ text: "done", usage })) });
	release.release();
	expect(await running).toEqual({ status: "success" }); expect(effects).toBe(1);
	expect((await receipt.applied).status).toBe("applied");
	const iterations = exporter.getFinishedSpans().filter(span => span.attributes["gen_ai.operation.name"] === "chat");
	expect(iterations.map(span => [span.attributes["gen_ai.system"], span.attributes["gen_ai.request.model"], span.attributes["forge.configuration.revision"]])).toEqual([[model.provider, model.id, 0], [nextModel.provider, nextModel.id, receipt.revision]]);
	// @ts-expect-error Observability resources are creation-only, including JavaScript callers.
	await expect(agent.updateConfiguration({ otel })).rejects.toThrow("configured at creation");
}));

test("OTel callbacks retain each span's model identity when configuration changes within one native run", () => withScenario("otel-callback-configuration", async s => {
	const { exporter, otel } = telemetry(s);
	const entered = s.gate("model"), release = s.gate("release");
	const nextModel = { ...model, id: "next-model", provider: "next-provider" };
	const starts: Array<{ info: OtelSpanInfo; model: string; provider: string }> = [];
	const remember = (info: OtelSpanInfo) => { starts.push({ info, model: info.ctx.model, provider: info.ctx.provider }); };
	let effects = 0;
	const agent = await s.agent({ model, otel: {
		...otel,
		spanNameFormatter: info => { remember(info); return `${info.kind} ${info.ctx.model}`; },
		onBeforeSpanStart: (info, options) => { remember(info); return options; },
		attributeEnricher: info => { remember(info); return {}; },
		onSpanEnd: (info, span) => { span.setAttributes({ "host.callback.model": info.ctx.model, "host.callback.provider": info.ctx.provider }); },
	}, adapter: replyAdapter(model, async () => {
		entered.release(); await release.wait();
		// Native schema errors continue the same run without an approval interrupt.
		return { toolCalls: [{ id: "invalid", name: "work", arguments: {} }] };
	}), tools: [{ ...work, async execute() { effects++; return { content: [], details: {} }; } }] });
	const running = consume(agent.runTurn("switch model after a rejected tool input"));
	await entered.wait();
	const receipt = await agent.updateConfiguration({ model: nextModel, adapter: replyAdapter(nextModel, () => ({ text: "done", usage })) });
	release.release();
	expect(await running).toEqual({ status: "success" }); expect(effects).toBe(0);
	expect((await receipt.applied).status).toBe("applied");
	const spans = exporter.getFinishedSpans();
	expect(spans.filter(span => !span.parentSpanContext)).toHaveLength(1);
	const iterations = spans.filter(span => span.attributes["gen_ai.operation.name"] === "chat");
	expect(iterations.map(span => [span.attributes["gen_ai.request.model"], span.attributes["forge.configuration.revision"]])).toEqual([[model.id, 0], [nextModel.id, receipt.revision]]);
	for (const span of spans) {
		expect(span.attributes["host.callback.model"]).toBe(span.attributes["gen_ai.request.model"]);
		expect(span.attributes["host.callback.provider"]).toBe(span.attributes["gen_ai.system"]);
	}
	expect(starts).toHaveLength(9);
	for (const start of starts) {
		expect(start.info.ctx.model).toBe(start.model);
		expect(start.info.ctx.provider).toBe(start.provider);
	}
}));

test("OTel ends error spans when the provider fails", () => withScenario("otel-error", async s => {
	const { exporter, otel } = telemetry(s);
	const agent = await s.agent({ model, otel, adapter: replyAdapter(model, () => { throw new Error("provider unavailable"); }) });
	expect((await consume(agent.runTurn("fail"))).status).toBe("error");
	const spans = exporter.getFinishedSpans(); expect(spans).toHaveLength(2);
	expect(spans.every(span => span.status.code === SpanStatusCode.ERROR && span.ended)).toBe(true);
	expect(spans.some(span => span.events.some(event => event.name === "exception"))).toBe(true);
}));

test("OTel ends spans when the task is canceled", () => withScenario("otel-abort", async s => {
	const { exporter, otel } = telemetry(s);
	const entered = s.gate("provider"), release = s.gate("release");
	const agent = await s.agent({ model, otel, adapter: replyAdapter(model, async request => { entered.release(); await release.wait(); request.request?.signal?.throwIfAborted(); return { text: "late" }; }) });
	const running = consume(agent.runTurn("cancel"));
	await entered.wait(); agent.abort(); release.release();
	expect((await running).status).toBe("aborted");
	const spans = exporter.getFinishedSpans(); expect(spans).toHaveLength(2);
	expect(spans.every(span => span.ended && span.status.code === SpanStatusCode.ERROR)).toBe(true);
}));

test("OTel callback failures do not change the task result", () => withScenario("otel-callbacks", async s => {
	const { exporter, otel } = telemetry(s);
	const warning = spyOn(console, "warn").mockImplementation(() => {});
	try {
		const fail = () => { throw new Error("observer failure"); };
		const agent = await s.agent({ model, otel: { ...otel, attributeEnricher: fail, onBeforeSpanStart: fail, onSpanEnd: fail }, adapter: replyAdapter(model, () => ({ text: "done" })) });
		expect(await consume(agent.runTurn("observe"))).toEqual({ status: "success" });
		expect(exporter.getFinishedSpans()).toHaveLength(2); expect(warning).toHaveBeenCalled();
	} finally { warning.mockRestore(); }
}));

test("OTel resources remain host-owned and shared tracers isolate session state", () => withScenario("otel-ownership", async s => {
	const { exporter, provider, otel } = telemetry(s);
	const agents = await Promise.all(["one", "two"].map(sessionId => s.agent({ model, sessionId, otel, adapter: replyAdapter(model, () => ({ text: sessionId })) })));
	expect(await Promise.all(agents.map(agent => consume(agent.runTurn("go"))))).toEqual([{ status: "success" }, { status: "success" }]);
	expect(exporter.getFinishedSpans().map(span => span.attributes["forge.session.id"]).sort()).toEqual(["one", "one", "two", "two"]);
	await Promise.all(agents.map(agent => agent.dispose()));
	provider.getTracer("host").startSpan("host after disposal").end();
	expect(exporter.getFinishedSpans().at(-1)?.name).toBe("host after disposal");
}));

test("OTel traces compaction summaries and deferred memory with their actual request kind", () => withScenario("otel-auxiliary", async s => {
	const { exporter, otel } = telemetry(s);
	const storage = new MemorySessionStorage([
		{ role: "user", timestamp: 1, content: [{ type: "text", text: "old goal" }] },
		{ role: "assistant", timestamp: 2, stopReason: "stop", content: [{ type: "text", text: "old work ".repeat(1000) }] },
		{ role: "user", timestamp: 3, content: [{ type: "text", text: "recent goal" }] },
	]);
	const agent = await s.agent({ model, otel, storage, sessionId: "auxiliary-session", context: { enabled: false, keepRecentTokens: 1 },
		memory: { store: new LongTermMemory({ project: join(s.directory, "memory") }) },
		adapter: replyAdapter(model, request => ({ text: systemText(request) === SUMMARY_SYSTEM ? JSON.stringify({ states: [], claims: [], taskChanged: false }) : isMemoryOrganizerRequest(request) ? JSON.stringify({ updates: [], indexes: [] }) : "done", usage })),
	});
	expect((await agent.compact()).status).toBe("complete");
	expect(await consume(agent.runTurn("finish"))).toEqual({ status: "success" });
	const roots = exporter.getFinishedSpans().filter(span => !span.parentSpanContext);
	expect(roots.map(span => span.attributes["forge.request.kind"]).sort()).toEqual(["memory", "summary", "task"]);
	expect(roots.every(span => span.attributes["forge.session.id"] === "auxiliary-session")).toBe(true);
	for (const span of roots.filter(span => span.attributes["forge.request.kind"] !== "task")) expect(span.attributes["forge.configuration.revision"]).toBeUndefined();
}));
