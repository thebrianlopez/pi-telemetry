import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// FIRST/Independent: no shared mutable state between files.
		sequence: { shuffle: true },
		// FIRST/Fast: TDD-ratified budget is 5s for the whole suite.
		testTimeout: 5000,
	},
});
