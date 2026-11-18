# Pseudocode: Model Attribution Recovery (F1, F2, F3)

Source: `~/docs/design/PERSONAL_20261118T131811Z_PiTelemetry_Model_Attribution_Recovery_FDD.md`
and its three TDDs. Not implementation — scaffolding to review before Step 2 of each TDD's
Implementation Sequence begins. Contract tests (CT-*) are written first per each TDD's gate rule.

---

## F1 — Derive model_distribution from agent_end message data

### extensions/telemetry.ts — aggregateTurnUsage()

```
INTERFACE TurnUsage:
    input, output, cacheRead, cacheWrite, turns: number
    modelTurns: Record<string, number>   // NEW

FUNCTION aggregateTurnUsage(messages: unknown) -> TurnUsage:
    usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, modelTurns: {} }

    IF NOT isArray(messages):
        RETURN usage                      // unchanged guard clause

    FOR message IN messages:
        IF NOT isAssistantMessage(message):
            CONTINUE                      // unchanged

        u = message.usage
        IF u IS object:
            usage.input      += number(u.input)      OR 0
            usage.output     += number(u.output)     OR 0
            usage.cacheRead  += number(u.cacheRead)  OR 0
            usage.cacheWrite += number(u.cacheWrite) OR 0
            usage.turns      += 1

        // --- NEW: model attribution, independent of usage validity ---
        modelId = message.model
        IF typeof modelId IS "string" AND modelId.length > 0:
            usage.modelTurns[modelId] = (usage.modelTurns[modelId] OR 0) + 1
        // ELSE: silent skip — error class model_field_missing, no throw

    RETURN usage
```

### extensions/telemetry.ts — agent_end handler

```
ON "agent_end" (event, ctx):
    state.promptCount += 1

    { input, output, cacheRead, cacheWrite, turns, modelTurns } = aggregateTurnUsage(event.messages)

    state.turns          += turns
    state.inputTokens     += input
    state.outputTokens    += output
    state.cacheReadTokens += cacheRead
    state.cacheWriteTokens += cacheWrite

    // --- NEW: merge modelTurns into state.modelDistribution, with dedup ---
    FOR (modelId, count) IN modelTurns:
        key = dedupKey(event, modelId)              // see dedup strategy below
        IF NOT state.seenTurnKeys.has(key):
            state.modelDistribution[modelId] = (state.modelDistribution[modelId] OR 0) + count
            state.seenTurnKeys.add(key)

    // ...rest of existing agent_end handling (prompt_submit emission etc.) unchanged...
```

### Dedup strategy (TDD F1 §2 Key Design Decisions)

```
FUNCTION dedupKey(event, modelId) -> string:
    // Turn identity approximated by (timestamp of last assistant message, modelId).
    // Not a true turn-id (none exists upstream) — documented limitation,
    // revisit granularity at Epic time if real data shows false collisions (TDD F1 §7).
    lastAssistantMsg = lastMessageOfRole(event.messages, "assistant")
    RETURN `${lastAssistantMsg.timestamp}:${modelId}`
```

### model_select hook — now a confirming write, same dedup path

```
ON "model_select" (event, ctx):
    modelId = extractModelId(event.model)   // unchanged extraction logic

    // --- CHANGED: route through the same dedup path as agent_end ---
    key = dedupKey({ messages: [...] }, modelId)   // approximate: use current timestamp
                                                     // if no agent_end message available yet
    IF NOT state.seenTurnKeys.has(key):
        state.modelDistribution[modelId] = (state.modelDistribution[modelId] OR 0) + 1
        state.seenTurnKeys.add(key)

    lifecycle("model_select")
    send({ ...existing model_routing_decision emission, unchanged... })
```

---

## F1 — Tests (test/telemetry.test.ts additions)

```
DESCRIBE "aggregateTurnUsage — model attribution (F1)":

    TEST CT-1 "returns modelTurns for two different models":
        messages = [
            assistantMessage(model: "claude-opus-5", usage: validUsage()),
            assistantMessage(model: "gpt-6-luna",     usage: validUsage()),
        ]
        result = aggregateTurnUsage(messages)
        EXPECT result.modelTurns == { "claude-opus-5": 1, "gpt-6-luna": 1 }

    TEST CT-2 "malformed model field is non-throwing, token totals unaffected":
        messages = [ assistantMessage(model: 123, usage: validUsage()) ]  // non-string model
        EXPECT NOT throws(() => aggregateTurnUsage(messages))
        result = aggregateTurnUsage(messages)
        EXPECT result.modelTurns == {}
        EXPECT result.input > 0   // usage still aggregated

    TEST CT-3 "non-array messages still safe":
        result = aggregateTurnUsage(null)
        EXPECT result.modelTurns == {}
        EXPECT NOT throws(...)

    TEST CT-4 "no double-count across agent_end + model_select for same turn":
        session = startSyntheticSession()
        session.emit("agent_end", { messages: [assistantMessage(model: "gpt-6-luna", usage: validUsage())] })
        session.emit("model_select", { model: { id: "gpt-6-luna" }, source: "set" })
        summary = session.emitSessionSummary()
        EXPECT summary.metadata.model_distribution["gpt-6-luna"] == 1   // not 2

    TEST BT-1 "mixed-provider session":
        messages = [assistantMessage(model: "claude-opus-5", ...), assistantMessage(model: "gpt-6-luna", ...)]
        result = aggregateTurnUsage(messages)
        EXPECT keys(result.modelTurns) == ["claude-opus-5", "gpt-6-luna"]

    TEST BT-2 "zero assistant messages":
        result = aggregateTurnUsage([])
        EXPECT result == { input:0, output:0, cacheRead:0, cacheWrite:0, turns:0, modelTurns:{} }

    TEST BT-3 "accumulates across multiple agent_end calls":
        session = startSyntheticSession()
        session.emit("agent_end", { messages: [assistantMessage(model: "claude-opus-5", ...)] })
        session.emit("agent_end", { messages: [assistantMessage(model: "claude-opus-5", ...)] })
        summary = session.emitSessionSummary()
        EXPECT summary.metadata.model_distribution["claude-opus-5"] == 2

    TEST RG-1 "model_distribution nonempty despite zero model_select events (the POMO defect)":
        session = startSyntheticSession()
        session.emit("agent_end", { messages: [assistantMessage(model: "gpt-6-luna", usage: { input: 100, output: 50 })] })
        // no model_select fired at all
        summary = session.emitSessionSummary()
        EXPECT summary.metadata.total_tokens > 0
        EXPECT summary.metadata.model_distribution != {}

    TEST RG-2 "pre-2026-08-05 GPT zero-token pattern does not regress":
        session = startSyntheticSession()
        session.emit("agent_end", { messages: [assistantMessage(model: "gpt-5.4-mini", usage: { input: 100, output: 50 })] })
        summary = session.emitSessionSummary()
        EXPECT summary.metadata.total_tokens > 0   // guards the adjacent, already-resolved defect
```

---

## F2 — Attribution completeness guard

### extensions/telemetry.ts — session_summary metadata assembly

```
FUNCTION buildSessionSummaryMetadata(state) -> SessionSummaryMetadata:
    metadata = {
        tool_events: state.toolEvents,
        prompt_count: state.promptCount,
        tool_distribution: state.toolDistribution,
        model_distribution: state.modelDistribution,
        input_tokens: state.inputTokens,
        output_tokens: state.outputTokens,
        total_tokens: state.inputTokens + state.outputTokens + ...,  // existing calc, unchanged
        turns: state.turns,
        signal_source: state.signalSource,
        // ...other existing fields unchanged...
    }

    // --- NEW: completeness guard ---
    attributionIncomplete = metadata.total_tokens > 0 AND isEmpty(metadata.model_distribution)
    IF attributionIncomplete:
        metadata.attribution_incomplete = true
    // ELSE: key omitted entirely — never emitted as false

    RETURN metadata
```

### src/schema/eventSchema.ts — additive field declaration

```
EVENT_RULES.session_summary.metadata.attribution_incomplete = {
    kind: "boolean",
    required: false,   // key itself optional
}
```

### core/schemas/event-schema.yaml (canonical, separate repo — same change mirrored)

```yaml
session_summary:
  metadata:
    attribution_incomplete: { kind: boolean, required: false }
```

---

## F2 — Tests (test/telemetry.test.ts additions)

```
DESCRIBE "session_summary — attribution completeness guard (F2)":

    TEST CT-1 "flag set on true positive":
        state = fakeState({ totalTokens: 5000, modelDistribution: {} })
        metadata = buildSessionSummaryMetadata(state)
        EXPECT metadata.attribution_incomplete == true

    TEST CT-2 "flag absent on healthy session":
        state = fakeState({ totalTokens: 5000, modelDistribution: { "claude-opus-5": 3 } })
        metadata = buildSessionSummaryMetadata(state)
        EXPECT "attribution_incomplete" NOT IN metadata   // absent, not false

    TEST CT-3 "flag absent on zero-token session":
        state = fakeState({ totalTokens: 0, modelDistribution: {} })
        metadata = buildSessionSummaryMetadata(state)
        EXPECT "attribution_incomplete" NOT IN metadata   // empty session is not a defect

    TEST BT-1 "end-to-end synthetic session emits the flag in the JSONL line":
        session = startSyntheticSession()
        session.emit("agent_end", { messages: [messageWithUsageButNoModelField()] })
        session.emitSessionShutdown()
        line = readLastEmittedJSONLLine()
        EXPECT line CONTAINS '"attribution_incomplete":true'

    TEST RG-1 "regression in F1 reintroducing empty model_distribution is caught, not silent":
        state = fakeState({ totalTokens: 1000, modelDistribution: {} })  // simulates F1 regressing
        metadata = buildSessionSummaryMetadata(state)
        EXPECT metadata.attribution_incomplete == true   // caught by the flag, not by manual jq
```

---

## F3 — Pi extension-API drift gate

### tsconfig.json (new, scoped per TDD F3 §3/§13 Q1)

```
CREATE tsconfig.json:
    compilerOptions: { strict: true, noEmit: true, module: "esnext", ... }
    include: [ "extensions/**/*.ts", "src/**/*.ts", "test/schema/pi-extension-api.test.ts" ]
```

### package.json — new script

```
scripts.typecheck = "tsc --noEmit"
scripts.test = "npm run typecheck && vitest run"   // typecheck gates the suite, not silently skippable
```

### test/schema/pi-extension-api.test.ts

```
IMPORT type { ModelSelectEvent, AgentEndEvent } FROM "@earendil-works/pi-coding-agent"
IMPORT type { AssistantMessage }                FROM "@earendil-works/pi-ai"
IMPORT { readFileSync }                          FROM "node:fs"

CONST PINNED_LAST_VERIFIED_VERSION = "0.82.1"   // bump deliberately after manual review

// --- type-only compile-time assertions (CT-1, enforced by `npm run typecheck`, not vitest) ---
FUNCTION assertModelSelectShape(e: ModelSelectEvent) -> { id: string }:
    RETURN { id: (e.model AS { id?: string }).id OR "unknown" }
    // fails to compile if `model` or `.id`-shaped access becomes invalid

FUNCTION assertAgentEndShape(e: AgentEndEvent) -> void:
    FOR m IN e.messages:
        IF (m AS { role?: unknown }).role == "assistant":
            am = m AS AssistantMessage
            _model: string = am.model     // fails to compile if renamed/removed
            _usage = am.usage             // fails to compile if renamed/removed

DESCRIBE "Pi extension-API drift gate (F3)":

    TEST CT-2 "reports installed version":
        pkg = JSON.parse(readFileSync("node_modules/@earendil-works/pi-coding-agent/package.json"))
        EXPECT pkg.version IS string
        LOG `installed=${pkg.version} pinned=${PINNED_LAST_VERIFIED_VERSION}`

    TEST CT-3 "seed regression: simulated 0.82.1 -> 1.5.2 drift fails without opt-out":
        installed = "1.5.2"   // simulated, not read from disk for this specific test
        pinned = "0.82.1"
        IF NOT seamChecksOptedOut():
            EXPECT installed == pinned   // FAILS by design — this is the seeded regression case
        ELSE:
            EXPECT true   // opted out, warn only (see BT-1)

    TEST BT-1 "opt-out env var suppresses hard failure":
        SET env SEAM_CHECKS_UNVERIFIED_I_ACCEPT_DRIFT_RISK = "1"
        installed = "1.5.2"
        pinned = "0.82.1"
        IF seamChecksOptedOut():
            CONSOLE.warn(`version drift: installed=${installed} pinned=${pinned}, UNVERIFIED`)
            EXPECT true   // passes, warning only
        UNSET env

    TEST RG-1 "real installed version vs pinned constant, hard-fails on unreviewed drift":
        pkg = JSON.parse(readFileSync("node_modules/@earendil-works/pi-coding-agent/package.json"))
        IF pkg.version != PINNED_LAST_VERIFIED_VERSION AND NOT seamChecksOptedOut():
            FAIL(`Pi version drifted: installed=${pkg.version} pinned=${PINNED_LAST_VERIFIED_VERSION}.
                  Review @earendil-works/pi-coding-agent + pi-ai changelogs for breaking type
                  changes, then bump PINNED_LAST_VERIFIED_VERSION deliberately.
                  Or set SEAM_CHECKS_UNVERIFIED_I_ACCEPT_DRIFT_RISK=1 to accept the risk.`)
```

---

## Implementation order across all three (per FDD §4 Dependency Graph)

```
F3 (independent)              F1 (Must, no deps)
     |                              |
     |                              v
     |                        F2 (depends on F1)
     |                              |
     +--------- both merge independently, F3 can land before/after/parallel to F1→F2 ---+
```

Per each TDD's §12 gate rule: within F1, within F2, and within F3, contract tests (CT-*)
must be committed and failing for the right reasons before Step 2 (implementation) begins
in that feature. F3's `tsconfig.json`/typecheck script is itself Step 2 of F3 — until it
exists, CT-1 "fails" simply because there is no `npm run typecheck` to run yet.
