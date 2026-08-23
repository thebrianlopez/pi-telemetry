# pi-telemetry

Pi coding agent extension that emits structured JSONL telemetry to the automation-metrics event bus.

## Install

```bash
pi install git:github.com/thebrianlopez/pi-telemetry
```

## What it does

Hooks into Pi's extension lifecycle to emit events matching the canonical automation-metrics event schema:

| Pi Event | Emitted event_type |
|----------|-------------------|
| `session_start` | `agent_lifecycle` (`agent_start`), `task_boundary` (`claim` or `handoff`) |
| `tool_call` | `tool_use`, `agent_lifecycle` (`tool_execution_start`) |
| `tool_result` | `tool_result` or `tool_failure`, `agent_lifecycle` (`tool_execution_end`) |
| `agent_end` | `prompt_submit`, `agent_lifecycle` (`agent_end`) |
| `model_select` | `model_routing_decision`, `agent_lifecycle` (`model_select`) |
| `session_shutdown` | `layer_routing_decision`, `task_boundary` (`release` or `suspend`), `session_summary` |

The `tool_execution_start` / `tool_execution_end` pair is emitted only under lifecycle detail `full`; the shipped default is `session`.

All events carry `harness: "pi"` and `agent_runtime: "pi-coding-agent"` to distinguish from Claude Code hook events.

Events append to `~/.automation-metrics/events/YYYY-MM-DD.jsonl`.

## Schema version and compatibility

`src/schema/eventSchema.ts` is a vendored **2.14 snapshot** of the canonical schema, covering only the 13 event types this package writes or correlates against. Validation compares the **major** version, so emission stays forward-compatible across all of 2.x: a minor bump does not invalidate historical events or fish-emitted events carrying `schema_version: "2"`.

The canonical `core/schemas/event-schema.yaml` is currently **v2.16**. Releases 2.15 and 2.16 only added new event types owned by other producers (chain-eval, agora, and legacy emitters); none of this package's 13 event types changed and no required common field was added, so the 2.14 pin remains accurate for this scope. `test/schema/parity.test.ts` checks the vendored snapshot against the canonical document when a `core` checkout is present.

## Herdr integration boundary

This package does **not** emit Herdr events. `pi_session_complete`, `dispatch_abandoned`, `workspace_idle`, and `agent_status_stalled` are written by `core`'s observer (`core/functions/herdr-event-emitter.fish`). pi-telemetry models and validates them so both producers share one event contract.

## Agent identity

Set `AUTOMATION_METRICS_AGENT` to tag events with the agent name:

```bash
AUTOMATION_METRICS_AGENT=linkari-workspace-agent pi
```

Without this env var, events emit with `agent: null`.

## Dev

```bash
# Test locally without installing
pi -e ./extensions/telemetry.ts

# Verify events
jq . ~/.automation-metrics/events/$(date +%Y-%m-%d).jsonl | tail -5
```

### Seam checks

Two test suites compare literals hard-coded here against their source of truth
in `core`:

- `test/schema/parity.test.ts` - vendored schema snapshot vs `core/schemas/event-schema.yaml`
- `test/schema/dispatchContract.test.ts` - dispatch trigger contract vs `core/functions/dispatch_emit.fish`

Both **fail** when `core` cannot be found. That is deliberate: a suite that
skips the comparison and still reports green is indistinguishable from one that
verified it. Point `WS_ORG_CORE` (and optionally
`AUTOMATION_METRICS_SCHEMA_PATH`) at a checkout, or opt out explicitly:

```bash
SEAM_CHECKS_UNVERIFIED_I_ACCEPT_DRIFT_RISK=1 npm test
```

That variable appearing in a CI config or shell profile means drift from `core`
is undetected in that environment. Treat it as a finding, not a default.
