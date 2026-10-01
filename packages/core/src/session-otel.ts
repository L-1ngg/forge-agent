import type { ChatMiddleware, ChatMiddlewareContext } from "@tanstack/ai";
import { otelMiddleware, type OtelMiddlewareOptions, type OtelSpanInfo } from "@tanstack/ai/middlewares/otel";

export function sessionOtelOptions(options: OtelMiddlewareOptions, kind: "task" | "summary" | "memory"): OtelMiddlewareOptions {
	return {
		...options,
		attributeEnricher: info => {
			if (info.kind === "generation") return options.attributeEnricher?.(info) ?? {};
			return {
				"forge.session.id": info.ctx.threadId,
				"tanstack.ai.run.id": info.ctx.runId,
				...(info.ctx.parentRunId ? { "tanstack.ai.parent_run.id": info.ctx.parentRunId } : {}),
				"forge.request.kind": kind,
				...options.attributeEnricher?.(info),
			};
		},
	};
}

interface ResponseMetadata { provider: string; model: string; revision: number; }
interface RunView { ctx: ChatMiddlewareContext; root: ResponseMetadata; iteration: ResponseMetadata; started: number; interrupted: boolean; }

function snapshotSpanInfo(info: OtelSpanInfo, identity: Pick<ResponseMetadata, "provider" | "model"> = info.ctx): OtelSpanInfo {
	if (info.kind === "generation") return info;
	const ctx: ChatMiddlewareContext = Object.create(info.ctx);
	ctx.provider = identity.provider; ctx.model = identity.model;
	return { ...info, ctx };
}

/** Only task runs need dynamic router identity and the TanStack 0.61 interrupt fix. */
export function sessionOtel(options: OtelMiddlewareOptions, response: () => ResponseMetadata): ChatMiddleware {
	const runs = new WeakMap<ChatMiddlewareContext, RunView>();
	function run(ctx: ChatMiddlewareContext): RunView {
		let value = runs.get(ctx);
		if (!value) {
			const metadata = { ...response() };
			const view: ChatMiddlewareContext = Object.create(ctx);
			view.provider = metadata.provider; view.model = metadata.model;
			value = { ctx: view, root: metadata, iteration: metadata, started: Date.now(), interrupted: false };
			runs.set(ctx, value); runs.set(view, value);
		}
		return value;
	}
	const common = sessionOtelOptions(options, "task");
	const { spanNameFormatter } = options;
	const native = otelMiddleware({
		...common,
		...(spanNameFormatter ? { spanNameFormatter: (info: OtelSpanInfo) => spanNameFormatter(snapshotSpanInfo(info)) } : {}),
		onBeforeSpanStart: (info, spanOptions) => {
			if (info.kind === "generation") return options.onBeforeSpanStart?.(info, spanOptions) ?? spanOptions;
			const state = run(info.ctx);
			// Native onConfig closes the previous span before starting the next one.
			if (info.kind === "iteration") state.iteration = { ...response() };
			return options.onBeforeSpanStart?.(snapshotSpanInfo(info, info.kind === "chat" ? state.root : state.iteration), spanOptions) ?? spanOptions;
		},
		attributeEnricher: info => {
			if (info.kind === "generation") return common.attributeEnricher?.(info) ?? {};
			const state = run(info.ctx);
			const metadata = info.kind === "chat" ? state.root : state.iteration;
			return { "forge.configuration.revision": metadata.revision, ...common.attributeEnricher?.(snapshotSpanInfo(info, metadata)) };
		},
		onSpanEnd: (info, span) => {
			if (info.kind === "generation") return options.onSpanEnd?.(info, span);
			const state = run(info.ctx);
			if (info.kind === "chat" && state.interrupted) span.setAttribute("tanstack.ai.outcome.type", "interrupt");
			options.onSpanEnd?.(snapshotSpanInfo(info, info.kind === "chat" ? state.root : state.iteration), span);
		},
	});
	return {
		name: "otel",
		onStart: ctx => { const state = run(ctx); state.started = Date.now(); return native.onStart?.(state.ctx); },
		onConfig: (ctx, config) => {
			const state = run(ctx);
			if (ctx.phase === "beforeModel" || ctx.phase === "structuredOutput") {
				const metadata = response();
				state.ctx.provider = metadata.provider; state.ctx.model = metadata.model;
			}
			return native.onConfig?.(state.ctx, { ...config, messages: config.providerMessages ?? config.messages });
		},
		onChunk: async (ctx, chunk) => {
			const state = run(ctx);
			await native.onChunk?.(state.ctx, chunk);
			// TanStack 0.61 skips terminal hooks for approval waits; this run has ended.
			if (chunk.type === "RUN_FINISHED" && chunk.outcome?.type === "interrupt") {
				state.interrupted = true;
				await native.onFinish?.(state.ctx, { finishReason: null, duration: Date.now() - state.started, content: "" });
			}
		},
		onUsage: (ctx, usage) => native.onUsage?.(run(ctx).ctx, usage),
		onBeforeToolCall: (ctx, call) => native.onBeforeToolCall?.(run(ctx).ctx, call),
		onAfterToolCall: (ctx, info) => native.onAfterToolCall?.(run(ctx).ctx, info),
		onError: (ctx, info) => native.onError?.(run(ctx).ctx, info),
		onAbort: (ctx, info) => native.onAbort?.(run(ctx).ctx, info),
		onFinish: (ctx, info) => native.onFinish?.(run(ctx).ctx, info),
	};
}
