import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { __setHostForTesting } from '../host.js';
import { testHost } from './install-test-host.js';
import {
	recordGhResponse,
	withGhCaller,
	getGhBudgetSnapshot,
	labelGhToken,
	__resetGhBudgetForTesting,
	__restartGhBudgetForTesting,
	BUDGET_ALERT_MIN_LEFT_MS,
	GH_BUDGET_SAVE_MS,
	meterGhPool,
} from '../gh-budget.js';
import { ghGet, ghGetConditional, __resetGhBlackoutForTesting } from '../runner-health.js';

/**
 * #119: the budget was invisible until the 403. On 2026-10-16 the first signal
 * of the 19:15:42Z blackout was the refusal itself, and who spent the budget was
 * reconstructed afterwards from code cadences. These pin the reading, the split
 * by caller, and the page that has to arrive BEFORE any call is refused.
 */
const realFetch = globalThis.fetch;
let posts: string[] = [];
let infos: string[] = [];

beforeEach(() => {
	__resetGhBudgetForTesting();
	__resetGhBlackoutForTesting();
	posts = [];
	infos = [];
	__setHostForTesting({
		...testHost,
		logger: { info: (m: string) => infos.push(m), warn() {}, error() {} },
		alerts: {
			post: async (content: string) => {
				posts.push(content);
				return { posted: true, sinkRecorded: true };
			},
			recordQuietly() {},
		},
	});
});
afterEach(() => {
	globalThis.fetch = realFetch;
	__setHostForTesting(testHost);
});

const T0 = 1_792_180_000_000;
const RESET_S = T0 / 1000 + 45 * 60; // 45 minutes of window left at T0

function headers(remaining: number, resetS = RESET_S, limit = 5000) {
	const h = new Headers({
		'x-ratelimit-limit': String(limit),
		'x-ratelimit-remaining': String(remaining),
		'x-ratelimit-used': String(limit - remaining),
		'x-ratelimit-reset': String(resetS),
		'x-ratelimit-resource': 'core',
	});
	return h;
}

test('every response is a reading, and 304s are counted as free', async () => {
	await withGhCaller('reap', async () => {
		recordGhResponse('tok', 200, headers(4000), T0);
		recordGhResponse('tok', 200, headers(3999), T0);
	});
	await withGhCaller('dispatch-poll', async () => {
		recordGhResponse('tok', 304, headers(3999), T0);
	});
	const [w] = getGhBudgetSnapshot(T0);
	assert.equal(w.remaining, 3999);
	assert.equal(w.used, 1001);
	assert.deepEqual(
		w.byCaller.map((c) => [c.caller, c.charged, c.notModified]),
		[
			['reap', 2, 0],
			['dispatch-poll', 0, 1],
		]
	);
	assert.equal(w.expired, false);
});

test('a call outside every scope is unattributed, not folded into a loop', () => {
	recordGhResponse('tok', 200, headers(4000), T0);
	assert.equal(getGhBudgetSnapshot(T0)[0].byCaller[0].caller, 'unattributed');
});

test('the caller survives awaits, and an inner scope wins', async () => {
	await withGhCaller('dispatch-poll', async () => {
		await new Promise((r) => setTimeout(r, 1));
		recordGhResponse('tok', 200, headers(4000), T0);
		await withGhCaller('dispatch-probe', async () => {
			await Promise.resolve();
			recordGhResponse('tok', 200, headers(3999), T0);
		});
	});
	const callers = getGhBudgetSnapshot(T0)[0]
		.byCaller.map((c) => c.caller)
		.sort();
	assert.deepEqual(callers, ['dispatch-poll', 'dispatch-probe']);
});

test('tokens are kept apart, and a report never carries the token itself', () => {
	labelGhToken('secret-a', 'HADOKU_SITE_TOKEN');
	recordGhResponse('secret-a', 200, headers(4000), T0);
	recordGhResponse('secret-b', 200, headers(100), T0);
	const snap = getGhBudgetSnapshot(T0);
	assert.equal(snap.length, 2);
	assert.match(snap[0].token, /^HADOKU_SITE_TOKEN \(sha256:[0-9a-f]{8}\)$/);
	assert.ok(!JSON.stringify(snap).includes('secret-'), 'a fingerprint, never the token');
});

test('a late response from the previous window does not roll the reading back', () => {
	recordGhResponse('tok', 200, headers(3000), T0);
	recordGhResponse('tok', 200, headers(3100), T0); // out of order, same window
	assert.equal(getGhBudgetSnapshot(T0)[0].remaining, 3000, 'the budget only falls in a window');
});

test('the low-budget page fires ONCE, below 20%, and names the top spender', async () => {
	await withGhCaller('reap', async () => {
		for (let i = 0; i < 30; i++) recordGhResponse('tok', 200, headers(1100 - i), T0);
	});
	assert.equal(posts.length, 0, 'still above 20% (1,000 of 5,000)');
	await withGhCaller('runner-health', async () => {
		for (let i = 0; i < 5; i++) recordGhResponse('tok', 200, headers(999 - i), T0);
	});
	assert.equal(posts.length, 1, 'one page, not one per response');
	// At the FIRST reading under the line — that is the whole point of the page.
	assert.match(posts[0], /999\/5000 core calls left \(19%\)/);
	assert.match(posts[0], /resets in 45m/);
	assert.match(posts[0], /Top spenders: reap 30, runner-health 1/);
	for (let i = 0; i < 10; i++) recordGhResponse('tok', 200, headers(900 - i), T0);
	assert.equal(posts.length, 1, 'still one page for this window');
	assert.equal(getGhBudgetSnapshot(T0)[0].alerted, true);
});

test('no page when the reset is too close to act on', () => {
	const soon = T0 / 1000 + BUDGET_ALERT_MIN_LEFT_MS / 1000 - 60;
	recordGhResponse('tok', 200, headers(500, soon), T0);
	assert.equal(posts.length, 0);
});

test('the page names what this process did NOT spend', () => {
	// 20 calls charged to the token between two of our readings, of which we made 1.
	recordGhResponse('tok', 200, headers(1020), T0);
	recordGhResponse('tok', 200, headers(999), T0);
	assert.equal(getGhBudgetSnapshot(T0)[0].otherSinceFirst, 20);
	assert.match(posts[0], /not this process: ~20/);
});

test('a new window logs the old one with every spender, and starts counting fresh', async () => {
	await withGhCaller('reap', async () => recordGhResponse('tok', 200, headers(2000), T0));
	await withGhCaller('mint', async () => recordGhResponse('tok', 201, headers(1999), T0));
	recordGhResponse('tok', 200, headers(4999, RESET_S + 3600), T0 + 46 * 60_000);
	const line = infos.find((l) => l.startsWith('[gh-budget] window ended'));
	assert.ok(line, 'the forensics line the 10-16 investigation did not have');
	assert.match(line, /used 3001\/5000/);
	assert.match(line, /mint 1, reap 1/);
	const [w] = getGhBudgetSnapshot(T0 + 46 * 60_000);
	assert.equal(w.remaining, 4999);
	assert.deepEqual(
		w.byCaller.map((c) => c.caller),
		['unattributed']
	);
});

test('ghGet and ghGetConditional record every response — refused and 304 included', async () => {
	let status = 200;
	globalThis.fetch = (async () =>
		new Response(status === 304 ? null : JSON.stringify({ runners: [] }), {
			status,
			headers: headers(status === 403 ? 0 : 3000),
		})) as typeof fetch;
	await withGhCaller('runner-health', async () => {
		await ghGet('/actions/runners', 'tok', 'WolffM/a');
		status = 304;
		await ghGetConditional('/actions/runs', 'tok', 'WolffM/a', 'W/"x"');
		status = 403;
		await ghGet('/actions/runners', 'tok', 'WolffM/a');
	});
	const [w] = getGhBudgetSnapshot();
	assert.equal(w.byCaller[0].caller, 'runner-health');
	assert.equal(w.byCaller[0].charged + w.byCaller[0].notModified, 3, 'all three calls');
	assert.equal(w.byCaller[0].notModified, 1);
	assert.equal(w.remaining, 0, 'the refusal is the reading nearest the 403');
});

test('a response with no headers is ignored — the meter never breaks the call it watches', async () => {
	// No `headers` at all, the shape the meter must survive. `text` because
	// that is how `ghGet` reads a body (it keeps the text for revalidation).
	globalThis.fetch = (async () =>
		({ ok: true, status: 200, text: async () => '{"runners":[]}' }) as Response) as typeof fetch;
	assert.deepEqual(await ghGet('/actions/runners', 'tok', 'WolffM/a'), { runners: [] });
	assert.deepEqual(getGhBudgetSnapshot(), []);
});

/**
 * 2026-10-25: one token, two windows. Some endpoints (the runner listing among
 * them) are counted in a bucket of their own with its own reset, and every
 * response still says `core`. Read as one window, each crossing closed the window holding the real spend, and the
 * general bucket's readings were then dropped as late — `GET /fleet` showed 65%
 * left while dispatch was about to be refused.
 */
const RUNNERS_RESET_S = RESET_S + 210; // the runner bucket resets 3.5 minutes later

function bucketHeaders(used: number, resetS: number) {
	return headers(5000 - used, resetS);
}

test('two buckets on one token are two windows, each with its own reading', () => {
	for (let i = 0; i < 5; i++) {
		recordGhResponse('tok', 200, bucketHeaders(4000 + i, RESET_S), T0);
		recordGhResponse('tok', 200, bucketHeaders(1700 + i, RUNNERS_RESET_S), T0);
	}
	assert.equal(
		infos.filter((l) => l.startsWith('[gh-budget] window ended')).length,
		0,
		'interleaved buckets close nothing'
	);
	const snap = getGhBudgetSnapshot(T0).sort((a, b) => a.resetAt.localeCompare(b.resetAt));
	assert.equal(snap.length, 2);
	assert.equal(snap[0].used, 4004, 'the general bucket keeps its own count');
	assert.equal(snap[1].used, 1704);
	assert.equal(snap[0].byCaller[0].charged + snap[1].byCaller[0].charged, 10);
});

test('the general bucket pages even while the runner bucket, resetting later, is healthy', () => {
	recordGhResponse('tok', 200, bucketHeaders(1700, RUNNERS_RESET_S), T0);
	recordGhResponse('tok', 200, bucketHeaders(4200, RESET_S), T0);
	recordGhResponse('tok', 200, bucketHeaders(1701, RUNNERS_RESET_S), T0);
	assert.equal(posts.length, 1);
	assert.match(posts[0], /800\/5000 core calls left/);
});

test('a bucket that resets closes alone, and the other keeps counting', () => {
	recordGhResponse('tok', 200, bucketHeaders(3000, RESET_S), T0);
	recordGhResponse('tok', 200, bucketHeaders(1700, RUNNERS_RESET_S), T0);
	const after = T0 + 46 * 60_000; // past RESET_S, before RUNNERS_RESET_S
	recordGhResponse('tok', 200, bucketHeaders(1, RESET_S + 3600), after);
	const ended = infos.filter((l) => l.startsWith('[gh-budget] window ended'));
	assert.equal(ended.length, 1);
	assert.match(ended[0], /used 3000\/5000/);
	assert.equal(getGhBudgetSnapshot(after).length, 2, 'the runner bucket and the new general one');
	// A late answer from the window that just ended opens nothing.
	recordGhResponse('tok', 200, bucketHeaders(3001, RESET_S), after);
	assert.equal(getGhBudgetSnapshot(after).length, 2);
});

test('the books survive a restart, and the window that ended in between is still logged', async () => {
	await withGhCaller('ci-alerts', async () => {
		recordGhResponse('tok', 200, bucketHeaders(1000, RESET_S), T0);
		recordGhResponse('tok', 200, bucketHeaders(1001, RESET_S), T0 + GH_BUDGET_SAVE_MS);
	});
	__restartGhBudgetForTesting();
	await withGhCaller('reap', async () => {
		recordGhResponse('tok', 200, bucketHeaders(1002, RESET_S), T0 + 2 * GH_BUDGET_SAVE_MS);
	});
	const [w] = getGhBudgetSnapshot(T0 + 2 * GH_BUDGET_SAVE_MS);
	assert.deepEqual(
		w.byCaller.map((c) => [c.caller, c.charged]),
		[
			['ci-alerts', 2],
			['reap', 1],
		],
		'the predecessor spent it, and it is still named'
	);
	assert.equal(w.restarts, 1);
	assert.equal(w.otherSinceFirst, 0, 'every call accounted for across the restart');

	// The process dies again; the window resets before anything reads it.
	__restartGhBudgetForTesting();
	getGhBudgetSnapshot(T0 + 46 * 60_000);
	const ended = infos.find((l) => l.startsWith('[gh-budget] window ended'));
	assert.ok(ended, 'the hourly line is written by whichever process sees the reset');
	assert.match(ended, /ci-alerts 2, reap 1/);
	assert.match(ended, /books carried across 2 restarts/);
});

test('a page that fired before a restart does not fire again after it', () => {
	recordGhResponse('tok', 200, headers(900), T0);
	assert.equal(posts.length, 1);
	__restartGhBudgetForTesting();
	recordGhResponse('tok', 200, headers(890), T0 + 1000);
	assert.equal(posts.length, 1);
});

// ---------------------------------------------------------------------------
// fleet-manager#9: naming what is NOT this process
// ---------------------------------------------------------------------------

function withToken(): void {
	__setHostForTesting({
		...testHost,
		githubToken: () => 'tok',
		logger: { info: (m: string) => infos.push(m), warn() {}, error() {} },
		alerts: { post: async () => ({ posted: true, sinkRecorded: true }), recordQuietly() {} },
	});
}

/** A scripted `/rate_limit`: each read returns the next `used`, in the window ending at RESET_S. */
function pool(...used: (number | null)[]) {
	return async () => {
		const u = used.shift();
		if (u === null || u === undefined) return null;
		return { limit: 5000, remaining: 5000 - u, used: u, resetAtMs: RESET_S * 1000 };
	};
}

test('a metered cron is charged what the pool rose while it ran, net of this process', async () => {
	withToken();
	const value = await meterGhPool(
		'cron:ci:audit-gates',
		async () => {
			// mgmt-api's own loop spends 2 charged calls while the cron runs.
			recordGhResponse('tok', 200, headers(4699), T0);
			recordGhResponse('tok', 200, headers(4350), T0);
			return 'gate result';
		},
		{ read: pool(300, 650), now: () => T0 }
	);
	assert.equal(value, 'gate result', 'the dispatch result passes through untouched');
	const [w] = getGhBudgetSnapshot(T0);
	assert.deepEqual(w.metered, [{ caller: 'cron:ci:audit-gates', runs: 1, spent: 348, unread: 0 }]);
});

test('a cron that throws is still metered, and the throw reaches the caller', async () => {
	withToken();
	await assert.rejects(
		meterGhPool(
			'cron:ci:fleet-coverage',
			async () => {
				throw new Error('finding');
			},
			{ read: pool(100, 540), now: () => T0 }
		),
		/finding/
	);
	assert.deepEqual(getGhBudgetSnapshot(T0)[0].metered?.[0], {
		caller: 'cron:ci:fleet-coverage',
		runs: 1,
		spent: 440,
		unread: 0,
	});
});

test('a run whose first reading failed is counted unread, never as zero spend', async () => {
	withToken();
	await meterGhPool('cron:repos:main-sync', async () => undefined, {
		read: pool(null, 900),
		now: () => T0,
	});
	assert.deepEqual(getGhBudgetSnapshot(T0)[0].metered?.[0], {
		caller: 'cron:repos:main-sync',
		runs: 1,
		spent: 0,
		unread: 1,
	});
});

test('a run across a reset books only the new window, from its reset', async () => {
	withToken();
	const reads = [
		{ limit: 5000, remaining: 100, used: 4900, resetAtMs: RESET_S * 1000 },
		{ limit: 5000, remaining: 4880, used: 120, resetAtMs: (RESET_S + 3600) * 1000 },
	];
	await meterGhPool('cron:ci:fleet-benchmark', async () => undefined, {
		read: async () => reads.shift() ?? null,
		now: () => RESET_S * 1000 + 60_000,
	});
	const w = getGhBudgetSnapshot(RESET_S * 1000 + 60_000).find(
		(x) => x.resetAt === new Date((RESET_S + 3600) * 1000).toISOString()
	);
	assert.deepEqual(w?.metered?.[0], {
		caller: 'cron:ci:fleet-benchmark',
		runs: 1,
		spent: 120,
		unread: 0,
	});
});

test('the window-ended line names the crons and the busiest five minutes outside', async () => {
	withToken();
	await withGhCaller('reap', async () => recordGhResponse('tok', 200, headers(4000), T0));
	// 05:20-ish: 900 spent outside, of which a cron ran for 650.
	await meterGhPool('cron:ci:audit-gates', async () => undefined, {
		read: pool(1000, 1650),
		now: () => T0 + 5 * 60_000,
	});
	recordGhResponse('tok', 200, headers(5000 - 1900), T0 + 6 * 60_000);
	// A quiet slice, then 1,220 with no cron running.
	recordGhResponse('tok', 200, headers(5000 - 1910), T0 + 12 * 60_000);
	recordGhResponse('tok', 200, headers(5000 - 3130), T0 + 17 * 60_000);
	recordGhResponse('tok', 200, headers(4999, RESET_S + 3600), T0 + 46 * 60_000);
	const line = infos.find((l) => l.startsWith('[gh-budget] window ended'));
	assert.ok(line);
	assert.match(line, /crons while running \(overlapping\): cron:ci:audit-gates 650/);
	const slice = (ms: number) => new Date(ms - (ms % (5 * 60_000))).toISOString().slice(11, 16);
	assert.match(line, new RegExp(`busiest outside, per 5 min: ${slice(T0 + 17 * 60_000)}Z \\+1219`));
	assert.doesNotMatch(
		line,
		new RegExp(`${slice(T0 + 12 * 60_000)}Z \\+`),
		'a quiet slice is not named'
	);
});

test('metered spend and the timeline survive a restart', async () => {
	withToken();
	await meterGhPool('cron:ci:audit-gates', async () => undefined, {
		read: pool(1000, 1650),
		now: () => T0,
	});
	__restartGhBudgetForTesting();
	withToken();
	const [w] = getGhBudgetSnapshot(T0 + 1000);
	assert.equal(w.metered?.[0]?.spent, 650);
	assert.ok(w.outsideTimeline?.length, 'the timeline came back with the books');
});

test('the meter never changes a dispatch outcome: a failing reader, or no host at all', async () => {
	withToken();
	const broken = async (): Promise<null> => {
		throw new Error('reader exploded');
	};
	assert.equal(await meterGhPool('cron:x', async () => 7, { read: broken, now: () => T0 }), 7);
	await assert.rejects(
		meterGhPool(
			'cron:x',
			async () => {
				throw new Error('the job failed');
			},
			{ read: broken, now: () => T0 }
		),
		/the job failed/,
		"the job's own error, not the meter's"
	);
	__setHostForTesting(null);
	try {
		assert.equal(await meterGhPool('cron:x', async () => 'ran'), 'ran');
	} finally {
		__setHostForTesting(testHost);
	}
});
