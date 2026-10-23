import { describe, expect, it } from "vitest";

import { clearModel, modelLabel, reportModel } from "../extensions/herdr-model";

describe("modelLabel", () => {
	it("builds an unambiguous provider/model label", () => {
		expect(modelLabel({ provider: "openai-codex", id: "gpt-5.5" })).toBe("openai-codex/gpt-5.5");
	});

	it.each([
		null,
		"gpt-5.5",
		{ provider: "", id: "gpt-5.5" },
		{ provider: "openai", id: "bad\nmodel" },
		{ provider: "p", id: "x".repeat(80) },
	])("rejects malformed or unsafe model data", (value) => {
		expect(modelLabel(value)).toBeNull();
	});
});

describe("Herdr reporting", () => {
	it("reports a namespaced, expiring token with an argv array", () => {
		const calls: Array<{ file: string; args: readonly string[] }> = [];
		reportModel("w1:p1", "anthropic/claude-opus-5", (file, args) => calls.push({ file, args }), "/bin/herdr");
		expect(calls).toEqual([
		{
			file: "/bin/herdr",
			args: [
				"pane", "report-metadata", "w1:p1", "--source", "pi-telemetry-model", "--agent", "pi",
				"--token", "pi_model=anthropic/claude-opus-5", "--ttl-ms", "43200000",
			],
		},
	]);
	});

	it("clears the token and does nothing outside Herdr", () => {
		const calls: readonly string[][] = [];
		const run = (_file: string, args: readonly string[]) => (calls as string[][]).push([...args]);
		reportModel(undefined, "anthropic/claude-opus-5", run);
		clearModel(undefined, run);
		clearModel("w1:p1", run);
		expect(calls).toEqual([
		["pane", "report-metadata", "w1:p1", "--source", "pi-telemetry-model", "--agent", "pi", "--clear-token", "pi_model"],
		]);
	});
});
