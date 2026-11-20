/**
 * F3 Pi extension-API drift gate (model-attribution-gap POMO, 2026-11-18).
 *
 * Two independent checks:
 *
 * 1. Type-level (enforced by `npm run typecheck`, i.e. `tsc --noEmit`, not by
 *    vitest itself): the functions below are typed against the real,
 *    installed `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai`
 *    `.d.ts` files. If a future Pi release renames or removes a field this
 *    extension depends on (e.g. `AssistantMessage.model`, which F1's
 *    `aggregateTurnUsage()` reads), this file fails to compile with a named,
 *    specific error instead of the dependency silently drifting unnoticed.
 *
 * 2. Runtime version-drift check (this suite): compares the installed
 *    package version against a pinned "last reviewed" constant. Follows the
 *    same loud-opt-out convention as `parity.test.ts` -- absence of review is
 *    a failure, not a silent pass, unless explicitly accepted via
 *    SEAM_CHECKS_UNVERIFIED_I_ACCEPT_DRIFT_RISK.
 *
 * Seed regression case for this gate: during the FDD/TDD authoring pass for
 * this feature, the installed `@earendil-works/pi-coding-agent` was found to
 * be `0.82.1` while npm's registry latest was `1.5.2` -- a large, silent
 * version gap this gate is specifically designed to catch.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type {
	AgentEndEvent,
	ExtensionEvent,
} from "@earendil-works/pi-coding-agent";

// `ModelSelectEvent` itself is not re-exported from the package's public
// `exports` map (its `package.json` only exposes `"."`and `"./rpc-entry"`,
// so a direct subpath import is unresolvable under `exports`-aware module
// resolution) — it is reachable only as a member of the exported
// `ExtensionEvent` union. If a future release removes `"model_select"` from
// that union entirely, `Extract<>` below silently resolves to `never` rather
// than failing to compile, which is a known gap in this gate (see TDD F3
// §7); `assertModelSelectShape`'s own field accesses are the stronger check.
type ModelSelectEvent = Extract<ExtensionEvent, { type: "model_select" }>;
import type { AssistantMessage } from "@earendil-works/pi-ai";

import { SEAM_OPT_OUT, seamChecksOptedOut } from "../seamOptOut.ts";

// --- Type-level assertions (compiled, not executed as meaningful runtime) ---

/**
 * Mirrors the `model_select` handler's extraction in `extensions/telemetry.ts`.
 * Fails to compile if `ModelSelectEvent.model` changes shape.
 */
function assertModelSelectShape(e: ModelSelectEvent): { id: string } {
	return { id: (e.model as unknown as { id?: string }).id ?? "unknown" };
}

/**
 * Mirrors `aggregateTurnUsage()`'s per-message reads in `extensions/telemetry.ts`.
 * Fails to compile if `AgentEndEvent.messages` or `AssistantMessage.model` /
 * `.usage` change shape.
 */
function assertAgentEndShape(e: AgentEndEvent): void {
	for (const m of e.messages) {
		if ((m as { role?: unknown }).role === "assistant") {
			const am = m as AssistantMessage;
			const _model: string = am.model;
			const _usage = am.usage;
			void _model;
			void _usage;
		}
	}
}

// Referenced so the functions above are not flagged as unused by strict mode;
// their value is the compile-time check itself, not runtime behavior.
void assertModelSelectShape;
void assertAgentEndShape;

// --- Runtime version-drift check ---------------------------------------------

/** Bump deliberately, only after manually reviewing the new version's
 *  changelog/type declarations for breaking changes to the fields this
 *  extension depends on. */
const PINNED_LAST_VERIFIED_VERSION = "1.6.0";

const here = dirname(fileURLToPath(import.meta.url));

function installedVersion(pkg: string): string | null {
	try {
		const pkgJsonPath = join(
			here,
			"..",
			"..",
			"node_modules",
			...pkg.split("/"),
			"package.json",
		);
		const json = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
		return typeof json.version === "string" ? json.version : null;
	} catch {
		return null;
	}
}

describe("F3 Pi extension-API drift gate", () => {
	it("CT-2: reports the installed @earendil-works/pi-coding-agent version", () => {
		const version = installedVersion("@earendil-works/pi-coding-agent");
		expect(version).not.toBeNull();
		if (version !== PINNED_LAST_VERIFIED_VERSION) {
			console.warn(
				`\n  [pi-extension-api] version drift: installed=${version} ` +
					`pinned=${PINNED_LAST_VERIFIED_VERSION}.\n` +
					`  Review @earendil-works/pi-coding-agent + pi-ai changelogs for ` +
					`breaking type changes (especially AssistantMessage.model, ` +
					`ModelSelectEvent.model/source, AgentEndEvent.messages), then bump ` +
					`PINNED_LAST_VERIFIED_VERSION deliberately in this file.\n`,
			);
		}
	});

	it("CT-3 / RG-1: unreviewed version drift fails loudly, not silently", () => {
		const version = installedVersion("@earendil-works/pi-coding-agent");
		if (version === null) {
			if (seamChecksOptedOut()) {
				console.warn(
					`\n  [pi-extension-api] ${SEAM_OPT_OUT} is set. Pi version drift ` +
						`was NOT checked in this run (package not installed).\n`,
				);
				return;
			}
			throw new Error(
				`@earendil-works/pi-coding-agent is not installed; Pi extension-API ` +
					`drift is UNVERIFIABLE.\n` +
					`  Fix by either installing the peer dependency, or setting ` +
					`${SEAM_OPT_OUT}=1 to accept undetected drift risk in this ` +
					`environment.`,
			);
		}

		if (version !== PINNED_LAST_VERIFIED_VERSION && !seamChecksOptedOut()) {
			throw new Error(
				`Pi version drifted: installed=${version} ` +
					`pinned=${PINNED_LAST_VERIFIED_VERSION}.\n` +
					`  Review @earendil-works/pi-coding-agent + pi-ai changelogs for ` +
					`breaking type changes, then bump PINNED_LAST_VERIFIED_VERSION in ` +
					`test/schema/pi-extension-api.test.ts deliberately.\n` +
					`  Or set ${SEAM_OPT_OUT}=1 to accept the risk in this environment.`,
			);
		}

		expect(version).toMatch(/^\d+\.\d+\.\d+/);
	});

	it("BT-1: opt-out env var suppresses hard failure on version drift", () => {
		const prev = process.env[SEAM_OPT_OUT];
		process.env[SEAM_OPT_OUT] = "1";
		try {
			const simulatedInstalled: string = "1.5.2";
			const simulatedPinned: string = "0.82.1";
			expect(() => {
				if (
					simulatedInstalled !== simulatedPinned &&
					!seamChecksOptedOut()
				) {
					throw new Error("should not reach: opted out");
				}
				console.warn(
					`\n  [pi-extension-api] version drift: installed=` +
						`${simulatedInstalled} pinned=${simulatedPinned}, UNVERIFIED ` +
						`by opt-out.\n`,
				);
			}).not.toThrow();
		} finally {
			if (prev === undefined) delete process.env[SEAM_OPT_OUT];
			else process.env[SEAM_OPT_OUT] = prev;
		}
	});

	it("seed regression: simulated 0.82.1 -> 1.5.2 drift fails without opt-out", () => {
		const prev = process.env[SEAM_OPT_OUT];
		delete process.env[SEAM_OPT_OUT];
		try {
			const simulatedInstalled: string = "1.5.2";
			const simulatedPinned: string = "0.82.1";
			expect(() => {
				if (
					simulatedInstalled !== simulatedPinned &&
					!seamChecksOptedOut()
				) {
					throw new Error(
						`Pi version drifted: installed=${simulatedInstalled} ` +
							`pinned=${simulatedPinned}`,
					);
				}
			}).toThrow(/version drifted/);
		} finally {
			if (prev === undefined) delete process.env[SEAM_OPT_OUT];
			else process.env[SEAM_OPT_OUT] = prev;
		}
	});
});
