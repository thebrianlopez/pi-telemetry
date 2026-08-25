import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

import { createHash } from "node:crypto";

import { validateEvent } from "../src/schema/validate.ts";
import { SCHEMA_VERSION as SNAPSHOT_VERSION } from "../src/schema/eventSchema.ts";
import { redact } from "../src/redact.ts";
import {
	billingRisk,
	resolveInboundHarness,
	resolveTaskContext,
	type Harness,
	type TaskContext,
} from "../src/taskContext.ts";

/**
 * Pinned to the vendored schema snapshot so the emitter and validator can
 * never disagree about which contract version is in force.
 */
export const SCHEMA_VERSION = SNAPSHOT_VERSION;

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

/** Stamp the canonical envelope onto a caller-supplied payload. */
export function buildRecord(
	event: Record<string, unknown>,
	now: Date,
): Record<string, unknown> {
	return {
		schema_version: SCHEMA_VERSION,
		timestamp: formatTimestamp(now),
		...event,
	};
}

/**
 * Transport primitive: stamp, serialize, append. Never throws.
 *
 * This function performs NO schema validation by design — it is the raw write
 * path, and its tests cover filesystem behavior (directory creation, date
 * rollover, concurrent append, unwritable destinations) where the payload is
 * irrelevant. Contract enforcement lives in {@link emitChecked}, which every
 * extension hook uses. RG-1 guards the seam by asserting that everything the
 * extension emits validates.
 */
export function emit(
	event: Record<string, unknown>,
	opts: EmitOptions = {},
): void {
	if (telemetryDisabled()) return;
	try {
		const dir = resolveEventsDir(opts.dir);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const now = opts.now ?? new Date();
		const line = JSON.stringify(buildRecord(event, now));
		appendFileSync(join(dir, dateFileName(now)), line + "\n");
	} catch {
		// telemetry must never crash the agent
	}
}

/** Counters for events rejected by the schema validator. */
export interface DropStats {
	droppedEvents: number;
	dropReasons: Record<string, number>;
}

/**
 * Validate against the vendored schema snapshot, then append.
 *
 * Invalid events are dropped and counted rather than written or raised: a
 * malformed event on the bus is worse than a missing one, and a throw inside a
 * Pi lifecycle hook would degrade the harness this package exists to observe.
 *
 * @returns `true` when the event was written, `false` when it was dropped.
 */
export function emitChecked(
	event: Record<string, unknown>,
	stats: DropStats,
	opts: EmitOptions = {},
): boolean {
	// Short-circuit before validation so the kill switch also removes the
	// validation cost, not just the write.
	if (telemetryDisabled()) return false;
	const now = opts.now ?? new Date();
	const result = validateEvent(buildRecord(event, now));

	if (!result.valid) {
		stats.droppedEvents++;
		for (const issue of result.issues) {
			stats.dropReasons[issue.code] =
				(stats.dropReasons[issue.code] ?? 0) + 1;
		}
		return false;
	}

	emit(event, { ...opts, now });
	return true;
}

// --- Agent Identity ---

export function resolveAgent(): string | null {
	return process.env.AUTOMATION_METRICS_AGENT || null;
}

/**
 * Operator kill switch.
 *
 * Set `AUTOMATION_METRICS_DISABLED=1` to suppress all emission. Checked at
 * call time, not import time, so it can be flipped for a single session
 * without reinstalling the package.
 */
export function telemetryDisabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const v = env.AUTOMATION_METRICS_DISABLED;
	return v === "1" || v === "true" || v === "yes";
}

/**
 * How much `agent_lifecycle` detail to emit.
 *
 * `session` (default) emits harness-level transitions only: `agent_start`,
 * `agent_end`, `model_select`.
 * `full` additionally emits `tool_execution_start` / `tool_execution_end`.
 *
 * Why `session` is the default:
 *
 * The per-tool lifecycle pair raises event volume 68% on a 50-tool session
 * (255 events vs 152) while adding no dimension a consumer can join on. The
 * information an engineer actually needs when debugging — which tool, how
 * long, did it fail — comes from `tool_use` / `tool_result` / `tool_failure`,
 * which now carry `tool_use_id` and are correlatable at zero extra cost.
 *
 * `full` remains available per-session for deep-debug runs, where volume is
 * irrelevant and a second orchestration-layer view of tool timing is welcome.
 */
export type LifecycleDetail = "full" | "session";

export function resolveLifecycleDetail(): LifecycleDetail {
	return process.env.AUTOMATION_METRICS_LIFECYCLE_DETAIL === "full"
		? "full"
		: "session";
}

/** pi_event_types suppressed when detail is `session`. */
const TOOL_LIFECYCLE = new Set([
	"tool_execution_start",
	"tool_execution_end",
]);

export function shouldEmitLifecycle(
	piEventType: string,
	detail: LifecycleDetail = resolveLifecycleDetail(),
): boolean {
	return detail === "full" || !TOOL_LIFECYCLE.has(piEventType);
}

/** Correlation fields carried by tool-scoped lifecycle events. */
export interface ToolRef {
	toolName: string;
	toolUseId: string;
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

/**
 * Bounded, redacted error text for `tool_failure`.
 *
 * Redaction is NOT optional here. Tool errors are one of the likeliest places
 * for a credential to surface verbatim - a failed curl, a rejected git push,
 * an auth error echoing the token it just tried. This previously wrote raw
 * tool output straight to the bus.
 *
 * KEEPS THE TAIL, NOT THE HEAD. A failing command's diagnostic is the LAST
 * thing it prints; anything before it is banner, progress, or listing output.
 * Head truncation therefore discarded the error and stored the noise, and the
 * stored text was unclassifiable by construction.
 *
 * Measured over a rolling 7-day window of 315 real tool_failure events:
 *   - messages short enough to survive intact  -> 5% unclassified
 *   - messages that hit the 200-char limit     -> 68% unclassified
 * The classifier is not the weak link; the truncation direction was.
 *
 * Trade-off, accepted deliberately: for the minority of commands that print
 * the error FIRST and then verbose output (e.g. `ls` on a missing path,
 * followed by a directory listing), the tail now holds the noise instead. In
 * the same window that pattern accounted for roughly 7 events, against ~100
 * that stand to become classifiable. If that balance shifts, the fix is a
 * split budget (leading N + trailing 200-N), not a return to head-only.
 *
 * Redaction still runs over the FULL text before slicing, so narrowing the
 * stored window cannot widen credential exposure.
 */
export function errorMessage(result: unknown): string {
	return redact(contentText(result)).slice(-200);
}

// --- Session State ---

export interface SessionState {
	sessionId: string;
	cwd: string;
	agent: string | null;
	/** Pi session JSONL path. Metadata only — never used as agent identity. */
	sessionFile: string | null;
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
	droppedEvents: number;
	dropReasons: Record<string, number>;
	// --- v2.14 session enrichment ---
	userMessageCount: number;
	assistantMessageCount: number;
	toolErrorCategories: Record<string, number>;
	toolsApproved: number;
	toolsRejected: number;
	usesTaskAgent: boolean;
	usesMcp: boolean;
	languages: Record<string, number>;
	filesModified: Set<string>;
	// --- F-010 task ownership + routing ---
	task: TaskContext;
	boundaryEventsEmitted: number;
	routingAvailable: number;
	routingMatched: number;
	bashFirstWords: Record<string, number>;
}

export function freshState(): SessionState {
	return {
		sessionId: randomUUID(),
		cwd: process.cwd(),
		agent: resolveAgent(),
		sessionFile: null,
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
		droppedEvents: 0,
		dropReasons: {},
		userMessageCount: 0,
		assistantMessageCount: 0,
		toolErrorCategories: {},
		toolsApproved: 0,
		toolsRejected: 0,
		usesTaskAgent: false,
		usesMcp: false,
		languages: {},
		filesModified: new Set<string>(),
		task: {
			taskId: null,
			source: "none",
			epic: null,
			milestones: [],
			diagnostic: null,
		},
		boundaryEventsEmitted: 0,
		routingAvailable: 0,
		routingMatched: 0,
		bashFirstWords: {},
	};
}

// --- Prompt Capture ---

/** Maximum characters retained in a prompt or output preview. */
export const PREVIEW_LIMIT = 200;

/**
 * Prompt retention mode.
 *
 * `preview` (default) stores a redacted, bounded excerpt plus a hash.
 * `hash`    stores only the hash and length — no text.
 * `off`     stores neither.
 *
 * Raw prompts are never retained in any mode: the bus is a plaintext,
 * unrotated, world-readable-by-default JSONL file.
 */
export type PromptCapture = "off" | "preview" | "hash";

export function resolvePromptCapture(): PromptCapture {
	const v = process.env.AUTOMATION_METRICS_PROMPT_CAPTURE;
	return v === "off" || v === "hash" ? v : "preview";
}

export function sha256(text: string): string {
	return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** Redact, then truncate to {@link PREVIEW_LIMIT}. Redaction runs first. */
export function preview(text: unknown): string {
	return redact(text).slice(0, PREVIEW_LIMIT);
}

/**
 * Build the retention-policy-aware fields for one free-text value.
 *
 * `length` is the pre-redaction character count, which is safe to publish and
 * lets consumers reason about prompt size without the content.
 */
export function captureText(
	text: unknown,
	mode: PromptCapture = resolvePromptCapture(),
): { text: string; hash: string | null; length: number } {
	const raw = typeof text === "string" ? text : "";
	if (mode === "off") return { text: "", hash: null, length: raw.length };
	if (mode === "hash")
		return { text: "", hash: raw ? sha256(raw) : null, length: raw.length };
	return {
		text: preview(raw),
		hash: raw ? sha256(raw) : null,
		length: raw.length,
	};
}

/** Flatten a message `content` field to plain text. */
export function messageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	return contentText(content);
}

/** Last message with the given role, or undefined. */
export function lastMessageOfRole(
	messages: readonly unknown[],
	role: string,
): unknown {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (
			m &&
			typeof m === "object" &&
			(m as { role?: unknown }).role === role
		) {
			return m;
		}
	}
	return undefined;
}

/**
 * Keyword classifier for the schema's `task_category` enum.
 *
 * Deliberately simple and transparent. Returns `null` rather than guessing
 * when no signal is present — the schema declares this field nullable, and a
 * wrong category is worse than an absent one for downstream scoring.
 */
const CATEGORY_PATTERNS: ReadonlyArray<[string, RegExp]> = [
	["dispatch", /\b(dispatch|epic-\d+|milestone|claim|handoff)\b/i],
	["bugfix", /\b(fix|bug|broken|regression|crash|error|failing|repair)\b/i],
	["code_review", /\b(review|critique|feedback on|look over|pr\b)/i],
	["documentation", /\b(document|readme|docs?|changelog|comment)\b/i],
	["planning", /\b(plan|design|architect|propose|roadmap|prd|fdd|tdd)\b/i],
	["configuration", /\b(config|configure|settings?|install|setup|env|yaml)\b/i],
	["discovery", /\b(find|search|where is|locate|which file|grep)\b/i],
	["exploration", /\b(explore|investigate|understand|explain|how does|what is)\b/i],
	["confirmation", /^\s*(yes|no|ok|okay|sure|proceed|continue|approved|lgtm)\b/i],
];

export function classifyTask(text: unknown): string | null {
	if (typeof text !== "string" || text.trim() === "") return null;
	for (const [category, pattern] of CATEGORY_PATTERNS) {
		if (pattern.test(text)) return category;
	}
	return "other";
}

// --- Layer Routing ---

/**
 * Go CLI tools in this workspace whose use is evidence of the `go_cli` layer.
 * Sourced from the runabout suite and the tools referenced by the routing
 * guidance in core.
 */
const GO_CLI_COMMANDS = new Set([
	"mdq",
	"md-tree",
	"ts-go",
	"perfgate",
	"shellprof",
	"workctl",
	"castex",
	"chain-eval",
	"bmux",
	"hookval",
	"effiscore",
	"runway",
	"wasend",
]);

/** Shell builtins and fish functions that evidence the `fish` layer. */
const FISH_COMMANDS = new Set(["fish", "wk", "uinit", "gsync", "winit"]);

/**
 * Infer which layer actually did the work, from observed tool usage.
 *
 * Pi does not emit routing recommendations of its own — those are injected by
 * the fish hook layer. Rather than fabricate a decision, this infers the
 * ACTUAL layer from evidence and compares it to a recommendation supplied via
 * environment. No recommendation means no event.
 */
export function inferActualLayer(
	bashFirstWords: Record<string, number>,
): "fish" | "go_cli" | "cloud_llm" {
	let goCli = 0;
	let fish = 0;
	for (const [word, count] of Object.entries(bashFirstWords)) {
		if (GO_CLI_COMMANDS.has(word)) goCli += count;
		else if (FISH_COMMANDS.has(word)) fish += count;
	}
	if (goCli === 0 && fish === 0) return "cloud_llm";
	return goCli >= fish ? "go_cli" : "fish";
}

export interface RoutingRecommendation {
	recommendedLayer: "fish" | "go_cli" | "cloud_llm";
	recommendedTool: string | null;
	taskType: string;
	confidence: number;
}

const ROUTING_LAYER_VALUES = new Set(["fish", "go_cli", "cloud_llm"]);

/**
 * Read an injected routing recommendation, if the hook layer supplied one.
 *
 * Returns `null` when absent or malformed — the session then reports null
 * adoption rather than a fabricated 0.
 */
export function resolveRoutingRecommendation(
	env: NodeJS.ProcessEnv = process.env,
): RoutingRecommendation | null {
	const layer = env.AUTOMATION_METRICS_ROUTING_LAYER;
	if (typeof layer !== "string" || !ROUTING_LAYER_VALUES.has(layer)) {
		return null;
	}
	const rawConfidence = Number(env.AUTOMATION_METRICS_ROUTING_CONFIDENCE);
	return {
		recommendedLayer: layer as RoutingRecommendation["recommendedLayer"],
		recommendedTool: env.AUTOMATION_METRICS_ROUTING_TOOL || null,
		taskType: env.AUTOMATION_METRICS_ROUTING_TASK_TYPE || "unspecified",
		confidence:
			Number.isFinite(rawConfidence) &&
			rawConfidence >= 0 &&
			rawConfidence <= 1
				? rawConfidence
				: 0.5,
	};
}

// --- Pi Runtime Introspection ---

/**
 * Best-effort extraction of the Pi session header from an extension context.
 *
 * The ExtensionAPI context shape varies across pi-mono versions, so every
 * access is guarded. A missing header yields nulls rather than a throw or a
 * fabricated value — per the TDD, unobservable is not the same as absent.
 */
export function readSessionHeader(ctx: unknown): {
	sessionId: string | null;
	sessionFile: string | null;
	cwd: string | null;
} {
	const empty = { sessionId: null, sessionFile: null, cwd: null };
	try {
		const manager = (ctx as { sessionManager?: unknown } | null)
			?.sessionManager as
			| { getHeader?: () => unknown; getPath?: () => unknown }
			| undefined;
		if (!manager) return empty;

		const header =
			typeof manager.getHeader === "function"
				? (manager.getHeader() as Record<string, unknown> | null)
				: null;
		const path =
			typeof manager.getPath === "function"
				? manager.getPath()
				: undefined;

		return {
			sessionId:
				header && typeof header.id === "string" ? header.id : null,
			sessionFile: typeof path === "string" ? path : null,
			cwd:
				header && typeof header.cwd === "string" ? header.cwd : null,
		};
	} catch {
		return empty;
	}
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
export function aggregateTurnUsage(messages: unknown): TurnUsage {
	const usage: TurnUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		turns: 0,
	};
	// Pi payload shapes vary across versions; a non-array `messages` must not
	// throw inside a lifecycle hook.
	if (!Array.isArray(messages)) return usage;
	for (const message of messages) {
		if (!isAssistantMessage(message)) continue;
		const u = (message as { usage?: unknown }).usage;
		if (!u || typeof u !== "object") continue;
		const m = u as Record<string, unknown>;
		usage.input += Number(m.input) || 0;
		usage.output += Number(m.output) || 0;
		usage.cacheRead += Number(m.cacheRead) || 0;
		usage.cacheWrite += Number(m.cacheWrite) || 0;
		usage.turns++;
	}
	return usage;
}

/** Map a file path to a coarse language label for session enrichment. */
export function languageOf(path: string): string | null {
	const m = /\.([A-Za-z0-9]+)$/.exec(path);
	if (!m) return null;
	const ext = m[1].toLowerCase();
	const table: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		go: "go",
		py: "python",
		rs: "rust",
		fish: "fish",
		sh: "shell",
		bash: "shell",
		md: "markdown",
		yaml: "yaml",
		yml: "yaml",
		json: "json",
		tf: "terraform",
		kt: "kotlin",
		java: "java",
		sql: "sql",
	};
	return table[ext] ?? null;
}

/** Extract a file path from a tool invocation's input, when present. */
export function pathFromInput(input: unknown): string | null {
	if (!input || typeof input !== "object") return null;
	for (const key of ["path", "file_path", "filePath", "file"]) {
		const v = (input as Record<string, unknown>)[key];
		if (typeof v === "string" && v !== "") return v;
	}
	return null;
}

/** Tool names that indicate a file mutation. */
const MUTATING_TOOLS = new Set(["edit", "write", "multiedit", "notebook_edit"]);

export function isMutatingTool(toolName: unknown): boolean {
	return (
		typeof toolName === "string" &&
		MUTATING_TOOLS.has(toolName.toLowerCase())
	);
}

// --- Content Plane ---

/**
 * Tool-input keys that carry a target file path, in precedence order.
 *
 * Pi's own tools use `path`; `file_path` and `notebook_path` are accepted so
 * that Claude-Code-shaped inputs replayed through the Pi harness resolve
 * identically rather than silently dropping to null.
 */
const PATH_KEYS = ["path", "file_path", "notebook_path"] as const;

/**
 * Extract the target path from a tool invocation.
 *
 * Returns `null` for tools that do not act on a file (bash, web_search, the
 * herdr_* family). Paths are emitted verbatim: they are already present in the
 * `cwd` field and in `command`, so they leak nothing new, and hashing them
 * would destroy the join key that makes the content plane useful.
 */
export function resolveFilePath(input: unknown): string | null {
	if (!input || typeof input !== "object") return null;
	const rec = input as Record<string, unknown>;
	for (const key of PATH_KEYS) {
		const v = rec[key];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return null;
}

/**
 * Content-plane fields for one tool invocation.
 *
 * `file_path` answers "which file", `content_hash` answers "did it change" —
 * together they let a bus event be joined to a VCS operation without the bus
 * ever storing file contents. The hash covers the post-state (`new_string` /
 * `content`), which is what a subsequent snapshot would record.
 *
 * Content is hashed, never previewed: unlike prompts, file bodies have no
 * bounded excerpt that is safe by construction on a plaintext, unrotated,
 * world-readable-by-default JSONL bus. `AUTOMATION_METRICS_PROMPT_CAPTURE=off`
 * suppresses the hash too, so the existing operator control keeps working.
 */
export function contentPlaneFields(
	input: unknown,
	mode: PromptCapture = resolvePromptCapture(),
): { file_path?: string; content_hash?: string; content_length?: number } {
	const filePath = resolveFilePath(input);
	if (filePath === null) return {};

	const out: {
		file_path?: string;
		content_hash?: string;
		content_length?: number;
	} = { file_path: filePath };

	const rec = input as Record<string, unknown>;
	const body = rec.new_string ?? rec.content;
	if (typeof body === "string") {
		out.content_length = body.length;
		if (mode !== "off" && body.length > 0) out.content_hash = sha256(body);
	}
	return out;
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
			// Schema-drift visibility: a nonzero count means this package
			// produced events its own vendored snapshot rejected.
			dropped_events: state.droppedEvents,
			drop_reasons: state.dropReasons,

			// --- v2.14 enrichment: observable by Pi ---
			user_message_count: state.userMessageCount,
			assistant_message_count: state.assistantMessageCount,
			tool_errors: state.toolErrors,
			tool_error_categories: state.toolErrorCategories,
			files_modified: state.filesModified.size,
			languages: state.languages,
			uses_task_agent: state.usesTaskAgent,
			uses_mcp: state.usesMcp,
			tools_approved: state.toolsApproved,
			tools_rejected: state.toolsRejected,
			approval_rate: approvalRate(state),

			// --- v2.14 enrichment: NOT observable by Pi ---
			// Emitted as explicit null, never omitted. The schema declares
			// these `*_or_null`, and null distinguishes "this harness cannot
			// see it" from "field forgotten" — a distinction arec/ahealth
			// need to score Pi fairly against Claude Code.
			git_commits: null,
			git_pushes: null,
			lines_added: null,
			lines_removed: null,
			user_interruptions: null,
			user_response_times: null,

			// --- Routing adoption (v2.14) ---
			// Null rather than 0 when no routing signal existed: an absent
			// denominator is not a 0% adoption rate.
			routing_signals_injected: state.routingAvailable,
			routing_candidates_available:
				state.routingAvailable > 0 ? state.routingAvailable : null,
			routing_candidates_matched:
				state.routingAvailable > 0 ? state.routingMatched : null,
			routing_adoption_rate:
				state.routingAvailable > 0
					? Math.round(
							(state.routingMatched / state.routingAvailable) *
								1000,
						) / 1000
					: null,

			// --- Task ownership diagnostics (F-010) ---
			task_context_source: state.task.source,
			boundary_events_emitted: state.boundaryEventsEmitted,
		},
	};
}

/**
 * Approval rate as a percentage, or `null` when nothing required approval.
 *
 * Null rather than 0 or 100: an empty denominator is not a 0% approval rate,
 * and reporting one would skew cross-harness comparisons.
 */
export function approvalRate(state: SessionState): number | null {
	const total = state.toolsApproved + state.toolsRejected;
	if (total === 0) return null;
	return Math.round((state.toolsApproved / total) * 1000) / 10;
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
	let state = freshState();

	/**
	 * Hook boundary guard (RG-5).
	 *
	 * Telemetry must never propagate an exception into the Pi harness it
	 * observes. Pi payload shapes vary across versions, and a malformed or
	 * hostile event should cost us one lost record - not the agent's session.
	 *
	 * One guard at the boundary rather than defensive checks scattered through
	 * every handler: it cannot be forgotten when a new hook is added.
	 */
	function guard(
		name: string,
		handler: (event: any, ctx: unknown) => Promise<void> | void,
	) {
		return async (event: any, ctx: unknown) => {
			try {
				await handler(event ?? {}, ctx);
			} catch {
				// Count it so a systematically failing hook is visible in the
				// session summary rather than silently dropping data.
				state.droppedEvents++;
				state.dropReasons[`hook_error:${name}`] =
					(state.dropReasons[`hook_error:${name}`] ?? 0) + 1;
			}
		};
	}

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

	/** All hook emissions go through the validated path. */
	function send(event: Record<string, unknown>): void {
		emitChecked(event, state);
	}

	/**
	 * Normalized Pi lifecycle event (Registry TDD F11 §3).
	 *
	 * `session_file` is metadata only — CT-6 asserts it never becomes the
	 * canonical agent identity.
	 */
	function lifecycle(
		piEventType: string,
		tool: ToolRef | null = null,
	): void {
		if (!shouldEmitLifecycle(piEventType)) return;
		send({
			...commonFields(),
			layer: "orchestration",
			event_type: "agent_lifecycle",
			command: piEventType,
			metadata: {
				pi_event_type: piEventType,
				session_file: state.sessionFile,
				task_id: state.task.taskId,
				// Tool-scoped lifecycle events are useless without a join key.
				// The canonical schema does not list these, but metadata is
				// open and extras validate. Without them a consumer cannot tell
				// WHICH tool a tool_execution_start refers to and must guess
				// positionally - precisely the assumption that breaks under
				// concurrency, i.e. the case being debugged.
				...(tool
					? { tool_name: tool.toolName, tool_use_id: tool.toolUseId }
					: {}),
			},
		});
	}

	/**
	 * Emit a task ownership transition.
	 *
	 * No-ops when task context is unresolved. Inventing an id here would
	 * produce ownership records that never correlate with Claude Code.
	 */
	function boundary(
		action: "claim" | "handoff" | "suspend" | "resume" | "release",
		fromHarness: Harness | null,
		toHarness: Harness | null,
		reason: string,
	): void {
		if (!state.task.taskId) return;

		send({
			...commonFields(),
			layer: "orchestration",
			event_type: "task_boundary",
			command: action,
			metadata: {
				task_id: state.task.taskId,
				boundary_action: action,
				from_harness: fromHarness,
				to_harness: toHarness,
				reason,
				concurrent_billing_risk: billingRisk(fromHarness),
			},
		});
		state.boundaryEventsEmitted++;
	}

	pi.on("session_start", guard("session_start", async (event, ctx) => {
		state = freshState();

		// Adopt Pi's own session identity when the runtime exposes it, so Pi
		// events correlate with the session JSONL. Falls back to the generated
		// UUID when unavailable.
		const header = readSessionHeader(ctx);
		if (header.sessionId) state.sessionId = header.sessionId;
		if (header.sessionFile) state.sessionFile = header.sessionFile;
		if (header.cwd) state.cwd = header.cwd;

		// Resolved once per session: the dispatch directory is on the
		// filesystem and must not be touched from the hot tool path.
		state.task = resolveTaskContext({ cwd: state.cwd });

		lifecycle("agent_start");

		// An inbound from_harness means another harness owned this task and is
		// handing it over; otherwise Pi is claiming it fresh.
		const inbound = resolveInboundHarness();
		if (inbound && inbound !== "pi") {
			boundary("handoff", inbound, "pi", "inbound_harness_handoff");
		} else {
			boundary("claim", null, "pi", "session_start");
		}
	}));

	pi.on("tool_call", guard("tool_call", async (event, ctx) => {
		const toolName = event.toolName;
		const fw =
			toolName === "bash"
				? firstWord(
						(event.input as { command?: string }).command,
					)
				: toolName;

		const toolUseId = event.toolCallId || "";

		send({
			...commonFields(),
			event_type: "tool_use",
			command: toolName,
			metadata: {
				tool_name: toolName,
				source: "pi",
				first_word: fw,
				// Content plane. Absent for non-file tools, so this stays a
				// zero-cost addition for the ~80% of events that are bash.
				...contentPlaneFields(event.input),
				// The canonical schema omits tool_use_id from tool_use and
				// declares it only on tool_result, which leaves the pair
				// joinable only by position. Emitting it here costs nothing,
				// validates as an extra field, and is what makes per-tool
				// duration and hung-tool detection possible without a parallel
				// lifecycle stream.
				tool_use_id: toolUseId,
			},
		});

		state.toolDistribution[toolName] =
			(state.toolDistribution[toolName] || 0) + 1;

		// Evidence for layer-routing inference at shutdown.
		if (toolName === "bash" && fw) {
			state.bashFirstWords[fw] = (state.bashFirstWords[fw] || 0) + 1;
		}

		// Enrichment signals derived from the invocation itself.
		if (typeof toolName === "string") {
			const lower = toolName.toLowerCase();
			if (lower === "task" || lower === "agent") state.usesTaskAgent = true;
			if (lower.startsWith("mcp__") || lower.includes("mcp"))
				state.usesMcp = true;
		}

		if (isMutatingTool(toolName)) {
			const path = pathFromInput(event.input);
			if (path) {
				state.filesModified.add(path);
				const lang = languageOf(path);
				if (lang)
					state.languages[lang] = (state.languages[lang] || 0) + 1;
			}
		}

		lifecycle("tool_execution_start", {
			toolName,
			toolUseId,
		});
	}));

	pi.on("tool_result", guard("tool_result", async (event, ctx) => {
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
			const errorClass = classifyError(toolName, event.content);
			state.toolErrorCategories[errorClass] =
				(state.toolErrorCategories[errorClass] || 0) + 1;
			if (errorClass === "permission_denied") state.toolsRejected++;
			else state.toolsApproved++;
			send({
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
			state.toolsApproved++;
			send({
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

		lifecycle("tool_execution_end", {
			toolName,
			toolUseId: event.toolCallId || "",
		});
	}));

	pi.on("agent_end", guard("agent_end", async (event, ctx) => {
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

		const messages = Array.isArray(event.messages) ? event.messages : [];

		// Count message roles for session enrichment.
		for (const m of messages) {
			const role = (m as { role?: unknown } | null)?.role;
			if (role === "user") state.userMessageCount++;
			else if (role === "assistant") state.assistantMessageCount++;
		}

		const promptText = messageText(lastMessageOfRole(messages, "user"));
		const replyText = messageText(lastMessageOfRole(messages, "assistant"));
		const captured = captureText(promptText);
		const reply = captureText(replyText);

		if (turnOutput > 0) {
			send({
				...commonFields(),
				event_type: "prompt_submit",
				// Prompt events belong to the cloud_llm layer, not claude_code.
				// commonFields() defaults to claude_code for the tool/session
				// family; this override is required by the canonical schema.
				layer: "cloud_llm",
				command: "pi_agent_turn",
				metadata: {
					input: captured.text,
					input_hash: captured.hash,
					input_length: captured.length,
					output: reply.text,
					output_hash: reply.hash,
					output_length: reply.length,
					// Pi has no approval gate of its own; Claude Code supplies
					// this. Emitted as "unknown" rather than a guessed value.
					approval: "unknown",
					task_category: classifyTask(promptText),
					input_tokens: turnInput,
					output_tokens: turnOutput,
					cache_read_tokens: turnCacheRead,
					cache_write_tokens: turnCacheWrite,
				},
			});
		}
	}));

	pi.on("model_select", guard("model_select", async (event, ctx) => {
		const modelId =
			typeof event.model === "object" && event.model !== null
				? (event.model as { id?: string }).id || "unknown"
				: String(event.model);

		state.modelDistribution[modelId] =
			(state.modelDistribution[modelId] || 0) + 1;

		lifecycle("model_select");

		send({
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
	}));

	pi.on("session_shutdown", guard("session_shutdown", async (event, ctx) => {
		lifecycle("agent_end");

		// A shutdown carrying an error or a non-clean reason suspends the task
		// rather than releasing it: consumers age out stale claims, but a
		// premature release would hide an abandoned task.
		const reason = (event as { reason?: unknown } | null)?.reason;
		const errored = Boolean(
			(event as { error?: unknown } | null)?.error ||
				(typeof reason === "string" &&
					/error|crash|abort|interrupt|signal/i.test(reason)),
		);

		if (errored) {
			boundary("suspend", "pi", null, "abnormal_shutdown");
		} else {
			boundary("release", "pi", null, "session_complete");
		}

		// Layer routing: emitted only when the hook layer injected a
		// recommendation. Absent one, adoption reports null rather than 0.
		const recommendation = resolveRoutingRecommendation();
		if (recommendation) {
			const actual = inferActualLayer(state.bashFirstWords);
			const matched = actual === recommendation.recommendedLayer;
			state.routingAvailable++;
			if (matched) state.routingMatched++;

			send({
				...commonFields(),
				layer: "topology",
				event_type: "layer_routing_decision",
				command: "layer_routing",
				metadata: {
					recommended_layer: recommendation.recommendedLayer,
					recommended_tool: recommendation.recommendedTool,
					actual_layer: actual,
					confidence: recommendation.confidence,
					task_type: recommendation.taskType,
					override: !matched,
					override_reason: matched ? null : "other",
					session_id_ref: state.sessionId,
					baseline_layer: null,
				},
			});
		}

		const { durationMs, metadata } = summaryMetadata(state);

		send({
			...commonFields(),
			event_type: "session_summary",
			command: "session_end",
			duration_ms: durationMs,
			metadata,
		});
	}));
}
