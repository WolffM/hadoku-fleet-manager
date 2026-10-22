import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { __setHostForTesting } from '../host.js';
import { ghGet, ghWrite, ghGetConditional, __resetGhBlackoutForTesting } from '../runner-health.js';

/**
 * A 403 is THREE different problems — primary rate limiting, secondary (burst)
 * rate limiting, or permissions — and this used to log the same word for all
 * three while discarding the body and headers that tell them apart.
 *
 * That cost a subagent and a log-archaeology pass on 2026-09-02 to conclude
 * that "could not read the queue for 26 repo(s)" was a concurrency burst, and
 * even then it could not be confirmed. These pin the line an operator reads.
 */
const realFetch = globalThis.fetch;
const realHost = { installed: false };
afterEach(() => {
	globalThis.fetch = realFetch;
	if (realHost.installed) __setHostForTesting(null);
	// The blackout is module state that OUTLIVES a test by design — a spent
	// budget is a fact about the token, not about one call. Without this, the
	// first primary-limit test above suppresses every test after it and they
	// pass by never reaching fetch at all.
	__resetGhBlackoutForTesting();
});

function captureWarn(): string[] {
	const lines: string[] = [];
	realHost.installed = true;
	__setHostForTesting({
		logger: { info() {}, warn: (m: string) => lines.push(m), error() {} },
		alerts: { post: async () => ({ posted: false, sinkRecorded: false }), recordQuietly() {} },
		jobs: { recordJobResult: async () => {} },
		githubToken: () => 'tok',
		manifestDir: '/tmp',
		stateDir: '/tmp',
		storeDoctorPath: '/tmp',
		cronProfilesPath: '/tmp',
	} as never);
	return lines;
}

const respond = (status: number, headers: Record<string, string>, body: unknown) => {
	globalThis.fetch = (async () =>
		new Response(JSON.stringify(body), { status, headers })) as typeof fetch;
};

test('a PRIMARY rate limit is named, with the budget and when it resets', async () => {
	const lines = captureWarn();
	respond(
		403,
		{
			'x-ratelimit-remaining': '0',
			'x-ratelimit-limit': '5000',
			'x-ratelimit-used': '5000',
			'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 120),
		},
		{ message: 'API rate limit exceeded for user 123.' }
	);
	assert.equal(await ghGet('/actions/runners', 'tok'), null, 'still fail-soft');
	const line = lines.at(-1) ?? '';
	assert.match(line, /PRIMARY rate limit/);
	assert.match(line, /remaining=0/);
	assert.match(line, /resets_in=\d+s/);
});

test('a SECONDARY rate limit is named as a burst, with retry-after', async () => {
	// The one that matters: the hourly budget still has thousands left, so a
	// human counting calls concludes "not rate limited" and looks elsewhere.
	const lines = captureWarn();
	respond(
		403,
		{ 'x-ratelimit-remaining': '4200', 'x-ratelimit-limit': '5000', 'retry-after': '37' },
		{ message: 'You have exceeded a secondary rate limit.' }
	);
	await ghGet('/actions/runners', 'tok');
	const line = lines.at(-1) ?? '';
	assert.match(line, /SECONDARY rate limit/);
	assert.match(line, /narrow concurrency/);
	assert.match(line, /retry_after=37s/);
	assert.doesNotMatch(line, /PRIMARY/, 'a burst is not the hourly budget');
});

test('a PERMISSIONS 403 is not mislabelled as rate limiting', async () => {
	// The negative case. Calling this a rate limit would send an operator to
	// widen a budget that was never the problem.
	const lines = captureWarn();
	respond(
		403,
		{ 'x-ratelimit-remaining': '4900', 'x-ratelimit-limit': '5000' },
		{ message: 'Resource not accessible by personal access token' }
	);
	await ghGet('/actions/runners', 'tok');
	const line = lines.at(-1) ?? '';
	assert.match(line, /Resource not accessible/);
	assert.doesNotMatch(line, /rate limit/i);
});

test('an unreadable body still logs the status rather than throwing', async () => {
	const lines = captureWarn();
	globalThis.fetch = (async () => ({
		ok: false,
		status: 502,
		headers: new Headers(),
		text: async () => {
			throw new Error('socket hang up');
		},
	})) as unknown as typeof fetch;
	assert.equal(await ghGet('/actions/runners', 'tok'), null);
	assert.match(lines.at(-1) ?? '', /HTTP 502/);
});

/**
 * THE BLACKOUT. A spent hourly budget is one fact about the TOKEN, so every
 * other call sharing it is already decided — retrying is arithmetic that cannot
 * come out differently until the reset.
 *
 * Measured 2026-09-06: the reap sweep walked all 27 repos and the 15s timer ran
 * it again, for the whole 19-minute blackout — 6,903 guaranteed-403 calls, none
 * of which could have succeeded, in exactly the burst shape GitHub's SECONDARY
 * limiter watches for.
 */

/** Count fetches so a suppressed call is proved by ABSENCE, not by its return. */
function countingRespond(status: number, headers: Record<string, string>, body: unknown) {
	const calls = { n: 0 };
	globalThis.fetch = (async () => {
		calls.n++;
		return new Response(JSON.stringify(body), { status, headers });
	}) as typeof fetch;
	return calls;
}

const PRIMARY = (resetInS: number) => ({
	'x-ratelimit-remaining': '0',
	'x-ratelimit-limit': '5000',
	'x-ratelimit-used': '5000',
	'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + resetInS),
});

test('once the budget is spent, later calls are suppressed rather than sent', async () => {
	captureWarn();
	const calls = countingRespond(403, PRIMARY(120), { message: 'API rate limit exceeded' });
	assert.equal(await ghGet('/actions/runners', 'tok'), null);
	assert.equal(calls.n, 1, 'the first call must go out — that is how we learn');
	for (let i = 0; i < 25; i++) await ghGet('/actions/runners?per_page=100', 'tok', `WolffM/r${i}`);
	assert.equal(calls.n, 1, '25 doomed calls became 0 — this is the whole fix');
});

test('suppression says "could not look", never "nothing to do"', async () => {
	// The rule this fix could most easily have broken. A suppressed poll that
	// answered `unchanged` would tell the dispatcher its CACHED queue is still
	// current, and it would mint against a 19-minute-old picture of the fleet.
	captureWarn();
	countingRespond(403, PRIMARY(120), { message: 'API rate limit exceeded' });
	await ghGet('/actions/runners', 'tok');

	assert.equal(await ghGet('/actions/runs', 'tok'), null, 'null is the error return');
	const c = await ghGetConditional('/actions/runs', 'tok', 'WolffM/x', 'etag-abc');
	assert.equal(c.status, 'error', 'NOT unchanged — we did not look');
	const w = await ghWrite('POST', '/actions/runners/registration-token', 'tok');
	assert.equal(w.ok, false, 'a mint must fail before it creates an orphan');
});

test('the blackout is announced ONCE, not per suppressed call', async () => {
	// Moving a 6,903-line flood from the failure path to the suppression path
	// would have fixed nothing an operator can see.
	const lines = captureWarn();
	countingRespond(403, PRIMARY(120), { message: 'API rate limit exceeded' });
	await ghGet('/actions/runners', 'tok');
	for (let i = 0; i < 30; i++) await ghGet('/actions/runners', 'tok');
	const announcements = lines.filter((l) => /suppressing GitHub calls/.test(l));
	assert.equal(announcements.length, 1, `said ${announcements.length}x`);
	assert.match(announcements[0], /could not look/, 'names what callers will see');
});

test('the blackout clears itself once the reset passes — nothing reopens it', async () => {
	captureWarn();
	// Already elapsed: the header says the window ended a second ago.
	const calls = countingRespond(403, PRIMARY(-1), { message: 'API rate limit exceeded' });
	await ghGet('/actions/runners', 'tok');
	await ghGet('/actions/runners', 'tok');
	assert.equal(calls.n, 2, 'a reset in the past must never arm a blackout');
});

test('a SECONDARY limit does NOT trip the blackout', async () => {
	// A burst is "too fast", usually seconds, and is fixed by narrowing
	// concurrency. Stopping the whole fleet over one would stall everything for
	// an hour on a limit that had already passed.
	captureWarn();
	const calls = countingRespond(
		403,
		{ 'x-ratelimit-remaining': '4200', 'x-ratelimit-limit': '5000', 'retry-after': '37' },
		{ message: 'You have exceeded a secondary rate limit.' }
	);
	await ghGet('/actions/runners', 'tok');
	await ghGet('/actions/runners', 'tok');
	assert.equal(calls.n, 2, 'a burst must not mute the fleet');
});

test('a primary 403 with no usable reset header fails OPEN', async () => {
	// We genuinely do not know when to look again. A few doomed calls are
	// cheaper than a blackout with no end.
	captureWarn();
	const calls = countingRespond(
		403,
		{ 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '5000' },
		{ message: 'API rate limit exceeded' }
	);
	await ghGet('/actions/runners', 'tok');
	await ghGet('/actions/runners', 'tok');
	assert.equal(calls.n, 2);
});
