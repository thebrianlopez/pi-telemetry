/**
 * F-010 contract tests — task boundary and routing parity (EPIC-253).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import telemetry, {
	dateFileName,
	inferActualLayer,
	resolveRoutingRecommendation,
} from "../../extensions/telemetry.ts";
import {
	billingRisk,
	composeTaskId,
	epicIdFrom,
	parseMilestones,
	readTriggers,
	resolveInboundHarness,
	resolveTaskContext,
} from "../../src/taskContext.ts";
import { validateEvent } from "../../src/schema/validate.ts";
import { bashToolCall } from "../fixtures/events.ts";

let dir: string;
let work: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
	"AUTOMATION_METRICS_EVENTS_DIR",
	"AUTOMATION_METRICS_AGENT",
	"AUTOMATION_METRICS_TASK_ID",
	"AUTOMATION_METRICS_CHAIN_KEY",
	"AUTOMATION_METRICS_FROM_HARNESS",
	"AUTOMATION_METRICS_PROVIDER",
	"AUTOMATION_METRICS_ROUTING_LAYER",
	"AUTOMATION_METRICS_ROUTING_TOOL",
	"AUTOMATION_METRICS_ROUTING_TASK_TYPE",
	"AUTOMATION_METRICS_ROUTING_CONFIDENCE",
];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-tb-events-"));
	work = mkdtempSync(join(tmpdir(), "pi-tb-work-"));
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
	rmSync(work, { recursive: true, force: true });
});

function readEvents(): any[] {
	const path = join(dir, dateFileName(new Date()));
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

function boundaries(): any[] {
	return readEvents().filter((e) => e.event_type === "task_boundary");
}

/** Write a dispatch trigger in the real production shape. */
function writeTrigger(
	epic: string,
	milestones: string,
	opts: { claimed?: boolean; malformed?: boolean } = {},
) {
	const d = join(work, ".claude-dispatch");
	mkdirSync(d, { recursive: true });
	const file = join(d, `PERSONAL_20260729T000000Z_Pi_${epic}_work.json`);
	writeFileSync(
		file,
		opts.malformed
			? "{ not valid json"
			: JSON.stringify({
					epic: `PERSONAL_20260729T000000Z_Pi_${epic}_work.md`,
					epic_path: `/docs/epics/PERSONAL_..._${epic}_work.md`,
					milestones,
					agent_id: "pi-telemetry-agent",
					dispatched_at: "20260729T000000Z",
				}),
	);
	if (opts.claimed) writeFileSync(`${file}.claimed`, "");
	return d;
}

type Handler = (event: any, ctx?: unknown) => Promise<void> | void;

/** Mount with cwd pinned to the temp workspace so tests stay hermetic. */
function mountExtension(cwd = work) {
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
		const merged =
			event === "session_start"
				? {
						sessionManager: {
							getHeader: () => ({ id: "sess-1", cwd }),
							getPath: () => null,
						},
						...(ctx as object),
					}
				: ctx;
		for (const h of handlers.get(event) ?? []) await h(payload, merged);
	};
}

describe("F-010 task context resolution", () => {
	it("CT-1: explicit env task id yields a claim at session start", async () => {
		process.env.AUTOMATION_METRICS_TASK_ID = "EPIC-251-M1";
		const fire = mountExtension();
		await fire("session_start");

		const [b] = boundaries();
		expect(b).toBeDefined();
		expect(b.metadata.task_id).toBe("EPIC-251-M1");
		expect(b.metadata.boundary_action).toBe("claim");
		expect(b.metadata.to_harness).toBe("pi");
		expect(b.metadata.from_harness).toBeNull();
		expect(b.layer).toBe("orchestration");
	});

	it("CT-2: no task context emits zero boundary events", async () => {
		const fire = mountExtension();
		await fire("session_start");
		await fire("session_shutdown");

		expect(boundaries()).toHaveLength(0);
	});

	it("CT-7: a dispatch trigger resolves the EPIC task id", () => {
		const d = writeTrigger("EPIC-253", "M2");
		const ctx = resolveTaskContext({ dispatchDir: d, env: {} });
		expect(ctx.taskId).toBe("EPIC-253-M2");
		expect(ctx.source).toBe("dispatch");
		expect(ctx.epic).toBe("EPIC-253");
		expect(ctx.milestones).toEqual(["M2"]);
	});

	it("a multi-milestone dispatch uses the bare epic as the task id", () => {
		const d = writeTrigger("EPIC-237", "M1,M2,M5");
		const ctx = resolveTaskContext({ dispatchDir: d, env: {} });
		expect(ctx.taskId).toBe("EPIC-237");
		expect(ctx.milestones).toEqual(["M1", "M2", "M5"]);
	});

	it("BT-3: precedence is env > dispatch > chain key", () => {
		const d = writeTrigger("EPIC-253", "M1");

		expect(
			resolveTaskContext({
				dispatchDir: d,
				env: {
					AUTOMATION_METRICS_TASK_ID: "OVERRIDE-1",
					AUTOMATION_METRICS_CHAIN_KEY: "chain",
				},
			}),
		).toMatchObject({ taskId: "OVERRIDE-1", source: "env" });

		expect(
			resolveTaskContext({
				dispatchDir: d,
				env: { AUTOMATION_METRICS_CHAIN_KEY: "chain" },
			}),
		).toMatchObject({ taskId: "EPIC-253-M1", source: "dispatch" });

		expect(
			resolveTaskContext({
				dispatchDir: join(work, "nonexistent"),
				env: { AUTOMATION_METRICS_CHAIN_KEY: "chain" },
			}),
		).toMatchObject({ taskId: "chain", source: "chain_key" });
	});

	it("BT-1: an unparseable trigger does not throw and reports a diagnostic", () => {
		const d = writeTrigger("EPIC-999", "M1", { malformed: true });
		expect(() => resolveTaskContext({ dispatchDir: d, env: {} })).not.toThrow();

		const ctx = resolveTaskContext({ dispatchDir: d, env: {} });
		// The filename still carries the epic id, so resolution succeeds via
		// the name even though the body is unreadable.
		expect(ctx.taskId).toBe("EPIC-999");
	});

	it("prefers an unclaimed trigger over a claimed one", () => {
		const d = join(work, ".claude-dispatch");
		mkdirSync(d, { recursive: true });
		writeFileSync(
			join(d, "a_EPIC-100_x.json"),
			JSON.stringify({ epic: "EPIC-100", milestones: "M1" }),
		);
		writeFileSync(join(d, "a_EPIC-100_x.json.claimed"), "");
		writeFileSync(
			join(d, "b_EPIC-200_y.json"),
			JSON.stringify({ epic: "EPIC-200", milestones: "M1" }),
		);

		expect(resolveTaskContext({ dispatchDir: d, env: {} }).taskId).toBe(
			"EPIC-200-M1",
		);
	});

	it("reports task_boundary_missing when nothing resolves", () => {
		const ctx = resolveTaskContext({
			dispatchDir: join(work, "none"),
			env: {},
		});
		expect(ctx.taskId).toBeNull();
		expect(ctx.source).toBe("none");
		expect(ctx.diagnostic).toBe("task_boundary_missing");
	});
});

describe("F-010 boundary emission", () => {
	it("CT-3: clean shutdown emits release from pi", async () => {
		process.env.AUTOMATION_METRICS_TASK_ID = "EPIC-251-M1";
		const fire = mountExtension();
		await fire("session_start");
		await fire("session_shutdown");

		const actions = boundaries().map((b) => b.metadata.boundary_action);
		expect(actions).toEqual(["claim", "release"]);
		const release = boundaries().at(-1);
		expect(release.metadata.from_harness).toBe("pi");
	});

	it("CT-4: abnormal shutdown emits suspend, not release", async () => {
		process.env.AUTOMATION_METRICS_TASK_ID = "EPIC-251-M1";
		const fire = mountExtension();
		await fire("session_start");
		await fire("session_shutdown", { reason: "interrupt signal" });

		const actions = boundaries().map((b) => b.metadata.boundary_action);
		expect(actions).toContain("suspend");
		expect(actions).not.toContain("release");
	});

	it("CT-5: inbound from_harness produces a handoff", async () => {
		process.env.AUTOMATION_METRICS_TASK_ID = "EPIC-251-M1";
		process.env.AUTOMATION_METRICS_FROM_HARNESS = "claude_code";
		const fire = mountExtension();
		await fire("session_start");

		const [b] = boundaries();
		expect(b.metadata.boundary_action).toBe("handoff");
		expect(b.metadata.from_harness).toBe("claude_code");
		expect(b.metadata.to_harness).toBe("pi");
	});

	it("CT-6: claim then release closes the task", async () => {
		process.env.AUTOMATION_METRICS_TASK_ID = "EPIC-251-M1";
		const fire = mountExtension();
		await fire("session_start");
		await fire("session_shutdown");

		const ids = new Set(boundaries().map((b) => b.metadata.task_id));
		expect(ids).toEqual(new Set(["EPIC-251-M1"]));
		expect(boundaries()).toHaveLength(2);
	});

	it("CT-9: an Anthropic-billed inbound handoff flags billing risk", async () => {
		process.env.AUTOMATION_METRICS_TASK_ID = "EPIC-251-M1";
		process.env.AUTOMATION_METRICS_FROM_HARNESS = "claude_code";
		const fire = mountExtension();
		await fire("session_start");

		expect(boundaries()[0].metadata.concurrent_billing_risk).toBe(true);
	});

	it("CT-10: a local-model session never flags billing risk", async () => {
		process.env.AUTOMATION_METRICS_TASK_ID = "EPIC-251-M1";
		process.env.AUTOMATION_METRICS_FROM_HARNESS = "claude_code";
		process.env.AUTOMATION_METRICS_PROVIDER = "ollama";
		const fire = mountExtension();
		await fire("session_start");

		expect(boundaries()[0].metadata.concurrent_billing_risk).toBe(false);
	});

	it("CT-14: every boundary event validates", async () => {
		process.env.AUTOMATION_METRICS_TASK_ID = "EPIC-251-M1";
		const fire = mountExtension();
		await fire("session_start");
		await fire("session_shutdown");

		for (const b of boundaries()) {
			expect(validateEvent(b).issues).toEqual([]);
		}
	});

	it("RG-1: a task id is never a session UUID", async () => {
		process.env.AUTOMATION_METRICS_TASK_ID = "EPIC-251-M1";
		const fire = mountExtension();
		await fire("session_start");
		await fire("session_shutdown");

		const uuid =
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
		for (const b of boundaries()) {
			expect(uuid.test(b.metadata.task_id)).toBe(false);
		}
	});

	it("RG-2: a Claude Code handoff opens exactly one pi ownership", async () => {
		process.env.AUTOMATION_METRICS_TASK_ID = "EPIC-251-M1";
		process.env.AUTOMATION_METRICS_FROM_HARNESS = "claude_code";
		const fire = mountExtension();
		await fire("session_start");
		await fire("session_shutdown");

		const opens = boundaries().filter((b) =>
			["claim", "handoff", "resume"].includes(b.metadata.boundary_action),
		);
		const closes = boundaries().filter((b) =>
			["release", "suspend"].includes(b.metadata.boundary_action),
		);
		expect(opens).toHaveLength(1);
		expect(closes).toHaveLength(1);
	});

	it("reports task_context_source and boundary count in the summary", async () => {
		process.env.AUTOMATION_METRICS_TASK_ID = "EPIC-251-M1";
		const fire = mountExtension();
		await fire("session_start");
		await fire("session_shutdown");

		const summary = readEvents().find(
			(e) => e.event_type === "session_summary",
		);
		expect(summary.metadata.task_context_source).toBe("env");
		expect(summary.metadata.boundary_events_emitted).toBe(2);
	});
});

describe("F-010 routing parity", () => {
	it("CT-11: adoption rate is null when no routing signal was injected", async () => {
		const fire = mountExtension();
		await fire("session_start");
		await fire("session_shutdown");

		const summary = readEvents().find(
			(e) => e.event_type === "session_summary",
		);
		expect(summary.metadata.routing_adoption_rate).toBeNull();
		expect(summary.metadata.routing_candidates_available).toBeNull();
		expect(summary.metadata.routing_signals_injected).toBe(0);
		expect(
			readEvents().filter((e) => e.event_type === "layer_routing_decision"),
		).toHaveLength(0);
	});

	it("CT-12/CT-13: a followed recommendation counts as matched", async () => {
		process.env.AUTOMATION_METRICS_ROUTING_LAYER = "go_cli";
		process.env.AUTOMATION_METRICS_ROUTING_TOOL = "mdq";
		process.env.AUTOMATION_METRICS_ROUTING_TASK_TYPE = "doc_discovery";
		process.env.AUTOMATION_METRICS_ROUTING_CONFIDENCE = "0.9";

		const fire = mountExtension();
		await fire("session_start");
		await fire("tool_call", bashToolCall("mdq list docs/**/*.md"));
		await fire("session_shutdown");

		const [decision] = readEvents().filter(
			(e) => e.event_type === "layer_routing_decision",
		);
		expect(decision.metadata.recommended_layer).toBe("go_cli");
		expect(decision.metadata.actual_layer).toBe("go_cli");
		expect(decision.metadata.override).toBe(false);
		expect(decision.metadata.confidence).toBe(0.9);
		expect(decision.layer).toBe("topology");
		expect(validateEvent(decision).issues).toEqual([]);

		const summary = readEvents().find(
			(e) => e.event_type === "session_summary",
		);
		expect(summary.metadata.routing_adoption_rate).toBe(1);
		expect(summary.metadata.routing_candidates_matched).toBe(1);
	});

	it("CT-13: an ignored recommendation is recorded as an override", async () => {
		process.env.AUTOMATION_METRICS_ROUTING_LAYER = "go_cli";
		const fire = mountExtension();
		await fire("session_start");
		// Plain shell work, not a go_cli tool.
		await fire("tool_call", bashToolCall("cat README.md"));
		await fire("session_shutdown");

		const [decision] = readEvents().filter(
			(e) => e.event_type === "layer_routing_decision",
		);
		expect(decision.metadata.actual_layer).toBe("cloud_llm");
		expect(decision.metadata.override).toBe(true);
		expect(decision.metadata.override_reason).toBe("other");

		const summary = readEvents().find(
			(e) => e.event_type === "session_summary",
		);
		expect(summary.metadata.routing_adoption_rate).toBe(0);
	});
});

describe("F-010 unit helpers", () => {
	it("epicIdFrom extracts an epic number from varied text", () => {
		expect(epicIdFrom("PERSONAL_x_EPIC-237_y.md")).toBe("EPIC-237");
		expect(epicIdFrom("EPIC-1")).toBe("EPIC-1");
		expect(epicIdFrom("no epic here")).toBeNull();
		expect(epicIdFrom(undefined)).toBeNull();
	});

	it("parseMilestones handles strings, arrays, and junk", () => {
		expect(parseMilestones("M1,M2,M5")).toEqual(["M1", "M2", "M5"]);
		expect(parseMilestones(" M1 , M2 ")).toEqual(["M1", "M2"]);
		expect(parseMilestones(["M1"])).toEqual(["M1"]);
		expect(parseMilestones("")).toEqual([]);
		expect(parseMilestones(null)).toEqual([]);
	});

	it("composeTaskId follows the single/multi milestone rule", () => {
		expect(composeTaskId("EPIC-1", ["M2"])).toBe("EPIC-1-M2");
		expect(composeTaskId("EPIC-1", ["M1", "M2"])).toBe("EPIC-1");
		expect(composeTaskId("EPIC-1", [])).toBe("EPIC-1");
		expect(composeTaskId(null, ["M1"])).toBeNull();
	});

	it("readTriggers tolerates a missing directory", () => {
		expect(readTriggers(join(work, "nope"))).toEqual([]);
	});

	it("resolveInboundHarness accepts only the vocabulary", () => {
		expect(
			resolveInboundHarness({ AUTOMATION_METRICS_FROM_HARNESS: "claude_code" }),
		).toBe("claude_code");
		expect(
			resolveInboundHarness({ AUTOMATION_METRICS_FROM_HARNESS: "borg" }),
		).toBeNull();
		expect(resolveInboundHarness({})).toBeNull();
	});

	it("billingRisk is false without an inbound harness or for local providers", () => {
		expect(billingRisk(null, {})).toBe(false);
		expect(billingRisk("pi", {})).toBe(false);
		expect(billingRisk("claude_code", {})).toBe(true);
		expect(
			billingRisk("claude_code", { AUTOMATION_METRICS_PROVIDER: "ollama" }),
		).toBe(false);
		expect(billingRisk("manual", {})).toBe(false);
	});

	it("inferActualLayer weighs go_cli and fish evidence", () => {
		expect(inferActualLayer({})).toBe("cloud_llm");
		expect(inferActualLayer({ cat: 3 })).toBe("cloud_llm");
		expect(inferActualLayer({ mdq: 1 })).toBe("go_cli");
		expect(inferActualLayer({ wk: 2 })).toBe("fish");
		expect(inferActualLayer({ mdq: 1, wk: 3 })).toBe("fish");
		expect(inferActualLayer({ mdq: 3, wk: 1 })).toBe("go_cli");
	});

	it("resolveRoutingRecommendation rejects malformed input", () => {
		expect(resolveRoutingRecommendation({})).toBeNull();
		expect(
			resolveRoutingRecommendation({ AUTOMATION_METRICS_ROUTING_LAYER: "bad" }),
		).toBeNull();

		const r = resolveRoutingRecommendation({
			AUTOMATION_METRICS_ROUTING_LAYER: "fish",
			AUTOMATION_METRICS_ROUTING_CONFIDENCE: "not-a-number",
		});
		expect(r!.recommendedLayer).toBe("fish");
		expect(r!.confidence).toBe(0.5);
		expect(r!.taskType).toBe("unspecified");
	});
});
