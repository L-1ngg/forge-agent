import { expect, test } from "bun:test";
import { activeMention, createInputCompletionSource, parseMentions, parseSlashCommand, slashCommandPrefix, tokenizeArgs } from "../src/index.ts";

test("slash parser only treats a leading command as a command", () => {
	expect(parseSlashCommand("  /model \"gpt 5\" --fast")).toEqual({
		command: "model",
		args: '\"gpt 5\" --fast',
		argv: ["gpt 5", "--fast"],
		raw: "  /model \"gpt 5\" --fast",
		start: 2,
		end: 23,
	});
	expect(parseSlashCommand("say /model later")).toBeUndefined();
	expect(slashCommandPrefix("/mo")).toEqual({ prefix: "mo", start: 0, end: 3 });
});

test("mention parser returns token ranges without routing or execution", () => {
	const input = "ask @src/app.ts and @docs/readme.md";
	expect(parseMentions(input)).toEqual([
		{ path: "src/app.ts", raw: "@src/app.ts", start: 4, end: 15 },
		{ path: "docs/readme.md", raw: "@docs/readme.md", start: 20, end: 35 },
	]);
	expect(activeMention(input, 9)?.path).toBe("src/app.ts");
	expect(parseMentions("open @")).toEqual([{ path: "", raw: "@", start: 5, end: 6 }]);
	expect(activeMention("open @", 6)?.path).toBe("");
	expect(activeMention("open @src/app.ts ", 16)).toBeUndefined();
	expect(activeMention("open @src/app.ts", 16)?.path).toBe("src/app.ts");
});

test("argument tokenizer handles quotes and escaped spaces", () => {
	expect(tokenizeArgs("one 'two words' three\\ four")).toEqual(["one", "two words", "three four"]);
	expect(tokenizeArgs("'' \"\" value")).toEqual(["", "", "value"]);
});

test("completion source reuses parser ranges for slash commands and mentions", async () => {
	const source = createInputCompletionSource({
		commands: [{ name: "model", description: "Choose a model" }, { name: "help" }],
		listFiles: (prefix) => (prefix.startsWith("src/") ? ["src/app.ts"] : ["README.md"]),
	});
	expect(await source.getSuggestions("/mo", 3)).toEqual({
		items: [{ value: "model", label: "/model", description: "Choose a model" }],
		prefix: "/mo",
	});
	expect(await source.getSuggestions("look @src/", 10)).toEqual({
		items: [{ value: "@src/app.ts", label: "@src/app.ts" }],
		prefix: "@src/",
	});

	const slash = source.applyCompletion("/mo", 3, { value: "model", label: "/model" }, "/mo");
	expect(slash).toEqual({ input: "/model ", cursor: 7 });
	const mention = source.applyCompletion("look @src/", 10, { value: "@src/app.ts", label: "@src/app.ts" }, "@src/");
	expect(mention).toEqual({ input: "look @src/app.ts ", cursor: 17 });

	const midToken = source.applyCompletion("look @src/old.ts", 11, { value: "@src/app.ts", label: "@src/app.ts" }, "@src/");
	expect(midToken).toEqual({ input: "look @src/app.ts ", cursor: 17 });
});
