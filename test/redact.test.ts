import { describe, expect, it } from "vitest";

import {
	REDACTED,
	RULE_NAMES,
	containsSecret,
	redact,
} from "../src/redact.ts";

/** Representative secret shapes. Values are synthetic. */
const SECRETS = {
	anthropic: "sk-ant-api03-AbCdEf_1234-ZzZz",
	openai: "sk-proj0123456789abcdefXYZ",
	githubPat: "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
	githubServer: "ghs_AbCdEf0123456789",
	awsAccessKey: "AKIAIOSFODNN7EXAMPLE",
	awsSecret: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY",
	genericToken: "GH_TOKEN=abc123def456",
	genericPassword: "DB_PASSWORD='hunter2'",
	pem: [
		"-----BEGIN RSA PRIVATE KEY-----",
		"MIIEowIBAAKCAQEAx7Nn2vQ9L0kFakeKeyMaterialForTests",
		"AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/=",
		"-----END RSA PRIVATE KEY-----",
	].join("\n"),
};

describe("redact", () => {
	it("removes an Anthropic API key", () => {
		const out = redact(`key is ${SECRETS.anthropic} ok`);
		expect(out).not.toContain("sk-ant-");
		expect(out).toContain(REDACTED);
	});

	it("removes an OpenAI-style key", () => {
		expect(redact(SECRETS.openai)).toBe(REDACTED);
	});

	it("removes GitHub tokens of every prefix", () => {
		for (const t of [SECRETS.githubPat, SECRETS.githubServer]) {
			const out = redact(`token=${t}`);
			expect(out).not.toContain(t);
		}
	});

	it("removes an AWS access key id", () => {
		expect(redact(SECRETS.awsAccessKey)).toBe(REDACTED);
	});

	it("removes an AWS secret value but keeps the key name", () => {
		const out = redact(SECRETS.awsSecret);
		expect(out).toContain("AWS_SECRET_ACCESS_KEY");
		expect(out).not.toContain("wJalrXUtnFEMI");
	});

	it("removes a whole PEM private key block", () => {
		const out = redact(`before\n${SECRETS.pem}\nafter`);
		expect(out).not.toContain("MIIEowIBAAKCAQEA");
		expect(out).not.toContain("BEGIN RSA PRIVATE KEY");
		expect(out).toContain("before");
		expect(out).toContain("after");
	});

	it("removes a truncated PEM header with no terminator", () => {
		const out = redact("-----BEGIN OPENSSH PRIVATE KEY-----\nabc123");
		expect(out).not.toContain("BEGIN OPENSSH PRIVATE KEY");
	});

	it("redacts generic TOKEN/PASSWORD assignments", () => {
		expect(redact(SECRETS.genericToken)).not.toContain("abc123def456");
		expect(redact(SECRETS.genericPassword)).not.toContain("hunter2");
	});

	it("is case-insensitive for generic assignments", () => {
		expect(redact("api_key=supersecretvalue")).not.toContain(
			"supersecretvalue",
		);
	});

	it("leaves ordinary prose untouched", () => {
		const prose =
			"Run the tests and check that the schema validator drops bad events.";
		expect(redact(prose)).toBe(prose);
	});

	it("does not mangle short hyphenated words resembling key prefixes", () => {
		const text = "sk-1 and gh-pages and secret sauce";
		expect(redact(text)).toBe(text);
	});

	it("handles multiple secrets of different classes in one string", () => {
		const text = `${SECRETS.anthropic} then ${SECRETS.githubPat} then ${SECRETS.awsAccessKey}`;
		const out = redact(text);
		expect(out).not.toContain("sk-ant-");
		expect(out).not.toContain("ghp_");
		expect(out).not.toContain("AKIA");
	});

	it("is idempotent", () => {
		const once = redact(`${SECRETS.anthropic} ${SECRETS.pem}`);
		expect(redact(once)).toBe(once);
	});

	it("returns empty string for non-string input", () => {
		for (const v of [undefined, null, 42, true, {}, []]) {
			expect(redact(v)).toBe("");
		}
	});

	it("never throws", () => {
		const inputs: unknown[] = [
			undefined,
			null,
			"",
			"x".repeat(10_000),
			Symbol("s"),
			{ toString: () => { throw new Error("boom"); } },
		];
		for (const i of inputs) expect(() => redact(i)).not.toThrow();
	});

	it("has no regex state leakage across calls", () => {
		// A shared /g regex with a stale lastIndex silently skips matches on
		// alternating calls. Same input must redact identically every time.
		const text = `a ${SECRETS.githubPat} b`;
		const results = new Set(
			Array.from({ length: 10 }, () => redact(text)),
		);
		expect(results.size).toBe(1);
		expect([...results][0]).not.toContain("ghp_");
	});
});

describe("containsSecret", () => {
	it("detects each secret class", () => {
		for (const [name, value] of Object.entries(SECRETS)) {
			expect(containsSecret(value), name).toBe(true);
		}
	});

	it("returns false for clean prose and non-strings", () => {
		expect(containsSecret("nothing to see here")).toBe(false);
		expect(containsSecret(undefined)).toBe(false);
		expect(containsSecret(123)).toBe(false);
	});
});

describe("rule table", () => {
	it("exposes stable rule names", () => {
		expect(RULE_NAMES).toContain("private_key_block");
		expect(RULE_NAMES).toContain("anthropic_key");
		expect(RULE_NAMES).toContain("secret_assignment");
	});

	it("orders the PEM block rule before the generic assignment rule", () => {
		expect(RULE_NAMES.indexOf("private_key_block")).toBeLessThan(
			RULE_NAMES.indexOf("secret_assignment"),
		);
	});
});
