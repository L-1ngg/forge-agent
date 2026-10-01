import type { OtelMiddlewareOptions } from "@forge-agent/core/sdk";

export async function startTelemetry(): Promise<{ otel: OtelMiddlewareOptions; shutdown(): Promise<void> } | undefined> {
	if (process.env.OTEL_SDK_DISABLED === "true" || !(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT)) return;
	const [{ BasicTracerProvider, BatchSpanProcessor }, { OTLPTraceExporter }, { defaultResource, resourceFromAttributes, detectResources, envDetector }] = await Promise.all([
		import("@opentelemetry/sdk-trace-base"),
		import("@opentelemetry/exporter-trace-otlp-http"),
		import("@opentelemetry/resources"),
	]);
	const provider = new BasicTracerProvider({
		resource: defaultResource().merge(resourceFromAttributes({ "service.name": "forge-agent" })).merge(detectResources({ detectors: [envDetector] })),
		spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
	});
	return {
		otel: { tracer: provider.getTracer("forge-agent"), captureContent: process.env.FORGE_OTEL_CAPTURE_CONTENT === "true" },
		async shutdown() {
			try { await provider.shutdown(); }
			catch (error) { console.error("OTel export shutdown failed:", error instanceof Error ? error.message : String(error)); }
		},
	};
}
