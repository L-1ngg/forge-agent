import { SessionStore, type SessionEntry } from "./session-store.ts";

export class SessionSearch {
	constructor(private readonly path: string) {}

	async search(query: string): Promise<string[]> {
		const normalized = query.trim().toLocaleLowerCase();
		if (!normalized) return [];
		return (await this.entries())
			.filter((entry) => JSON.stringify(entry.type === "message" ? entry.message : entry.summary).toLocaleLowerCase().includes(normalized))
			.map((entry) => entry.id);
	}

	async readEntry(id: string): Promise<SessionEntry | undefined> {
		return (await this.entries()).find((entry) => entry.id === id);
	}

	private async entries(): Promise<SessionEntry[]> {
		return (await SessionStore.open(this.path, process.cwd(), { create: false })).getEntries();
	}
}
