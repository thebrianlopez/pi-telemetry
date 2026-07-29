/**
 * RG-1 — the seam guard.
 *
 * `emit()` is an unvalidated transport primitive; `emitChecked()` enforces the
 * contract. That split is only safe if every extension hook actually uses the
 * checked path. These tests mount the real extension, fire every hook, and
 * assert that nothing it produces violates the vendored snapshot.
 *
 * If someone adds a hook that calls `emit()` directly, or emits an event whose
 * shape drifts from the schema, this file fails.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import telemetry, { dateFileName } from "../../extensions/telemetry.ts";
import { validateEvent } from "../../src/schema/validate.ts";
import {
	assistantMessage,
	bashToolCall,
	bashToolResult,
} from "../fixtures/events.ts";

let dir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-telemetry-rg1-"));
	saved.AUTOMATION_METRICS_EVENTS_DIR =
		process.env.AUTOMATION_METRICS_EVENTS_DIR;
	saved.AUTOMATION_METRICS_AGENT = process.env.AUTOMATION_METRICS_AGENT;
	process.env.AUTOMATION_METRICS_EVENTS_DIR = dir;
	delete process.env.AUTOMATION_METRICS_AGENT;
});

afterEach(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(dir, { recursive: true, force: true });
});

function readEvents(): Record<string, unknown>[] {
	const path = join(dir, dateFileName(new Date()));
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

type Handler = (event: any, ctx?: unknown) => Promise<void> | void;

function mountExtension() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};
	telemetry(pi as never);
	return async (event: string, payload: unknown = {}) => {
		for (const h of handlers.get(event) ?? []) await h(payload, {});
	};
}

/** Drive every hook the extension registers, in realistic order. */
async function fullSession(fire: (e: string, p?: unknown) => Promise<void>) {
	await fire("session_start");
	await fire("model_select", {
		type: "model_select",
		model: { id: "gpt-5.5", provider: "openai-codex" },
	});
	await fire("tool_call", bashToolCall("ls -la"));
	await fire("tool_result", bashToolResult("ls -la", "total 0"));
	await fire("tool_call", bashToolCall("cat missing", "tc-2"));
	await fire(
		"tool_result",
		bashToolResult("cat missing", "no such file", true, "tc-2"),
	);
	await fire("agent_end", {
		type: "agent_end",
		messages: [assistantMessage({ input: 1200, output: 450, cacheRead: 80 })],
	});
	await fire("session_shutdown");
}

describe("RG-1: every extension-emitted event satisfies the schema", () => {
	it("a full session produces zero schema violations", async () => {
		const fire = mountExtension();
		await fullSession(fire);

		const events = readEvents();
		expect(events.length).toBeGreaterThan(0);

		const violations = events
			.map((e) => ({ event: e, result: validateEvent(e) }))
			.filter((x) => !x.result.valid)
			.map((x) => ({
				event_type: x.event.event_type,
				issues: x.result.issues,
			}));

		expect(violations).toEqual([]);
	});

	it("the session covers every event type the extension can emit", async () => {
		const fire = mountExtension();
		await fullSession(fire);

		const seen = new Set(readEvents().map((e) => e.event_type as string));
		for (const expected of [
			"tool_use",
			"tool_result",
			"tool_failure",
			"prompt_submit",
			"model_routing_decision",
			"session_summary",
		]) {
			expect(seen, `missing '${expected}'`).toContain(expected);
		}
	});

	it("prompt_submit carries the cloud_llm layer, not claude_code", async () => {
		const fire = mountExtension();
		await fullSession(fire);

		const prompt = readEvents().find(
			(e) => e.event_type === "prompt_submit",
		);
		expect(prompt).toBeDefined();
		expect(prompt!.layer).toBe("cloud_llm");
	});

	it("tool and session events stay on the claude_code layer", async () => {
		const fire = mountExtension();
		await fullSession(fire);

		for (const e of readEvents()) {
			if (
				["tool_use", "tool_result", "tool_failure", "session_summary"].includes(
					e.event_type as string,
				)
			) {
				expect(e.layer, e.event_type as string).toBe("claude_code");
			}
		}
	});

	it("model_routing_decision stays on the orchestration layer", async () => {
		const fire = mountExtension();
		await fullSession(fire);

		const routing = readEvents().find(
			(e) => e.event_type === "model_routing_decision",
		);
		expect(routing!.layer).toBe("orchestration");
	});

	it("the summary reports zero dropped events for a clean session", async () => {
		const fire = mountExtension();
		await fullSession(fire);

		const summary = readEvents().at(-1) as any;
		expect(summary.event_type).toBe("session_summary");
		expect(summary.metadata.dropped_events).toBe(0);
		expect(summary.metadata.drop_reasons).toEqual({});
	});

	it("every emitted event carries pi harness identity", async () => {
		const fire = mountExtension();
		await fullSession(fire);

		for (const e of readEvents()) {
			expect(e.harness).toBe("pi");
			expect(e.agent_runtime).toBe("pi-coding-agent");
			expect(typeof e.session_id).toBe("string");
			expect(e.session_id).not.toBe("");
		}
	});

	it("all events in a session share one session_id", async () => {
		const fire = mountExtension();
		await fullSession(fire);

		const ids = new Set(readEvents().map((e) => e.session_id));
		expect(ids.size).toBe(1);
	});
});
