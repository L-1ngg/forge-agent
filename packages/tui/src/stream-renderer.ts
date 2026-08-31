import type { SessionEvent, SessionMessage } from "@myh/protocol";
import { Container, type Component, Text } from "@earendil-works/pi-tui";

interface ContentBlock {
	kind: "text" | "thinking" | "tool_call";
	text: string;
}

function messageText(message: SessionMessage): string {
	return message.content
		.map((block) => {
			if (block.type === "text") return block.text;
			if (block.type === "thinking") return block.thinking;
			return `${block.name}(${JSON.stringify(block.arguments)})`;
		})
		.join("\n");
}

export class StreamRenderer extends Container {
	private readonly blocks = new Map<number, ContentBlock>();
	private readonly messages: SessionMessage[] = [];
	private readonly events: SessionEvent[] = [];

	apply(event: SessionEvent): void {
		this.events.push(event);
		if (event.type === "message_start") {
			if (event.message.role === "assistant") this.blocks.clear();
			this.messages.push(event.message);
			this.syncChildren();
			return;
		}
		if (event.type === "message_end") {
			if (event.message.role !== "user") {
				const current = this.messages.at(-1);
				if (current?.role === event.message.role) this.messages[this.messages.length - 1] = event.message;
				else this.messages.push(event.message);
			}
			if (event.message.role === "assistant") this.blocks.clear();
			this.syncChildren();
			return;
		}
		if (event.type === "message_delta") {
			const current = this.blocks.get(event.contentIndex) ?? { kind: event.contentType, text: "" };
			current.text += event.delta;
			this.blocks.set(event.contentIndex, current);
			this.syncChildren();
			return;
		}
		if (event.type === "tool_execution_end") {
			this.syncChildren();
		}
	}

	getEvents(): SessionEvent[] {
		return structuredClone(this.events);
	}

	getOrderedBlocks(): readonly ContentBlock[] {
		return [...this.blocks.entries()].sort(([left], [right]) => left - right).map(([, block]) => ({ ...block }));
	}

	private syncChildren(): void {
		this.clear();
		for (const message of this.messages) this.addChild(new Text(messageText(message), 1, 0));
		for (const block of this.getOrderedBlocks()) {
			const prefix = block.kind === "thinking" ? "thinking: " : block.kind === "tool_call" ? "tool: " : "";
			this.addChild(new Text(`${prefix}${block.text}`, 1, 0));
		}
	}
}

export class RendererComponent implements Component {
	constructor(private readonly renderer: StreamRenderer) {}

	render(width: number): string[] {
		return this.renderer.render(width);
	}

	invalidate(): void {
		this.renderer.invalidate();
	}
}
