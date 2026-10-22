/**
 * WHICH TREE ANSWERED, AND WHICH VERSION OF THIS PACKAGE.
 *
 * Issue #4. Six times between 2026-09-02 and 2026-09-05 a fix was correct,
 * committed and INERT because the thing running was not the thing changed, and
 * two of those six were the same mistake twice: a gate run by hand from
 * `~/repos` while the cron runs from `~/srv/hadoku_site`. On 2026-09-04 an
 * operator reproducing `ci:identity-model` watched G7 fire while the alert
 * named G3 — `~/repos/hadoku_site` had fleet-manager 0.21.69 installed and srv
 * had 0.21.94 — and chased the wrong rule. The full history is
 * `docs/planning/deployed-not-published-2026-09-05.md`.
 *
 * Nothing about resolution changes here. What was missing was any OUTPUT saying
 * which answer was used, so a discrepancy is visible without already suspecting
 * one.
 *
 * TWO PROPERTIES THIS FILE EXISTS TO HOLD
 * ---------------------------------------
 * 1. THE VERSION IS THE RUNNING MODULE'S OWN, never a manifest and never a
 *    number typed anywhere. It is read from `package.json` at the directory
 *    this compiled file resolves to, which is the one fact that distinguishes
 *    `~/repos/hadoku_site/node_modules/@wolffm/fleet-manager` from srv's copy —
 *    and distinguishing those two IS the whole point. Reading a manifest would
 *    report the same number from either tree.
 *
 * 2. IT NEVER THROWS. `siteRoot()` and `manifestDir()` throw on purpose, because
 *    every reader behind them turns a failed read into an empty result. A
 *    BANNER has no reader behind it: making `fleet --help` or `fleet onboard`
 *    die because no hadoku_site checkout is on disk would be a provenance line
 *    breaking commands that never needed a site root. So an unresolved path is
 *    REPORTED as unresolved, with its reason, and the subcommand goes on to
 *    fail loudly for itself if it actually needed one. "I could not look" still
 *    renders as "I could not look" — it just is not fatal here.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { manifestDir, siteRoot } from './fleet-paths.js';

/** dist/lib/ -> dist/ -> the package root, which is where `package.json` is. */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface Provenance {
	/** The hadoku_site checkout that answered, or why it could not be resolved. */
	site: string;
	/** The manifest directory that answered, or why it could not be resolved. */
	manifests: string;
	/** This package's version, read from the package.json beside the running code. */
	version: string;
}

/**
 * The reason, as ONE line.
 *
 * `must()` writes three lines of explanation, which is right for a fatal error
 * and wrong for a banner — a banner that wraps to four lines stops being read.
 * The first line names the label and the path, which is the part an operator
 * chasing a wrong-tree bug needs.
 */
function unresolved(err: unknown): string {
	const first = (err instanceof Error ? err.message : String(err)).split('\n')[0].trim();
	return `<unresolved: ${first.replace(/^fleet: /, '')}>`;
}

function tryResolve(fn: () => string): string {
	try {
		return fn();
	} catch (err) {
		return unresolved(err);
	}
}

/**
 * This package's version, from the `package.json` beside the running code.
 *
 * Read as a FILE rather than imported: the `exports` map does not list
 * `./package.json`, so `require.resolve('@wolffm/fleet-manager/package.json')`
 * is refused by Node. The directory is derived from `import.meta.url`, which is
 * the running module — not from a resolver that could pick a different install.
 */
export function packageVersion(): string {
	try {
		const raw: unknown = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
		if (typeof raw === 'object' && raw !== null) {
			const v = (raw as Record<string, unknown>).version;
			if (typeof v === 'string' && v) return v;
		}
		return '<unresolved: package.json declares no version>';
	} catch (err) {
		return unresolved(err);
	}
}

export function provenance(): Provenance {
	return {
		site: tryResolve(siteRoot),
		manifests: tryResolve(manifestDir),
		version: packageVersion(),
	};
}

/** The one line. Deliberately `k=v`, so `parseSummary`-shaped eyes can read it. */
export function provenanceLine(p: Provenance = provenance()): string {
	return `site=${p.site} manifests=${p.manifests} fleet-manager=${p.version}`;
}
