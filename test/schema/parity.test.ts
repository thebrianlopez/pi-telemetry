/**
 * F-012 schema parity — EPIC-255 M1.
 *
 * The snapshot in `src/schema/eventSchema.ts` is vendored from
 * `core/schemas/event-schema.yaml`, a file in a different repository. Nothing
 * prevents that source from advancing without this package noticing.
 *
 * This suite reads the canonical file WHEN PRESENT and fails on real drift.
 * When absent — CI, a fresh Alpine node, any machine without a `core` checkout
 * — it skips with a visible warning rather than failing, because the package
 * must remain buildable and testable without `core`.
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
		it("SKIPPED: canonical schema not present on this machine", () => {
			// Deliberately not a failure. Surfaced loudly so a green suite on a
			// machine without `core` is never mistaken for verified parity.
			console.warn(
				`\n  [parity] canonical schema not found. Looked in:\n` +
					CANDIDATES.map((p) => `    - ${p}`).join("\n") +
					`\n  Drift from core/schemas/event-schema.yaml is UNVERIFIED in this run.` +
					`\n  Set AUTOMATION_METRICS_SCHEMA_PATH to check explicitly.\n`,
			);
			expect(SCHEMA_VERSION).toMatch(/^\d+(\.\d+)?$/);
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
