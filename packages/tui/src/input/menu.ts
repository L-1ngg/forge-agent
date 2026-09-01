import { Key, SelectList, type Component, type SelectItem } from "@earendil-works/pi-tui";

export interface SlashMenuItem {
	value: string;
	label: string;
	description?: string;
}

const theme = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	noMatch: (text: string) => text,
};

/** Keyboard-only projection of parsed slash-command suggestions. */
export class SlashMenu implements Component {
	private items: SelectItem[];
	private list: SelectList;
	private visible = false;
	private prefix = "";

	onSelect: ((item: SlashMenuItem) => void) | undefined;
	onCancel: (() => void) | undefined;

	constructor(items: readonly SlashMenuItem[] = [], onSelect?: (item: SlashMenuItem) => void) {
		this.items = items.map((item) => ({ ...item }));
		this.list = this.createList();
		this.onSelect = onSelect;
	}

	open(prefix = ""): void {
		this.visible = true;
		this.setPrefix(prefix);
	}

	close(): void {
		this.visible = false;
	}

	isOpen(): boolean {
		return this.visible;
	}

	setItems(items: readonly SlashMenuItem[]): void {
		this.items = items.map((item) => ({ ...item }));
		this.list = this.createList(this.prefix);
	}

	setPrefix(prefix: string): void {
		this.prefix = prefix;
		this.list.setFilter(prefix.replace(/^\//, ""));
	}

	getSelectedItem(): SlashMenuItem | undefined {
		const item = this.list.getSelectedItem();
		return item ? { value: item.value, label: item.label, ...(item.description ? { description: item.description } : {}) } : undefined;
	}

	handleInput(data: string): void {
		if (!this.visible) return;
		if (data === Key.escape || data === "\u001b") {
			this.visible = false;
			this.onCancel?.();
			return;
		}
		this.list.handleInput(data);
	}

	render(width: number): string[] {
		return this.visible ? this.list.render(Math.max(1, Math.floor(width))) : [];
	}

	invalidate(): void {
		this.list.invalidate();
	}

	private createList(prefix = ""): SelectList {
		const list = new SelectList([...this.items], 8, theme);
		list.setFilter(prefix.replace(/^\//, ""));
		list.onSelect = (item) => {
			this.visible = false;
			this.onSelect?.({ value: item.value, label: item.label, ...(item.description ? { description: item.description } : {}) });
		};
		list.onCancel = () => {
			this.visible = false;
			this.onCancel?.();
		};
		return list;
	}
}

export const SlashCommandMenu = SlashMenu;
