/**
 * Dependency-free validator for automation-metrics events.
 *
 * Contract (TDD F-007):
 *   - Pure and synchronous.
 *   - NEVER throws, for any input — including undefined, null, arrays, and
 *     primitives. A telemetry validator that throws inside a Pi lifecycle hook
 *     would degrade the harness it exists to observe.
 *   - Callers drop invalid events and count them; they do not raise.
 */

import {
	COMMON_FIELDS,
	EVENT_RULES,
	KNOWN_EVENT_TYPES,
	SCHEMA_MAJOR,
	SCHEMA_VERSION,
	TIMESTAMP_PATTERN,
	majorVersion,
	type FieldRule,
} from "./eventSchema.ts";

export type IssueCode =
	| "missing_required"
	| "type_mismatch"
	| "enum_violation"
	| "unknown_event_type"
	| "schema_version_mismatch"
	| "validator_internal_error";

export interface ValidationIssue {
	field: string;
	code: IssueCode;
	detail: string;
}

export interface ValidationResult {
	valid: boolean;
	issues: ValidationIssue[];
}

export function isKnownEventType(t: unknown): boolean {
	return typeof t === "string" && Object.hasOwn(EVENT_RULES, t);
}

/** Structural type check for one field against its rule. */
function checkField(
	path: string,
	value: unknown,
	rule: FieldRule,
	issues: ValidationIssue[],
): void {
	const nullable = rule.kind.endsWith("_or_null");
	const base = nullable ? rule.kind.slice(0, -"_or_null".length) : rule.kind;

	if (value === null) {
		if (!nullable) {
			issues.push({
				field: path,
				code: "type_mismatch",
				detail: `expected ${rule.kind}, got null`,
			});
		}
		return;
	}

	let ok: boolean;
	switch (base) {
		case "string":
			ok = typeof value === "string";
			break;
		case "number":
			ok = typeof value === "number" && Number.isFinite(value);
			break;
		case "boolean":
			ok = typeof value === "boolean";
			break;
		case "object":
			ok =
				typeof value === "object" &&
				value !== null &&
				!Array.isArray(value);
			break;
		default:
			ok = false;
	}

	if (!ok) {
		issues.push({
			field: path,
			code: "type_mismatch",
			detail: `expected ${rule.kind}, got ${describe(value)}`,
		});
		return;
	}

	if (rule.enum && typeof value === "string" && !rule.enum.includes(value)) {
		issues.push({
			field: path,
			code: "enum_violation",
			detail: `value '${value}' not in [${rule.enum.join(", ")}]`,
		});
	}
}

function describe(v: unknown): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	return typeof v;
}

/**
 * Validate one event against the vendored schema snapshot.
 *
 * Returns `{ valid: false, issues }` rather than throwing. An empty `issues`
 * array always accompanies `valid: true`.
 */
export function validateEvent(event: unknown): ValidationResult {
	const issues: ValidationIssue[] = [];

	try {
		if (
			typeof event !== "object" ||
			event === null ||
			Array.isArray(event)
		) {
			return {
				valid: false,
				issues: [
					{
						field: "(root)",
						code: "type_mismatch",
						detail: `expected object, got ${describe(event)}`,
					},
				],
			};
		}

		const e = event as Record<string, unknown>;

		// 1. Common fields: presence + type + enum.
		for (const [name, rule] of Object.entries(COMMON_FIELDS)) {
			if (!Object.hasOwn(e, name)) {
				if (rule.required !== false) {
					issues.push({
						field: name,
						code: "missing_required",
						detail: `required field '${name}' absent`,
					});
				}
				continue;
			}
			checkField(name, e[name], rule, issues);
		}

		// 2. Schema version: compare MAJOR only.
		//
		// The bus carries "2" (emit_jsonl) and "2.14" (pi-telemetry). Minor
		// revisions only add optional fields, so an exact-match rule would
		// reject every historical and fish-emitted event for no benefit.
		if (typeof e.schema_version === "string") {
			const got = majorVersion(e.schema_version);
			if (got !== SCHEMA_MAJOR) {
				issues.push({
					field: "schema_version",
					code: "schema_version_mismatch",
					detail: `major version '${got}' is incompatible with '${SCHEMA_MAJOR}' (from '${e.schema_version}', snapshot '${SCHEMA_VERSION}')`,
				});
			}
		}

		// 3. Timestamp shape.
		if (
			typeof e.timestamp === "string" &&
			!TIMESTAMP_PATTERN.test(e.timestamp)
		) {
			issues.push({
				field: "timestamp",
				code: "type_mismatch",
				detail: `expected YYYYMMDDTHHMMSSZ, got '${e.timestamp}'`,
			});
		}

		// 4. Non-empty invariants for fields that exist. An empty session_id or
		//    cwd defeats correlation, so a present-but-blank value is rejected
		//    even though the field itself is optional.
		for (const name of ["session_id", "cwd", "agent_runtime", "command"]) {
			if (typeof e[name] === "string" && e[name] === "") {
				issues.push({
					field: name,
					code: "missing_required",
					detail: `'${name}' must not be empty`,
				});
			}
		}

		// 5. Event type must be known before per-type rules can apply.
		if (!isKnownEventType(e.event_type)) {
			issues.push({
				field: "event_type",
				code: "unknown_event_type",
				detail:
					typeof e.event_type === "string"
						? `'${e.event_type}' not in [${KNOWN_EVENT_TYPES.join(", ")}]`
						: `expected string, got ${describe(e.event_type)}`,
			});
			return { valid: issues.length === 0, issues };
		}

		const rule = EVENT_RULES[e.event_type as string];

		// 6. Layer must match the type's declared layer.
		if (typeof e.layer === "string" && e.layer !== rule.layer) {
			issues.push({
				field: "layer",
				code: "enum_violation",
				detail: `event_type '${String(e.event_type)}' requires layer '${rule.layer}', got '${e.layer}'`,
			});
		}

		// 7. Per-type metadata contract.
		//
		// Metadata keys are validated for TYPE and ENUM when present, but their
		// presence is not mandated. The canonical schema documents 48
		// metadata_fields blocks and marks exactly one field `required`, so the
		// block describes the shape a field takes rather than a set every
		// producer must supply.
		//
		// Enforcing presence here rejected 285 of 298 real bus events —
		// including every Claude Code `tool_use`, which omits `first_word`.
		// Completeness of THIS package's own emissions is package policy and is
		// asserted by RG-1 instead.
		if (rule.metadata) {
			const meta = e.metadata;
			if (
				typeof meta === "object" &&
				meta !== null &&
				!Array.isArray(meta)
			) {
				const m = meta as Record<string, unknown>;
				for (const [name, fieldRule] of Object.entries(rule.metadata)) {
					if (!Object.hasOwn(m, name)) continue;
					checkField(`metadata.${name}`, m[name], fieldRule, issues);
				}
			}
			// A non-object `metadata` was already reported by the common-field
			// pass; no need to double-report per key.
		}

		return { valid: issues.length === 0, issues };
	} catch (err) {
		// Defensive: the validator must never propagate.
		return {
			valid: false,
			issues: [
				{
					field: "(validator)",
					code: "validator_internal_error",
					detail: err instanceof Error ? err.message : String(err),
				},
			],
		};
	}
}
