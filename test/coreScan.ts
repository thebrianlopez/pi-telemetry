/**
 * Locating and grepping a live `core` checkout for env-var producers.
 *
 * Extracted from the test body so the scan itself is exercisable: a seam check
 * whose scanner is subtly broken reports success it did not earn, which is the
 * same class of failure the check exists to catch.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Candidate `core` checkouts, most explicit first. */
export function coreCandidates(
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	return [
		env.WS_ORG_CORE,
		env.ORG_PATH ? join(env.ORG_PATH, "core") : undefined,
		join(homedir(), "core"),
		join(homedir(), "code", "personal", "core"),
	].filter((p): p is string => Boolean(p));
}

/** First candidate that looks like a real core checkout. */
export function findCore(env: NodeJS.ProcessEnv = process.env): string | null {
	for (const root of coreCandidates(env)) {
		if (existsSync(join(root, "functions"))) return root;
	}
	return null;
}

const SCAN_EXT = /\.(fish|sh|bash|zsh|go|py|ya?ml|toml|json|md)$/;
const MAX_FILE_BYTES = 2_000_000;

export interface SourceFile {
	readonly path: string;
	readonly text: string;
}

/** Every scannable file under `root`. */
export function coreSources(root: string): SourceFile[] {
	const out: SourceFile[] = [];
	const walk = (dir: string) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const p = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === ".git" || entry.name === "node_modules") continue;
				walk(p);
			} else if (SCAN_EXT.test(entry.name)) {
				try {
					if (statSync(p).size > MAX_FILE_BYTES) continue;
					out.push({ path: p, text: readFileSync(p, "utf8") });
				} catch {
					/* an unreadable file is not a contract signal */
				}
			}
		}
	};
	walk(root);
	return out;
}

/**
 * Files that ASSIGN `name`, as opposed to merely mentioning it.
 *
 * Matched: fish `set [-flags] NAME`, `export NAME`, `NAME=value` at the start
 * of a line, and the herdr `--env "NAME=value"` passthrough core uses for
 * dispatched panes.
 *
 * Deliberately NOT matched:
 *   - prose in documentation - naming a variable is not producing it;
 *   - `set -q NAME`, which QUERIES existence and is therefore a consumer;
 *   - `set -e NAME`, which ERASES it and is the opposite of a producer;
 *   - `$NAME` reads.
 *
 * Known imprecision, accepted deliberately: `set -l NAME` (local, unexported)
 * counts as a producer here even though it never reaches a child process.
 * Erring toward counting keeps the check from reporting a FALSE absence, which
 * would send someone hunting a rename that did not happen.
 */
function hasFishSetAssignment(name: string, text: string): boolean {
	const re = new RegExp(`\\bset\\s+((?:-[a-zA-Z]+\\s+)*)${name}\\b`, "g");
	for (const m of text.matchAll(re)) {
		const flags = m[1] ?? "";
		// `-q` queries, `-e` erases. Either makes this a non-producer.
		if (/-[a-zA-Z]*[qe]/.test(flags)) continue;
		return true;
	}
	return false;
}

export function producersOf(name: string, sources: SourceFile[]): string[] {
	const otherPatterns = [
		new RegExp(`\\bexport\\s+${name}\\b`),
		new RegExp(`--env\\s+"?${name}=`),
		new RegExp(`^[ \\t]*${name}=`, "m"),
	];
	const hits: string[] = [];
	for (const src of sources) {
		if (!src.text.includes(name)) continue;
		if (
			hasFishSetAssignment(name, src.text) ||
			otherPatterns.some((re) => re.test(src.text))
		) {
			hits.push(src.path);
		}
	}
	return hits;
}

/**
 * Drop core's own test harnesses.
 *
 * They set `AUTOMATION_METRICS_DIR` and friends to redirect fixtures at a
 * tmpdir. That is a test double, not a production producer, and counting it
 * would let a deleted real producer keep passing.
 */
export function excludingCoreTests(paths: string[]): string[] {
	return paths.filter(
		(p) => !/\/tests?\//.test(p) && !/\/test[-_][^/]*$/.test(p),
	);
}

/** Every `AUTOMATION_METRICS_*` name appearing in TypeScript under `dirs`. */
export function envNamesInSource(repoRoot: string, dirs: string[]): Set<string> {
	const re = /AUTOMATION_METRICS_[A-Z0-9_]+/g;
	const found = new Set<string>();
	const walk = (dir: string) => {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
				walk(p);
			} else if (/\.(ts|js|mts|mjs)$/.test(entry.name)) {
				for (const m of readFileSync(p, "utf8").matchAll(re)) found.add(m[0]);
			}
		}
	};
	for (const d of dirs) walk(join(repoRoot, d));
	return found;
}
