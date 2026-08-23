/**
 * Dispatch-trigger seam.
 *
 * This package CONSUMES files written by `core/functions/dispatch_emit.fish`.
 * Nothing in the type system, the build, or the previous test suite compared
 * the two sides. The consumer filtered `.endsWith(".json")` and parsed with
 * `JSON.parse`; the producer had been writing `$task_id.md` with YAML
 * frontmatter for months. The result was silent absence: no error, no event,
 * no task identity.
 *
 * Two layers here, on purpose:
 *
 *   1. FIXTURE LAYER (always runs) - `readTriggers` is exercised against a
 *      byte-shaped copy of a real on-disk trigger. This catches the consumer
 *      drifting away from the recorded contract.
 *   2. PRODUCER LAYER (runs when `core` is present, hard-fails otherwise) -
 *      the recorded contract is checked against the live producer source. This
 *      catches the producer drifting away from the recorded contract.
 *
 * RESIDUAL GAP, stated explicitly: layer 2 greps fish source rather than
 * executing `dispatch_emit`. It pins the write path and the frontmatter fence,
 * which are the two literals that actually broke. It would NOT catch a
 * semantic change that preserves those literals - e.g. `status:` gaining a new
 * value, or `milestones` switching from inline-flow to a block sequence.
 * Closing that would require running the producer, which needs fish, yq, cue,
 * and a registered agent id, and is out of scope for a unit suite.
 */

import { describe, expect, it } from "vitest";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
	DISPATCH_RESPONSE_SUFFIX,
	DISPATCH_TRIGGER_EXT,
	FRONTMATTER_FENCE,
	parseFrontmatter,
	readTriggers,
	resolveTaskContext,
} from "../../src/taskContext.ts";
import {
	CONSUMER_KEYS_READ,
	PRODUCER_EXT,
	PRODUCER_FENCE,
	PRODUCER_PATH_TEMPLATE,
	PRODUCER_REQUIRED_KEYS,
	REAL_RESPONSE_MD,
	REAL_TRIGGER_MD,
} from "../fixtures/dispatchTrigger.ts";
import { SEAM_OPT_OUT, seamChecksOptedOut } from "../seamOptOut.ts";

function scratch(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "pi-dispatch-"));
	const d = join(root, ".claude-dispatch");
	mkdirSync(d, { recursive: true });
	for (const [name, body] of Object.entries(files)) {
		writeFileSync(join(d, name), body);
	}
	return d;
}

describe("dispatch trigger seam: consumer vs recorded contract", () => {
	it("the consumer's extension literal is the producer's extension", () => {
		expect(DISPATCH_TRIGGER_EXT).toBe(PRODUCER_EXT);
		expect(PRODUCER_PATH_TEMPLATE.endsWith(DISPATCH_TRIGGER_EXT)).toBe(true);
	});

	it("the consumer's fence literal is the producer's fence", () => {
		expect(FRONTMATTER_FENCE).toBe(PRODUCER_FENCE);
	});

	it("a real trigger parses into the fields the consumer reads", () => {
		const fm = parseFrontmatter(REAL_TRIGGER_MD);
		expect(fm, "real trigger did not parse as frontmatter").not.toBeNull();
		for (const key of CONSUMER_KEYS_READ) {
			expect(Object.keys(fm!), `consumer reads '${key}'`).toContain(key);
		}
	});

	it("every field the producer always writes survives the consumer's parse", () => {
		const fm = parseFrontmatter(REAL_TRIGGER_MD)!;
		const missing = PRODUCER_REQUIRED_KEYS.filter((k) => !(k in fm));
		expect(missing, `producer keys lost in parse: ${missing.join(", ")}`).toEqual(
			[],
		);
	});

	it("readTriggers resolves epic AND milestones from a real trigger", () => {
		const d = scratch({ "f3-m5-castex-event-aggregation.md": REAL_TRIGGER_MD });
		const triggers = readTriggers(d);
		expect(triggers).toHaveLength(1);
		expect(triggers[0].epic).toBe("EPIC-209");
		// The inline-flow sequence must not leak brackets into the task id.
		expect(triggers[0].milestones).toEqual(["M5"]);
		expect(triggers[0].claimed).toBe(false);
		expect(resolveTaskContext({ dispatchDir: d, env: {} })).toMatchObject({
			taskId: "EPIC-209-M5",
			source: "dispatch",
		});
	});

	it("JSON.parse would have failed on this content - the extension alone was not the bug", () => {
		expect(() => JSON.parse(REAL_TRIGGER_MD)).toThrow();
	});

	it("a .response.md sibling is not treated as a trigger", () => {
		const d = scratch({
			"epic-047-thing.response.md": REAL_RESPONSE_MD,
		});
		expect(DISPATCH_RESPONSE_SUFFIX.endsWith(DISPATCH_TRIGGER_EXT)).toBe(true);
		expect(readTriggers(d)).toEqual([]);
		// And it must not suppress the chain-key fallback.
		expect(
			resolveTaskContext({
				dispatchDir: d,
				env: { AUTOMATION_METRICS_CHAIN_KEY: "chain-1" },
			}),
		).toMatchObject({ taskId: "chain-1", source: "chain_key" });
	});

	it("a frontmatter-less stray .md is ignored rather than half-read", () => {
		const d = scratch({ "notes.md": "# just notes\n" });
		expect(readTriggers(d)).toEqual([]);
	});

	it("a claimed trigger is marked claimed via frontmatter status", () => {
		const d = scratch({
			"t.md": REAL_TRIGGER_MD.replace("status: pending", "status: claimed"),
		});
		expect(readTriggers(d)[0].claimed).toBe(true);
	});

	it("no .json trigger is read, so the dead format cannot mask producer drift", () => {
		const d = scratch({
			"legacy_EPIC-100_x.json": JSON.stringify({ epic_path: "EPIC-100" }),
		});
		expect(readTriggers(d)).toEqual([]);
	});
});

/** Candidate `core` checkouts, most explicit first. */
const CORE_CANDIDATES = [
	process.env.WS_ORG_CORE,
	process.env.ORG_PATH ? join(process.env.ORG_PATH, "core") : undefined,
	join(homedir(), "core"),
	join(homedir(), "code", "personal", "core"),
].filter((p): p is string => Boolean(p));

function findProducer(): string | null {
	for (const root of CORE_CANDIDATES) {
		const p = join(root, "functions", "dispatch_emit.fish");
		if (existsSync(p)) return p;
	}
	return null;
}

const producerPath = findProducer();

describe("dispatch trigger seam: recorded contract vs live producer", () => {
	if (!producerPath) {
		const where = CORE_CANDIDATES.map((p) =>
			`    - ${join(p, "functions", "dispatch_emit.fish")}`,
		).join("\n");

		if (seamChecksOptedOut()) {
			it(`UNVERIFIED by opt-out (${SEAM_OPT_OUT})`, () => {
				console.warn(
					`\n  [dispatch] ${SEAM_OPT_OUT} is set. The dispatch trigger` +
						`\n  contract was NOT checked against dispatch_emit.fish in this run.` +
						`\n  Looked in:\n${where}\n`,
				);
				expect(PRODUCER_EXT).toBe(DISPATCH_TRIGGER_EXT);
			});
			return;
		}

		it("producer source must be present for the contract to be verifiable", () => {
			throw new Error(
				`dispatch_emit.fish not found; the dispatch trigger contract is UNVERIFIABLE.\n` +
					`  Looked in:\n${where}\n` +
					`  Fix by either:\n` +
					`    - setting WS_ORG_CORE to a core checkout, or\n` +
					`    - setting ${SEAM_OPT_OUT}=1 to accept undetected producer drift\n` +
					`      in this environment.`,
			);
		});
		return;
	}

	const src = readFileSync(producerPath, "utf8");

	it("the producer writes the extension this package filters on", () => {
		const m = /set\s+-l\s+dispatch_file\s+"([^"]+)"/.exec(src);
		expect(m, "could not locate the dispatch_file assignment").not.toBeNull();
		const template = m![1];
		expect(
			template.endsWith(DISPATCH_TRIGGER_EXT),
			`producer writes '${template}' but this package filters on '${DISPATCH_TRIGGER_EXT}'`,
		).toBe(true);
	});

	it("the producer writes into the directory this package reads", () => {
		expect(src).toContain(".claude-dispatch");
	});

	it("the producer emits a frontmatter fence, not JSON", () => {
		// The write is: printf '%s\n' '---' $fm_fields '---' ...
		expect(
			new RegExp(`printf[^\\n]*'${PRODUCER_FENCE}'`).test(src),
			"producer no longer opens the file with a frontmatter fence",
		).toBe(true);
	});

	it("every frontmatter key the recorded contract requires is still emitted", () => {
		const missing = PRODUCER_REQUIRED_KEYS.filter(
			(k) => !new RegExp(`"${k}:`).test(src),
		);
		expect(
			missing,
			`producer no longer emits: ${missing.join(", ")}`,
		).toEqual([]);
	});

	it("records which producer was checked", () => {
		console.log(`  [dispatch] verified against ${producerPath}`);
		expect(producerPath).toBeTruthy();
	});
});
