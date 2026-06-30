import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const SCHEMA_VERSION = "2.14";
const EVENTS_DIR = join(homedir(), ".automation-metrics", "events");

// --- Emitter ---

function formatTimestamp(date: Date): string {
	return date
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}/, "");
}

function dateFileName(date: Date): string {
	return `${date.toISOString().slice(0, 10)}.jsonl`;
}

function emit(event: Record<string, unknown>): void {
	try {
		if (!existsSync(EVENTS_DIR)) {
			mkdirSync(EVENTS_DIR, { recursive: true });
		}
		const now = new Date();
		const line = JSON.stringify({
			schema_version: SCHEMA_VERSION,
			timestamp: formatTimestamp(now),
			...event,
		});
		appendFileSync(join(EVENTS_DIR, dateFileName(now)), line + "\n");
	} catch {
		// telemetry must never crash the agent
	}
}

// --- Agent Identity ---

function resolveAgent(): string | null {
	return process.env.AUTOMATION_METRICS_AGENT || null;
}

// --- Helpers ---

function isAssistantMessage(message: unknown): message is AssistantMessage {
	if (!message || typeof message !== "object") return false;
	return (message as { role?: unknown }).role === "assistant";
}

function firstWord(command: string | undefined): string {
	if (!command) return "";
	return command.trim().split(/\s+/)[0] || "";
}

function classifyError(toolName: string, result: unknown): string {
	const text =
		typeof result === "string"
			? result
			: JSON.stringify(result).slice(0, 500);
	const lower = text.toLowerCase();
	if (lower.includes("not found") || lower.includes("no such file"))
		return "not_found";
	if (lower.includes("permission") || lower.includes("denied"))
		return "permission_denied";
	if (lower.includes("timeout") || lower.includes("timed out"))
		return "timeout";
	if (lower.includes("blocked")) return "hook_blocked";
	return "unknown";
}

function errorMessage(result: unknown): string {
	const text =
		typeof result === "string" ? result : JSON.stringify(result);
	return text.slice(0, 200);
}

// --- Session State ---

interface SessionState {
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

function freshState(): SessionState {
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
				? firstWord(event.args?.command as string | undefined)
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
					error_class: classifyError(toolName, event.result),
					error_message: errorMessage(event.result),
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

		let turnInput = 0;
		let turnOutput = 0;
		let turnCacheRead = 0;
		let turnCacheWrite = 0;

		for (const message of event.messages) {
			if (!isAssistantMessage(message)) continue;
			turnInput += message.usage.input || 0;
			turnOutput += message.usage.output || 0;
			turnCacheRead += message.usage.cacheRead || 0;
			turnCacheWrite += message.usage.cacheWrite || 0;
			state.turns++;
		}

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
		const durationMs = Date.now() - state.startedAt;
		const durationMinutes = Math.round(durationMs / 60000);

		const effectiveInput =
			state.inputTokens +
			state.cacheReadTokens +
			state.cacheWriteTokens;
		const totalTokens = effectiveInput + state.outputTokens;
		const cacheHitPct =
			effectiveInput > 0
				? (state.cacheReadTokens / effectiveInput) * 100
				: 0;

		let opusTurns = 0;
		for (const [modelId, count] of Object.entries(
			state.modelDistribution,
		)) {
			if (modelId.toLowerCase().includes("opus")) {
				opusTurns += count;
			}
		}
		const opusPct =
			state.turns > 0 ? (opusTurns / state.turns) * 100 : 0;

		emit({
			...commonFields(),
			event_type: "session_summary",
			command: "session_end",
			duration_ms: durationMs,
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
				opus_pct: Math.round(opusPct * 10) / 10,
				tool_events: state.toolEvents,
				tool_distribution: state.toolDistribution,
				model_distribution: state.modelDistribution,
				prompt_count: state.promptCount,
				turns: state.turns,
				signal_source: "pi_extension",
			},
		});
	});
}
