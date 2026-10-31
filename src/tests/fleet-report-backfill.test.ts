/**
 * `fetchJobForBackfill`: moved onto github-client.ts's `ghFetchRaw` (plan
 * §4.1 F2b) — extracted to a named export so this behaviour (especially
 * that a network failure never reports `expired: true`) can be pinned
 * directly. This closure had NO test coverage at all before this wave:
 * every existing `backfillFailedSteps` test injects its own fetch-like
 * callback and never exercised the real one inline in the route. Split out
 * of fleet-report.test.ts (wave 5o lane B) — see
 * `src/tests/helpers/fleet-report-rig.ts` for the shared admission-verdict
 * reset every split file installs (this file's tests do not read it, but
 * node:test's beforeEach was file-global in the original, so it is kept
 * here for parity).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchJobForBackfill } from '../routes/fleet.js';
import { installFleetReportRig } from './helpers/fleet-report-rig.js';

installFleetReportRig();

// ---------------------------------------------------------------------------
// fetchJobForBackfill: moved onto github-client.ts's `ghFetchRaw` (plan §4.1
// F2b) — extracted to a named export so this behaviour (especially that a
// network failure never reports `expired: true`) can be pinned directly.
// This closure had NO test coverage at all before this wave: every existing
// `backfillFailedSteps` test injects its own fetch-like callback and never
// exercised the real one inline in the route.
// ---------------------------------------------------------------------------

test('fetchJobForBackfill: a successful read parses the job, expired: false', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ id: 1, conclusion: 'failure', steps: [] }), {
			status: 200,
		})) as typeof fetch;
	try {
		const r = await fetchJobForBackfill('WolffM/x', 1, 'tok');
		assert.deepEqual(r, { job: { id: 1, conclusion: 'failure', steps: [] }, expired: false });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('fetchJobForBackfill: a 404 is EXPIRED — the job aged out of GitHub, stop asking', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
	try {
		const r = await fetchJobForBackfill('WolffM/x', 1, 'tok');
		assert.deepEqual(r, { job: null, expired: true });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('fetchJobForBackfill: a non-404 failure is NOT expired — worth another pass', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response('', { status: 500 })) as typeof fetch;
	try {
		const r = await fetchJobForBackfill('WolffM/x', 1, 'tok');
		assert.deepEqual(r, { job: null, expired: false });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('fetchJobForBackfill: a network failure never throws and is never reported expired', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => {
		throw new Error('ECONNRESET');
	}) as typeof fetch;
	try {
		const r = await fetchJobForBackfill('WolffM/x', 1, 'tok');
		assert.deepEqual(r, { job: null, expired: false });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('fetchJobForBackfill: the User-Agent names THIS package, not the mgmt-api leftover', async () => {
	const originalFetch = globalThis.fetch;
	let seenUserAgent: string | undefined;
	globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
		seenUserAgent = (init?.headers as Record<string, string> | undefined)?.['User-Agent'];
		return new Response(JSON.stringify({ id: 1 }), { status: 200 });
	}) as typeof fetch;
	try {
		await fetchJobForBackfill('WolffM/x', 1, 'tok');
		assert.ok(seenUserAgent, 'a User-Agent header must be sent at all');
		assert.doesNotMatch(
			seenUserAgent!,
			/hadoku-mgmt-api/,
			'the pre-extraction literal must not survive this move'
		);
		assert.match(seenUserAgent!, /job-history-backfill/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
