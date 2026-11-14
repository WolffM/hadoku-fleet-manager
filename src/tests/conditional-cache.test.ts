/**
 * Conditional-request caches that outlive the process (2026-10-25).
 *
 * mgmt-api restarted 12 times between 04:46 and 06:39Z that morning, and every
 * restart began with no ETags: each first read of each listing was charged,
 * ~400 calls in the first four minutes of one process, and the general budget
 * was spent at 05:30:36. These pin the three things that make a restart cheap
 * without making it wrong: the ETag survives, a restored body is only served on
 * a 304, and the disk is bounded.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { stateDir } from '../host.js';
import { CONDITIONAL_CACHE_DIR, conditionalCacheStore } from '../conditional-cache-store.js';
import { __resetRunnerHealthAlertsForTesting } from '../runner-health.js';
import {
	ghGet,
	readRunnerListingShared,
	__restartGhCacheForTesting,
} from '../lib/github-client.js';
import { __resetGhBlackoutForTesting } from '../lib/github-client-blackout.js';
import {
	GH_CACHE_SPILL_CHARS,
	ghCache,
	ghCacheKey as ghCacheKeyFor,
} from '../lib/github-client-cache.js';
import {
	syncHostedFallback,
	__resetFallbackConvergenceForTesting,
	__restartFallbackForTesting,
} from '../ci-runner-fallback.js';
import { FLEET_VALUE } from '../lib/ci-runner-values.js';

const realFetch = globalThis.fetch;
/** Every request's If-None-Match, in order; null when none was sent. */
let sent: (string | null)[] = [];

/** A GitHub that answers 304 when the ETag sent is the CURRENT body's, and 200 otherwise. */
function installGithub(bodyFor: (url: string) => unknown) {
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		const inm = (init?.headers as Record<string, string> | undefined)?.['If-None-Match'] ?? null;
		sent.push(inm);
		const body = JSON.stringify(bodyFor(url));
		const etag = `W/"${createHash('sha1').update(body).digest('hex')}"`;
		if (inm === etag) return new Response(null, { status: 304 });
		return new Response(body, { status: 200, headers: { etag } });
	}) as typeof fetch;
}

beforeEach(() => {
	sent = [];
	__resetGhBlackoutForTesting();
	__resetRunnerHealthAlertsForTesting();
	__resetFallbackConvergenceForTesting();
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

test('the ETag outlives the process, and the restored body is served on the 304', async () => {
	installGithub(() => ({ workflow_runs: [{ id: 7 }] }));
	const path = '/actions/workflows/ci.yml/runs?per_page=10&status=completed';
	assert.deepEqual(await ghGet(path, 'tok', 'WolffM/a'), { workflow_runs: [{ id: 7 }] });
	__restartGhCacheForTesting();
	assert.deepEqual(await ghGet(path, 'tok', 'WolffM/a'), { workflow_runs: [{ id: 7 }] });
	assert.equal(sent.length, 2);
	assert.equal(sent[0], null, 'the very first read has nothing to send');
	assert.ok(sent[1], 'the restarted process sent the ETag its predecessor was given');
});

test('a body that CHANGED across the restart is read fresh, never the restored one', async () => {
	let id = 1;
	installGithub(() => ({ workflow_runs: [{ id }] }));
	await ghGet('/actions/runs', 'tok', 'WolffM/a');
	__restartGhCacheForTesting();
	id = 22; // GitHub's representation moved on while no process was running
	assert.deepEqual(await ghGet('/actions/runs', 'tok', 'WolffM/a'), {
		workflow_runs: [{ id: 22 }],
	});
});

test('the shared runner listing never answers from a restored entry without asking', async () => {
	installGithub(() => ({ total_count: 1, runners: [{ id: 1, name: 'r', busy: false }] }));
	await readRunnerListingShared('WolffM/a', 'tok');
	assert.equal(sent.length, 1);
	await readRunnerListingShared('WolffM/a', 'tok');
	assert.equal(sent.length, 1, 'in-process, a listing GitHub just vouched for is shared');
	__restartGhCacheForTesting();
	await readRunnerListingShared('WolffM/a', 'tok');
	assert.equal(sent.length, 2, 'restored: GitHub has not vouched for it in THIS process');
	assert.ok(sent[1], '…but the ask is conditional, and free when unchanged');
});

test('the store drops what is too old, too big, or unreadable, keeping the newest', () => {
	const store = conditionalCacheStore('bounds-test', { maxBytes: 10, maxAgeMs: 60_000 });
	const now = 1_800_000_000_000;
	store.save('old', 'W/"o"', 'x', now - 120_000);
	store.save('a', 'W/"a"', '123456', now - 2000);
	store.save('b', 'W/"b"', '123456', now - 1000); // a + b = 12 bytes > 10
	const dir = join(stateDir(), CONDITIONAL_CACHE_DIR, 'bounds-test');
	writeFileSync(join(dir, 'torn.json'), '{"key":');
	writeFileSync(join(dir, 'x.json.tmp'), 'half');
	const kept = store.load(now);
	assert.deepEqual(
		kept.map((e) => e.key),
		['b'],
		'newest under the byte bound; the aged and the overflow are gone'
	);
	assert.equal(readdirSync(dir).length, 1, 'and their files with them');
	store.clear();
});

test('an empty or missing store is a cold start, not an error', () => {
	const store = conditionalCacheStore('never-written', { maxBytes: 1024 });
	assert.deepEqual(store.load(), []);
	mkdirSync(join(stateDir(), CONDITIONAL_CACHE_DIR, 'never-written'), { recursive: true });
	assert.deepEqual(store.load(), []);
	store.clear();
});

test('CI_RUNNER reads are conditional across a restart — a 304 is still an observation', async () => {
	installGithub((url) =>
		url.includes('/actions/variables/') ? { name: 'CI_RUNNER', value: FLEET_VALUE } : {}
	);
	const first = await syncHostedFallback(3, 'tok');
	assert.deepEqual(first.failed, []);
	const reads = sent.length;
	assert.ok(reads > 0);
	assert.ok(
		sent.every((e) => e === null),
		'a cold first pass has no ETags'
	);
	__restartFallbackForTesting();
	sent = [];
	const again = await syncHostedFallback(3, 'tok');
	assert.deepEqual(again.changed, [], 'the 304 read the value as it is, so nothing changed');
	assert.equal(sent.length, reads, 'one read per repo again — and no write');
	assert.ok(
		sent.every((e) => e !== null),
		'every read after the restart was conditional'
	);
});

// ── fleet-manager#86: large bodies live on disk only ─────────────────────────

/** A runs listing past GH_CACHE_SPILL_CHARS, with a two-byte character in it. */
const bigRuns = (id: number) => ({
	workflow_runs: Array.from({ length: 300 }, (_, i) => ({
		id: id * 1000 + i,
		head_commit: { message: `fix ✨ the thing ${'x'.repeat(200)}` },
	})),
});

test('a large body leaves memory once on disk, and a 304 serves it from there', async () => {
	installGithub(() => bigRuns(1));
	const path = '/actions/runs?per_page=100&page=1&exclude_pull_requests=true';
	const first = await ghGet(path, 'tok', 'WolffM/big');
	assert.ok(JSON.stringify(first).length >= GH_CACHE_SPILL_CHARS, 'the fixture is big enough');
	const entry = [...ghCache.values()].find((e) => e.repo === 'WolffM/big');
	assert.equal(entry?.text, null, 'the body is not held in memory');
	assert.ok((entry?.size ?? 0) >= GH_CACHE_SPILL_CHARS, 'but still counts toward the bound');
	assert.deepEqual(await ghGet(path, 'tok', 'WolffM/big'), first, 'the 304 answers with it');
	assert.ok(sent[1], 'and that read was conditional, so free');
});

test('a 304 for a body whose disk copy is gone refetches without the ETag', async () => {
	installGithub(() => bigRuns(2));
	const path = '/actions/runs';
	const first = await ghGet(path, 'tok', 'WolffM/gone');
	rmSync(join(stateDir(), CONDITIONAL_CACHE_DIR, 'runner-health'), { recursive: true });
	assert.deepEqual(await ghGet(path, 'tok', 'WolffM/gone'), first);
	assert.equal(sent.length, 3, 'the 304, then one unconditional read');
	assert.ok(sent[1], 'it asked with the ETag');
	assert.equal(
		sent[2],
		null,
		'a 304 it could not answer from is never served: the retry has no ETag'
	);
});

test('a legacy all-JSON file is still restored, and served on its 304', async () => {
	const body = JSON.stringify(bigRuns(3));
	const etag = `W/"${createHash('sha1').update(body).digest('hex')}"`;
	const key = ghCacheKeyFor('tok', 'WolffM/legacy', '/actions/runs');
	const dir = join(stateDir(), CONDITIONAL_CACHE_DIR, 'runner-health');
	mkdirSync(dir, { recursive: true });
	const stem = createHash('sha256').update(key).digest('hex').slice(0, 32);
	writeFileSync(
		join(dir, `${stem}.json`),
		JSON.stringify({ key, etag, text: body, savedAtMs: Date.now() })
	);
	__restartGhCacheForTesting();
	installGithub(() => bigRuns(3));
	assert.deepEqual(await ghGet('/actions/runs', 'tok', 'WolffM/legacy'), bigRuns(3));
	assert.deepEqual(sent, [etag], 'one conditional read, answered 304 from the legacy file');
});

test('the store reads a body back only under the ETag it was saved with', async () => {
	const store = conditionalCacheStore('read-test', { maxBytes: 1024 });
	assert.equal(store.save('k', 'W/"1"', 'line one\nline two'), true);
	assert.equal(
		await store.read('k', 'W/"1"'),
		'line one\nline two',
		'newlines in the body survive'
	);
	assert.equal(await store.read('k', 'W/"2"'), null, 'another ETag is not this body');
	assert.equal(await store.read('missing', 'W/"1"'), null);
	assert.deepEqual(
		store.load().map((e) => e.text),
		['line one\nline two']
	);
	store.clear();
});
