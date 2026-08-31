import type { SessionEntry } from "./session-store.ts";
import { readFile } from "node:fs/promises";

export class SessionSearch {
	constructor(private readonly path: string) {}

	async search(query: string): Promise<string[]> {
		const normalized = query.trim().toLocaleLowerCase();
		if (!normalized) return [];
		return (await this.entries())
			.filter((entry) => JSON.stringify(entry.message).toLocaleLowerCase().includes(normalized))
			.map((entry) => entry.id);
	}

	async readEntry(id: string): Promise<SessionEntry | undefined> {
		return (await this.entries()).find((entry) => entry.id === id);
	}

	private async entries(): Promise<SessionEntry[]> {
		return (await readFile(this.path, "utf8"))
			.split("\n")
			.slice(1)
			.filter(Boolean)
			.map((line) => JSON.parse(line) as SessionEntry);
	}
}
