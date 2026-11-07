/**
 * The ppe sweep: which repos it wakes, and that it reads every repo in ONE
 * query and wakes a tip at most once per REDISPATCH_MS.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
	PPE_QUIET_MS,
	REDISPATCH_MS,
	dueForPromotion,
	parseSweep,
	ppeSweepTick,
	sweepQuery,
	__stopPpeSweepForTesting,
	type PpeState,
} from '../ppe-sweep.js';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const MIN = 60_000;

const state = (over: Partial<PpeState> = {}): PpeState => ({
	repo: 'WolffM/a',
	ppeSha: 'aaa',
	ppeAhead: 2,
	mainAhead: 0,
	tipAtMs: NOW - 11 * MIN,
	rollup: 'SUCCESS',
	...over,
});

const none = new Map<string, { sha: string; atMs: number }>();

void test('a settled, quiet, green ppe ahead of main is woken', () => {
	assert.deepEqual(
		dueForPromotion([state()], NOW, none).map((s) => s.repo),
		['WolffM/a']
	);
	// Nothing reported at all is woken too: the promoter decides what untested means.
	assert.equal(dueForPromotion([state({ rollup: null })], NOW, none).length, 1);
});

void test('each reason not to wake, one at a time', () => {
	const cases: [string, Partial<PpeState>][] = [
		['no ppe branch (not adopted)', { ppeSha: null }],
		['nothing to promote', { ppeAhead: 0 }],
		['main ahead: no fast-forward until the sync merges it', { mainAhead: 1 }],
		['checks still running: the CI completion wakes it', { rollup: 'PENDING' }],
		['not quiet yet', { tipAtMs: NOW - PPE_QUIET_MS + 1 }],
	];
	for (const [why, over] of cases)
		assert.deepEqual(dueForPromotion([state(over)], NOW, none), [], why);
});

void test('#68: a settled red tip is woken once, so a re-run red the event missed still reverts', () => {
	assert.equal(dueForPromotion([state({ rollup: 'FAILURE' })], NOW, none).length, 1);
	assert.equal(dueForPromotion([state({ rollup: 'ERROR' })], NOW, none).length, 1);
	// Woken once at any time: never again, however long it stays red.
	const woken = new Map([['WolffM/a', { sha: 'aaa', atMs: NOW - 10 * REDISPATCH_MS }]]);
	assert.deepEqual(dueForPromotion([state({ rollup: 'FAILURE' })], NOW, woken), []);
	assert.equal(
		dueForPromotion([state({ rollup: 'FAILURE', ppeSha: 'bbb' })], NOW, woken).length,
		1
	);
});

void test('the same tip is not woken again inside REDISPATCH_MS; a new tip is', () => {
	const woken = new Map([['WolffM/a', { sha: 'aaa', atMs: NOW - REDISPATCH_MS + 1 }]]);
	assert.deepEqual(dueForPromotion([state()], NOW, woken), []);
	assert.equal(dueForPromotion([state()], NOW + 1, woken).length, 1);
	assert.equal(dueForPromotion([state({ ppeSha: 'bbb' })], NOW, woken).length, 1);
});

void test('parseSweep: compare is ppe-as-base, so behindBy is what ppe holds that main lacks', () => {
	const repos = ['WolffM/a', 'WolffM/b', 'WolffM/gone', 'WolffM/c'];
	const { states, unreadable } = parseSweep(repos, {
		r0: {
			ppe: {
				target: {
					oid: 'aaa',
					committedDate: '2026-11-01T11:00:00Z',
					statusCheckRollup: { state: 'SUCCESS' },
				},
				compare: { aheadBy: 1, behindBy: 3 },
			},
		},
		r1: { ppe: null },
		r2: null,
		r3: { ppe: { target: { oid: 'ccc' }, compare: null } },
	});
	assert.deepEqual(states, [
		{
			repo: 'WolffM/a',
			ppeSha: 'aaa',
			ppeAhead: 3,
			mainAhead: 1,
			tipAtMs: Date.parse('2026-11-01T11:00:00Z'),
			rollup: 'SUCCESS',
		},
		{ repo: 'WolffM/b', ppeSha: null, ppeAhead: 0, mainAhead: 0, tipAtMs: null, rollup: null },
	]);
	// Unresolvable is NOT "no ppe": it is named, never read as a quiet repo.
	assert.deepEqual(unreadable, ['WolffM/gone', 'WolffM/c']);
});

void test('sweepQuery: one aliased query, the compare hung off ppe', () => {
	const q = sweepQuery(['WolffM/a', 'WolffM/b']);
	assert.match(q, /^query \{ r0: repository\(owner: "WolffM", name: "a"\)/);
	assert.match(q, /r1: repository\(owner: "WolffM", name: "b"\)/);
	assert.match(
		q,
		/ppe: ref\(qualifiedName: "refs\/heads\/ppe"\) \{[^]*compare\(headRef: "refs\/heads\/main"\)/
	);
});

let originalFetch: typeof globalThis.fetch;
let calls: { url: string; body: string }[];

function installFetch(data: unknown, dispatchStatus = 204) {
	calls = [];
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, body: String(init?.body ?? '') });
		const respond = (status: number, body: unknown) =>
			({
				ok: status < 400,
				status,
				headers: new Headers(),
				text: async () => (body === undefined ? '' : JSON.stringify(body)),
			}) as Response;
		if (url.endsWith('/graphql')) return respond(200, data);
		return respond(dispatchStatus, undefined);
	}) as typeof globalThis.fetch;
}

beforeEach(() => {
	originalFetch = globalThis.fetch;
	__stopPpeSweepForTesting();
});
afterEach(() => {
	globalThis.fetch = originalFetch;
	__stopPpeSweepForTesting();
});

const quietGreen = {
	ppe: {
		target: {
			oid: 'aaa',
			committedDate: new Date(NOW - 20 * MIN).toISOString(),
			statusCheckRollup: { state: 'SUCCESS' },
		},
		compare: { aheadBy: 0, behindBy: 2 },
	},
};

void test('a tick reads every repo in ONE query and dispatches only the due one, once', async () => {
	installFetch({ data: { r0: quietGreen, r1: { ppe: null } } });
	const r = await ppeSweepTick(NOW, 'tok', ['WolffM/a', 'WolffM/b']);
	assert.deepEqual(r, { woke: ['WolffM/a'], failed: [] });
	assert.equal(calls.filter((c) => c.url.endsWith('/graphql')).length, 1);
	const dispatch = calls.filter((c) => c.url.includes('/dispatches'));
	assert.deepEqual(
		dispatch.map((c) => c.url),
		['https://api.github.com/repos/WolffM/a/actions/workflows/ppe-promote.yml/dispatches']
	);
	assert.deepEqual(JSON.parse(dispatch[0].body), { ref: 'main' });

	// The next pass, same tip: read again, woken not again.
	const again = await ppeSweepTick(NOW + 5 * MIN, 'tok', ['WolffM/a', 'WolffM/b']);
	assert.deepEqual(again, { woke: [], failed: [] });
});

void test('could not look: a failed query wakes nothing', async () => {
	installFetch({ errors: [{ message: 'Something went wrong' }] });
	assert.equal(await ppeSweepTick(NOW, 'tok', ['WolffM/a']), null);
	assert.equal(calls.filter((c) => c.url.includes('/dispatches')).length, 0);
	assert.equal(await ppeSweepTick(NOW, undefined, ['WolffM/a']), null);
});

void test('a refused dispatch (a ppe branch with no promoter yet) is reported, and not retried every pass', async () => {
	installFetch({ data: { r0: quietGreen } }, 404);
	assert.deepEqual(await ppeSweepTick(NOW, 'tok', ['WolffM/a']), {
		woke: [],
		failed: ['WolffM/a'],
	});
	assert.deepEqual(await ppeSweepTick(NOW + 5 * MIN, 'tok', ['WolffM/a']), {
		woke: [],
		failed: [],
	});
});
