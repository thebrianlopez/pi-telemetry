/**
 * F-012 schema parity — EPIC-255 M1.
 *
 * The snapshot in `src/schema/eventSchema.ts` is vendored from
 * `core/schemas/event-schema.yaml`, a file in a different repository. Nothing
 * prevents that source from advancing without this package noticing.
 *
 * This suite reads the canonical file and fails on real drift.
 *
 * ABSENCE IS NOW A FAILURE. It used to `console.warn` and pass, which reported
 * success for a check that never ran — the same false-confidence failure class
 * this file exists to catch, applied to itself. A green suite must mean parity
 * was verified.
 *
 * Environments that genuinely lack a `core` checkout (CI, a fresh Alpine box)
 * opt out explicitly via `SEAM_CHECKS_UNVERIFIED_I_ACCEPT_DRIFT_RISK=1`. The
 * name is deliberately alarming: seeing it in a CI config or a shell profile
 * should read as a standing admission that schema drift is undetected there.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	EVENT_RULES,
	KNOWN_EVENT_TYPES,
	LAYERS,
	SCHEMA_MAJOR,
	SCHEMA_VERSION,
	majorVersion,
} from "../../src/schema/eventSchema.ts";
import { SEAM_OPT_OUT, seamChecksOptedOut } from "../seamOptOut.ts";

/** Candidate locations for the canonical schema, most specific first. */
const CANDIDATES = [
	process.env.AUTOMATION_METRICS_SCHEMA_PATH,
	join(homedir(), "core", "schemas", "event-schema.yaml"),
	join(homedir(), ".claude", "event-schema.yaml"),
].filter((p): p is string => Boolean(p));

function findCanonical(): string | null {
	for (const p of CANDIDATES) {
		if (existsSync(p)) return p;
	}
	return null;
}

const canonicalPath = findCanonical();
const canonical = canonicalPath ? readFileSync(canonicalPath, "utf8") : null;

/** Top-level `version: "x.y"` from the schema header. */
function canonicalVersion(src: string): string | null {
	const m = /^version:\s*"([^"]+)"/m.exec(src);
	return m ? m[1] : null;
}

/** Declared layer for an event type in the canonical source. */
function canonicalLayer(src: string, eventType: string): string | null {
	const block = new RegExp(
		`^  ${eventType}:\\n(?:    .*\\n|\\n)*?    layer:\\s*(\\w+)`,
		"m",
	).exec(src);
	return block ? block[1] : null;
}

/** Every layer name in the canonical `layers:` block. */
function canonicalLayers(src: string): string[] {
	const m = /^layers:\n((?:  \w+:\n(?:    .*\n|\n)*)*)/m.exec(src);
	if (!m) return [];
	return [...m[1].matchAll(/^  (\w+):/gm)].map((x) => x[1]);
}

describe("F-012 schema parity", () => {
	if (!canonical) {
		const where = CANDIDATES.map((p) => `    - ${p}`).join("\n");

		if (seamChecksOptedOut()) {
			it(`UNVERIFIED by opt-out (${SEAM_OPT_OUT})`, () => {
				console.warn(
					`\n  [parity] ${SEAM_OPT_OUT} is set. Parity against` +
						`\n  core/schemas/event-schema.yaml was NOT checked in this run.` +
						`\n  Looked in:\n${where}\n`,
				);
				expect(SCHEMA_VERSION).toMatch(/^\d+(\.\d+)?$/);
			});
			return;
		}

		it("canonical schema must be present for parity to be verifiable", () => {
			// Hard failure by design. A skip here would report success for a
			// comparison that never happened.
			throw new Error(
				`canonical event schema not found; parity is UNVERIFIABLE.\n` +
					`  Looked in:\n${where}\n` +
					`  Fix by either:\n` +
					`    - pointing AUTOMATION_METRICS_SCHEMA_PATH at core/schemas/event-schema.yaml, or\n` +
					`    - checking out core, or\n` +
					`    - setting ${SEAM_OPT_OUT}=1 to accept undetected schema drift\n` +
					`      in this environment.`,
			);
		});
		return;
	}

	it("CT-2: vendored major version matches the canonical document", () => {
		const version = canonicalVersion(canonical);
		expect(version, "canonical file declares no version").not.toBeNull();
		expect(
			majorVersion(version!),
			`canonical is ${version}, vendored snapshot is ${SCHEMA_VERSION}`,
		).toBe(SCHEMA_MAJOR);
	});

	it("reports the exact canonical version for drift review", () => {
		const version = canonicalVersion(canonical)!;
		if (version !== SCHEMA_VERSION) {
			console.warn(
				`\n  [parity] MINOR drift: canonical=${version} vendored=${SCHEMA_VERSION}.` +
					`\n  Compatible (same major), but review whether new optional fields` +
					`\n  should be adopted into the snapshot.\n`,
			);
		}
		expect(majorVersion(version)).toBe(SCHEMA_MAJOR);
	});

	it("every modelled event type still exists upstream", () => {
		const missing = KNOWN_EVENT_TYPES.filter(
			(t) => !new RegExp(`^  ${t}:`, "m").test(canonical),
		);
		expect(
			missing,
			`event types vendored here but absent upstream: ${missing.join(", ")}`,
		).toEqual([]);
	});

	it("every modelled event declares the same layer upstream", () => {
		const mismatches: string[] = [];
		for (const [type, rule] of Object.entries(EVENT_RULES)) {
			const upstream = canonicalLayer(canonical, type);
			if (upstream && upstream !== rule.layer) {
				mismatches.push(`${type}: vendored=${rule.layer} upstream=${upstream}`);
			}
		}
		expect(mismatches).toEqual([]);
	});

	it("the vendored layer vocabulary is a subset of upstream", () => {
		const upstream = canonicalLayers(canonical);
		expect(upstream.length).toBeGreaterThan(0);
		const extra = LAYERS.filter((l) => !upstream.includes(l));
		expect(
			extra,
			`layers vendored here but not upstream: ${extra.join(", ")}`,
		).toEqual([]);
	});

	it("records which file was checked", () => {
		expect(canonicalPath).toBeTruthy();
		console.log(`  [parity] verified against ${canonicalPath}`);
	});
});
