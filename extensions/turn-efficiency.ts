/**
 * Turn Efficiency Meter
 *
 * Tracks turn count, tokens/turn, and context fill rate per turn to surface
 * how efficiently each turn uses the context window — and whether that rate
 * is accelerating (a warning signal that the context is filling faster and
 * faster, indicating compaction may be needed soon).
 *
 * Status bar display (status key: "turn_eff"):
 *
 *   Normal:       ↺7  1.8k/t  1.4%/t
 *   Accelerating: ↺7  1.8k/t  ↑3.2%/t   ← warning color when fill rate is climbing
 *   Healthy:      ↺7  1.8k/t  ✓1.4%/t   ← success color when fill rate is steady/low
 *
 * Color tiers for context fill rate (context%/turn):
 *   < 2%/turn  + no acceleration → success (green)   — efficient, plenty of runway
 *   2–5%/turn  or mild accel     → accent  (blue)    — moderate, keep an eye on it
 *   > 5%/turn  or fast accel     → warning (yellow)  — burning through context
 *   > 10%/turn or severe accel   → error   (red)     — compact soon
 *
 * Acceleration is detected by comparing the last 3-turn rolling average fill
 * rate to the session average. If the rolling avg is ≥1.75× the session avg,
 * the arrow indicator (↑) is shown and the color shifts warm.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ACCEL_WINDOW = 3;      // turns to use for rolling average
const ACCEL_THRESHOLD = 1.75; // rolling avg must be this × session avg to flag

export default function (pi: ExtensionAPI) {
  // Per-session state
  let turns = 0;
  let totalOutputTokens = 0;
  let totalInputTokens = 0;

  // Context % recorded at the end of each turn (for delta/acceleration tracking)
  let contextPctHistory: number[] = [];

  function reset() {
    turns = 0;
    totalOutputTokens = 0;
    totalInputTokens = 0;
    contextPctHistory = [];
  }

  function formatTokens(n: number): string {
    if (n < 1000) return `${n}`;
    if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
    return `${Math.round(n / 1000)}k`;
  }

  function render(ctx: Parameters<Parameters<typeof pi.on<"turn_end">>[1]>[1]) {
    if (turns === 0) return;

    // ── Token rate ────────────────────────────────────────────────────────
    const totalTokens = totalInputTokens + totalOutputTokens;
    const tokPerTurn = totalTokens / turns;

    // ── Context fill rate ─────────────────────────────────────────────────
    const usage = ctx.getContextUsage();
    const ctxPct = usage?.percent ?? null;

    const ctxPerTurn = ctxPct !== null ? ctxPct / turns : null;

    // ── Acceleration detection ────────────────────────────────────────────
    let accelerating = false;
    let severityLevel: "ok" | "moderate" | "high" | "critical" = "ok";

    if (ctxPct !== null && ctxPerTurn !== null) {
      // Compute per-turn deltas from history
      const deltas: number[] = [];
      for (let i = 1; i < contextPctHistory.length; i++) {
        deltas.push(Math.max(0, contextPctHistory[i] - contextPctHistory[i - 1]));
      }

      const sessionAvgDelta = deltas.length > 0
        ? deltas.reduce((a, b) => a + b, 0) / deltas.length
        : 0;

      const recentDeltas = deltas.slice(-ACCEL_WINDOW);
      const rollingAvgDelta = recentDeltas.length > 0
        ? recentDeltas.reduce((a, b) => a + b, 0) / recentDeltas.length
        : 0;

      accelerating = recentDeltas.length >= 2 &&
        sessionAvgDelta > 0 &&
        rollingAvgDelta >= sessionAvgDelta * ACCEL_THRESHOLD;

      // Severity based on fill rate + acceleration
      if (ctxPerTurn > 10 || (accelerating && rollingAvgDelta > 5)) {
        severityLevel = "critical";
      } else if (ctxPerTurn > 5 || accelerating) {
        severityLevel = "high";
      } else if (ctxPerTurn > 2) {
        severityLevel = "moderate";
      } else {
        severityLevel = "ok";
      }
    }

    // ── Build label pieces ────────────────────────────────────────────────
    const turnLabel = ctx.ui.theme.fg("muted", `↺${turns}`);

    const tokLabel = ctx.ui.theme.fg(
      severityLevel === "critical" ? "error" : severityLevel === "high" ? "warning" : "muted",
      `${formatTokens(tokPerTurn)}/t`
    );

    let ctxLabel = "";
    if (ctxPerTurn !== null) {
      const arrow = accelerating ? "↑" : severityLevel === "ok" ? "✓" : "";
      const pctStr = `${arrow}${ctxPerTurn.toFixed(1)}%/t`;
      const color =
        severityLevel === "critical" ? "error"
          : severityLevel === "high" ? "warning"
          : severityLevel === "moderate" ? "accent"
          : "success";
      ctxLabel = ctx.ui.theme.fg(color, pctStr);
    }

    const parts = [turnLabel, tokLabel, ctxLabel].filter(Boolean);
    ctx.ui.setStatus("turn_eff", parts.join("  "));
  }

  // ── Event handlers ────────────────────────────────────────────────────────

  pi.on("agent_start", async (_event, ctx) => {
    reset();
    ctx.ui.setStatus("turn_eff", "");
  });

  pi.on("turn_start", async (event, ctx) => {
    // turnIndex is 0-based; track in-progress turn count
    turns = event.turnIndex + 1;
    ctx.ui.setStatus("turn_eff", ctx.ui.theme.fg("dim", `↺${turns} …`));
  });

  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return;
    const usage = (event.message as any).usage;
    if (!usage) return;
    totalOutputTokens += usage.output ?? 0;
    totalInputTokens += (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  });

  pi.on("turn_end", async (_event, ctx) => {
    // Snapshot context % at turn boundary for delta tracking
    const usage = ctx.getContextUsage();
    if (usage?.percent != null) {
      contextPctHistory.push(usage.percent);
    }
    render(ctx);
  });
}
