import { BasicTracerProvider, BatchSpanProcessor, ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";
import { createAgent } from "../packages/core/src/sdk.ts";
import { scriptedResponses } from "./scripted-adapter.ts";

const provider = new BasicTracerProvider({ spanProcessors: [new BatchSpanProcessor(new ConsoleSpanExporter())] });
let agent;
try {
	agent = await createAgent({
		...scriptedResponses([{ text: "Observed through the official TanStack OTel middleware." }]),
		cwd: process.cwd(), systemPrompt: "Answer concisely.",
		otel: { tracer: provider.getTracer("forge-example") },
	});
	const turn = agent.runTurn("Hello");
	for await (const _event of turn) {}
	console.log(await turn.result);
} finally {
	try { await agent?.dispose(); }
	finally { await provider.shutdown(); }
}
