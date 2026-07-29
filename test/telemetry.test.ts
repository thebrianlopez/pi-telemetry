import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import telemetry, {
	aggregateTurnUsage,
	classifyError,
	contentText,
	dateFileName,
	emit,
	errorMessage,
	firstWord,
	formatTimestamp,
	freshState,
	opusPct,
	resolveAgent,
	resolveEventsDir,
	summaryMetadata,
	SCHEMA_VERSION,
	type SessionState,
} from "../extensions/telemetry.ts";

import {
	assistantMessage,
	bashToolCall,
	bashToolResult,
	userMessage,
} from "./fixtures/events.ts";

// --- Harness -----------------------------------------------------------------

/** Per-test scratch dir. Never touches the live ~/.automation-metrics bus. */
let dir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-telemetry-"));
	savedEnv.AUTOMATION_METRICS_EVENTS_DIR =
		process.env.AUTOMATION_METRICS_EVENTS_DIR;
	savedEnv.AUTOMATION_METRICS_AGENT = process.env.AUTOMATION_METRICS_AGENT;
	process.env.AUTOMATION_METRICS_EVENTS_DIR = dir;
	delete process.env.AUTOMATION_METRICS_AGENT;
});

afterEach(() => {
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(dir, { recursive: true, force: true });
});

function readEvents(d = dir, date = new Date()): Record<string, unknown>[] {
	const path = join(d, dateFileName(date));
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

/**
 * Select emitted events by type.
 *
 * Prefer this over positional indexing: the extension also emits
 * `agent_lifecycle` around tool and session transitions, so absolute
 * positions are not stable and a test that indexes into the file is really
 * asserting on unrelated behavior.
 */
function eventsOfType(type: string, d = dir): any[] {
	return readEvents(d).filter((e) => e.event_type === type);
}

type Handler = (event: any, ctx?: unknown) => Promise<void> | void;

/** Minimal ExtensionAPI stand-in that captures registered handlers. */
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

// --- F6: Emitter -------------------------------------------------------------

describe("F6 emitter", () => {
	it("formatTimestamp produces YYYYMMDDTHHMMSSZ", () => {
		expect(formatTimestamp(new Date("2026-07-27T03:47:24.123Z"))).toBe(
			"20260727T034724Z",
		);
	});

	it("dateFileName produces YYYY-MM-DD.jsonl", () => {
		expect(dateFileName(new Date("2026-07-27T03:47:24.123Z"))).toBe(
			"2026-07-27.jsonl",
		);
	});

	it("emit creates the events dir when missing", () => {
		const nested = join(dir, "a", "b");
		emit({ event_type: "t" }, { dir: nested });
		expect(existsSync(nested)).toBe(true);
	});

	it("emit appends a valid JSON line per call", () => {
		emit({ event_type: "one" }, { dir });
		emit({ event_type: "two" }, { dir });
		const events = readEvents();
		expect(events).toHaveLength(2);
		expect(events.map((e) => e.event_type)).toEqual(["one", "two"]);
	});

	it("emit stamps schema_version and timestamp on every event", () => {
		const now = new Date("2026-07-27T03:47:24.000Z");
		emit({ event_type: "t" }, { dir, now });
		const [event] = readEvents(dir, now);
		expect(event.schema_version).toBe(SCHEMA_VERSION);
		expect(event.timestamp).toBe("20260727T034724Z");
	});

	it("emit never throws on an unwritable destination", () => {
		// A regular file stands where a directory is required -> ENOTDIR.
		// Do NOT probe /proc here: mkdirSync(recursive) under procfs blocks
		// forever on some kernels, and a synchronous block starves the event
		// loop so vitest's own timeouts never fire.
		const blocker = join(dir, "not-a-dir");
		writeFileSync(blocker, "");
		expect(() =>
			emit({ event_type: "t" }, { dir: join(blocker, "sub") }),
		).not.toThrow();
	});

	it("resolveEventsDir precedence: override > env > homedir", () => {
		expect(resolveEventsDir("/explicit")).toBe("/explicit");
		expect(resolveEventsDir()).toBe(dir);
		delete process.env.AUTOMATION_METRICS_EVENTS_DIR;
		expect(resolveEventsDir()).toMatch(/\.automation-metrics\/events$/);
	});
});

// --- F7: Agent identity ------------------------------------------------------

describe("F7 agent identity", () => {
	it("resolveAgent returns the env var when set", () => {
		process.env.AUTOMATION_METRICS_AGENT = "test-agent";
		expect(resolveAgent()).toBe("test-agent");
	});

	it("resolveAgent returns null when unset", () => {
		expect(resolveAgent()).toBeNull();
	});

	it("emitted events carry the resolved agent and harness", async () => {
		process.env.AUTOMATION_METRICS_AGENT = "test-agent";
		const fire = mountExtension();
		await fire("session_start");
		await fire("tool_call", bashToolCall("git status"));
		const [event] = readEvents();
		expect(event.agent).toBe("test-agent");
		expect(event.harness).toBe("pi");
		expect(event.agent_runtime).toBe("pi-coding-agent");
	});
});

// --- F8: Session lifecycle ---------------------------------------------------

describe("F8 session lifecycle", () => {
	it("accumulator resets on session_start", async () => {
		const fire = mountExtension();
		await fire("session_start");
		await fire("tool_call", bashToolCall("ls"));
		await fire("tool_result", bashToolResult("ls", "ok"));
		await fire("session_start");
		await fire("session_shutdown");
		const summary = readEvents().at(-1) as any;
		expect(summary.metadata.tool_events).toBe(0);
		expect(summary.metadata.tool_distribution).toEqual({});
	});

	it("accumulator totals tokens across multiple agent_end turns", async () => {
		const fire = mountExtension();
		await fire("session_start");
		await fire("agent_end", {
			messages: [assistantMessage({ input: 10, output: 5 })],
		});
		await fire("agent_end", {
			messages: [assistantMessage({ input: 4, output: 6, cacheRead: 2 })],
		});
		await fire("session_shutdown");
		const summary = readEvents().at(-1) as any;
		expect(summary.metadata.input_tokens).toBe(14);
		expect(summary.metadata.output_tokens).toBe(11);
		expect(summary.metadata.cache_read_tokens).toBe(2);
	});

	it("summaryMetadata computes duration_minutes by rounding", () => {
		const state = freshState();
		const { durationMs, metadata } = summaryMetadata(
			state,
			state.startedAt + 125_000,
		);
		expect(durationMs).toBe(125_000);
		expect(metadata.duration_minutes).toBe(2);
	});

	it("summaryMetadata computes opus_pct from model distribution", () => {
		const state: SessionState = {
			...freshState(),
			modelDistribution: { "claude-opus-4": 3, "claude-sonnet-4": 1 },
			turns: 4,
		};
		expect(summaryMetadata(state, state.startedAt).metadata.opus_pct).toBe(
			75,
		);
	});

	it("opusPct is 0 when no turns were recorded", () => {
		expect(opusPct(freshState())).toBe(0);
	});
});

// --- F9: Tool events ---------------------------------------------------------

describe("F9 tool events", () => {
	it("tool_call emits tool_use with the bash first_word", async () => {
		const fire = mountExtension();
		await fire("session_start");
		await fire("tool_call", bashToolCall("  git status --short "));
		const [event] = eventsOfType("tool_use");
		expect(event).toBeDefined();
		expect(event.metadata.first_word).toBe("git");
	});

	it("tool_result emits tool_result on the success path", async () => {
		const fire = mountExtension();
		await fire("session_start");
		await fire("tool_result", bashToolResult("git status", "clean"));
		const [event] = eventsOfType("tool_result");
		expect(event).toBeDefined();
		expect(event.metadata.first_word).toBe("git");
		expect(event.metadata.tool_use_id).toBe("tc-1");
	});

	it("tool_result emits tool_failure on the error path", async () => {
		const fire = mountExtension();
		await fire("session_start");
		await fire(
			"tool_result",
			bashToolResult("cat nope", "cat: no such file or directory", true),
		);
		const [event] = eventsOfType("tool_failure");
		expect(event).toBeDefined();
		expect(event.metadata.error_class).toBe("not_found");
		expect(event.metadata.error_message).toContain("no such file");
	});

	it("error classification maps Pi errors to the schema enum", () => {
		const cases: [string, string][] = [
			["no such file or directory", "not_found"],
			["permission denied", "permission_denied"],
			["command timed out", "timeout"],
			["blocked by hook", "hook_blocked"],
			["something inexplicable", "unknown"],
		];
		for (const [text, expected] of cases) {
			expect(classifyError("bash", [{ type: "text", text }])).toBe(
				expected,
			);
		}
	});

	it("contentText tolerates the shapes handlers may actually receive", () => {
		expect(contentText([{ type: "text", text: "a" }, { type: "image" }])).toBe(
			"a",
		);
		expect(contentText("raw")).toBe("raw");
		expect(contentText(undefined)).toBe("");
		expect(contentText(null)).toBe("");
	});

	it("firstWord handles empty and undefined commands", () => {
		expect(firstWord(undefined)).toBe("");
		expect(firstWord("   ")).toBe("");
	});
});

// --- F10: Prompt events ------------------------------------------------------

describe("F10 prompt events", () => {
	it("agent_end extracts tokens from assistant messages only", () => {
		const usage = aggregateTurnUsage([
			assistantMessage({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1 }),
			userMessage(),
			assistantMessage({ input: 4, output: 6 }),
		]);
		expect(usage).toEqual({
			input: 14,
			output: 11,
			cacheRead: 2,
			cacheWrite: 1,
			turns: 2,
		});
	});

	it("agent_end suppresses prompt_submit when no output tokens", async () => {
		const fire = mountExtension();
		await fire("session_start");
		await fire("agent_end", { messages: [assistantMessage({ input: 10 })] });
		expect(eventsOfType("prompt_submit")).toHaveLength(0);
	});
});

// --- §5.3 Boundary -----------------------------------------------------------

describe("boundary conditions", () => {
	it("a session spanning midnight splits events across two date files", () => {
		const before = new Date("2026-07-27T23:59:59.000Z");
		const after = new Date("2026-07-28T00:00:01.000Z");
		emit({ event_type: "a" }, { dir, now: before });
		emit({ event_type: "b" }, { dir, now: after });
		expect(readEvents(dir, before)).toHaveLength(1);
		expect(readEvents(dir, after)).toHaveLength(1);
	});

	it("a session with zero tool calls still emits a summary", async () => {
		const fire = mountExtension();
		await fire("session_start");
		await fire("session_shutdown");
		const summary = readEvents().at(-1) as any;
		expect(summary.event_type).toBe("session_summary");
		expect(summary.metadata.tool_events).toBe(0);
		expect(summary.metadata.tool_distribution).toEqual({});
	});

	it("interleaved writers append without corrupting the file", () => {
		for (let i = 0; i < 50; i++) {
			emit({ event_type: "pi", i }, { dir });
			emit({ event_type: "claude", i }, { dir });
		}
		const events = readEvents();
		expect(events).toHaveLength(100);
		expect(events.every((e) => typeof e.event_type === "string")).toBe(true);
	});

	it("recreates the events dir if it is deleted mid-session", () => {
		emit({ event_type: "first" }, { dir });
		rmSync(dir, { recursive: true, force: true });
		emit({ event_type: "second" }, { dir });
		expect(readEvents()).toHaveLength(1);
	});

	it("truncates error_message to 200 chars", () => {
		const long = "x".repeat(500);
		expect(errorMessage([{ type: "text", text: long }])).toHaveLength(200);
	});
});
