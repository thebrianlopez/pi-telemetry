/**
 * Task identity resolution for `task_boundary` events.
 *
 * Pi has no intrinsic notion of an epic or milestone, so task identity is
 * always *derived* from surrounding context and never invented. When no stable
 * context exists, resolution returns `null` and the caller emits nothing.
 *
 * Fabricating a task id from the session UUID would be worse than silence: it
 * would never correlate with the same task claimed under Claude Code, making
 * `duplicate_active_task` permanently false-negative — which is the exact
 * failure this feature exists to detect.
 *
 * Precedence (first match wins, per TDD F-010 §2):
 *   1. AUTOMATION_METRICS_TASK_ID   explicit operator override
 *   2. .claude-dispatch/*.json      dispatch trigger in the workspace
 *   3. AUTOMATION_METRICS_CHAIN_KEY chain-scoped work
 *   4. none                         no boundary event is emitted
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type TaskContextSource = "env" | "dispatch" | "chain_key" | "none";

export interface TaskContext {
	taskId: string | null;
	source: TaskContextSource;
	/** Populated only when resolved from a dispatch trigger. */
	epic: string | null;
	milestones: string[];
	/** Diagnostic set when a trigger was present but unusable. */
	diagnostic: string | null;
}

const EMPTY: TaskContext = {
	taskId: null,
	source: "none",
	epic: null,
	milestones: [],
	diagnostic: null,
};

/**
 * `PERSONAL_..._EPIC-237_fetchpage.md` -> `EPIC-237`
 *
 * Note on the boundaries: `\b` is wrong here. Underscore is a word character,
 * so `\bEPIC` never matches inside `_EPIC-237_` — which is the exact shape of
 * every real dispatch filename. Uses an explicit letter lookbehind instead,
 * plus a digit lookahead so `EPIC-23` does not match inside `EPIC-237`.
 */
export function epicIdFrom(text: unknown): string | null {
	if (typeof text !== "string") return null;
	const m = /(?<![A-Za-z])EPIC-(\d+)(?!\d)/.exec(text);
	return m ? `EPIC-${m[1]}` : null;
}

/** `"M1,M2,M5"` -> `["M1","M2","M5"]`; tolerates spaces and empties. */
export function parseMilestones(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((v): v is string => typeof v === "string");
	}
	if (typeof value !== "string") return [];
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Compose the canonical task id for a dispatch.
 *
 * A single-milestone dispatch yields `EPIC-237-M1`, matching the TDD's stated
 * shape. A multi-milestone dispatch yields bare `EPIC-237`: the epic is the
 * unit of ownership, and two harnesses working *any* part of the same epic
 * concurrently is the billing anti-pattern worth flagging. Encoding a
 * milestone list into the id would fragment that signal.
 */
export function composeTaskId(
	epic: string | null,
	milestones: string[],
): string | null {
	if (!epic) return null;
	return milestones.length === 1 ? `${epic}-${milestones[0]}` : epic;
}

interface Trigger {
	file: string;
	epic: string | null;
	milestones: string[];
	claimed: boolean;
}

/** Read and parse every dispatch trigger in a directory. Never throws. */
export function readTriggers(dispatchDir: string): Trigger[] {
	let names: string[];
	try {
		if (!existsSync(dispatchDir)) return [];
		names = readdirSync(dispatchDir).filter((n) => n.endsWith(".json"));
	} catch {
		return [];
	}

	const triggers: Trigger[] = [];
	for (const name of names.sort()) {
		const file = join(dispatchDir, name);
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<
				string,
				unknown
			>;
			triggers.push({
				file,
				epic:
					epicIdFrom(parsed.epic) ??
					epicIdFrom(parsed.epic_path) ??
					epicIdFrom(name),
				milestones: parseMilestones(parsed.milestones),
				claimed: existsSync(`${file}.claimed`),
			});
		} catch {
			// Unparseable body, but the filename still encodes the epic id.
			// Degrade to name-based resolution rather than losing ownership
			// entirely — a corrupt trigger should not silently drop the task.
			triggers.push({
				file,
				epic: epicIdFrom(name),
				milestones: [],
				claimed: existsSync(`${file}.claimed`),
			});
		}
	}
	return triggers;
}

export interface ResolveOptions {
	/** Directory to search. Defaults to `<cwd>/.claude-dispatch`. */
	dispatchDir?: string;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

/**
 * Resolve task context once per session.
 *
 * Deliberately not called per event: the dispatch directory is on the
 * filesystem, and the hot tool path must not touch it.
 */
export function resolveTaskContext(opts: ResolveOptions = {}): TaskContext {
	const env = opts.env ?? process.env;
	const cwd = opts.cwd ?? process.cwd();

	// 1. Explicit override.
	const explicit = env.AUTOMATION_METRICS_TASK_ID;
	if (typeof explicit === "string" && explicit.trim() !== "") {
		return {
			...EMPTY,
			taskId: explicit.trim(),
			source: "env",
			epic: epicIdFrom(explicit),
		};
	}

	// 2. Dispatch trigger.
	const dispatchDir = opts.dispatchDir ?? join(cwd, ".claude-dispatch");
	const triggers = readTriggers(dispatchDir);
	if (triggers.length > 0) {
		// Prefer an unclaimed trigger; fall back to the first claimed one so a
		// resumed session still reports ownership.
		const chosen =
			triggers.find((t) => !t.claimed && t.epic) ??
			triggers.find((t) => t.epic);

		if (chosen) {
			return {
				taskId: composeTaskId(chosen.epic, chosen.milestones),
				source: "dispatch",
				epic: chosen.epic,
				milestones: chosen.milestones,
				diagnostic: null,
			};
		}

		// Triggers existed but none yielded an epic id.
		return {
			...EMPTY,
			diagnostic: `task_id_unresolvable: ${triggers.length} trigger(s) in ${dispatchDir} yielded no EPIC id`,
		};
	}

	// 3. Chain key.
	const chainKey = env.AUTOMATION_METRICS_CHAIN_KEY;
	if (typeof chainKey === "string" && chainKey.trim() !== "") {
		return {
			...EMPTY,
			taskId: chainKey.trim(),
			source: "chain_key",
		};
	}

	// 4. Nothing. Caller emits no boundary event.
	return { ...EMPTY, diagnostic: "task_boundary_missing" };
}

/** Harness vocabulary accepted for inbound handoff context. */
export const HARNESS_VALUES = ["claude_code", "pi", "manual", "other"] as const;
export type Harness = (typeof HARNESS_VALUES)[number];

export function resolveInboundHarness(
	env: NodeJS.ProcessEnv = process.env,
): Harness | null {
	const v = env.AUTOMATION_METRICS_FROM_HARNESS;
	return typeof v === "string" &&
		(HARNESS_VALUES as readonly string[]).includes(v)
		? (v as Harness)
		: null;
}

/**
 * Whether this session may overlap a paid session in another harness.
 *
 * Local-model work is never a billing risk regardless of inbound harness, so
 * an explicit local provider suppresses the flag.
 */
export function billingRisk(
	fromHarness: Harness | null,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (!fromHarness || fromHarness === "pi") return false;
	const provider = (env.AUTOMATION_METRICS_PROVIDER ?? "").toLowerCase();
	if (provider === "ollama" || provider === "local") return false;
	return fromHarness === "claude_code";
}
