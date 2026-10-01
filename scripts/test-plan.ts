import { resolve } from "node:path";

export const groups = ["contract", "integration", "cli"] as const;
export type TestGroup = typeof groups[number];
export type TestRegistry = Record<TestGroup, readonly string[]>;

/** Every executable suite has an explicit owner; helpers and fixtures are not suites. */
export const registry: TestRegistry = {
	contract: [
		"packages/interaction/test/interaction-scope.test.ts",
		"packages/interaction/test/session-coordinator.test.ts",
		"packages/tui/test/presentation-session.test.ts",
		"packages/core/test/blocks.test.ts",
		"packages/core/test/input.test.ts",
		"packages/core/test/model-auth.test.ts",
		"packages/core/test/model-catalog.test.ts",
		"packages/core/test/model-policy.test.ts",
		"packages/core/test/permission.test.ts",
		"packages/core/test/request-budget.test.ts",
		"packages/core/test/session.test.ts",
		"packages/core/test/tool-arguments.test.ts",
		"packages/core/test/usage.test.ts",
		"packages/tui/test/ansi.test.ts",
		"packages/tui/test/app-input.test.ts",
		"packages/tui/test/app-rendering.test.ts",
		"packages/tui/test/app-requests.test.ts",
		"packages/tui/test/app-transcript.test.ts",
		"packages/tui/test/composer.test.ts",
		"packages/tui/test/editor.test.ts",
		"packages/tui/test/entry-shell.test.ts",
		"packages/tui/test/focus-stack.test.ts",
		"packages/tui/test/fold.test.ts",
		"packages/tui/test/frame.test.ts",
		"packages/tui/test/host.test.ts",
		"packages/tui/test/input-router.test.ts",
		"packages/tui/test/keys.test.ts",
		"packages/tui/test/layout.test.ts",
		"packages/tui/test/markdown.test.ts",
		"packages/tui/test/parity.test.ts",
		"packages/tui/test/present.test.ts",
		"packages/tui/test/projector.test.ts",
		"packages/tui/test/reference-parity.test.ts",
		"packages/tui/test/request-card.test.ts",
		"packages/tui/test/scan-files.test.ts",
		"packages/tui/test/scroll.test.ts",
		"packages/tui/test/theme.test.ts",
		"packages/tui/test/transcript-browser.test.ts",
		"packages/tui/test/welcome.test.ts",
		"packages/tui/test/width.test.ts",
		"scripts/check-deps.test.ts",
		"scripts/context-compaction-report.test.ts",
		"scripts/release-policy.test.ts",
		"scripts/test-evidence.test.ts",
		"scripts/test-plan.test.ts",
		"scripts/test-offline.test.ts",
		"scripts/test-source.test.ts",
		"scripts/tui-frame.test.ts",
		"tests/fixtures/protocol-request.test.ts",
		"tests/request-bus/request-bus.property.test.ts",
		"tests/request-bus/request-bus.test.ts",
		"tests/support/controlled-tool.test.ts",
		"tests/support/control.test.ts",
		"tests/support/http-fixture.test.ts",
		"tests/support/scenario.test.ts",
	],
	integration: [
		"packages/cli/test/interaction-options.test.ts",
		"packages/cli/test/headless.test.ts",
		"packages/cli/test/memory-command.test.ts",
		"packages/cli/test/memory-host.test.ts",
		"packages/cli/test/session-host.test.ts",
		"packages/cli/test/session-preview.test.ts",
		"packages/cli/test/session-ui-management.test.ts",
		"packages/cli/test/session-ui-preview.test.ts",
		"packages/cli/test/session-ui-requests.test.ts",
		"packages/cli/test/session-ui-switching.test.ts",
		"packages/core/test/agent-assembly.test.ts",
		"packages/core/test/bedrock-converse.test.ts",
		"packages/core/test/compaction-lifecycle.test.ts",
		"packages/core/test/context-compaction.test.ts",
		"packages/core/test/context-http.test.ts",
		"packages/core/test/context-transform.test.ts",
		"packages/core/test/foundation-data.test.ts",
		"packages/core/test/foundation-lifecycle.test.ts",
		"packages/core/test/foundation-review.test.ts",
		"packages/core/test/incremental-session.test.ts",
		"packages/core/test/input-ownership.test.ts",
		"packages/core/test/native-approval.test.ts",
		"packages/core/test/native-model.test.ts",
		"packages/core/test/openai-stream.test.ts",
		"packages/core/test/persistent-memory.test.ts",
		"packages/core/test/provider-matrix.test.ts",
		"packages/core/test/provider-replay.test.ts",
		"packages/core/test/provider-stream.test.ts",
		"packages/core/test/request-compaction-budget.test.ts",
		"packages/core/test/responses-terminal.test.ts",
		"packages/core/test/runtime-adapter.test.ts",
		"packages/core/test/runtime-configuration.test.ts",
		"packages/core/test/runtime-retry.test.ts",
		"packages/core/test/runtime-session.test.ts",
		"packages/core/test/runtime-tools.test.ts",
		"packages/core/test/runtime-turn-policy.test.ts",
		"packages/core/test/sdk-bounded-checkpoint.test.ts",
		"packages/core/test/sdk-integration.test.ts",
		"packages/core/test/sdk-mcp-boundaries.test.ts",
		"packages/core/test/sdk-mcp-legacy.test.ts",
		"packages/core/test/sdk-mcp-oauth.test.ts",
		"packages/core/test/sdk-mcp-subscriptions.test.ts",
		"packages/core/test/sdk-mcp.test.ts",
		"packages/core/test/sdk-memory-organizer.test.ts",
		"packages/core/test/sdk-message-codec.test.ts",
		"packages/core/test/sdk-native-memory.test.ts",
		"packages/core/test/sdk-native-skills.test.ts",
		"packages/core/test/sdk-otel.test.ts",
		"packages/core/test/sdk.test.ts",
		"packages/core/test/session-conversion.test.ts",
		"packages/core/test/session-first-write.test.ts",
		"packages/core/test/session-tools.test.ts",
		"packages/tools/test/tools.test.ts",
		"scripts/live-probe.test.ts",
		"tests/integration/cancellation.test.ts",
		"tests/integration/lifecycle.property.test.ts",
		"tests/integration/protocol.test.ts",
		"tests/integration/retry.test.ts",
		"tests/loop-contract/abort.test.ts",
		"tests/loop-contract/native-lifecycle.test.ts",
		"tests/loop-contract/owned-core.test.ts",
		"tests/loop-contract/parallel-tools.test.ts",
		"tests/loop-contract/steering.test.ts",
		"tests/loop-contract/stop-reason.test.ts",
	],
	cli: [
		"packages/cli/test/telemetry.test.ts",
		"tests/support/pty.test.ts",
		"packages/cli/test/headless-smoke.test.ts",
		"packages/cli/test/headless-request.test.ts",
		"packages/cli/test/mcp.test.ts",
		"packages/cli/test/runtime.test.ts",
		"packages/cli/test/skills.test.ts",
		"packages/cli/test/startup.test.ts",
		"tests/tui-integration/context.test.ts",
		"tests/tui-integration/input-ownership.test.ts",
		"tests/tui-integration/main-workflow.test.ts",
		"tests/tui-integration/mcp.test.ts",
		"tests/tui-integration/memory.test.ts",
		"tests/tui-integration/permission.test.ts",
		"tests/tui-integration/pty.test.ts",
		"tests/tui-integration/retry.test.ts",
		"tests/tui-integration/session-management.test.ts",
		"tests/tui-integration/skills.test.ts",
		"tests/tui-integration/tool-ui.test.ts",
	],
};

export function discoverTests(root = resolve(import.meta.dir, "..")): string[] {
	const paths = ["packages/*/test/**", "tests/**", "scripts/**"].flatMap(prefix =>
		[...new Bun.Glob(`${prefix}/*.{js,jsx,ts,tsx}`).scanSync({ cwd: root, onlyFiles: true })]);
	return paths.filter(path => !path.split("/").some(part => ["node_modules", "dist"].includes(part)) && /[._](test|spec)\.[jt]sx?$/.test(path)).sort();
}

export function testGroup(path: string, suites: TestRegistry = registry): TestGroup {
	const owners = groups.filter(group => suites[group].includes(path));
	if (owners.length !== 1) throw new Error(owners.length ? `Duplicate test registration: ${path}` : `Unregistered test: ${path}`);
	return owners[0]!;
}

export function createTestPlan(discovered = discoverTests(), suites: TestRegistry = registry): TestRegistry {
	const discoveredSet = new Set(discovered);
	if (discoveredSet.size !== discovered.length) throw new Error("Duplicate discovered test");
	for (const group of groups) {
		if (!suites[group].length) throw new Error(`Empty test group: ${group}`);
		if (new Set(suites[group]).size !== suites[group].length) throw new Error(`Duplicate test registration in ${group}`);
		for (const path of suites[group]) {
			testGroup(path, suites);
			if (!discoveredSet.has(path)) throw new Error(`Registered test is missing: ${path}`);
		}
	}
	for (const path of discovered) testGroup(path, suites);
	return { contract: [...suites.contract].sort(), integration: [...suites.integration].sort(), cli: [...suites.cli].sort() };
}

if (import.meta.main) console.log(JSON.stringify(createTestPlan(), null, 2));
