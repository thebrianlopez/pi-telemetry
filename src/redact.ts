/**
 * Credential redaction for free-text fields.
 *
 * The event bus is a plaintext append-only JSONL file with no rotation and no
 * access control, living beside `~/.automation-metrics` on shared Alpine
 * instances. Anything that reaches it should be assumed readable. Every
 * free-text field emitted by this package passes through {@link redact} first.
 *
 * Ordering matters: the PEM block rule runs before the generic `KEY=value`
 * rule so a multi-line private key is replaced whole rather than line by line.
 */

export const REDACTED = "[REDACTED]";

interface Rule {
	name: string;
	pattern: RegExp;
	replace: (match: string, ...groups: string[]) => string;
}

/**
 * Rules are applied in order. Each pattern carries the `g` flag; `lastIndex`
 * is reset before use so a shared module-level regex cannot leak state between
 * calls (a classic source of intermittent misses).
 */
const RULES: Rule[] = [
	{
		// Whole PEM block, including headers and body. Must precede the
		// generic KEY=value rule.
		name: "private_key_block",
		pattern:
			/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
		replace: () => REDACTED,
	},
	{
		// Truncated or malformed PEM: header present, terminator missing.
		name: "private_key_header",
		pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
		replace: () => REDACTED,
	},
	{
		name: "anthropic_key",
		pattern: /sk-ant-[A-Za-z0-9_-]+/g,
		replace: () => REDACTED,
	},
	{
		// OpenAI-style keys: sk- followed by a long opaque body. Deliberately
		// requires length so ordinary words like "sk-1" are not mangled.
		name: "openai_key",
		pattern: /\bsk-[A-Za-z0-9]{16,}/g,
		replace: () => REDACTED,
	},
	{
		// GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_
		name: "github_token",
		pattern: /\bgh[pousr]_[A-Za-z0-9]+/g,
		replace: () => REDACTED,
	},
	{
		name: "aws_access_key_id",
		pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
		replace: () => REDACTED,
	},
	{
		// Generic secret-bearing assignment. Catch-all, runs last so more
		// specific rules win. Preserves the key so the shape stays legible.
		name: "secret_assignment",
		pattern:
			/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|CREDENTIAL)[A-Za-z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi,
		replace: (_m, key) => `${key}=${REDACTED}`,
	},
];

/**
 * Replace credential material in `text`.
 *
 * Never throws. Non-string input returns an empty string so callers can pass
 * unknown values without a guard.
 */
export function redact(text: unknown): string {
	if (typeof text !== "string" || text === "") return "";

	let out = text;
	for (const rule of RULES) {
		rule.pattern.lastIndex = 0;
		out = out.replace(rule.pattern, rule.replace as never);
	}
	return out;
}

/** Rule names, exposed for tests and diagnostics. */
export const RULE_NAMES = RULES.map((r) => r.name);

/** True when redaction would alter the input. */
export function containsSecret(text: unknown): boolean {
	if (typeof text !== "string" || text === "") return false;
	return redact(text) !== text;
}
