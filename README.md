# pi-telemetry

Pi coding agent extension that emits structured JSONL telemetry to the automation-metrics event bus.

## Install

```bash
pi install git:github.com/thebrianlopez/pi-telemetry
```

## What it does

Hooks into Pi's extension lifecycle to emit events matching `~/.automation-metrics/event-schema.yaml` (v2.14):

| Pi Event | Emitted event_type |
|----------|-------------------|
| `session_start` | (init accumulator) |
| `tool_call` | `tool_use` |
| `tool_result` | `tool_result` or `tool_failure` |
| `agent_end` | `prompt_submit` |
| `model_select` | `model_routing_decision` |
| `session_shutdown` | `session_summary` |

All events carry `harness: "pi"` and `agent_runtime: "pi-coding-agent"` to distinguish from Claude Code hook events.

Events append to `~/.automation-metrics/events/YYYY-MM-DD.jsonl`.

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
