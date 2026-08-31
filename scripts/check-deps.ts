import { readFile } from "node:fs/promises";
import { relative } from "node:path";

const root = new URL("../", import.meta.url);
const packageNames = ["protocol", "tools", "core", "tui", "cli"] as const;
const violations: string[] = [];

function dependencyNames(manifest: Record<string, unknown>): string[] {
	return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((field) =>
		Object.keys((manifest[field] as Record<string, string> | undefined) ?? {}),
	);
}

function importSpecifiers(source: string): string[] {
	const specifiers: string[] = [];
	const staticImport = /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
	const dynamicImport = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
	for (const pattern of [staticImport, dynamicImport]) {
		for (const match of source.matchAll(pattern)) {
			if (match[1]) specifiers.push(match[1]);
		}
	}
	return specifiers;
}

for (const packageName of packageNames) {
	const packageUrl = new URL(`packages/${packageName}/`, root);
	const manifest = JSON.parse(await readFile(new URL("package.json", packageUrl), "utf8")) as Record<string, unknown>;
	const dependencies = dependencyNames(manifest);

	if (packageName === "core" && dependencies.includes("@myh/tui")) {
		violations.push("packages/core/package.json must not depend on @myh/tui");
	}
	if (packageName === "tools" && dependencies.includes("@myh/core")) {
		violations.push("packages/tools/package.json must not depend on @myh/core");
	}
	if (packageName === "tui") {
		const allowed = new Set(["@myh/protocol", "@earendil-works/pi-tui"]);
		for (const dependency of dependencies) {
			if (!allowed.has(dependency)) violations.push(`packages/tui/package.json has forbidden dependency ${dependency}`);
		}
	}

	const glob = new Bun.Glob("src/**/*.ts");
	for await (const path of glob.scan({ cwd: packageUrl.pathname, absolute: true })) {
		const imports = importSpecifiers(await readFile(path, "utf8"));
		const displayPath = relative(root.pathname, path);
		for (const specifier of imports) {
			if (packageName === "core" && specifier === "@myh/tui") {
				violations.push(`${displayPath} must not import @myh/tui`);
			}
			if (packageName === "tools" && specifier === "@myh/core") {
				violations.push(`${displayPath} must not import @myh/core`);
			}
			if (packageName === "tui" && !specifier.startsWith(".") && !["@myh/protocol", "@earendil-works/pi-tui"].includes(specifier)) {
				violations.push(`${displayPath} has forbidden external import ${specifier}`);
			}
			if (
				(specifier === "@earendil-works/pi-ai" || specifier.startsWith("@earendil-works/pi-ai/") || specifier === "@earendil-works/pi-agent-core") &&
				displayPath !== "packages/core/src/pi-port.ts"
			) {
				violations.push(`${displayPath} imports pi agent/model APIs outside packages/core/src/pi-port.ts`);
			}
		}
	}
}

if (violations.length > 0) {
	console.error(violations.join("\n"));
	process.exit(1);
}

console.log("Dependency boundaries are valid.");
