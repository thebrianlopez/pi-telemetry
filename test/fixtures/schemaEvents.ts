/**
 * One canonical, schema-valid fixture per event type in the vendored snapshot.
 *
 * RG-2 depends on this map being exhaustive: adding an entry to EVENT_RULES
 * without adding a fixture here fails the suite.
 */

import { SCHEMA_VERSION } from "../../src/schema/eventSchema.ts";

/** Common envelope every fixture shares. */
export function envelope(overrides: Record<string, unknown> = {}) {
	return {
		schema_version: SCHEMA_VERSION,
		timestamp: "20260729T124754Z",
		session_id: "11111111-2222-3333-4444-555555555555",
		cwd: "/home/brian/pi-telemetry",
		agent: null,
		harness: "pi",
		agent_runtime: "pi-coding-agent",
		...overrides,
	};
}

export const VALID_EVENTS: Record<string, Record<string, unknown>> = {
	agent_lifecycle: envelope({
		event_type: "agent_lifecycle",
		layer: "orchestration",
		metadata: {
			pi_event_type: "agent_start",
			session_file: "~/.pi/agent/sessions/--repo--/ts_uuid.jsonl",
			task_id: null,
		},
	}),

	task_boundary: envelope({
		event_type: "task_boundary",
		layer: "orchestration",
		metadata: {
			task_id: "EPIC-251-M1",
			boundary_action: "claim",
			from_harness: null,
			to_harness: "pi",
			reason: "autonomous_execution",
			concurrent_billing_risk: false,
		},
	}),

	model_routing_decision: envelope({
		event_type: "model_routing_decision",
		layer: "orchestration",
		metadata: {
			classification: "model_switch",
			model_selected: "gpt-5.5",
			confidence: 1.0,
			override: false,
			session_id_ref: "11111111-2222-3333-4444-555555555555",
			baseline_model: null,
		},
	}),

	prompt_submit: envelope({
		event_type: "prompt_submit",
		layer: "cloud_llm",
		metadata: {
			input_tokens: 1200,
			output_tokens: 450,
		},
	}),

	tool_use: envelope({
		event_type: "tool_use",
		layer: "claude_code",
		metadata: {
			tool_name: "bash",
			source: "pi",
			first_word: "ls",
		},
	}),

	tool_result: envelope({
		event_type: "tool_result",
		layer: "claude_code",
		metadata: {
			tool_name: "bash",
			source: "pi",
			phase: "post",
			exit_code: "",
			tool_use_id: "tc-1",
			first_word: "ls",
			graduation_candidate: false,
		},
	}),

	tool_failure: envelope({
		event_type: "tool_failure",
		layer: "claude_code",
		metadata: {
			tool_name: "bash",
			error_class: "not_found",
			error_message: "no such file or directory",
			tool_use_id: "tc-1",
		},
	}),

	session_summary: envelope({
		event_type: "session_summary",
		layer: "claude_code",
		metadata: {
			tool_events: 3,
			prompt_count: 2,
			tool_distribution: { bash: 3 },
			model_distribution: { "gpt-5.5": 2 },
			input_tokens: 1200,
			output_tokens: 450,
			total_tokens: 1650,
			turns: 2,
			signal_source: "pi_extension",
		},
	}),

	layer_routing_decision: envelope({
		event_type: "layer_routing_decision",
		layer: "topology",
		metadata: {
			recommended_layer: "go_cli",
			actual_layer: "go_cli",
			confidence: 0.82,
			task_type: "doc_discovery",
			override: false,
		},
	}),

	pi_session_complete: envelope({
		event_type: "pi_session_complete",
		layer: "fish",
		metadata: {
			workspace_id: "w1",
			pane_id: "w1:p1",
			working_duration_s: 412,
		},
	}),

	dispatch_abandoned: envelope({
		event_type: "dispatch_abandoned",
		layer: "fish",
		metadata: {
			workspace_id: "w1",
			pane_id: "w1:p1",
			dispatch_dir: "/home/brian/pi-telemetry/.claude-dispatch",
			claimed_sentinel:
				"/home/brian/pi-telemetry/.claude-dispatch/EPIC-251.json.claimed",
			idle_duration_s: 95,
		},
	}),

	workspace_idle: envelope({
		event_type: "workspace_idle",
		layer: "fish",
		metadata: {
			workspace_id: "w1",
			pane_count: 3,
		},
	}),

	agent_status_stalled: envelope({
		event_type: "agent_status_stalled",
		layer: "fish",
		metadata: {
			workspace_id: "w1",
			pane_id: "w1:p1",
			stall_duration_s: 900,
		},
	}),
};

/** Deep clone so a mutating test cannot leak into a shuffled sibling. */
export function validEvent(type: string): Record<string, unknown> {
	return structuredClone(VALID_EVENTS[type]);
}
