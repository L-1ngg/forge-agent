import type { HostInput, HostOutput } from "../../packages/tui/src/host.ts";

/** Host doubles only: production presentation and interaction still run. */
export class TestInput implements HostInput {
	raw: boolean | undefined;
	private readonly listeners = new Set<(chunk: Buffer) => void>();
	setRawMode(raw: boolean): void { this.raw = raw; }
	resume(): void {}
	pause(): void {}
	on(_event: "data", listener: (chunk: Buffer) => void): void { this.listeners.add(listener); }
	off(_event: "data", listener: (chunk: Buffer) => void): void { this.listeners.delete(listener); }
	emit(chunk: Buffer): void { for (const listener of [...this.listeners]) listener(chunk); }
	send(text: string): void { this.emit(Buffer.from(text)); }
}

export class TestOutput implements HostOutput {
	readonly chunks: string[] = [];
	constructor(public columns = 80, public rows = 24) {}
	write(text: string): void { this.chunks.push(text); }
	get text(): string { return this.chunks.join(""); }
	count(needle: string): number { return this.chunks.filter(chunk => chunk.includes(needle)).length; }
}
