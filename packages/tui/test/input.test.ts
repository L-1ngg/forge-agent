import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FilePicker, createInputAutocompleteProvider, scanFiles, SlashMenu } from "../src/index.ts";

test("slash menu delegates selection and navigation to the list component", () => {
	const selected: string[] = [];
	const menu = new SlashMenu([
		{ value: "help", label: "/help" },
		{ value: "model", label: "/model" },
	], (item) => selected.push(item.value));
	menu.open("/");
	menu.handleInput("\u001b[B");
	menu.handleInput("\r");
	expect(selected).toEqual(["model"]);
	expect(menu.isOpen()).toBe(false);
});

test("slash menu preserves its active prefix when items are refreshed", () => {
	const menu = new SlashMenu([
		{ value: "help", label: "/help" },
		{ value: "model", label: "/model" },
	]);
	menu.open("/mo");
	menu.setItems([
		{ value: "model", label: "/model" },
		{ value: "mode", label: "/mode" },
	]);
	expect(menu.getSelectedItem()?.value).toBe("model");
});

test("file picker scans synchronously and filters by path prefix", async () => {
	const root = await mkdtemp("/tmp/myh-picker-");
	try {
		await mkdir(join(root, "src"), { recursive: true });
		await mkdir(join(root, "src2"), { recursive: true });
		await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
		await writeFile(join(root, "src", "app.ts"), "");
		await writeFile(join(root, "src2", "wrong.ts"), "");
		await writeFile(join(root, "README.md"), "");
		await writeFile(join(root, "node_modules", "ignored", "bad.ts"), "");
		expect(scanFiles(root, "src/")).toEqual(["src/app.ts"]);
		expect(scanFiles(root, "src")).toEqual(["src/app.ts"]);
		const picker = new FilePicker({ cwd: root, files: [{ value: "src/app.ts" }, { value: "README.md" }] });
		picker.open("src/");
		expect(picker.render(80).join("\n")).toContain("src/app.ts");
		expect(picker.render(80).join("\n")).not.toContain("README.md");
		picker.setFiles([{ value: "src/app.ts" }, { value: "src/other.ts" }]);
		picker.setPrefix("src/app");
		expect(picker.render(80).join("\n")).toContain("src/app.ts");
		expect(picker.render(80).join("\n")).not.toContain("src/other.ts");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("autocomplete adapter preserves multiline cursor positions", async () => {
	const provider = createInputAutocompleteProvider({
		getSuggestions: async (input, cursor) => ({ items: [{ value: "@src/app.ts", label: "@src/app.ts" }], prefix: input.slice(cursor - 5, cursor) }),
		applyCompletion: (input, cursor, item) => ({ input: `${input.slice(0, cursor)}${item.value}${input.slice(cursor)}`, cursor: cursor + item.value.length }),
	});
	const suggestions = await provider.getSuggestions(["first", "@src/"], 1, 5, { signal: new AbortController().signal });
	expect(suggestions?.prefix).toBe("@src/");
	const applied = provider.applyCompletion(["first", "@src/"], 1, 5, { value: "@src/app.ts", label: "@src/app.ts" }, "@src/");
	expect(applied.lines).toEqual(["first", "@src/@src/app.ts"]);
	expect(applied.cursorLine).toBe(1);
	expect(applied.cursorCol).toBe(16);
});
