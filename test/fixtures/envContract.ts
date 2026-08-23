/**
 * The AUTOMATION_METRICS_* environment contract, as it actually is.
 *
 * This package reads 13 `AUTOMATION_METRICS_*` names at runtime. Nothing in
 * the type system or the build compares that set against what `core` actually
 * exports. Every one of them is read with a fallback, so a producer-side
 * rename does not raise: it degrades. Agent attribution becomes `null`, task
 * identity becomes `task_boundary_missing`, routing adoption becomes a
 * fabricated default. Same shape as the `.json`/`.md` dispatch bug and the
 * `id`/`workspace_id` payload bug: two components hand-type the same string,
 * nothing compares them, failure is silent.
 *
 * The table below is the recorded contract.
 * `test/schema/envContract.test.ts` checks it against both sides:
 * the consumer (source in this repo) and the producer (a live `core`).
 *
 * ---------------------------------------------------------------------------
 * THE THREE CLASSES, AND WHY THEY ARE TREATED DIFFERENTLY
 * ---------------------------------------------------------------------------
 *
 * `core_produced` - MUST have a producer.
 *   `core` sets it on the launch path and this package's output is materially
 *   wrong without it. A rename in `core` silently degrades every event.
 *   The test demands a live producer and fails when one is absent.
 *
 * `operator_override` - MAY have a producer, and usually must NOT.
 *   A per-invocation knob with a defined default. `core` deliberately does not
 *   export these; exporting them session-wide is the documented anti-pattern
 *   (see `core/AGENTS.md` on `AUTOMATION_METRICS_DIR`). Demanding a producer
 *   here would create a permanently red test, and a permanently red test gets
 *   disabled - which is strictly worse than no test. The test asserts the
 *   DEFAULT behaviour instead, because the default is the real contract.
 *
 * `unwired` - has NO producer anywhere, today.
 *   The consumer reads it and the code comments imply an injector ("if the
 *   hook layer supplied one"). That injector does not exist. These are not
 *   drift, they are unbuilt integration points. The test pins them at zero
 *   producers and fails if one APPEARS - because the day `core` starts
 *   exporting one, this table is wrong and the classification must be revisited.
 *   That is drift detection in the opposite direction, and it is the only
 *   assertion that stays honest without demanding a producer that should not
 *   exist yet.
 */

export type EnvClass = "core_produced" | "operator_override" | "unwired";

export interface EnvVarContract {
	/** Exact variable name, as hand-typed on both sides. */
	readonly name: string;
	readonly class: EnvClass;
	/** Where this package consumes it. */
	readonly readAt: string;
	/** What the consumer does when the variable is absent or unparseable. */
	readonly fallback: string;
	/**
	 * Would a producer-side rename be SILENT - no throw, no log, no missing
	 * field the validator would reject? True for every entry here; recorded
	 * per-row anyway so the claim is checkable rather than asserted in prose.
	 */
	readonly renameIsSilent: boolean;
	readonly note?: string;
}

/**
 * Every `AUTOMATION_METRICS_*` name read by `src/` or `extensions/`.
 *
 * Adding a read without adding a row here fails the fixture layer.
 */
export const ENV_CONTRACT: readonly EnvVarContract[] = [
	// --- class: core_produced -------------------------------------------
	{
		name: "AUTOMATION_METRICS_AGENT",
		class: "core_produced",
		readAt: "extensions/telemetry.ts resolveAgent()",
		fallback: "null - every event emits with no agent attribution",
		renameIsSilent: true,
		note:
			"Set by core in pi.fish, pi-core.fish, wk.fish, agora.fish, yolo.fish " +
			"via _am_identity, and passed through herdr `--env` by " +
			"pi-launch-dispatch.fish and wk-herdr-prd.fish. The one true seam.",
	},

	// --- class: operator_override ----------------------------------------
	{
		name: "AUTOMATION_METRICS_EVENTS_DIR",
		class: "operator_override",
		readAt: "extensions/telemetry.ts resolveEventsDir()",
		fallback: "~/.automation-metrics/events",
		renameIsSilent: true,
		note:
			"NOT the same name core uses. Core's readers honour " +
			"AUTOMATION_METRICS_DIR and append /events. See CORE_ONLY_ENV.",
	},
	{
		name: "AUTOMATION_METRICS_DISABLED",
		class: "operator_override",
		readAt: "extensions/telemetry.ts telemetryDisabled()",
		fallback: "false - emission stays on",
		renameIsSilent: true,
		note: "Kill switch. A rename makes the kill switch stop killing.",
	},
	{
		name: "AUTOMATION_METRICS_LIFECYCLE_DETAIL",
		class: "operator_override",
		readAt: "extensions/telemetry.ts resolveLifecycleDetail()",
		fallback: '"session"',
		renameIsSilent: true,
	},
	{
		name: "AUTOMATION_METRICS_PROMPT_CAPTURE",
		class: "operator_override",
		readAt: "extensions/telemetry.ts resolvePromptCapture()",
		fallback: '"preview"',
		renameIsSilent: true,
		note:
			"Privacy-relevant: a rename silently reverts `off`/`hash` to " +
			"`preview`, restoring prompt previews someone deliberately disabled.",
	},

	// --- class: unwired ---------------------------------------------------
	{
		name: "AUTOMATION_METRICS_TASK_ID",
		class: "unwired",
		readAt: "src/taskContext.ts resolveTaskContext() step 1",
		fallback: "falls through to dispatch-trigger resolution",
		renameIsSilent: true,
	},
	{
		name: "AUTOMATION_METRICS_CHAIN_KEY",
		class: "unwired",
		readAt: "src/taskContext.ts resolveTaskContext() step 3",
		fallback: 'diagnostic "task_boundary_missing"',
		renameIsSilent: true,
	},
	{
		name: "AUTOMATION_METRICS_FROM_HARNESS",
		class: "unwired",
		readAt: "src/taskContext.ts resolveInboundHarness()",
		fallback: "null - billingRisk() then always false",
		renameIsSilent: true,
	},
	{
		name: "AUTOMATION_METRICS_PROVIDER",
		class: "unwired",
		readAt: "src/taskContext.ts billingRisk()",
		fallback: '"" - local-model suppression never triggers',
		renameIsSilent: true,
	},
	{
		name: "AUTOMATION_METRICS_ROUTING_LAYER",
		class: "unwired",
		readAt: "extensions/telemetry.ts resolveRoutingRecommendation()",
		fallback: "null - the whole recommendation is dropped",
		renameIsSilent: true,
		note: "Gates the other three ROUTING_* reads; if it is absent they never run.",
	},
	{
		name: "AUTOMATION_METRICS_ROUTING_CONFIDENCE",
		class: "unwired",
		readAt: "extensions/telemetry.ts resolveRoutingRecommendation()",
		fallback: "0.5 - a fabricated midpoint, not null",
		renameIsSilent: true,
	},
	{
		name: "AUTOMATION_METRICS_ROUTING_TOOL",
		class: "unwired",
		readAt: "extensions/telemetry.ts resolveRoutingRecommendation()",
		fallback: "null",
		renameIsSilent: true,
	},
	{
		name: "AUTOMATION_METRICS_ROUTING_TASK_TYPE",
		class: "unwired",
		readAt: "extensions/telemetry.ts resolveRoutingRecommendation()",
		fallback: '"unspecified"',
		renameIsSilent: true,
	},
] as const;

/**
 * Read by the test suite only, never by shipped code, so it is not part of the
 * runtime contract and the fixture layer excludes it from the source scan.
 */
export const TEST_ONLY_ENV = ["AUTOMATION_METRICS_SCHEMA_PATH"] as const;

/**
 * Core's bus-redirect knob, and the sharpest finding in this table.
 *
 * Every core reader (`ametrics-status`, `ahealth`, `aregress`, `arec`,
 * `atopology`, `agrad`, `ascore-composite`, ...) resolves
 * `$AUTOMATION_METRICS_DIR/events`. This package honours no such variable - its
 * writer reads `AUTOMATION_METRICS_EVENTS_DIR`, a DIFFERENT name denoting a
 * DIFFERENT level of the path (the events dir itself, not its parent).
 *
 * So an operator who redirects the bus per core's own documented convention
 * moves the READERS and leaves this WRITER pointed at the default. Nothing
 * errors; the redirected dashboard just reports "No events". The two sides
 * agree only because their defaults coincide, which is exactly what
 * {@link CORE_DEFAULT_EVENTS_DIR} pins.
 *
 * Recorded, not "fixed": making this package honour AUTOMATION_METRICS_DIR is a
 * behaviour change that belongs to whoever owns the redirect semantics.
 */
export const CORE_REDIRECT_ENV = "AUTOMATION_METRICS_DIR";

/**
 * Names neither side produces.
 *
 * `AUTOMATION_METRICS_LOG` is read by `core/org-overrides/claude-hooks/
 * validate-command.fish` behind a `set -q` guard and assigned by nothing in
 * core. It is core's own operator override, listed here only so it is not
 * mistaken for a producer this package lost.
 */
export const CORE_ONLY_ENV = [CORE_REDIRECT_ENV, "AUTOMATION_METRICS_LOG"] as const;

/**
 * The default bus location, hand-typed on both sides.
 *
 * Core spells it `~/.automation-metrics/events` in ~40 places; this package
 * builds it with `join(homedir(), ".automation-metrics", "events")`. Neither
 * side imports the other. If core relocates the bus, this package keeps
 * writing to an orphaned directory and every core reader reports "no events".
 */
export const CORE_DEFAULT_EVENTS_DIR = "~/.automation-metrics/events";

/** Path segments of {@link CORE_DEFAULT_EVENTS_DIR}, relative to `$HOME`. */
export const DEFAULT_EVENTS_DIR_SEGMENTS = [
	".automation-metrics",
	"events",
] as const;

export function namesInClass(c: EnvClass): string[] {
	return ENV_CONTRACT.filter((e) => e.class === c).map((e) => e.name);
}
