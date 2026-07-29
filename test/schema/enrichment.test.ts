/**
 * F-009 contract tests — prompt and session enrichment (EPIC-252 M3/M4).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import telemetry, {
	PREVIEW_LIMIT,
	approvalRate,
	captureText,
	classifyTask,
	dateFileName,
	freshState,
	isMutatingTool,
	languageOf,
	lastMessageOfRole,
	messageText,
	pathFromInput,
	preview,
	resolvePromptCapture,
	sha256,
	summaryMetadata,
	shouldEmitLifecycle,
} from "../../extensions/telemetry.ts";
import { validateEvent } from "../../src/schema/validate.ts";
import { assistantMessage } from "../fixtures/events.ts";

let dir: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
	"AUTOMATION_METRICS_EVENTS_DIR",
	"AUTOMATION_METRICS_AGENT",
	"AUTOMATION_METRICS_PROMPT_CAPTURE",
	"AUTOMATION_METRICS_LIFECYCLE_DETAIL",
];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-telemetry-enrich-"));
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

function userMsg(text: string) {
	return { role: "user" as const, content: text };
}

function assistantMsg(text: string, usage = { input: 100, output: 40 }) {
	return { ...assistantMessage(usage), content: [{ type: "text", text }] };
}

async function turn(
	fire: (e: string, p?: unknown) => Promise<void>,
	prompt: string,
	reply = "done",
) {
	await fire("agent_end", {
		messages: [userMsg(prompt), assistantMsg(reply)],
	});
}

describe("F-009 prompt enrichment", () => {
	it("CT-7: prompt_submit includes input, output, approval, task_category", async () => {
		const fire = mountExtension();
		await fire("session_start");
		await turn(fire, "please fix the broken parser");

		const [e] = readEvents().filter((x) => x.event_type === "prompt_submit");
		expect(e).toBeDefined();
		expect(e.metadata.input).toBe("please fix the broken parser");
		expect(e.metadata.output).toBe("done");
		expect(e.metadata.approval).toBe("unknown");
		expect(e.metadata.task_category).toBe("bugfix");
	});

	it("CT-8: prompt preview never exceeds the limit", async () => {
		const fire = mountExtension();
		await fire("session_start");
		await turn(fire, "x".repeat(5000), "y".repeat(5000));

		const [e] = readEvents().filter((x) => x.event_type === "prompt_submit");
		expect(e.metadata.input.length).toBe(PREVIEW_LIMIT);
		expect(e.metadata.output.length).toBe(PREVIEW_LIMIT);
		expect(e.metadata.input_length).toBe(5000);
	});

	it("CT-9: input_hash is stable for identical input, distinct otherwise", () => {
		expect(sha256("abc")).toBe(sha256("abc"));
		expect(sha256("abc")).not.toBe(sha256("abd"));
		expect(sha256("abc")).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	it("redacts secrets from the preview before truncation", async () => {
		const fire = mountExtension();
		await fire("session_start");
		await turn(fire, "use sk-ant-api03-SECRETVALUE123 to auth");

		const [e] = readEvents().filter((x) => x.event_type === "prompt_submit");
		expect(e.metadata.input).not.toContain("sk-ant-");
		expect(e.metadata.input).toContain("[REDACTED]");
	});

	it("PROMPT_CAPTURE=off stores neither text nor hash", () => {
		const r = captureText("secret prompt", "off");
		expect(r.text).toBe("");
		expect(r.hash).toBeNull();
		expect(r.length).toBe(13);
	});

	it("PROMPT_CAPTURE=hash stores the hash but no text", () => {
		const r = captureText("secret prompt", "hash");
		expect(r.text).toBe("");
		expect(r.hash).toMatch(/^sha256:/);
	});

	it("resolvePromptCapture defaults to preview and honors overrides", () => {
		expect(resolvePromptCapture()).toBe("preview");
		process.env.AUTOMATION_METRICS_PROMPT_CAPTURE = "off";
		expect(resolvePromptCapture()).toBe("off");
		process.env.AUTOMATION_METRICS_PROMPT_CAPTURE = "hash";
		expect(resolvePromptCapture()).toBe("hash");
		process.env.AUTOMATION_METRICS_PROMPT_CAPTURE = "nonsense";
		expect(resolvePromptCapture()).toBe("preview");
	});
});

describe("classifyTask", () => {
	it("maps representative prompts to schema categories", () => {
		const cases: Array<[string, string]> = [
			["fix the broken test", "bugfix"],
			["review this PR", "code_review"],
			["update the README docs", "documentation"],
			["let's plan the PRD", "planning"],
			["configure the yaml settings", "configuration"],
			["where is the parser defined", "discovery"],
			["explain how does this work", "exploration"],
			["yes proceed", "confirmation"],
			["dispatch EPIC-251", "dispatch"],
		];
		for (const [text, expected] of cases) {
			expect(classifyTask(text), text).toBe(expected);
		}
	});

	it("returns other for unmatched prose and null for empty input", () => {
		expect(classifyTask("blorp zizzle")).toBe("other");
		expect(classifyTask("")).toBeNull();
		expect(classifyTask("   ")).toBeNull();
		expect(classifyTask(undefined)).toBeNull();
		expect(classifyTask(42)).toBeNull();
	});
});

describe("F-009 session enrichment", () => {
	it("CT-10: summary includes the applicable v2.14 enrichment keys", async () => {
		const fire = mountExtension();
		await fire("session_start");
		await fire("session_shutdown");

		const summary = readEvents().at(-1);
		for (const key of [
			"user_message_count",
			"assistant_message_count",
			"tool_errors",
			"tool_error_categories",
			"files_modified",
			"languages",
			"uses_task_agent",
			"uses_mcp",
			"tools_approved",
			"tools_rejected",
			"approval_rate",
			"git_commits",
			"git_pushes",
			"lines_added",
			"lines_removed",
			"user_interruptions",
			"user_response_times",
			"routing_adoption_rate",
		]) {
			expect(summary.metadata, key).toHaveProperty(key);
		}
	});

	it("CT-11: unobservable fields are explicit null, not absent", async () => {
		const fire = mountExtension();
		await fire("session_start");
		await fire("session_shutdown");

		const m = readEvents().at(-1).metadata;
		for (const key of [
			"git_commits",
			"git_pushes",
			"lines_added",
			"lines_removed",
			"user_interruptions",
			"user_response_times",
		]) {
			expect(Object.hasOwn(m, key), key).toBe(true);
			expect(m[key], key).toBeNull();
		}
	});

	it("CT-12: effective_input_tokens equals input + cacheRead + cacheWrite", () => {
		const state = {
			...freshState(),
			inputTokens: 100,
			cacheReadTokens: 20,
			cacheWriteTokens: 5,
			outputTokens: 40,
		};
		const { metadata } = summaryMetadata(state, state.startedAt);
		expect(metadata.effective_input_tokens).toBe(125);
		expect(metadata.total_tokens).toBe(165);
	});

	it("CT-13: cache_hit_pct is 0 when effective input is 0", () => {
		const { metadata } = summaryMetadata(freshState(), Date.now());
		expect(metadata.cache_hit_pct).toBe(0);
	});

	it("CT-14: approval_rate is null when nothing required approval", () => {
		expect(approvalRate(freshState())).toBeNull();
		expect(
			approvalRate({ ...freshState(), toolsApproved: 3, toolsRejected: 1 }),
		).toBe(75);
	});

	it("CT-15: every emitted event validates against the schema", async () => {
		const fire = mountExtension();
		await fire("session_start");
		await turn(fire, "fix the parser");
		await fire("session_shutdown");

		for (const e of readEvents()) {
			const r = validateEvent(e);
			expect(r.issues, e.event_type).toEqual([]);
		}
	});

	it("counts user and assistant messages across turns", async () => {
		const fire = mountExtension();
		await fire("session_start");
		await turn(fire, "one");
		await turn(fire, "two");
		await fire("session_shutdown");

		const m = readEvents().at(-1).metadata;
		expect(m.user_message_count).toBe(2);
		expect(m.assistant_message_count).toBe(2);
	});

	it("tracks modified files and languages from mutating tools", async () => {
		const fire = mountExtension();
		await fire("session_start");
		await fire("tool_call", {
			type: "tool_call",
			toolCallId: "t1",
			toolName: "edit",
			input: { path: "src/a.ts" },
		});
		await fire("tool_call", {
			type: "tool_call",
			toolCallId: "t2",
			toolName: "write",
			input: { path: "src/b.go" },
		});
		// A read must not count as a modification.
		await fire("tool_call", {
			type: "tool_call",
			toolCallId: "t3",
			toolName: "read",
			input: { path: "src/c.py" },
		});
		await fire("session_shutdown");

		const m = readEvents().at(-1).metadata;
		expect(m.files_modified).toBe(2);
		expect(m.languages).toEqual({ typescript: 1, go: 1 });
	});

	it("records tool error categories", async () => {
		const fire = mountExtension();
		await fire("session_start");
		await fire("tool_result", {
			type: "tool_result",
			toolCallId: "t1",
			toolName: "bash",
			input: { command: "cat x" },
			content: [{ type: "text", text: "no such file" }],
			isError: true,
		});
		await fire("session_shutdown");

		const m = readEvents().at(-1).metadata;
		expect(m.tool_errors).toBe(1);
		expect(m.tool_error_categories).toEqual({ not_found: 1 });
	});

	it("detects task-agent and MCP usage", async () => {
		const fire = mountExtension();
		await fire("session_start");
		await fire("tool_call", {
			type: "tool_call",
			toolCallId: "t1",
			toolName: "task",
			input: {},
		});
		await fire("tool_call", {
			type: "tool_call",
			toolCallId: "t2",
			toolName: "mcp__server__method",
			input: {},
		});
		await fire("session_shutdown");

		const m = readEvents().at(-1).metadata;
		expect(m.uses_task_agent).toBe(true);
		expect(m.uses_mcp).toBe(true);
	});
});

describe("helpers", () => {
	it("languageOf maps extensions and returns null for unknown", () => {
		expect(languageOf("a/b.ts")).toBe("typescript");
		expect(languageOf("x.go")).toBe("go");
		expect(languageOf("Makefile")).toBeNull();
		expect(languageOf("a.zzz")).toBeNull();
	});

	it("pathFromInput reads common key spellings", () => {
		expect(pathFromInput({ path: "a" })).toBe("a");
		expect(pathFromInput({ file_path: "b" })).toBe("b");
		expect(pathFromInput({ filePath: "c" })).toBe("c");
		expect(pathFromInput({})).toBeNull();
		expect(pathFromInput(null)).toBeNull();
	});

	it("isMutatingTool distinguishes writes from reads", () => {
		expect(isMutatingTool("edit")).toBe(true);
		expect(isMutatingTool("Write")).toBe(true);
		expect(isMutatingTool("read")).toBe(false);
		expect(isMutatingTool(undefined)).toBe(false);
	});

	it("messageText flattens string and array content", () => {
		expect(messageText({ content: "hi" })).toBe("hi");
		expect(messageText({ content: [{ type: "text", text: "a" }] })).toBe("a");
		expect(messageText(null)).toBe("");
	});

	it("lastMessageOfRole returns the most recent match", () => {
		const msgs = [userMsg("first"), userMsg("second")];
		expect(messageText(lastMessageOfRole(msgs, "user"))).toBe("second");
		expect(lastMessageOfRole(msgs, "assistant")).toBeUndefined();
	});

	it("preview redacts before truncating", () => {
		const text = `${"a".repeat(190)} sk-ant-SECRETVALUE`;
		expect(preview(text)).not.toContain("sk-ant-");
	});
});

describe("lifecycle detail control", () => {
	it("full mode emits tool execution lifecycle events", () => {
		expect(shouldEmitLifecycle("tool_execution_start", "full")).toBe(true);
		expect(shouldEmitLifecycle("agent_start", "full")).toBe(true);
	});

	it("session mode suppresses only the tool execution pair", () => {
		expect(shouldEmitLifecycle("tool_execution_start", "session")).toBe(false);
		expect(shouldEmitLifecycle("tool_execution_end", "session")).toBe(false);
		expect(shouldEmitLifecycle("agent_start", "session")).toBe(true);
		expect(shouldEmitLifecycle("agent_end", "session")).toBe(true);
		expect(shouldEmitLifecycle("model_select", "session")).toBe(true);
	});

	it("session mode measurably reduces event volume", async () => {
		process.env.AUTOMATION_METRICS_LIFECYCLE_DETAIL = "session";
		const fire = mountExtension();
		await fire("session_start");
		for (let i = 0; i < 10; i++) {
			await fire("tool_call", {
				type: "tool_call",
				toolCallId: `t${i}`,
				toolName: "bash",
				input: { command: "ls" },
			});
		}
		await fire("session_shutdown");

		const lifecycles = readEvents().filter(
			(e) => e.event_type === "agent_lifecycle",
		);
		// agent_start + agent_end only; the 10 tool_execution_start events
		// are suppressed.
		expect(lifecycles).toHaveLength(2);
	});
});
