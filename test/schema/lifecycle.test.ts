/**
 * F-008 contract tests — Pi lifecycle normalization (EPIC-252 M2).
 *
 * Verifies that every observable Pi runtime transition produces a canonical
 * `agent_lifecycle` event carrying stable harness identity.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import telemetry, {
	dateFileName,
	readSessionHeader,
} from "../../extensions/telemetry.ts";
import { validateEvent } from "../../src/schema/validate.ts";
import {
	assistantMessage,
	bashToolCall,
	bashToolResult,
} from "../fixtures/events.ts";

let dir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-telemetry-lc-"));
	for (const k of [
		"AUTOMATION_METRICS_EVENTS_DIR",
		"AUTOMATION_METRICS_AGENT",
		"AUTOMATION_METRICS_LIFECYCLE_DETAIL",
	]) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
	process.env.AUTOMATION_METRICS_EVENTS_DIR = dir;
	// This suite exercises the full lifecycle contract. The shipped DEFAULT is
	// `session`; opting in explicitly keeps that distinction visible.
	process.env.AUTOMATION_METRICS_LIFECYCLE_DETAIL = "full";
});

afterEach(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(dir, { recursive: true, force: true });
});

function readEvents(): any[] {
	const path = join(dir, dateFileName(new Date()));
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

function lifecycleEvents(): any[] {
	return readEvents().filter((e) => e.event_type === "agent_lifecycle");
}

function piEventTypes(): string[] {
	return lifecycleEvents().map((e) => e.metadata.pi_event_type);
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
	return async (event: string, payload: unknown = {}, ctx: unknown = {}) => {
		for (const h of handlers.get(event) ?? []) await h(payload, ctx);
	};
}

describe("F-008 lifecycle contract tests", () => {
	it("CT-1: session_start emits agent_lifecycle(agent_start)", async () => {
		const fire = mountExtension();
		await fire("session_start");

		const events = lifecycleEvents();
		expect(events).toHaveLength(1);
		expect(events[0].metadata.pi_event_type).toBe("agent_start");
		expect(events[0].layer).toBe("orchestration");
	});

	it("CT-2: session_shutdown emits agent_end before session_summary", async () => {
		const fire = mountExtension();
		await fire("session_start");
		await fire("session_shutdown");

		const all = readEvents();
		const endIdx = all.findIndex(
			(e) =>
				e.event_type === "agent_lifecycle" &&
				e.metadata.pi_event_type === "agent_end",
		);
		const summaryIdx = all.findIndex(
			(e) => e.event_type === "session_summary",
		);

		expect(endIdx).toBeGreaterThanOrEqual(0);
		expect(summaryIdx).toBeGreaterThanOrEqual(0);
		expect(endIdx).toBeLessThan(summaryIdx);
	});

	it("CT-3: tool_call emits tool_use and agent_lifecycle(tool_execution_start)", async () => {
		const fire = mountExtension();
		await fire("session_start");
		await fire("tool_call", bashToolCall("ls"));

		const types = readEvents().map((e) => e.event_type);
		expect(types).toContain("tool_use");
		expect(piEventTypes()).toContain("tool_execution_start");
	});

	it("CT-3b: tool_result emits agent_lifecycle(tool_execution_end)", async () => {
		const fire = mountExtension();
		await fire("session_start");
		await fire("tool_result", bashToolResult("ls", "ok"));

		expect(piEventTypes()).toContain("tool_execution_end");
	});

	it("CT-3c: an error tool_result still emits tool_execution_end", async () => {
		const fire = mountExtension();
		await fire("session_start");
		await fire("tool_result", bashToolResult("cat x", "no such file", true));

		const types = readEvents().map((e) => e.event_type);
		expect(types).toContain("tool_failure");
		expect(piEventTypes()).toContain("tool_execution_end");
	});

	it("CT-4: model_select emits routing decision and lifecycle event", async () => {
		const fire = mountExtension();
		await fire("session_start");
		await fire("model_select", {
			type: "model_select",
			model: { id: "gpt-5.5" },
		});

		const types = readEvents().map((e) => e.event_type);
		expect(types).toContain("model_routing_decision");
		expect(piEventTypes()).toContain("model_select");
	});

	it("CT-5: every lifecycle event carries pi harness identity", async () => {
		const fire = mountExtension();
		await fire("session_start");
		await fire("tool_call", bashToolCall("ls"));
		await fire("tool_result", bashToolResult("ls", "ok"));
		await fire("session_shutdown");

		const events = lifecycleEvents();
		expect(events.length).toBeGreaterThanOrEqual(4);
		for (const e of events) {
			expect(e.harness).toBe("pi");
			expect(e.agent_runtime).toBe("pi-coding-agent");
			expect(e.layer).toBe("orchestration");
			expect(validateEvent(e).valid).toBe(true);
		}
	});

	it("CT-6: session_file is metadata only, never the agent identity", async () => {
		const fire = mountExtension();
		const sessionFile = "~/.pi/agent/sessions/--repo--/ts_uuid.jsonl";
		await fire(
			"session_start",
			{},
			{
				sessionManager: {
					getHeader: () => ({ id: "hdr-session-1", cwd: "/repo" }),
					getPath: () => sessionFile,
				},
			},
		);

		const [event] = lifecycleEvents();
		expect(event.metadata.session_file).toBe(sessionFile);
		expect(event.agent).not.toBe(sessionFile);
		expect(event.agent).toBeNull();
		// Header identity is adopted for correlation with the session JSONL.
		expect(event.session_id).toBe("hdr-session-1");
		expect(event.cwd).toBe("/repo");
	});

	it("emits null session_file when the runtime exposes no header", async () => {
		const fire = mountExtension();
		await fire("session_start");

		const [event] = lifecycleEvents();
		expect(event.metadata.session_file).toBeNull();
		// Falls back to a generated UUID rather than fabricating a path.
		expect(typeof event.session_id).toBe("string");
		expect(event.session_id).not.toBe("");
	});

	it("tool lifecycle events carry a join key to their tool", async () => {
		const fire = mountExtension();
		await fire("session_start");
		await fire("tool_call", bashToolCall("ls", "tc-42"));
		await fire("tool_result", bashToolResult("ls", "ok", false, "tc-42"));

		const start = lifecycleEvents().find(
			(e) => e.metadata.pi_event_type === "tool_execution_start",
		);
		const end = lifecycleEvents().find(
			(e) => e.metadata.pi_event_type === "tool_execution_end",
		);

		// Without these a consumer cannot tell which tool the event brackets.
		expect(start.metadata.tool_use_id).toBe("tc-42");
		expect(start.metadata.tool_name).toBe("bash");
		expect(end.metadata.tool_use_id).toBe("tc-42");
		expect(end.metadata.tool_name).toBe("bash");
	});

	it("session-level lifecycle events carry no tool reference", async () => {
		const fire = mountExtension();
		await fire("session_start");

		const [start] = lifecycleEvents();
		expect(start.metadata.pi_event_type).toBe("agent_start");
		expect(start.metadata.tool_use_id).toBeUndefined();
		expect(start.metadata.tool_name).toBeUndefined();
	});

	it("all lifecycle events in a session share one session_id", async () => {
		const fire = mountExtension();
		await fire("session_start");
		await fire("tool_call", bashToolCall("ls"));
		await fire("session_shutdown");

		const ids = new Set(lifecycleEvents().map((e) => e.session_id));
		expect(ids.size).toBe(1);
	});
});

describe("readSessionHeader", () => {
	it("returns nulls for absent, malformed, or throwing contexts", () => {
		const bad: unknown[] = [
			undefined,
			null,
			{},
			{ sessionManager: null },
			{ sessionManager: {} },
			{ sessionManager: { getHeader: () => null } },
			{ sessionManager: { getHeader: () => ({}) } },
			{
				sessionManager: {
					getHeader: () => {
						throw new Error("boom");
					},
				},
			},
		];
		for (const ctx of bad) {
			expect(() => readSessionHeader(ctx)).not.toThrow();
			const r = readSessionHeader(ctx);
			expect(r.sessionId).toBeNull();
			expect(r.sessionFile).toBeNull();
		}
	});

	it("extracts id, cwd, and path when present", () => {
		const r = readSessionHeader({
			sessionManager: {
				getHeader: () => ({ id: "abc", cwd: "/x" }),
				getPath: () => "/sessions/a.jsonl",
			},
		});
		expect(r).toEqual({
			sessionId: "abc",
			cwd: "/x",
			sessionFile: "/sessions/a.jsonl",
		});
	});

	it("ignores non-string header values", () => {
		const r = readSessionHeader({
			sessionManager: {
				getHeader: () => ({ id: 42, cwd: {} }),
				getPath: () => 99,
			},
		});
		expect(r.sessionId).toBeNull();
		expect(r.cwd).toBeNull();
		expect(r.sessionFile).toBeNull();
	});
});
