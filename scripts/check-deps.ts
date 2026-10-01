import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const packageNames = ["protocol", "tools", "core", "interaction", "tui", "cli"] as const;

function dependencyNames(manifest: Record<string, unknown>): string[] {
	return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((field) =>
		Object.keys((manifest[field] as Record<string, string> | undefined) ?? {}),
	);
}

function importSpecifiers(source: string): string[] {
	const specifiers: string[] = [];
	const file = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true);
	function visit(node: ts.Node): void {
		if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
			specifiers.push(node.moduleSpecifier.text);
		}
		if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!)) {
			specifiers.push(node.arguments[0]!.text);
		}
		ts.forEachChild(node, visit);
	}
	visit(file);
	return specifiers;
}

function callsBlockingGlobal(source: string): boolean {
 const file = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true);
 let found = false;
 function visit(node: ts.Node): void {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["prompt", "confirm"].includes(node.expression.text)) found = true;
  ts.forEachChild(node, visit);
 }
 visit(file);
 return found;
}

export async function findViolations(projectRoot: URL = root): Promise<string[]> {
	const violations: string[] = [];
	const rootManifest = new URL("package.json", projectRoot);
	if (await Bun.file(rootManifest).exists()) {
		const manifest = JSON.parse(await readFile(rootManifest, "utf8")) as Record<string, unknown>;
		if (dependencyNames(manifest).includes("@earendil-works/pi-agent-core")) {
			violations.push("package.json must not depend on pi-agent-core");
		}
		if (dependencyNames(manifest).includes("@earendil-works/pi-ai")) {
			violations.push("package.json must not depend on pi-ai");
		}
	}
	for (const packageName of packageNames) {
		const packageUrl = new URL(`packages/${packageName}/`, projectRoot);
		const manifest = JSON.parse(await readFile(new URL("package.json", packageUrl), "utf8")) as Record<string, unknown>;
		const dependencies = dependencyNames(manifest);
		if (dependencies.includes("@earendil-works/pi-agent-core")) {
			violations.push(`packages/${packageName}/package.json must not depend on pi-agent-core`);
		}
		if (dependencies.includes("@earendil-works/pi-ai")) {
			violations.push(`packages/${packageName}/package.json must not depend on pi-ai`);
		}

		if (packageName === "core") {
			for (const dependency of ["@forge-agent/tui", "@forge-agent/interaction"]) if (dependencies.includes(dependency)) violations.push(`packages/core/package.json must not depend on ${dependency}`);
		}
		if (packageName === "tools" && dependencies.includes("@forge-agent/core")) {
			violations.push("packages/tools/package.json must not depend on @forge-agent/core");
		}
		if (packageName === "tui") {
			const allowed = new Set(["@forge-agent/protocol", "@forge-agent/interaction", "marked", "lowlight"]);
			for (const dependency of dependencies) {
				if (!allowed.has(dependency)) violations.push(`packages/tui/package.json has forbidden dependency ${dependency}`);
			}
		}
		if (packageName === "interaction") {
			for (const dependency of dependencies) if (dependency !== "@forge-agent/protocol") violations.push(`packages/interaction/package.json has forbidden dependency ${dependency}`);
		}

		const glob = new Bun.Glob("src/**/*.ts");
		for await (const path of glob.scan({ cwd: packageUrl.pathname, absolute: true })) {
			const source = await readFile(path, "utf8");
			const imports = importSpecifiers(source);
			const displayPath = relative(projectRoot.pathname, path);
			if (packageName === "core" && /\bui\s*\.\s*(?:prompt|confirm|ask)\s*\(/.test(source)) {
				violations.push(`${displayPath} must not call UI blocking APIs directly`);
			}
			if (packageName === "core" && callsBlockingGlobal(source)) {
				violations.push(`${displayPath} must not call prompt/confirm directly`);
			}
			if (packageName === "interaction" && /\b(?:process\s*\.\s*(?:stdin|stdout|stderr)|Bun\s*\.\s*(?:stdin|stdout|stderr|spawn|spawnSync)|(?:prompt|confirm)\s*\()/.test(source)) violations.push(`${displayPath} must not use terminal or process I/O`);
			for (const specifier of imports) {
				if (packageName === "interaction") {
					const ownPath = specifier.startsWith(".") && !relative(packageUrl.pathname, resolve(path, "..", specifier)).startsWith("..");
					if (!ownPath && specifier !== "@forge-agent/protocol" && !["node:util", "node:events"].includes(specifier)) violations.push(`${displayPath} has forbidden interaction import ${specifier}`);
				}
				if (specifier === "@earendil-works/pi-agent-core" || specifier.startsWith("@earendil-works/pi-agent-core/")) {
					violations.push(`${displayPath} must not import pi-agent-core`);
				}
				if (packageName === "core" && ["@forge-agent/tui", "@forge-agent/interaction"].some(name => specifier === name || specifier.startsWith(name + "/"))) {
					violations.push(`${displayPath} must not import ${specifier}`);
				}
				if (packageName === "tools" && specifier === "@forge-agent/core") {
					violations.push(`${displayPath} must not import @forge-agent/core`);
				}
				if (packageName === "tui" && !specifier.startsWith(".") && !specifier.startsWith("node:") && specifier !== "@forge-agent/protocol" && specifier !== "@forge-agent/interaction" && specifier !== "@forge-agent/interaction/scope" && specifier !== "marked" && specifier !== "lowlight") {
					violations.push(`${displayPath} has forbidden external import ${specifier}`);
				}
				if (specifier === "@earendil-works/pi-ai" || specifier.startsWith("@earendil-works/pi-ai/")) {
					violations.push(`${displayPath} must not import pi-ai`);
				}
			}
		}
	}
	for (const directory of ["examples", "scripts"]) {
		const glob = new Bun.Glob(`${directory}/**/*.ts`);
		for await (const path of glob.scan({ cwd: projectRoot.pathname, absolute: true })) {
			const source = await readFile(path, "utf8");
			for (const specifier of importSpecifiers(source)) {
				if (specifier === "@earendil-works/pi-ai" || specifier.startsWith("@earendil-works/pi-ai/")) {
					violations.push(`${relative(projectRoot.pathname, path)} must not import pi-ai`);
				}
			}
		}
	}
	return violations;
}

if (import.meta.main) {
	const violations = await findViolations();
	if (violations.length > 0) {
		console.error(violations.join("\n"));
		process.exit(1);
	}

	console.log("Dependency boundaries are valid.");
}
