/**
 * AUTOMATION_METRICS_* environment seam.
 *
 * This package CONSUMES environment variables that `core` is supposed to
 * export. Nothing compared the two sides. Every read has a fallback, so a
 * producer-side rename does not throw - it degrades to a default that looks
 * like a legitimately-absent value. `AUTOMATION_METRICS_AGENT` becoming
 * `AUTOMATION_METRICS_AGENT_NAME` in `core` would turn every event's agent
 * attribution to `null`, and no test, type, or validator would notice.
 *
 * Two layers, matching test/schema/dispatchContract.test.ts:
 *
 *   1. FIXTURE LAYER (always runs) - the recorded contract in
 *      `test/fixtures/envContract.ts` is checked against this repo's own
 *      source, and each recorded fallback is exercised for real. This catches
 *      the consumer drifting away from the recorded contract, including the
 *      case where someone adds a new env read and classifies nothing.
 *   2. PRODUCER LAYER (runs when `core` is present, hard-fails otherwise) -
 *      the recorded contract is checked against live `core` source. This
 *      catches `core` dropping or renaming a producer, and equally catches
 *      `core` GAINING a producer for a name recorded as unwired.
 *
 * RESIDUAL GAP, stated explicitly: layer 2 greps fish source for assignment
 * syntax. It pins the NAME - the literal that actually breaks - and nothing
 * else. It would NOT catch:
 *   - a producer that still assigns the right name but computes a wrong or
 *     empty VALUE (e.g. `_am_identity` silently returning "" ), because an
 *     assignment to an empty string greps identically to a good one;
 *   - a producer that is assigned but never exported to the child process
 *     (`set -l` vs `set -lx`), since both match the assignment pattern;
 *   - a producer that stops being REACHED - deleting the `pi.fish` call site
 *     while leaving the assignment in a dead branch;
 *   - a change in the VOCABULARY behind a name, e.g. `AUTOMATION_METRICS_
 *     FROM_HARNESS` gaining a value `claude` that `HARNESS_VALUES` rejects.
 * Closing those requires launching a real session under fish and reading the
 * resulting child environment, which needs fish, a registered agent id, and a
 * live bus, and is out of scope for a unit suite.
 */

import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	coreCandidates,
	coreSources,
	excludingCoreTests,
	envNamesInSource,
	findCore,
	producersOf,
} from "../coreScan.ts";

import {
	billingRisk,
	resolveInboundHarness,
	resolveTaskContext,
} from "../../src/taskContext.ts";
import {
	resolveAgent,
	resolveEventsDir,
	resolveLifecycleDetail,
	resolvePromptCapture,
	resolveRoutingRecommendation,
	telemetryDisabled,
} from "../../extensions/telemetry.ts";
import { ROUTING_LAYERS } from "../../src/schema/eventSchema.ts";
import {
	CORE_DEFAULT_EVENTS_DIR,
	CORE_REDIRECT_ENV,
	DEFAULT_EVENTS_DIR_SEGMENTS,
	ENV_CONTRACT,
	TEST_ONLY_ENV,
	namesInClass,
} from "../fixtures/envContract.ts";
import { SEAM_OPT_OUT, seamChecksOptedOut } from "../seamOptOut.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

const readSourceNames = (dirs: string[]) => envNamesInSource(REPO_ROOT, dirs);

// ---------------------------------------------------------------------------
// Layer 1: consumer vs recorded contract
// ---------------------------------------------------------------------------

describe("env seam: consumer vs recorded contract", () => {
	const recorded = new Set(ENV_CONTRACT.map((e) => e.name));

	it("the recorded contract has no duplicate names", () => {
		expect(recorded.size).toBe(ENV_CONTRACT.length);
	});

	it("every AUTOMATION_METRICS_* name in shipped source is classified", () => {
		const inSource = readSourceNames(["src", "extensions"]);
		const unclassified = [...inSource].filter((n) => !recorded.has(n));
		expect(
			unclassified,
			`shipped source reads env vars absent from the contract table: ` +
				`${unclassified.join(", ")}. Add a row to test/fixtures/envContract.ts ` +
				`with its class, read site, and fallback.`,
		).toEqual([]);
	});

	it("every recorded name is actually read by shipped source", () => {
		const inSource = readSourceNames(["src", "extensions"]);
		const stale = [...recorded].filter((n) => !inSource.has(n));
		expect(
			stale,
			`contract records env vars no longer read: ${stale.join(", ")}. ` +
				`Remove the row, or restore the read.`,
		).toEqual([]);
	});

	it("test-only names are not smuggled into the runtime contract", () => {
		for (const n of TEST_ONLY_ENV) {
			expect(recorded.has(n), `${n} is test-only`).toBe(false);
			expect(readSourceNames(["src", "extensions"]).has(n)).toBe(false);
		}
	});

	it("the contract classifies exactly one core-produced variable", () => {
		// Not a style rule: the count is the finding. 13 names are read, 12 of
		// them have no producer in core. If this number moves, the wiring
		// changed and the table must be re-derived rather than patched.
		expect(namesInClass("core_produced")).toEqual([
			"AUTOMATION_METRICS_AGENT",
		]);
		expect(ENV_CONTRACT).toHaveLength(13);
		expect(namesInClass("unwired")).toHaveLength(8);
		expect(namesInClass("operator_override")).toHaveLength(4);
	});
});

// ---------------------------------------------------------------------------
// Layer 1b: the fallbacks are real, and they are silent
// ---------------------------------------------------------------------------

/**
 * Each recorded row claims a rename would be silent. These exercise the claim
 * against the real functions with an empty environment, which is exactly the
 * state a renamed producer leaves the consumer in.
 */
describe("env seam: absent producers degrade silently, as recorded", () => {
	const withEnv = <T>(env: NodeJS.ProcessEnv, fn: () => T): T => {
		const saved: Record<string, string | undefined> = {};
		for (const e of ENV_CONTRACT) {
			saved[e.name] = process.env[e.name];
			delete process.env[e.name];
		}
		Object.assign(process.env, env);
		try {
			return fn();
		} finally {
			for (const e of ENV_CONTRACT) {
				delete process.env[e.name];
				if (saved[e.name] !== undefined) process.env[e.name] = saved[e.name]!;
			}
		}
	};

	it("AUTOMATION_METRICS_AGENT absent yields null, not a throw", () => {
		expect(withEnv({}, () => resolveAgent())).toBeNull();
	});

	it("a RENAMED agent variable is indistinguishable from an absent one", () => {
		// The actual failure mode: core renames, the new name is exported, the
		// old name is gone, and the consumer reports exactly what it reports
		// when telemetry was never configured at all.
		const renamed = withEnv(
			{ AUTOMATION_METRICS_AGENT_NAME: "linkari-workspace-agent" },
			() => resolveAgent(),
		);
		expect(renamed).toBeNull();
		expect(renamed).toEqual(withEnv({}, () => resolveAgent()));
	});

	it("events dir falls back to the literal core also hard-codes", () => {
		expect(withEnv({}, () => resolveEventsDir())).toBe(
			join(homedir(), ...DEFAULT_EVENTS_DIR_SEGMENTS),
		);
		expect(CORE_DEFAULT_EVENTS_DIR).toBe(
			`~/${DEFAULT_EVENTS_DIR_SEGMENTS.join("/")}`,
		);
	});

	it("a renamed kill switch stops killing", () => {
		expect(
			withEnv({ AUTOMATION_METRICS_OFF: "1" }, () => telemetryDisabled()),
		).toBe(false);
		expect(withEnv({ AUTOMATION_METRICS_DISABLED: "1" }, telemetryDisabled)).toBe(
			true,
		);
	});

	it("a renamed prompt-capture control silently restores previews", () => {
		expect(
			withEnv({ AUTOMATION_METRICS_PROMPTS: "off" }, resolvePromptCapture),
		).toBe("preview");
		expect(withEnv({}, resolveLifecycleDetail)).toBe("session");
	});

	it("routing recommendation degrades to null, never a fabricated record", () => {
		expect(withEnv({}, () => resolveRoutingRecommendation())).toBeNull();
	});

	it("routing confidence fabricates 0.5 once the layer is present", () => {
		// Recorded because it is a genuine sharp edge: the ONLY gate is
		// ROUTING_LAYER. Rename ROUTING_CONFIDENCE alone and adoption analysis
		// silently receives a synthetic midpoint for every session.
		const r = withEnv(
			{
				AUTOMATION_METRICS_ROUTING_LAYER: ROUTING_LAYERS[0],
				AUTOMATION_METRICS_ROUTING_CONFIDENCE_PCT: "90",
			},
			() => resolveRoutingRecommendation(),
		);
		expect(r).not.toBeNull();
		expect(r!.confidence).toBe(0.5);
		expect(r!.taskType).toBe("unspecified");
	});

	it("every declared routing layer is accepted by the env reader", () => {
		// `extensions/telemetry.ts` hand-types ROUTING_LAYER_VALUES as a second
		// copy of `src/schema/eventSchema.ts` ROUTING_LAYERS, and the set is not
		// exported so nothing compared them. Same two-hand-typed-literals shape
		// as the env seam itself: drop a value from one copy and that layer's
		// recommendations become silently unreadable.
		for (const layer of ROUTING_LAYERS) {
			const r = withEnv(
				{ AUTOMATION_METRICS_ROUTING_LAYER: layer },
				() => resolveRoutingRecommendation(),
			);
			expect(r, `declared layer '${layer}' rejected by the env reader`).not.toBeNull();
			expect(r!.recommendedLayer).toBe(layer);
		}
	});

	it("task identity degrades to a diagnostic, not an error", () => {
		expect(resolveTaskContext({ env: {}, dispatchDir: "/nonexistent" })).toMatchObject(
			{ taskId: null, diagnostic: "task_boundary_missing" },
		);
	});

	it("harness and billing-risk degrade to the safe-looking answer", () => {
		expect(resolveInboundHarness({})).toBeNull();
		// A renamed FROM_HARNESS makes overlap risk unreportable, and the
		// unreportable answer is the reassuring one.
		expect(
			resolveInboundHarness({ AUTOMATION_METRICS_HARNESS: "claude_code" }),
		).toBeNull();
		expect(billingRisk(null, {})).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Layer 2: recorded contract vs live core
// ---------------------------------------------------------------------------

const coreRoot = findCore();

describe("env seam: recorded contract vs live core", () => {
	if (!coreRoot) {
		const where = coreCandidates().map((p) => `    - ${p}`).join("\n");

		if (seamChecksOptedOut()) {
			it(`UNVERIFIED by opt-out (${SEAM_OPT_OUT})`, () => {
				console.warn(
					`\n  [env] ${SEAM_OPT_OUT} is set. The AUTOMATION_METRICS_*` +
						`\n  environment contract was NOT checked against core in this run.` +
						`\n  Looked in:\n${where}\n`,
				);
				expect(namesInClass("core_produced")).not.toEqual([]);
			});
			return;
		}

		it("core must be present for the env contract to be verifiable", () => {
			throw new Error(
				`core checkout not found; the AUTOMATION_METRICS_* contract is UNVERIFIABLE.\n` +
					`  Looked in:\n${where}\n` +
					`  Fix by either:\n` +
					`    - setting WS_ORG_CORE to a core checkout, or\n` +
					`    - setting ${SEAM_OPT_OUT}=1 to accept undetected producer drift\n` +
					`      in this environment.`,
			);
		});
		return;
	}

	const sources = coreSources(coreRoot);

	it("the core scan actually found source to scan", () => {
		// Guards the whole layer against silently passing on an empty read -
		// a scan that finds nothing would otherwise "prove" every unwired
		// assertion below.
		expect(sources.length).toBeGreaterThan(100);
	});

	for (const name of namesInClass("core_produced")) {
		it(`core still exports ${name}`, () => {
			const hits = excludingCoreTests(producersOf(name, sources));
			expect(
				hits.length,
				`no producer for ${name} found anywhere in ${coreRoot}.\n` +
					`  This package reads it and falls back to null, so telemetry has\n` +
					`  gone dark silently. Either core renamed it - update the consumer\n` +
					`  and this fixture together - or the producer was deleted.`,
			).toBeGreaterThan(0);
		});
	}

	for (const name of namesInClass("unwired")) {
		it(`${name} still has no producer, as recorded`, () => {
			const hits = excludingCoreTests(producersOf(name, sources));
			expect(
				hits,
				`${name} is recorded as unwired but core now sets it in:\n` +
					hits.map((h) => `    - ${h}`).join("\n") +
					`\n  Reclassify it as core_produced in test/fixtures/envContract.ts\n` +
					`  so a future rename is caught.`,
			).toEqual([]);
		});
	}

	it("core's default bus location still matches this package's default", () => {
		const withDefault = sources.filter((s) =>
			s.text.includes(CORE_DEFAULT_EVENTS_DIR),
		);
		expect(
			withDefault.length,
			`core no longer references '${CORE_DEFAULT_EVENTS_DIR}'. This package's ` +
				`resolveEventsDir() default is hand-typed to match it; if core moved ` +
				`the bus, every event is now written to an orphaned directory.`,
		).toBeGreaterThan(0);
	});

	it("core's bus-redirect variable is still one this package does not read", () => {
		// Recorded asymmetry, asserted so it cannot change unnoticed in EITHER
		// direction: core dropping the redirect, or this package quietly growing
		// support for it while the fixture still says it has none.
		expect(
			producersOf(CORE_REDIRECT_ENV, sources).length,
			`core no longer sets ${CORE_REDIRECT_ENV}`,
		).toBeGreaterThan(0);
		expect(
			readSourceNames(["src", "extensions"]).has(CORE_REDIRECT_ENV),
			`this package now reads ${CORE_REDIRECT_ENV}; the recorded ` +
				`writer/reader asymmetry is stale and the fixture must be updated`,
		).toBe(false);
	});

	it("records which core was checked", () => {
		console.log(
			`  [env] verified ${ENV_CONTRACT.length} names against ${coreRoot} ` +
				`(${sources.length} files scanned)`,
		);
		expect(coreRoot).toBeTruthy();
	});
});
