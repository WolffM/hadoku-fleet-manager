/**
 * Tests for the hosted-runner fallback's convergence, against a stubbed fetch.
 *
 * The case that matters most here is a RESTART. `alreadyHosted` is process-local
 * and empty after one, and the skip used to read that empty set as "nothing is
 * hosted, nothing to clear" — so a restart during a hosted window left all 20
 * repos pinned to billed runners permanently. That happened on 2026-08-17.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { __setHostForTesting } from '../host.js';
import { testHost } from './install-test-host.js';

import {
	coveredRepos,
	syncHostedFallback,
	__resetFallbackConvergenceForTesting,
	HOSTED_VALUE,
	FLEET_VALUE,
	VAR_SYNC_CONCURRENCY,
} from '../ci-runner-fallback.js';

let originalFetch: typeof globalThis.fetch;
let deletes: string[];
let patches: string[];
let posts: string[];
/** Variable READS. What the cache skip actually saves — a converged repo is not even looked up. */
let gets: string[];
/** Repos that currently HAVE CI_RUNNER set, mutated as the code writes. */
let pinned: Set<string>;
let fleetSet: Set<string>;

/**
 * The variables API with its REAL status codes, not a blanket 200.
 *
 * `setVar` PATCHes first and POSTs only on 404, because the variable usually
 * already exists after the first outage. A stub that answers every PATCH with
 * 200 therefore never reaches the POST — so the create path, which is what runs
 * on a repo's FIRST outage, had no coverage in any test while looking covered.
 * That is the branch that decides whether a repo can move to hosted runners at
 * all.
 *
 * `pinned` is mutated by the handler rather than read as a fixed set, so a
 * sequence of calls sees the state its predecessors left behind — the same
 * reason production PATCHes succeed on the second outage.
 */
function installFetch(existing: Set<string>) {
	pinned = new Set(existing);
	fleetSet = new Set();
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		const method = (init?.method ?? 'GET').toUpperCase();
		const ok = (status: number, body: unknown = {}) =>
			({
				ok: status < 400,
				status,
				json: () => Promise.resolve(body),
				text: async () => '',
			}) as Response;
		const repo = /repos\/([^/]+\/[^/]+)/.exec(url)?.[1] ?? '';

		// The variable is READ before every write now, so the stub has to model
		// its VALUE and not just its presence. `pinned` means "holds the hosted
		// value"; anything else is either absent or already on the fleet.
		if (method === 'GET') {
			gets.push(url);
			if (pinned.has(repo)) return ok(200, { name: 'CI_RUNNER', value: HOSTED_VALUE });
			if (fleetSet.has(repo)) return ok(200, { name: 'CI_RUNNER', value: FLEET_VALUE });
			return ok(404);
		}

		if (method === 'DELETE') {
			deletes.push(url);
			// 204 when it was set, 404 when it was not — the distinction `changed`
			// is derived from.
			if (!pinned.has(repo)) return ok(404);
			pinned.delete(repo);
			return ok(204);
		}
		if (method === 'PATCH') {
			patches.push(url);
			const wrote = String((init?.body as string) ?? '');
			// 404 drives the POST-create fallback — only when nothing is set.
			if (!pinned.has(repo) && !fleetSet.has(repo)) return ok(404);
			if (wrote.includes('ubuntu-latest')) {
				pinned.add(repo);
				fleetSet.delete(repo);
			} else {
				fleetSet.add(repo);
				pinned.delete(repo);
			}
			return ok(200);
		}
		if (method === 'POST') {
			posts.push(url);
			// The real API 409s on creating one that exists. setVar only reaches
			// POST after a 404, so a 409 here means the flow is wrong.
			if (pinned.has(repo) || fleetSet.has(repo)) return ok(409);
			const wrote = String((init?.body as string) ?? '');
			if (wrote.includes('ubuntu-latest')) pinned.add(repo);
			else fleetSet.add(repo);
			return ok(201);
		}
		return ok(200);
	}) as typeof globalThis.fetch;
}

beforeEach(() => {
	originalFetch = globalThis.fetch;
	deletes = [];
	patches = [];
	posts = [];
	gets = [];
	__resetFallbackConvergenceForTesting();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

test('restart + everything pinned: the first fleet pass rewrites every repo', async () => {
	const repos = coveredRepos();
	installFetch(new Set(repos));
	// A fresh process: the cache is empty, which means UNKNOWN, not "none hosted".
	const res = await syncHostedFallback(2, 'tok', { alreadyHosted: new Set() });

	assert.equal(res.desired, 'fleet');
	// WRITES, not DELETEs. "The fleet" used to mean the variable ABSENT, which
	// forced all 107 workflows to carry their own `|| '[...]'` fallback. It is
	// now an explicit value, so a workflow can say `fromJSON(vars.CI_RUNNER)`
	// and carry no fleet knowledge at all.
	assert.equal(patches.length, repos.length, 'every covered repo must be written through');
	assert.equal(deletes.length, 0, 'the fleet branch must never delete the variable');
	assert.equal(
		res.changed.length,
		repos.length,
		'each repo really was pinned, so each is a reported change'
	);
});

test('restart + nothing pinned: still writes through, but reports no changes', async () => {
	const repos = coveredRepos();
	installFetch(new Set());
	const res = await syncHostedFallback(2, 'tok', { alreadyHosted: new Set() });

	assert.equal(patches.length, repos.length, 'the first pass cannot trust the cache');
	assert.equal(res.changed.length, 0, 'it was already on the fleet — not a change');
	// A repo with no variable at all is the case the seeding must cover: PATCH
	// 404s and setVar falls through to POST, so it ends up SET either way.
	assert.equal(posts.length, repos.length, 'an absent variable must be created, not skipped');
});

test('steady state: a later fleet tick with a clean cache does not re-write', async () => {
	installFetch(new Set());
	const cache = new Set<string>();
	await syncHostedFallback(2, 'tok', { alreadyHosted: cache }); // first pass
	patches = [];
	posts = [];
	await syncHostedFallback(2, 'tok', { alreadyHosted: cache }); // second tick

	assert.equal(patches.length + posts.length, 0, 'once converged, a no-op tick must cost nothing');
});

test('all claws down: flips to hosted, and the cache suppresses the repeat', async () => {
	const repos = coveredRepos();
	installFetch(new Set());
	const cache = new Set<string>();

	const first = await syncHostedFallback(0, 'tok', { alreadyHosted: cache });
	assert.equal(first.desired, 'hosted');
	assert.equal(patches.length, repos.length);
	assert.equal(first.changed.length, repos.length);

	patches = [];
	const second = await syncHostedFallback(0, 'tok', { alreadyHosted: cache });
	assert.equal(patches.length, 0, 'already hosted — no repeat writes');
	assert.equal(second.changed.length, 0);
});

/**
 * The FIRST outage a repo ever sees: it has no CI_RUNNER variable at all, so
 * the PATCH 404s and the flip depends entirely on the POST-create fallback.
 *
 * This branch had no coverage in any test until 2026-08-29 — both harnesses
 * answered every PATCH with 200, so `setVar` returned true without ever
 * reaching the POST. A wrong create path or body would have failed silently on
 * exactly the repos that had never been pinned, and the fleet would have sat
 * self-hosted-with-no-runners through the outage it was supposed to escape.
 */
test('first outage on a never-pinned repo: PATCH 404s, POST creates the pin', async () => {
	const repos = coveredRepos();
	installFetch(new Set()); // nothing pinned anywhere

	const res = await syncHostedFallback(0, 'tok', { alreadyHosted: new Set<string>() });

	assert.equal(res.desired, 'hosted');
	assert.equal(patches.length, repos.length, 'every repo is PATCHed first');
	assert.equal(posts.length, repos.length, 'and every PATCH 404 falls through to a POST');
	assert.equal(res.failed.length, 0, 'a 404 on PATCH is not a failure — it is the create path');
	assert.equal(res.changed.length, repos.length);
	// The POST must target the collection, not the item: POST to
	// /actions/variables/CI_RUNNER is a 404 against the real API.
	for (const url of posts) assert.match(url, /\/actions\/variables$/);
});

/**
 * The mirror: recovery when nothing was ever pinned. Every PATCH 404s, so
 * `setVar` falls through to POST and the variable ends up SET regardless —
 * which is the property the workflows now depend on. Nothing CHANGED, because
 * the repos were already on the fleet.
 */
test('recovery with nothing pinned: creates the variable, reports no change', async () => {
	const repos = coveredRepos();
	installFetch(new Set());

	const res = await syncHostedFallback(3, 'tok');

	assert.equal(res.desired, 'fleet');
	assert.equal(patches.length, repos.length, 'the first pass writes through regardless');
	assert.equal(posts.length, repos.length, 'a 404 must become a CREATE, never a skip');
	assert.deepEqual(res.changed, [], 'nothing was pinned, so nothing CHANGED');
	assert.deepEqual(res.failed, [], 'creating a missing variable is not a failure');
});

test('recovery: hosted → fleet rewrites exactly what was pinned', async () => {
	const repos = coveredRepos();
	installFetch(new Set(repos));
	const cache = new Set<string>();

	await syncHostedFallback(0, 'tok', { alreadyHosted: cache }); // go hosted
	patches = [];
	const back = await syncHostedFallback(3, 'tok', { alreadyHosted: cache }); // a claw returns

	assert.equal(back.desired, 'fleet');
	assert.equal(patches.length, repos.length, 'every pinned repo is rewritten to the fleet value');
	assert.equal(deletes.length, 0, 'recovery never deletes — the variable is the contract now');
	assert.equal(back.changed.length, repos.length, 'each really came off hosted');
	assert.equal(cache.size, 0, 'the cache must no longer consider any repo hosted');
});

// ── a FAILED write must be retried, not cached as done ──────────────────────

/** Every write fails; the variable is never set. Counts attempts per repo. */
function installFailingFetch() {
	const attempts: string[] = [];
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		const method = (init?.method ?? 'GET').toUpperCase();
		const ok = (status: number, body: unknown = {}) =>
			({
				ok: status < 400,
				status,
				json: () => Promise.resolve(body),
				text: async () => '',
			}) as Response;
		if (method === 'GET') return ok(404); // nothing set — this is the "never written" repo
		attempts.push(`${method} ${url}`);
		return ok(500); // not 404, so setVar does not fall through to POST-create
	}) as typeof globalThis.fetch;
	return attempts;
}

test('a write that FAILED is attempted again on the next tick, not skipped by the cache', async () => {
	// THE BUG. The skip reads `alreadyHosted` as the whole truth — "not in the
	// hosted set" means "already on fleet" — but a repo whose write FAILED is in
	// NEITHER state. It was pushed to `failed` and `continue`d without touching
	// the set, so the next tick saw "not hosted", concluded there was nothing to
	// do, and skipped it. Forever, for the life of the process.
	//
	// The hosted direction never had it (a failed repo is never added, so
	// `wasHosted` stays false and it retries), which is exactly why it went
	// unnoticed: the broken direction is the STEADY STATE, and the one exercised
	// during an outage is the one that works.
	const attempts = installFailingFetch();
	const hosted = new Set<string>();

	const first = await syncHostedFallback(2, 'tok', { alreadyHosted: hosted });
	assert.ok(first.failed.length > 0, 'the first pass must record the failure');
	const afterFirst = attempts.length;
	assert.ok(afterFirst > 0, 'the first pass must actually attempt a write');

	// Second tick, same process: the cache is now trusted.
	const second = await syncHostedFallback(2, 'tok', { alreadyHosted: hosted });
	assert.ok(
		attempts.length > afterFirst,
		'a repo whose write failed must be RE-ATTEMPTED, not skipped as already-converged'
	);
	assert.deepEqual(
		second.failed,
		first.failed,
		'and it must still be reported as failing while it still fails'
	);
});

test('a repo that succeeded IS still skipped by the cache — the retry is not a write-through', async () => {
	// The fix must not defeat the cache for everyone. Only the failed repo is
	// exempt; the skip that keeps a steady-state tick cheap has to survive.
	const repos = coveredRepos();
	installFetch(new Set());
	const hosted = new Set<string>();
	await syncHostedFallback(2, 'tok', { alreadyHosted: hosted }); // first pass writes through
	const afterFirst = patches.length + posts.length;
	assert.ok(afterFirst >= repos.length, 'the first pass writes every repo');
	const readsAfterFirst = gets.length;
	await syncHostedFallback(2, 'tok', { alreadyHosted: hosted });
	assert.equal(
		patches.length + posts.length,
		afterFirst,
		'a converged repo must not be re-written on the next tick'
	);
	// Counting WRITES alone cannot see this: a bypassed cache still finds
	// `had === want` and skips setVar, so writes stay flat while every repo is
	// re-READ. The read is what the skip exists to avoid, so the read is what
	// has to be asserted — verified by mutation (forcing the bypass on leaves
	// the write count unchanged and moves this one).
	assert.equal(
		gets.length,
		readsAfterFirst,
		'a converged repo must not even be looked up again — the cache skip is the point'
	);
});

test('the per-repo reads go out concurrently, bounded by VAR_SYNC_CONCURRENCY', async () => {
	// One read per covered repo per tick, one after another, was ~10s of every
	// runner-health tick. The reads are independent, so they overlap — but only
	// up to the cap, because the token behind them serves the fast loop too.
	const repos = coveredRepos();
	assert.ok(repos.length > VAR_SYNC_CONCURRENCY, 'the roster must be wider than the cap');
	installFetch(new Set());
	const inner = globalThis.fetch;
	let inFlight = 0;
	let peak = 0;
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		if ((init?.method ?? 'GET').toUpperCase() !== 'GET') return inner(input, init);
		inFlight++;
		peak = Math.max(peak, inFlight);
		await new Promise((r) => setTimeout(r, 5));
		inFlight--;
		return inner(input, init);
	}) as typeof globalThis.fetch;

	const res = await syncHostedFallback(3, 'tok');
	assert.equal(peak, VAR_SYNC_CONCURRENCY, 'reads in flight at the peak');
	assert.equal(gets.length, repos.length, 'and every repo was still read');
	assert.deepEqual(res.failed, []);
});

/**
 * THE UNMEASURED TICK.
 *
 * Under all-JIT every claw's capacity comes from the fast loop's probe, and that
 * snapshot is null until its first pass ~60s after boot. So runner-health's
 * first tick after a restart reads zero claws on a fleet that is entirely
 * healthy — observed 2026-09-07 across three consecutive deploys, reading 1,
 * then 10, then 0, then 3, against a steady 6 between restarts.
 *
 * `desired` has no debounce, so one such tick would pin every covered repo to
 * billed minutes. `census` already draws the line as `ephemeralUnknown`; these
 * pin the writer refusing to act on the zero it cannot vouch for.
 */

test('unmeasured capacity writes NOTHING — a null is not a zero', async () => {
	installFetch(new Set());
	const res = await syncHostedFallback(null, 'tok', { alreadyHosted: new Set<string>() });
	assert.equal(res.desired, 'unmeasured');
	assert.equal(patches.length + posts.length + deletes.length, 0, 'a held tick must not write');
	assert.equal(res.changed.length, 0);
	assert.equal(res.failed.length, 0);
	assert.equal(gets.length, 0, 'and must not even look — there is nothing to decide');
});

test('a real all-claws-down zero still flips to hosted', async () => {
	// The negative. Holding on `null` must not become holding on an outage, or
	// this fix trades a spurious flip for a fleet that can never escape one.
	installFetch(new Set());
	const res = await syncHostedFallback(0, 'tok', { alreadyHosted: new Set<string>() });
	assert.equal(res.desired, 'hosted');
	assert.equal(res.changed.length, coveredRepos().length);
});

test('a held tick does not count as this process having converged', async () => {
	// THE SUBTLE HALF. `converged` gates whether the NEXT tick trusts
	// `alreadyHosted`, and an empty cache means "I have no idea", not "nothing is
	// hosted". If a held tick marked the process converged, the next one would
	// trust that empty set and skip the repos it needed to clear — which is the
	// 2026-08-17 outage that stranded all 20 repos on billed runners, reached by
	// a new road.
	const repos = coveredRepos();
	installFetch(new Set(repos)); // everything currently pinned to hosted

	await syncHostedFallback(null, 'tok', { alreadyHosted: new Set<string>() });

	// Claws are back. An empty cache plus a converged flag would skip every repo.
	patches = [];
	const back = await syncHostedFallback(4, 'tok', { alreadyHosted: new Set<string>() });
	assert.equal(back.desired, 'fleet');
	assert.equal(
		back.changed.length,
		repos.length,
		'every repo must be written back to the fleet, not skipped on a cache the held tick never filled'
	);
});

test('a repo added to the roster after the first pass is seeded on the next tick (#107)', async () => {
	// coveredRepos() is read fresh every tick, so the roster grows under a running
	// process. hadoku-bomberman joined at 14:07 UTC on 2026-10-10, two hours after
	// a restart, and was skipped on every tick: the process-wide "converged" flag
	// told the fleet-direction skip to trust a cache that had never seen it.
	const dir = mkdtempSync(join(tmpdir(), 'fallback-roster-'));
	const coverage = join(dir, 'fleet-runner-coverage.json');
	const writeRoster = (repos: string[]) => writeFileSync(coverage, JSON.stringify({ repos }));
	__setHostForTesting({ ...testHost, manifestDir: dir });
	try {
		writeRoster(['WolffM/old-a', 'WolffM/old-b']);
		installFetch(new Set());
		const cache = new Set<string>();
		await syncHostedFallback(3, 'tok', { alreadyHosted: cache });
		assert.deepEqual([...fleetSet].sort(), ['WolffM/old-a', 'WolffM/old-b']);

		writeRoster(['WolffM/old-a', 'WolffM/old-b', 'WolffM/new-c']);
		gets = [];
		const res = await syncHostedFallback(3, 'tok', { alreadyHosted: cache });

		assert.ok(fleetSet.has('WolffM/new-c'), 'the new repo must get CI_RUNNER without a restart');
		// The cache still earns its keep for the repos it HAS converged.
		assert.deepEqual(
			gets.map((u) => /repos\/([^/]+\/[^/]+)/.exec(u)?.[1]),
			['WolffM/new-c'],
			'only the unconverged repo is read; converged ones stay skipped'
		);
		// Seeding an absent variable is not a hosted/fleet transition.
		assert.deepEqual(res.changed, []);
	} finally {
		__setHostForTesting(testHost);
		rmSync(dir, { recursive: true, force: true });
	}
});
