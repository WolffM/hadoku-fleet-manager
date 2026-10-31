/**
 * check-header-fleet's allowlist (scripts/check-header-fleet.mjs, wave 5m
 * lane D split #13 — pure move): exemptions keyed `repo:rule` or `repo:path`,
 * and the one place this gate stops itself on a fault in its OWN inputs
 * rather than in the fleet it audits.
 *
 * `ALLOWLIST_JSON` is resolved INSIDE `loadAllowlist`, not as a module-level
 * constant — the same "a value that must be computed after the CLI installs
 * a host is computed lazily" rule `floor-probe-state.mjs`'s `ledgerPath`
 * follows, so importing this module alone never resolves the manifest
 * directory as a side effect of the import itself.
 */
import { readFileSync } from 'node:fs';

import { manifest as manifestFile } from './paths.mjs';

/**
 * Exemptions keyed `repo:rule` or `repo:path`. Every entry needs a `why`, and
 * an entry that stops matching FAILS — an exemption must not outlive its
 * reason. Mirrors tier-fleet-allowlist.json.
 *
 * `ctx` carries exactly what a malformed entry needs to `refuse` through —
 * `json`/`emitter` (the CLI's own stdout discipline) and `repoCount` (what
 * `--json`'s `repos` field reports) — passed in explicitly rather than
 * reverse-imported from `check-header-fleet.mjs`; see that module's header for
 * why the reverse import was wrong.
 */
export function loadAllowlist(ctx) {
	const ALLOWLIST_JSON = manifestFile('header-fleet-allowlist.json');
	let obj;
	try {
		obj = JSON.parse(readFileSync(ALLOWLIST_JSON, 'utf8'));
	} catch (err) {
		if (err.code === 'ENOENT') return new Map();
		throw err;
	}
	const map = new Map();
	for (const entry of obj.allowed || []) {
		if (!entry.key || !entry.why) {
			refuse(ctx, `allowlist entry missing "key" or "why": ${JSON.stringify(entry)}`);
		}
		map.set(entry.key, entry);
	}
	return map;
}

/**
 * Stop the run on a fault in this script's OWN inputs, keeping `--json`
 * parseable.
 *
 * A bare `console.error` + `exit(1)` printed nothing to stdout, and
 * ci:header-fleet reads stdout BEFORE the exit code — so a malformed allowlist
 * entry surfaced as "checker produced no JSON", i.e. "the checker broke",
 * rather than as the one-line config fault it is. The document carries the
 * fault as a finding as well as `error`, because the consumer fails a run with
 * zero `repos` before it reads anything else, and a finding is the field it
 * already turns into a readable page.
 */
export function refuse({ json, emitter, repoCount }, message) {
	if (json) {
		emitter.emit({
			error: message,
			repos: repoCount,
			findings: [{ repo: 'header-fleet-allowlist', rule: 'allowlist-invalid', detail: message }],
			advisory: [],
			staleExemptions: [],
		});
	} else {
		console.error(`✗ ${message}`);
	}
	process.exit(1);
}
