import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export const SCHEMA_VERSION = "2.14";

// --- Emitter ---

/**
 * Resolve the events directory at call time (never at import time) so tests can
 * redirect writes away from the live event bus.
 *
 * Precedence: explicit override > AUTOMATION_METRICS_EVENTS_DIR > ~/.automation-metrics/events
 */
export function resolveEventsDir(override?: string): string {
	if (override) return override;
	const fromEnv = process.env.AUTOMATION_METRICS_EVENTS_DIR;
	if (fromEnv) return fromEnv;
	return join(homedir(), ".automation-metrics", "events");
}

export interface EmitOptions {
	/** Destination directory. Defaults to {@link resolveEventsDir}. */
	dir?: string;
	/** Clock injection point. Defaults to `new Date()`. */
	now?: Date;
}

export function formatTimestamp(date: Date): string {
	return date
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}/, "");
}

export function dateFileName(date: Date): string {
	return `${date.toISOString().slice(0, 10)}.jsonl`;
}

export function emit(
	event: Record<string, unknown>,
	opts: EmitOptions = {},
): void {
	try {
		const dir = resolveEventsDir(opts.dir);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const now = opts.now ?? new Date();
		const line = JSON.stringify({
			schema_version: SCHEMA_VERSION,
			timestamp: formatTimestamp(now),
			...event,
		});
		appendFileSync(join(dir, dateFileName(now)), line + "\n");
	} catch {
		// telemetry must never crash the agent
	}
}

// --- Agent Identity ---

export function resolveAgent(): string | null {
	return process.env.AUTOMATION_METRICS_AGENT || null;
}

// --- Helpers ---

export function isAssistantMessage(message: unknown): message is AssistantMessage {
	if (!message || typeof message !== "object") return false;
	return (message as { role?: unknown }).role === "assistant";
}

export function firstWord(command: string | undefined): string {
	if (!command) return "";
	return command.trim().split(/\s+/)[0] || "";
}

/**
 * Flatten a Pi tool result `content` array into plain text.
 *
 * `ToolResultEvent.content` is `(TextContent | ImageContent)[]`; only text parts
 * carry diagnostic value. Accepts `unknown` because handlers must never throw.
 */
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (
			part &&
			typeof part === "object" &&
			(part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string"
		) {
			parts.push((part as { text: string }).text);
		}
	}
	return parts.join("\n");
}

export function classifyError(toolName: string, result: unknown): string {
	const lower = contentText(result).slice(0, 500).toLowerCase();
	if (lower.includes("not found") || lower.includes("no such file"))
		return "not_found";
	if (lower.includes("permission") || lower.includes("denied"))
		return "permission_denied";
	if (lower.includes("timeout") || lower.includes("timed out"))
		return "timeout";
	if (lower.includes("blocked")) return "hook_blocked";
	return "unknown";
}

export function errorMessage(result: unknown): string {
	return contentText(result).slice(0, 200);
}

// --- Session State ---

export interface SessionState {
	sessionId: string;
	cwd: string;
	agent: string | null;
	startedAt: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	toolEvents: number;
	toolErrors: number;
	toolDistribution: Record<string, number>;
	modelDistribution: Record<string, number>;
	promptCount: number;
	turns: number;
}

export function freshState(): SessionState {
	return {
		sessionId: randomUUID(),
		cwd: process.cwd(),
		agent: resolveAgent(),
		startedAt: Date.now(),
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		toolEvents: 0,
		toolErrors: 0,
		toolDistribution: {},
		modelDistribution: {},
		promptCount: 0,
		turns: 0,
	};
}

// --- Derived Metrics (pure) ---

export interface TurnUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	turns: number;
}

/** Aggregate token usage across the assistant messages of one agent_end turn. */
export function aggregateTurnUsage(messages: readonly unknown[]): TurnUsage {
	const usage: TurnUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		turns: 0,
	};
	for (const message of messages) {
		if (!isAssistantMessage(message)) continue;
		usage.input += message.usage.input || 0;
		usage.output += message.usage.output || 0;
		usage.cacheRead += message.usage.cacheRead || 0;
		usage.cacheWrite += message.usage.cacheWrite || 0;
		usage.turns++;
	}
	return usage;
}

/** Share of turns routed to an Opus-class model, as a percentage. */
export function opusPct(state: SessionState): number {
	let opusTurns = 0;
	for (const [modelId, count] of Object.entries(state.modelDistribution)) {
		if (modelId.toLowerCase().includes("opus")) {
			opusTurns += count;
		}
	}
	return state.turns > 0 ? (opusTurns / state.turns) * 100 : 0;
}

/** Build the session_summary metadata block. `nowMs` is injectable for tests. */
export function summaryMetadata(
	state: SessionState,
	nowMs: number = Date.now(),
): { durationMs: number; metadata: Record<string, unknown> } {
	const durationMs = nowMs - state.startedAt;
	const durationMinutes = Math.round(durationMs / 60000);

	const effectiveInput =
		state.inputTokens + state.cacheReadTokens + state.cacheWriteTokens;
	const totalTokens = effectiveInput + state.outputTokens;
	const cacheHitPct =
		effectiveInput > 0
			? (state.cacheReadTokens / effectiveInput) * 100
			: 0;

	return {
		durationMs,
		metadata: {
			duration_minutes: durationMinutes,
			input_tokens: state.inputTokens,
			output_tokens: state.outputTokens,
			cache_read_tokens: state.cacheReadTokens,
			cache_write_tokens: state.cacheWriteTokens,
			cache_write_1h_tokens: 0,
			cache_write_5m_tokens: 0,
			web_search_requests: 0,
			effective_input_tokens: effectiveInput,
			total_tokens: totalTokens,
			cache_hit_pct: Math.round(cacheHitPct * 10) / 10,
			opus_pct: Math.round(opusPct(state) * 10) / 10,
			tool_events: state.toolEvents,
			tool_distribution: state.toolDistribution,
			model_distribution: state.modelDistribution,
			prompt_count: state.promptCount,
			turns: state.turns,
			signal_source: "pi_extension",
		},
	};
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
	let state = freshState();

	function commonFields(): Record<string, unknown> {
		return {
			layer: "claude_code",
			session_id: state.sessionId,
			cwd: state.cwd,
			agent: state.agent,
			harness: "pi",
			agent_runtime: "pi-coding-agent",
		};
	}

	pi.on("session_start", async (_event, _ctx) => {
		state = freshState();
	});

	pi.on("tool_call", async (event, _ctx) => {
		const toolName = event.toolName;
		const fw =
			toolName === "bash"
				? firstWord(
						(event.input as { command?: string }).command,
					)
				: toolName;

		emit({
			...commonFields(),
			event_type: "tool_use",
			command: toolName,
			metadata: {
				tool_name: toolName,
				source: "pi",
				first_word: fw,
			},
		});

		state.toolDistribution[toolName] =
			(state.toolDistribution[toolName] || 0) + 1;
	});

	pi.on("tool_result", async (event, _ctx) => {
		const toolName = event.toolName;
		const fw =
			toolName === "bash"
				? firstWord(
						(event.input as { command?: string } | undefined)
							?.command,
					)
				: toolName;

		state.toolEvents++;

		if (event.isError) {
			state.toolErrors++;
			emit({
				...commonFields(),
				event_type: "tool_failure",
				command: toolName,
				metadata: {
					tool_name: toolName,
					error_class: classifyError(toolName, event.content),
					error_message: errorMessage(event.content),
					tool_use_id: event.toolCallId || "",
				},
			});
		} else {
			emit({
				...commonFields(),
				event_type: "tool_result",
				command: toolName,
				metadata: {
					tool_name: toolName,
					source: "pi",
					phase: "post",
					exit_code: "",
					tool_use_id: event.toolCallId || "",
					first_word: fw,
					graduation_candidate: false,
				},
			});
		}
	});

	pi.on("agent_end", async (event, _ctx) => {
		state.promptCount++;

		const {
			input: turnInput,
			output: turnOutput,
			cacheRead: turnCacheRead,
			cacheWrite: turnCacheWrite,
			turns: turnCount,
		} = aggregateTurnUsage(event.messages);

		state.turns += turnCount;
		state.inputTokens += turnInput;
		state.outputTokens += turnOutput;
		state.cacheReadTokens += turnCacheRead;
		state.cacheWriteTokens += turnCacheWrite;

		if (turnOutput > 0) {
			emit({
				...commonFields(),
				event_type: "prompt_submit",
				command: "pi_agent_turn",
				metadata: {
					input_tokens: turnInput,
					output_tokens: turnOutput,
					cache_read_tokens: turnCacheRead,
					cache_write_tokens: turnCacheWrite,
				},
			});
		}
	});

	pi.on("model_select", async (event, _ctx) => {
		const modelId =
			typeof event.model === "object" && event.model !== null
				? (event.model as { id?: string }).id || "unknown"
				: String(event.model);

		state.modelDistribution[modelId] =
			(state.modelDistribution[modelId] || 0) + 1;

		emit({
			...commonFields(),
			event_type: "model_routing_decision",
			command: "model_select",
			layer: "orchestration",
			metadata: {
				classification: "model_switch",
				model_selected: modelId,
				confidence: 1.0,
				override: false,
				session_id_ref: state.sessionId,
				baseline_model: null,
			},
		});
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		const { durationMs, metadata } = summaryMetadata(state);

		emit({
			...commonFields(),
			event_type: "session_summary",
			command: "session_end",
			duration_ms: durationMs,
			metadata,
		});
	});
}
