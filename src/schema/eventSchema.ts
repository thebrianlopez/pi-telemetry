/**
 * Vendored snapshot of the canonical automation-metrics event schema.
 *
 * Source of truth: `core/schemas/event-schema.yaml` (symlinked as
 * `~/.claude/event-schema.yaml`). This file mirrors ONLY the event types this
 * package writes or correlates against — 13 of the 40+ types in the canonical
 * schema.
 *
 * Why vendored instead of parsed at runtime (TDD F-007 §Rationale):
 * Alpine ASG instances and CI have no `core` checkout, so a runtime YAML read
 * would couple emission to a filesystem layout that does not exist on the
 * deployment target. Drift risk is accepted here and closed by the schema
 * parity test in F-012 / EPIC-255.
 *
 * When the canonical schema advances, bump SCHEMA_VERSION and update this table
 * in the same commit.
 */

export const SCHEMA_VERSION = "2.14";

/** Layer vocabulary from the canonical schema's `layers:` block. */
export const LAYERS = [
	"cloud_llm",
	"fish",
	"go_cli",
	"go_lib",
	"topology",
	"interactive_shell",
	"claude_code",
	"orchestration",
] as const;

export type EventLayer = (typeof LAYERS)[number];

/** Primitive kinds this validator distinguishes. */
export type FieldKind =
	| "string"
	| "number"
	| "boolean"
	| "object"
	| "string_or_null"
	| "number_or_null"
	| "boolean_or_null";

export interface FieldRule {
	kind: FieldKind;
	/** Permitted values. `null` is allowed independently via `*_or_null` kinds. */
	enum?: readonly string[];
}

export interface EventRule {
	/** The layer this event MUST carry. */
	layer: EventLayer;
	/** Metadata keys that must be present, with their type/enum contract. */
	metadata?: Record<string, FieldRule>;
}

// --- Shared enums ------------------------------------------------------------

export const HARNESSES = ["claude_code", "pi", "manual", "other"] as const;

export const PI_EVENT_TYPES = [
	"agent_start",
	"agent_end",
	"tool_execution_start",
	"tool_execution_end",
	"model_select",
] as const;

export const BOUNDARY_ACTIONS = [
	"claim",
	"handoff",
	"suspend",
	"resume",
	"release",
] as const;

export const ERROR_CLASSES = [
	"permission_denied",
	"timeout",
	"not_found",
	"validation_error",
	"network_error",
	"hook_blocked",
	"resource_exhausted",
	"unknown",
] as const;

export const ROUTING_LAYERS = ["fish", "go_cli", "cloud_llm"] as const;

export const APPROVALS = ["approved", "rejected", "unknown"] as const;

export const TASK_CATEGORIES = [
	"dispatch",
	"exploration",
	"bugfix",
	"code_review",
	"discovery",
	"planning",
	"configuration",
	"documentation",
	"confirmation",
	"other",
] as const;

// --- Common field contract ---------------------------------------------------

/**
 * Fields required on every event regardless of type.
 *
 * `agent` is `string_or_null`: the canonical schema permits a null agent when
 * AUTOMATION_METRICS_AGENT is unset, but the KEY must be present so consumers
 * can distinguish "unattributed" from "field forgotten".
 */
export const COMMON_FIELDS: Record<string, FieldRule> = {
	schema_version: { kind: "string" },
	timestamp: { kind: "string" },
	event_type: { kind: "string" },
	layer: { kind: "string", enum: LAYERS },
	session_id: { kind: "string" },
	agent: { kind: "string_or_null" },
	cwd: { kind: "string" },
	harness: { kind: "string", enum: HARNESSES },
	agent_runtime: { kind: "string" },
	metadata: { kind: "object" },
};

/** Compact UTC form used across the bus: YYYYMMDDTHHMMSSZ. */
export const TIMESTAMP_PATTERN = /^\d{8}T\d{6}Z$/;

// --- Event table -------------------------------------------------------------

export const EVENT_RULES: Record<string, EventRule> = {
	// ── Pi harness lifecycle (orchestration) ──
	agent_lifecycle: {
		layer: "orchestration",
		metadata: {
			pi_event_type: { kind: "string", enum: PI_EVENT_TYPES },
			session_file: { kind: "string_or_null" },
			task_id: { kind: "string_or_null" },
		},
	},
	task_boundary: {
		layer: "orchestration",
		metadata: {
			task_id: { kind: "string" },
			boundary_action: { kind: "string", enum: BOUNDARY_ACTIONS },
			from_harness: { kind: "string_or_null", enum: HARNESSES },
			to_harness: { kind: "string_or_null", enum: HARNESSES },
			reason: { kind: "string_or_null" },
			concurrent_billing_risk: { kind: "boolean" },
		},
	},
	model_routing_decision: {
		layer: "orchestration",
		metadata: {
			classification: { kind: "string" },
			model_selected: { kind: "string" },
			confidence: { kind: "number" },
			override: { kind: "boolean" },
			session_id_ref: { kind: "string_or_null" },
			baseline_model: { kind: "string_or_null" },
		},
	},

	// ── Prompt layer (cloud_llm) ──
	prompt_submit: {
		layer: "cloud_llm",
		metadata: {
			input_tokens: { kind: "number" },
			output_tokens: { kind: "number" },
		},
	},

	// ── Tool + session lifecycle (claude_code) ──
	tool_use: {
		layer: "claude_code",
		metadata: {
			tool_name: { kind: "string" },
			source: { kind: "string" },
			first_word: { kind: "string" },
		},
	},
	tool_result: {
		layer: "claude_code",
		metadata: {
			tool_name: { kind: "string" },
			source: { kind: "string" },
			phase: { kind: "string", enum: ["post"] },
			exit_code: { kind: "string" },
			tool_use_id: { kind: "string" },
			first_word: { kind: "string" },
			graduation_candidate: { kind: "boolean" },
		},
	},
	tool_failure: {
		layer: "claude_code",
		metadata: {
			tool_name: { kind: "string" },
			error_class: { kind: "string", enum: ERROR_CLASSES },
			error_message: { kind: "string" },
			tool_use_id: { kind: "string" },
		},
	},
	session_summary: {
		layer: "claude_code",
		metadata: {
			tool_events: { kind: "number" },
			prompt_count: { kind: "number" },
			tool_distribution: { kind: "object" },
			model_distribution: { kind: "object" },
			input_tokens: { kind: "number" },
			output_tokens: { kind: "number" },
			total_tokens: { kind: "number" },
			turns: { kind: "number" },
			signal_source: { kind: "string" },
		},
	},

	// ── Routing observability (topology) ──
	layer_routing_decision: {
		layer: "topology",
		metadata: {
			recommended_layer: { kind: "string", enum: ROUTING_LAYERS },
			actual_layer: { kind: "string", enum: ROUTING_LAYERS },
			confidence: { kind: "number" },
			task_type: { kind: "string" },
			override: { kind: "boolean" },
		},
	},

	// ── Herdr observer transitions (fish) ──
	pi_session_complete: {
		layer: "fish",
		metadata: {
			workspace_id: { kind: "string" },
			pane_id: { kind: "string" },
			working_duration_s: { kind: "number_or_null" },
		},
	},
	dispatch_abandoned: {
		layer: "fish",
		metadata: {
			workspace_id: { kind: "string" },
			pane_id: { kind: "string" },
			dispatch_dir: { kind: "string" },
			claimed_sentinel: { kind: "string" },
			idle_duration_s: { kind: "number_or_null" },
		},
	},
	workspace_idle: {
		layer: "fish",
		metadata: {
			workspace_id: { kind: "string" },
			pane_count: { kind: "number" },
		},
	},
	agent_status_stalled: {
		layer: "fish",
		metadata: {
			workspace_id: { kind: "string" },
			pane_id: { kind: "string" },
			stall_duration_s: { kind: "number" },
		},
	},
};

/** Every event type covered by this snapshot. */
export const KNOWN_EVENT_TYPES = Object.keys(EVENT_RULES);
