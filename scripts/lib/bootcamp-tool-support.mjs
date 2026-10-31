import { createReleaseLookup } from './tool-release.mjs';
import { readFileSync } from 'node:fs';
import process from 'node:process';

/**
 * ONE release lookup for the whole run, shared by every node's `ensureTools`
 * call so a fleet-wide bootcamp asks npm once per tool rather than once per
 * node (the same per-run sharing `createReleaseLookup` gives the refresh
 * cycle).
 *
 * TEST SEAM. In every real invocation this is `createReleaseLookup()` — the
 * npm registry, for real; `FLEET_TEST_RELEASE_LOOKUP` is unset. The fixtures
 * in `bootcamp.test.mjs` run offline and must not depend on reaching the
 * registry to stay deterministic, so they point this at a JSON file holding
 * one canned `resolveInstallTarget`-shaped answer
 * (`{"status":"known","version":"...","publishedAt":"..."}` or
 * `{"status":"unknown","reason":"..."}`), the same shape `lookupLatest`
 * returns.
 */
export function releaseLookup() {
	const fixture = process.env.FLEET_TEST_RELEASE_LOOKUP;
	if (!fixture) return createReleaseLookup();
	const canned = JSON.parse(readFileSync(fixture, 'utf8'));
	return async () => canned;
}

/** The tail of a failed command's output — the reason, not the whole log. */
export const reasonOf = (r) =>
	(r.stderr || r.stdout || r.error || 'no output')
		.trim()
		.split('\n')
		.slice(-3)
		.join(' | ')
		.slice(-300);
