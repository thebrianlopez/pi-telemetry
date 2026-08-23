/**
 * The dispatch-trigger contract, as actually written by the producer.
 *
 * Producer: `core/functions/dispatch_emit.fish`
 *
 *     set -l dispatch_file "$dispatch_dir/$task_id.md"
 *     printf '%s\n' '---' $fm_fields '---' '' "# Task: $title" '' $body '' '## Response' ''
 *
 * This fixture is a byte-shaped copy of a real on-disk trigger, so
 * `readTriggers` can be tested against the true encoding rather than against a
 * second hand-typed guess. `test/schema/dispatchContract.test.ts` cross-checks
 * these constants against the live producer when `core` is available.
 */

/** Extension the producer writes. */
export const PRODUCER_EXT = ".md";

/** Producer's filename template, relative to the agent CWD. */
export const PRODUCER_PATH_TEMPLATE = ".claude-dispatch/$task_id.md";

/** Frontmatter fence the producer opens and closes the header block with. */
export const PRODUCER_FENCE = "---";

/**
 * Frontmatter keys emitted by `dispatch_emit.fish` on every trigger.
 * Chain/epic-dispatch producers add `epic_path`, `milestones`, `capabilities`,
 * `model`, `pr_url`, `type`; those are optional and not asserted as required.
 */
export const PRODUCER_REQUIRED_KEYS = [
	"schema_version",
	"task",
	"agent",
	"dispatched_at",
	"status",
	"claimed_at",
	"completed_at",
	"producer",
] as const;

/** Keys this package reads. Every one must be producible by the producer. */
export const CONSUMER_KEYS_READ = [
	"task",
	"epic_path",
	"milestones",
	"status",
] as const;

/**
 * A real trigger, verbatim in shape (identifiers genericised).
 * Note `milestones` is a YAML inline-flow sequence, not a comma string.
 */
export const REAL_TRIGGER_MD = `---
schema_version: 1
task: f3-m5-castex-event-aggregation
agent: castex-agent
epic_path: /Users/x/docs/epics/PERSONAL_20260610T204126Z_automation-metrics_EPIC-209_event-schema.md
dispatched_at: 20260613T141235Z
status: pending
claimed_at: null
completed_at: null
milestones: [M5]
producer: chain
---

# F3 M5: Castex Event Aggregation

## Overview

Body text.

## Response
`;

/** A `.response.md` sibling: same directory, no frontmatter, NOT a trigger. */
export const REAL_RESPONSE_MD = `# EPIC-047 - Bearer Token (response)

## Resources added

- something
`;
