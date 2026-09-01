import { SelectList, type Component, type SelectItem } from "@earendil-works/pi-tui";

export interface FilePickerItem {
	value: string;
	label?: string;
	description?: string;
}

export interface ScanFilesOptions {
	maxEntries?: number;
	maxDepth?: number;
}

const theme = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	noMatch: (text: string) => text,
};

/** Synchronous, prefix-filtered repository scan used by the interactive picker. */
export function scanFiles(cwd: string, prefix = "", options: ScanFilesOptions = {}): string[] {
	const normalizedPrefix = normalizePath(prefix);
	const maxEntries = normalizeLimit(options.maxEntries, 2_000);
	const maxDepth = normalizeLimit(options.maxDepth, 12);
	const found: string[] = [];
	if (maxEntries === 0) return found;

	// Bun.Glob keeps the UI package free of direct node:fs/path imports while
	// retaining the synchronous scan contract required by the picker.
	try {
		const glob = new Bun.Glob("**/*");
		for (const entry of glob.scanSync({ cwd, dot: true, onlyFiles: true })) {
			const relativePath = normalizePath(entry);
			const segments = relativePath.split("/").filter(Boolean);
			if (segments.some((segment) => segment === ".git" || segment === "node_modules")) continue;
			if (Math.max(0, segments.length - 1) > maxDepth || !relativePath.startsWith(normalizedPrefix)) continue;
			found.push(relativePath);
			if (found.length >= maxEntries) break;
		}
	} catch {
		return [];
	}
	return found.sort((left, right) => left.localeCompare(right));
}

export interface FilePickerOptions extends ScanFilesOptions {
	cwd: string;
	prefix?: string;
	files?: readonly FilePickerItem[];
	onSelect?: (item: FilePickerItem) => void;
	onCancel?: () => void;
}

/** Keyboard interaction for file suggestions; parsing of the @ token stays in core. */
export class FilePicker implements Component {
	private readonly cwd: string;
	private readonly scanOptions: ScanFilesOptions;
	private suppliedFiles: readonly FilePickerItem[] | undefined;
	private list: SelectList;
	private visible = false;

	onSelect: ((item: FilePickerItem) => void) | undefined;
	onCancel: (() => void) | undefined;

	constructor(options: FilePickerOptions) {
		this.cwd = options.cwd;
		this.scanOptions = {
			...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
			...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
		};
		this.suppliedFiles = options.files;
		this.onSelect = options.onSelect;
		this.onCancel = options.onCancel;
		this.list = this.createList(options.prefix ?? "");
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

	setFiles(files: readonly FilePickerItem[]): void {
		this.suppliedFiles = files;
		this.list = this.createList("");
	}

	setPrefix(prefix: string): void {
		this.list = this.createList(prefix);
	}

	getSelectedItem(): FilePickerItem | undefined {
		const item = this.list.getSelectedItem();
		return item ? { value: item.value, label: item.label, ...(item.description ? { description: item.description } : {}) } : undefined;
	}

	handleInput(data: string): void {
		if (!this.visible) return;
		this.list.handleInput(data);
	}

	render(width: number): string[] {
		return this.visible ? this.list.render(Math.max(1, Math.floor(width))) : [];
	}

	invalidate(): void {
		this.list.invalidate();
	}

	private createList(prefix: string): SelectList {
		const normalizedPrefix = normalizePath(prefix).replace(/^\.\//, "");
		const items = this.suppliedFiles
			? this.suppliedFiles.filter((item) => normalizePath(item.value).startsWith(normalizedPrefix)).map((item) => ({ value: normalizePath(item.value), label: item.label ?? normalizePath(item.value), ...(item.description ? { description: item.description } : {}) }))
			: scanFiles(this.cwd, normalizedPrefix, this.scanOptions).map((value) => ({ value, label: value }));
		const list = new SelectList(items, 10, theme);
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

export const FilePickerComponent = FilePicker;

function normalizePath(value: string): string {
	return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function normalizeLimit(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value < 0) throw new RangeError("file scan limit must be a non-negative finite number");
	return Math.floor(value);
}
