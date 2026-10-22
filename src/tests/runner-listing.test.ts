import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
	ghGet,
	ghWrite,
	readRunnerListingShared,
	SHARED_LISTING_MAX_AGE_MS,
	GH_CACHE_MAX_BYTES,
	__resetRunnerHealthAlertsForTesting,
	__resetGhBlackoutForTesting,
} from '../runner-health.js';
import { __resetGhBudgetForTesting, getGhBudgetSnapshot, withGhCaller } from '../gh-budget.js';

/**
 * #118: the shared runner listing. Every successful `/actions/runners` read
 * through `ghGet` is kept, `readRunnerListingShared` answers from it while it
 * is young, and any runner write for the repo drops it.
 */
const realFetch = globalThis.fetch;
let listings = 0;
let gate: Promise<void> | null = null;

beforeEach(() => {
	__resetRunnerHealthAlertsForTesting();
	__resetGhBlackoutForTesting();
	listings = 0;
	gate = null;
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		if ((init?.method ?? 'GET') === 'GET' && url.includes('/actions/runners')) {
			listings++;
			const n = listings;
			if (gate) await gate;
			return new Response(JSON.stringify({ runners: [{ id: n, name: `r${n}` }] }), {
				status: 200,
			});
		}
		return new Response(null, { status: 204 });
	}) as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

const PATH = '/actions/runners?per_page=100';
const REPO = 'WolffM/a';

test('a listing any loop fetched answers the shared read without a call', async () => {
	await ghGet(PATH, 'tok', REPO);
	const got = await readRunnerListingShared(REPO, 'tok');
	assert.equal(listings, 1, 'no second call');
	assert.equal(got?.runners?.[0]?.name, 'r1');
});

test('the memo is per repo', async () => {
	await ghGet(PATH, 'tok', REPO);
	await readRunnerListingShared('WolffM/b', 'tok');
	assert.equal(listings, 2);
});

test('a listing past the window is read again', async () => {
	await ghGet(PATH, 'tok', REPO);
	await readRunnerListingShared(
		REPO,
		'tok',
		SHARED_LISTING_MAX_AGE_MS,
		Date.now() + SHARED_LISTING_MAX_AGE_MS
	);
	assert.equal(listings, 2);
});

test('a runner WRITE for the repo drops it — a loop never reads back its own past', async () => {
	await ghGet(PATH, 'tok', REPO);
	await ghWrite('POST', '/actions/runners/1/labels', 'tok', { labels: ['x'] }, REPO);
	const got = await readRunnerListingShared(REPO, 'tok');
	assert.equal(listings, 2, 're-read after the label write');
	assert.equal(got?.runners?.[0]?.name, 'r2');
});

test('a GET in flight across a write is not kept', async () => {
	let release: () => void = () => undefined;
	gate = new Promise((r) => (release = r));
	const inFlight = ghGet(PATH, 'tok', REPO);
	await new Promise((r) => setTimeout(r, 1));
	await ghWrite('DELETE', '/actions/runners/9', 'tok', undefined, REPO);
	release();
	await inFlight;
	gate = null;
	await readRunnerListingShared(REPO, 'tok');
	assert.equal(listings, 2, 'the pre-write body was not stored');
});

test('an unreadable listing is never stored as an empty one', async () => {
	globalThis.fetch = (async () => new Response('{}', { status: 502 })) as typeof fetch;
	assert.equal(await ghGet(PATH, 'tok', REPO), null);
	assert.equal(await readRunnerListingShared(REPO, 'tok'), null, '"could not look" stays that');
});

/**
 * Every `ghGet` is conditional (see `ghCache` in runner-health). A fake GitHub
 * that honours `If-None-Match` the way the real one does: 304 when the ETag
 * sent matches the body it would serve now, 200 with the new ETag otherwise.
 */
interface Seen {
	url: string;
	ifNoneMatch: string | null;
	auth: string | null;
	status: number;
}
let seen: Seen[] = [];
const server = new Map<string, { etag: string; body: string }>();

function serve(url: string, body: unknown): void {
	const text = JSON.stringify(body);
	server.set(url, { etag: `W/"${text.length}-${server.size}-${Math.random()}"`, body: text });
}

function installConditionalGitHub(): void {
	seen = [];
	server.clear();
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		const h = new Headers(init?.headers);
		const cur = server.get(url);
		const rate = {
			'x-ratelimit-limit': '5000',
			'x-ratelimit-remaining': '4000',
			'x-ratelimit-used': '1000',
			'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1800),
			'x-ratelimit-resource': 'core',
		};
		if ((init?.method ?? 'GET') !== 'GET' || !cur) {
			seen.push({
				url,
				ifNoneMatch: h.get('if-none-match'),
				auth: h.get('authorization'),
				status: 204,
			});
			return new Response(null, { status: 204, headers: rate });
		}
		if (h.get('if-none-match') === cur.etag) {
			seen.push({ url, ifNoneMatch: cur.etag, auth: h.get('authorization'), status: 304 });
			return new Response(null, { status: 304, headers: { ...rate, etag: cur.etag } });
		}
		seen.push({
			url,
			ifNoneMatch: h.get('if-none-match'),
			auth: h.get('authorization'),
			status: 200,
		});
		return new Response(cur.body, { status: 200, headers: { ...rate, etag: cur.etag } });
	}) as typeof fetch;
}

const LISTING_URL = `https://api.github.com/repos/${REPO}${PATH}`;
const RUNS_PATH = '/actions/workflows/test.yml/runs?per_page=10&status=completed';
const RUNS_URL = `https://api.github.com/repos/${REPO}${RUNS_PATH}`;

test('an unchanged listing is revalidated, not re-bought: the ETag goes out and a 304 serves the body', async () => {
	installConditionalGitHub();
	serve(LISTING_URL, { runners: [{ id: 1, name: 'jit-a', busy: false }] });
	const first = await ghGet<{ runners: { name: string }[] }>(PATH, 'tok', REPO);
	const second = await ghGet<{ runners: { name: string }[] }>(PATH, 'tok', REPO);
	assert.deepEqual(
		seen.map((s) => s.status),
		[200, 304]
	);
	assert.equal(seen[0].ifNoneMatch, null, 'nothing to send the first time');
	assert.equal(seen[1].ifNoneMatch, server.get(LISTING_URL)?.etag, 'the ETag GitHub gave us');
	assert.deepEqual(second, first);
});

test('a CHANGED listing is served as changed — a 304 is never assumed', async () => {
	installConditionalGitHub();
	serve(LISTING_URL, { runners: [{ id: 1, name: 'jit-a', busy: false }] });
	await ghGet(PATH, 'tok', REPO);
	serve(LISTING_URL, { runners: [{ id: 1, name: 'jit-a', busy: true }] });
	const got = await ghGet<{ runners: { busy: boolean }[] }>(PATH, 'tok', REPO);
	assert.equal(got?.runners[0].busy, true, 'the reap must see busy=true to keep the runner');
	assert.equal(seen[1].status, 200);
	// And the NEW ETag is the one sent after that.
	await ghGet(PATH, 'tok', REPO);
	assert.equal(seen[2].status, 304);
	assert.equal(seen[2].ifNoneMatch, server.get(LISTING_URL)?.etag);
});

test('every read is a fresh object — a caller editing its copy cannot change what the next is served', async () => {
	installConditionalGitHub();
	serve(LISTING_URL, { runners: [{ id: 1, name: 'r', labels: [{ name: 'hadoku-builder' }] }] });
	const a = await ghGet<{ runners: { labels: { name: string }[] }[] }>(PATH, 'tok', REPO);
	a!.runners[0].labels = [];
	const b = await ghGet<{ runners: { labels: { name: string }[] }[] }>(PATH, 'tok', REPO);
	assert.equal(seen[1].status, 304);
	assert.deepEqual(b?.runners[0].labels, [{ name: 'hadoku-builder' }]);
	const c = await readRunnerListingShared(REPO, 'tok');
	assert.deepEqual(c?.runners?.[0]?.labels, [{ name: 'hadoku-builder' }]);
});

test('a 304 renews the shared listing: GitHub vouched for it just now', async () => {
	installConditionalGitHub();
	serve(LISTING_URL, { runners: [{ id: 1, name: 'r' }] });
	const realNow = Date.now;
	const t0 = realNow();
	try {
		Date.now = () => t0;
		await ghGet(PATH, 'tok', REPO);
		// Four minutes on, the reap revalidates and GitHub answers 304.
		Date.now = () => t0 + 4 * 60_000;
		await ghGet(PATH, 'tok', REPO);
	} finally {
		Date.now = realNow;
	}
	assert.equal(seen[1].status, 304);
	const calls = seen.length;
	// Six minutes after the 200, two after the 304: inside the window only
	// because the 304 counted.
	await readRunnerListingShared(REPO, 'tok', SHARED_LISTING_MAX_AGE_MS, t0 + 6 * 60_000);
	assert.equal(seen.length, calls, 'served from the revalidated entry');
});

test('the ETag is per TOKEN — another credential sends none, since GitHub varies on Authorization', async () => {
	installConditionalGitHub();
	serve(LISTING_URL, { runners: [] });
	await ghGet(PATH, 'tok-a', REPO);
	await ghGet(PATH, 'tok-b', REPO);
	assert.equal(seen[1].ifNoneMatch, null);
	assert.equal(seen[1].auth, 'Bearer tok-b');
});

test('a runner write makes the shared listing stale but keeps its ETag — GitHub decides', async () => {
	installConditionalGitHub();
	serve(LISTING_URL, { runners: [{ id: 1, name: 'r' }] });
	await ghGet(PATH, 'tok', REPO);
	await ghWrite('DELETE', '/actions/runners/1', 'tok', undefined, REPO);
	serve(LISTING_URL, { runners: [] });
	const got = await readRunnerListingShared(REPO, 'tok');
	const last = seen[seen.length - 1];
	assert.equal(last.url, LISTING_URL, 'not answered from the pre-write listing');
	assert.notEqual(last.ifNoneMatch, null, 'the old ETag still went out');
	assert.equal(last.status, 200);
	assert.deepEqual(got?.runners, []);
});

test('any GET path is conditional, not just the runner listing (ci-alerts, the runs sweep, the queue probe)', async () => {
	installConditionalGitHub();
	serve(RUNS_URL, { workflow_runs: [{ id: 7, conclusion: 'success' }] });
	await ghGet(RUNS_PATH, 'tok', REPO);
	const again = await ghGet<{ workflow_runs: { id: number }[] }>(RUNS_PATH, 'tok', REPO);
	assert.equal(seen[1].status, 304);
	assert.equal(again?.workflow_runs[0].id, 7);
});

test('a 304 is not a charge: N unchanged reads cost ONE call against the budget', async () => {
	__resetGhBudgetForTesting();
	installConditionalGitHub();
	serve(LISTING_URL, { runners: [{ id: 1, name: 'r' }] });
	for (let i = 0; i < 10; i++) await withGhCaller('reap', () => ghGet(PATH, 'tok', REPO));
	const row = getGhBudgetSnapshot()[0].byCaller.find((c) => c.caller === 'reap');
	assert.deepEqual(row, { caller: 'reap', charged: 1, notModified: 9 });
});

test('a failed revalidation is "could not look", never the cached body', async () => {
	installConditionalGitHub();
	serve(LISTING_URL, { runners: [{ id: 1, name: 'r' }] });
	await ghGet(PATH, 'tok', REPO);
	globalThis.fetch = (async () => new Response('{}', { status: 502 })) as typeof fetch;
	assert.equal(await ghGet(PATH, 'tok', REPO), null);
});

test('the cache is bounded by bytes, oldest-touched first', async () => {
	installConditionalGitHub();
	const big = 'x'.repeat(Math.ceil(GH_CACHE_MAX_BYTES / 4));
	const paths = [0, 1, 2, 3, 4].map((i) => `/actions/runs/${i}/jobs`);
	for (const p of paths) serve(`https://api.github.com/repos/${REPO}${p}`, { jobs: [], pad: big });
	for (const p of paths) await ghGet(p, 'tok', REPO);
	seen = [];
	await ghGet(paths[0], 'tok', REPO);
	await ghGet(paths[4], 'tok', REPO);
	assert.equal(seen[0].ifNoneMatch, null, 'the oldest was evicted to stay under the bound');
	assert.equal(seen[1].status, 304, 'the newest is still held');
});
