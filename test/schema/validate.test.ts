import { describe, expect, it } from "vitest";

import {
	EVENT_RULES,
	KNOWN_EVENT_TYPES,
	SCHEMA_VERSION,
} from "../../src/schema/eventSchema.ts";
import {
	isKnownEventType,
	validateEvent,
} from "../../src/schema/validate.ts";
import { VALID_EVENTS, validEvent } from "../fixtures/schemaEvents.ts";

function codes(event: unknown): string[] {
	return validateEvent(event).issues.map((i) => i.code);
}

describe("F-007 contract tests", () => {
	it("CT-1: a minimal valid session_summary passes with zero issues", () => {
		const result = validateEvent(validEvent("session_summary"));
		expect(result.issues).toEqual([]);
		expect(result.valid).toBe(true);
	});

	it("CT-2: a present-but-empty session_id is rejected", () => {
		// session_id is optional upstream, so absence is tolerated — but an
		// empty string defeats correlation and is treated as a defect.
		const absent = validEvent("session_summary");
		delete absent.session_id;
		expect(validateEvent(absent).valid).toBe(true);

		const blank = validEvent("session_summary");
		blank.session_id = "";
		expect(codes(blank)).toContain("missing_required");
		expect(validateEvent(blank).valid).toBe(false);
	});

	it("CT-3: an incompatible MAJOR version yields schema_version_mismatch", () => {
		const e = validEvent("session_summary");
		e.schema_version = "3.0";
		expect(codes(e)).toContain("schema_version_mismatch");
	});

	it("CT-3b: minor revisions within major 2 are accepted", () => {
		// The bus carries "2" from emit_jsonl and "2.14" from this package.
		// Both must validate, or every historical event becomes invalid.
		for (const v of ["2", "2.9", "2.14", "2.15"]) {
			const e = validEvent("session_summary");
			e.schema_version = v;
			expect(validateEvent(e).valid, v).toBe(true);
		}
	});

	it("CT-4: unknown event_type yields unknown_event_type", () => {
		const e = validEvent("session_summary");
		e.event_type = "nope";
		expect(codes(e)).toContain("unknown_event_type");
	});

	it("CT-5: wrong layer on tool_use yields enum_violation", () => {
		const e = validEvent("tool_use");
		e.layer = "orchestration";
		const result = validateEvent(e);
		expect(result.valid).toBe(false);
		expect(
			result.issues.some(
				(i) => i.field === "layer" && i.code === "enum_violation",
			),
		).toBe(true);
	});

	it("CT-6: agent may be null OR absent (optional in the canonical schema)", () => {
		const withNull = validEvent("session_summary");
		withNull.agent = null;
		expect(validateEvent(withNull).valid).toBe(true);

		// `agent` is string_or_null and NOT marked required:true upstream.
		// Rejecting its absence would invalidate every interactive-shell event
		// on the bus.
		const absent = validEvent("session_summary");
		delete absent.agent;
		expect(validateEvent(absent).valid).toBe(true);
	});

	it("CT-6b: the four upstream-required fields are enforced", () => {
		for (const field of ["timestamp", "event_type", "layer", "command"]) {
			const e = validEvent("session_summary");
			delete e[field];
			const result = validateEvent(e);
			expect(result.valid, field).toBe(false);
			expect(
				result.issues.some((i) => i.field === field),
				field,
			).toBe(true);
		}
	});

	it("CT-6c: optional envelope fields may be omitted entirely", () => {
		// A fish-emitted event carries no harness/agent_runtime. It must still
		// validate — those fields were added in v2.9 as optional.
		const e = validEvent("workspace_idle");
		delete e.harness;
		delete e.agent_runtime;
		e.schema_version = "2";
		expect(validateEvent(e).issues).toEqual([]);
	});

	it("CT-7: non-object metadata yields type_mismatch", () => {
		for (const bad of ["str", 42, true, [], null]) {
			const e = validEvent("session_summary");
			e.metadata = bad;
			expect(codes(e)).toContain("type_mismatch");
		}
	});

	it("CT-8: every event type in the snapshot has a passing fixture", () => {
		for (const type of KNOWN_EVENT_TYPES) {
			const fixture = VALID_EVENTS[type];
			expect(fixture, `no fixture for '${type}'`).toBeDefined();
			const result = validateEvent(structuredClone(fixture));
			expect(result.issues, `fixture '${type}' invalid`).toEqual([]);
		}
	});

	it("CT-9: never throws for undefined, null, arrays, or primitives", () => {
		const inputs: unknown[] = [
			undefined,
			null,
			[],
			[1, 2, 3],
			"string",
			42,
			true,
			Symbol("s"),
			() => {},
			new Date(),
			NaN,
		];
		for (const input of inputs) {
			expect(() => validateEvent(input)).not.toThrow();
			expect(validateEvent(input).valid).toBe(false);
		}
	});

	it("CT-10: validation is pure — repeated calls are identical", () => {
		const e = validEvent("tool_failure");
		const a = validateEvent(e);
		const b = validateEvent(e);
		expect(a).toEqual(b);
		// The input is not mutated by validation.
		expect(e).toEqual(validEvent("tool_failure"));
	});
});

describe("F-007 field rules", () => {
	it("rejects an out-of-vocabulary error_class", () => {
		const e = validEvent("tool_failure");
		(e.metadata as Record<string, unknown>).error_class = "kaboom";
		const result = validateEvent(e);
		expect(
			result.issues.some(
				(i) =>
					i.field === "metadata.error_class" &&
					i.code === "enum_violation",
			),
		).toBe(true);
	});

	it("rejects an out-of-vocabulary boundary_action", () => {
		const e = validEvent("task_boundary");
		(e.metadata as Record<string, unknown>).boundary_action = "yolo";
		expect(codes(e)).toContain("enum_violation");
	});

	it("rejects a malformed timestamp", () => {
		const e = validEvent("workspace_idle");
		e.timestamp = "2026-07-29T12:47:54Z";
		const result = validateEvent(e);
		expect(
			result.issues.some((i) => i.field === "timestamp"),
		).toBe(true);
	});

	it("rejects an empty session_id", () => {
		const e = validEvent("workspace_idle");
		e.session_id = "";
		expect(codes(e)).toContain("missing_required");
	});

	it("tolerates a missing metadata key but still type-checks present ones", () => {
		// Presence is not mandated — the canonical schema documents metadata
		// shape, it does not require every producer to supply every field.
		const absent = validEvent("dispatch_abandoned");
		delete (absent.metadata as Record<string, unknown>).claimed_sentinel;
		expect(validateEvent(absent).valid).toBe(true);

		// But a present field of the wrong type is still a defect.
		const wrong = validEvent("dispatch_abandoned");
		(wrong.metadata as Record<string, unknown>).claimed_sentinel = 42;
		const result = validateEvent(wrong);
		expect(result.valid).toBe(false);
		expect(
			result.issues.some(
				(i) =>
					i.field === "metadata.claimed_sentinel" &&
					i.code === "type_mismatch",
			),
		).toBe(true);
	});

	it("accepts null for a *_or_null metadata field", () => {
		const e = validEvent("pi_session_complete");
		(e.metadata as Record<string, unknown>).working_duration_s = null;
		expect(validateEvent(e).valid).toBe(true);
	});

	it("rejects null for a non-nullable metadata field", () => {
		const e = validEvent("workspace_idle");
		(e.metadata as Record<string, unknown>).pane_count = null;
		expect(codes(e)).toContain("type_mismatch");
	});

	it("rejects NaN where a finite number is required", () => {
		const e = validEvent("workspace_idle");
		(e.metadata as Record<string, unknown>).pane_count = NaN;
		expect(codes(e)).toContain("type_mismatch");
	});

	it("rejects an unknown harness value", () => {
		const e = validEvent("tool_use");
		e.harness = "borg";
		expect(codes(e)).toContain("enum_violation");
	});

	it("isKnownEventType matches the rule table", () => {
		expect(isKnownEventType("session_summary")).toBe(true);
		expect(isKnownEventType("nope")).toBe(false);
		expect(isKnownEventType(undefined)).toBe(false);
		expect(isKnownEventType(42)).toBe(false);
	});
});

describe("F-007 regression guards", () => {
	it("RG-2: every EVENT_RULES entry has a fixture", () => {
		const missing = Object.keys(EVENT_RULES).filter(
			(t) => !Object.hasOwn(VALID_EVENTS, t),
		);
		expect(missing).toEqual([]);
	});

	it("RG-2b: no orphan fixture without a rule", () => {
		const orphans = Object.keys(VALID_EVENTS).filter(
			(t) => !Object.hasOwn(EVENT_RULES, t),
		);
		expect(orphans).toEqual([]);
	});

	it("fixtures are pinned to the vendored schema version", () => {
		for (const [type, fixture] of Object.entries(VALID_EVENTS)) {
			expect(fixture.schema_version, type).toBe(SCHEMA_VERSION);
		}
	});
});

describe("F-007 performance budget", () => {
	/**
	 * BT-3 protects against accidental O(n^2) work or hidden IO in the
	 * validator - not against a specific wall-clock number.
	 *
	 * The original form asserted "1000 events under 50ms" total, which was
	 * flaky on constrained hardware (observed 70ms on Termux under load) while
	 * still being ~0.07ms per event, i.e. entirely acceptable. A cold-JIT,
	 * shared-CPU total is the wrong thing to gate on.
	 *
	 * Warms up first, then asserts a per-event bound with real headroom.
	 */
	it("BT-3: per-event validation cost stays negligible", () => {
		const e = validEvent("session_summary");

		// Warm up the JIT so the measurement reflects steady state.
		for (let i = 0; i < 500; i++) validateEvent(e);

		const N = 2000;
		const start = performance.now();
		for (let i = 0; i < N; i++) validateEvent(e);
		const perEvent = (performance.now() - start) / N;

		// 0.5ms/event is ~7x the observed worst case here and still leaves the
		// BT-4 tool-path budget (<10ms p95) untouched at one validation per
		// emitted event.
		expect(perEvent).toBeLessThan(0.5);
	});

	it("BT-3b: cost scales linearly, not quadratically", () => {
		const e = validEvent("session_summary");
		for (let i = 0; i < 500; i++) validateEvent(e);

		const time = (n: number) => {
			const t0 = performance.now();
			for (let i = 0; i < n; i++) validateEvent(e);
			return performance.now() - t0;
		};

		const t1000 = time(1000);
		const t4000 = time(4000);

		// 4x the work should cost well under 8x the time. Generous bound so the
		// test catches complexity regressions without policing scheduler noise.
		expect(t4000).toBeLessThan(Math.max(t1000 * 8, 20));
	});
});
