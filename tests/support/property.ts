/** Fixed defaults plus Bun/fast-check's printed seed/path make failures replayable. */
export function propertyOptions(defaultSeed: number, numRuns: number) {
	const seed = Number(process.env.FORGE_TEST_SEED ?? defaultSeed);
	if (!Number.isSafeInteger(seed)) throw new Error("FORGE_TEST_SEED must be an integer");
	const path = process.env.FORGE_TEST_PATH;
	return { seed, numRuns, ...(path !== undefined ? { path } : {}) };
}
