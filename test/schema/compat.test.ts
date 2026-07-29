/**
 * F-012 compatibility, privacy, and fail-open guards — EPIC-255 M2/M3.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import telemetry, {
	dateFileName,
	emit,
	emitChecked,
	resolveEventsDir,
	telemetryDisabled,
} from "../../extensions/telemetry.ts";
import { assistantMessage, bashToolCall } from "../fixtures/events.ts";
import { ALL_SECRETS as SECRETS, CANARY } from "../fixtures/secrets.ts";

/**
 * session_summary metadata keys emitted by shipped v1.0.
 *
 * Extracted from `summaryMetadata()` at commit c63bc84. RG-4 asserts v1.1 is a
 * superset: a consumer written against v1.0 must not encounter a missing key.
 */
const V1_0_SUMMARY_KEYS = [
	"duration_minutes",
	"input_tokens",
	"output_tokens",
	"cache_read_tokens",
	"cache_write_tokens",
	"cache_write_1h_tokens",
	"cache_write_5m_tokens",
	"web_search_requests",
	"effective_input_tokens",
	"total_tokens",
	"cache_hit_pct",
	"opus_pct",
	"tool_events",
	"tool_distribution",
	"model_distribution",
	"prompt_count",
	"turns",
	"signal_source",
] as const;


let dir: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
	"AUTOMATION_METRICS_EVENTS_DIR",
	"AUTOMATION_METRICS_AGENT",
	"AUTOMATION_METRICS_DISABLED",
	"AUTOMATION_METRICS_PROMPT_CAPTURE",
	"AUTOMATION_METRICS_LIFECYCLE_DETAIL",
];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-compat-"));
	for (const k of ENV_KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
	process.env.AUTOMATION_METRICS_EVENTS_DIR = dir;
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
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

function rawOutput(): string {
	const path = join(dir, dateFileName(new Date()));
	return existsSync(path) ? readFileSync(path, "utf8") : "";
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

async function fullSession(fire: (e: string, p?: unknown) => Promise<void>) {
	await fire("session_start");
	await fire("tool_call", bashToolCall("ls"));
	await fire("agent_end", {
		messages: [
			{ role: "user", content: "run it" },
			{ ...assistantMessage({ input: 10, output: 5 }), content: [] },
		],
	});
	await fire("session_shutdown");
}

// --- M2: compatibility ------------------------------------------------------

describe("F-012 compatibility", () => {
	it("RG-4: every v1.0 session_summary key is still present", async () => {
		const fire = mountExtension();
		await fullSession(fire);

		const summary = readEvents().find(
			(e) => e.event_type === "session_summary",
		);
		expect(summary).toBeDefined();

		const missing = V1_0_SUMMARY_KEYS.filter(
			(k) => !Object.hasOwn(summary.metadata, k),
		);
		expect(
			missing,
			`v1.1 dropped keys a v1.0 consumer depends on: ${missing.join(", ")}`,
		).toEqual([]);
	});

	it("CT-4: v1.1 only ADDS to the v1.0 summary surface", async () => {
		const fire = mountExtension();
		await fullSession(fire);
		const summary = readEvents().find(
			(e) => e.event_type === "session_summary",
		);
		const keys = Object.keys(summary.metadata);
		expect(keys.length).toBeGreaterThan(V1_0_SUMMARY_KEYS.length);
	});

	it("CT-5: v1.0-shaped events still parse and validate", async () => {
		// A consumer replaying historical v1.0 output must not break. v1.0 wrote
		// schema_version "2.14" with the same envelope, minus the new fields.
		const v10Event = {
			schema_version: "2.14",
			timestamp: "20260701T120000Z",
			layer: "claude_code",
			event_type: "tool_use",
			command: "bash",
			session_id: "old-session",
			cwd: "/repo",
			agent: null,
			harness: "pi",
			agent_runtime: "pi-coding-agent",
			metadata: { tool_name: "bash", source: "pi", first_word: "ls" },
		};
		const { validateEvent } = await import("../../src/schema/validate.ts");
		expect(validateEvent(v10Event).issues).toEqual([]);
	});

	it("CT-6: documents the one known breaking change (prompt_submit layer)", async () => {
		const fire = mountExtension();
		await fullSession(fire);

		const prompt = readEvents().find((e) => e.event_type === "prompt_submit");
		expect(prompt).toBeDefined();

		// v1.0 inherited layer "claude_code" from commonFields(); the canonical
		// schema declares prompt_submit under cloud_llm. This is the sole
		// intentional break in v1.1. A consumer filtering
		// `layer == "claude_code" AND event_type == "prompt_submit"` stops
		// matching and must filter on event_type alone.
		expect(prompt.layer).toBe("cloud_llm");
		expect(prompt.layer).not.toBe("claude_code");
	});
});

// --- M1: controls -----------------------------------------------------------

describe("F-012 operator controls", () => {
	it("CT-7: AUTOMATION_METRICS_DISABLED emits zero events", async () => {
		process.env.AUTOMATION_METRICS_DISABLED = "1";
		const fire = mountExtension();
		await fullSession(fire);
		expect(readEvents()).toHaveLength(0);
		expect(existsSync(join(dir, dateFileName(new Date())))).toBe(false);
	});

	it("the kill switch accepts 1, true, yes and nothing else", () => {
		for (const v of ["1", "true", "yes"]) {
			expect(telemetryDisabled({ AUTOMATION_METRICS_DISABLED: v }), v).toBe(
				true,
			);
		}
		for (const v of ["0", "false", "no", "", "maybe"]) {
			expect(telemetryDisabled({ AUTOMATION_METRICS_DISABLED: v }), v).toBe(
				false,
			);
		}
		expect(telemetryDisabled({})).toBe(false);
	});

	it("CT-8: PROMPT_CAPTURE=off omits prompt previews", async () => {
		process.env.AUTOMATION_METRICS_PROMPT_CAPTURE = "off";
		const fire = mountExtension();
		await fullSession(fire);

		const prompt = readEvents().find((e) => e.event_type === "prompt_submit");
		expect(prompt.metadata.input).toBe("");
		expect(prompt.metadata.input_hash).toBeNull();
		// Length is still reported: it is safe to publish and lets consumers
		// reason about prompt size without the content.
		expect(prompt.metadata.input_length).toBeGreaterThan(0);
	});
});

// --- M3: privacy ------------------------------------------------------------

describe("F-012 privacy guards", () => {
	it("RG-1/2/3: no credential shape survives to the bus", async () => {
		const fire = mountExtension();
		await fire("session_start");
		await fire("agent_end", {
			messages: [
				{
					role: "user",
					content: `deploy with ${SECRETS.anthropic} and ${SECRETS.githubPat}\n${SECRETS.pem}\n${SECRETS.aws}`,
				},
				{
					...assistantMessage({ input: 10, output: 5 }),
					content: [{ type: "text", text: `echoing ${SECRETS.anthropic}` }],
				},
			],
		});
		await fire("session_shutdown");

		const out = rawOutput();
		expect(out.length).toBeGreaterThan(0);
		for (const [name, value] of Object.entries(SECRETS)) {
			// Check the canary substring, not the whole block, so a partial
			// leak is caught too.
			const canary = CANARY;
			expect(out.includes(canary), `${name} leaked to the bus`).toBe(false);
		}
	});

	it("a tool error message carrying a secret is redacted", async () => {
		const fire = mountExtension();
		await fire("session_start");
		await fire("tool_result", {
			type: "tool_result",
			toolCallId: "t1",
			toolName: "bash",
			input: { command: "auth" },
			content: [
				{ type: "text", text: `permission denied for ${SECRETS.githubPat}` },
			],
			isError: true,
		});

		expect(rawOutput().includes(CANARY)).toBe(false);
	});
});

// --- M3: fail-open ----------------------------------------------------------

describe("F-012 fail-open guarantees", () => {
	it("CT-9: tests never write to the default events directory", () => {
		// The suite redirects via env; assert the redirect is actually in force
		// so a misconfigured run cannot silently pollute the real bus.
		expect(resolveEventsDir()).toBe(dir);
		expect(resolveEventsDir()).not.toContain(".automation-metrics");
	});

	it("CT-10: an unwritable destination does not throw", () => {
		const blocker = join(dir, "not-a-dir");
		writeFileSync(blocker, "");
		expect(() =>
			emit({ event_type: "t" }, { dir: join(blocker, "sub") }),
		).not.toThrow();
	});

	it("CT-11: a validator rejection drops the event and continues", () => {
		const stats = { droppedEvents: 0, dropReasons: {} as Record<string, number> };
		const ok = emitChecked(
			// Missing every required field.
			{ event_type: "definitely_not_a_real_type" },
			stats,
			{ dir },
		);
		expect(ok).toBe(false);
		expect(stats.droppedEvents).toBe(1);
		expect(Object.keys(stats.dropReasons).length).toBeGreaterThan(0);
		expect(readEvents()).toHaveLength(0);
	});

	it("RG-5: a hostile Pi payload never propagates an exception", async () => {
		const fire = mountExtension();
		await fire("session_start");

		const hostile: unknown[] = [
			undefined,
			null,
			{ toolName: null },
			{ toolName: {}, input: null },
			{ messages: "not-an-array" },
			{ messages: [null, undefined, 42] },
			{
				get toolName() {
					throw new Error("boom");
				},
			},
		];

		for (const payload of hostile) {
			await expect(fire("tool_call", payload)).resolves.not.toThrow();
			await expect(fire("tool_result", payload)).resolves.not.toThrow();
			await expect(fire("agent_end", payload)).resolves.not.toThrow();
		}
		await expect(fire("session_shutdown")).resolves.not.toThrow();
	});

	it("a session still summarizes after hostile input", async () => {
		const fire = mountExtension();
		await fire("session_start");
		await fire("agent_end", { messages: "garbage" });
		await fire("session_shutdown");

		const summary = readEvents().find(
			(e) => e.event_type === "session_summary",
		);
		expect(summary).toBeDefined();
		expect(summary.metadata.signal_source).toBe("pi_extension");
	});
});
