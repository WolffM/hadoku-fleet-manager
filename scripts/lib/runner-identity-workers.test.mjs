/**
 * runner-identity-workers — a worker GitHub does not count as a job
 * (fleet-manager-private#138). The fixtures are the 2026-11-10 incident's own
 * shape: a warm listener's worker, alive on the node, with the registration
 * idle because GitHub ran the job somewhere else.
 *
 * Nothing here reaches a node or GitHub: every dependency is passed in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	WORKER_LOOK_FILE,
	describeOrphan,
	judgeWorker,
	listingReader,
	lookForOrphanWorkers,
	parseWorkers,
	recordWorkerLook,
} from './runner-identity-workers.mjs';

const WARM = 'warm-claw-fixture-hadoku-cardtable';
const DIR = '/home/ci/.hadoku/warm/slot0';
const row = (pid, age = 48480) => `WORKER ${DIR} WolffM/hadoku-cardtable ${WARM} ${age} ${pid}`;
const probeOf = (...rows) => ['RUNNER x y z 1', ...rows, 'PROBE-END n 1 0'].join('\n');
const listing = (...runners) => ({ ok: true, runners });

/** Deps whose listings and probes are scripted per look, and which record every call. */
function deps({ listings, probes }) {
	const calls = { listings: 0, probes: 0, slept: [] };
	return {
		calls,
		readListing: async () => listings[Math.min(calls.listings++, listings.length - 1)],
		probeNode: async () => probes[Math.min(calls.probes++, probes.length - 1)],
		canonical: async (r) => r,
		sleep: async (ms) => void calls.slept.push(ms),
	};
}

test('parseWorkers reads WORKER rows, and an age the node could not read is null, not 0', () => {
	const out = probeOf(row(4100), `WORKER ${DIR} ? ? ? 4200`, 'WORKER short');
	assert.deepEqual(parseWorkers('claw-fixture', out), [
		{
			node: 'claw-fixture',
			dir: DIR,
			repo: 'WolffM/hadoku-cardtable',
			name: WARM,
			ageSec: 48480,
			pid: '4100',
		},
		{ node: 'claw-fixture', dir: DIR, repo: '?', name: '?', ageSec: null, pid: '4200' },
	]);
});

test('judgeWorker: busy is a job; idle, offline and unlisted are suspects; no evidence is unjudged', () => {
	const w = { dir: DIR, repo: 'WolffM/r', name: WARM };
	assert.equal(judgeWorker(w, listing({ name: WARM, busy: true })).verdict, 'busy');
	assert.match(
		judgeWorker(w, listing({ name: WARM, status: 'online', busy: false })).why,
		/online and not busy/
	);
	assert.match(
		judgeWorker(w, listing({ name: WARM, status: 'offline' })).why,
		/offline and not busy/
	);
	assert.match(judgeWorker(w, listing({ name: 'other', busy: true })).why, /no runner named/);
	// "I could not look" is never a suspect and never a pass.
	assert.equal(judgeWorker(w, { ok: false, reason: 'HTTP 502' }).verdict, 'unjudged');
	assert.equal(judgeWorker({ ...w, name: '?' }, listing()).verdict, 'unjudged');
});

test('the incident: same pid alive on both looks, registration idle on both, is an orphan', async () => {
	const d = deps({
		listings: [listing({ name: WARM, status: 'online', busy: false })],
		probes: [{ ok: true, out: probeOf(row(4100, 48545)) }],
	});
	const look = await lookForOrphanWorkers({
		workers: parseWorkers('claw-fixture', probeOf(row(4100))),
		...d,
	});
	assert.equal(look.orphans.length, 1);
	assert.equal(look.orphans[0].ageSec, 48545);
	assert.match(describeOrphan(look.orphans[0]), /claw-fixture pid 4100 .*809m old.*on two looks/);
	// The second look is a fresh listing, after the wait.
	assert.deepEqual(d.calls, { listings: 2, probes: 1, slept: [60_000] });
});

test('a busy worker is a job: no wait, no second look', async () => {
	const d = deps({ listings: [listing({ name: WARM, busy: true })], probes: [] });
	const look = await lookForOrphanWorkers({
		workers: parseWorkers('claw-fixture', probeOf(row(4100, 30))),
		...d,
	});
	assert.deepEqual(
		{ seen: look.seen, busy: look.busy, orphans: look.orphans, slept: d.calls.slept },
		{ seen: 1, busy: 1, orphans: [], slept: [] }
	);
});

test('the race: a job that ended between the probe and the listing clears on the second look', async () => {
	const gone = deps({
		listings: [listing({ name: WARM, busy: false })],
		probes: [{ ok: true, out: probeOf() }],
	});
	const a = await lookForOrphanWorkers({
		workers: parseWorkers('claw-fixture', probeOf(row(4100))),
		...gone,
	});
	assert.equal(a.orphans.length, 0);
	assert.match(a.cleared[0].outcome, /exited/);

	// A new job in the same slot is a new pid: the old one is still "exited".
	const reused = deps({
		listings: [listing({ name: WARM, busy: false })],
		probes: [{ ok: true, out: probeOf(row(9999, 3)) }],
	});
	const b = await lookForOrphanWorkers({
		workers: parseWorkers('claw-fixture', probeOf(row(4100))),
		...reused,
	});
	assert.equal(b.orphans.length, 0);

	// The listing lagged: busy by the second look.
	const lagged = deps({
		listings: [listing({ name: WARM, busy: false }), listing({ name: WARM, busy: true })],
		probes: [{ ok: true, out: probeOf(row(4100)) }],
	});
	const c = await lookForOrphanWorkers({
		workers: parseWorkers('claw-fixture', probeOf(row(4100))),
		...lagged,
	});
	assert.equal(c.orphans.length, 0);
	assert.match(c.cleared[0].outcome, /busy on the second look/);
});

test('a second look that cannot be taken is unjudged with the reason, never cleared and never an orphan', async () => {
	const dark = deps({
		listings: [listing({ name: WARM, busy: false })],
		probes: [{ ok: false, error: 'ssh: connect timed out' }],
	});
	const a = await lookForOrphanWorkers({
		workers: parseWorkers('claw-fixture', probeOf(row(4100))),
		...dark,
	});
	assert.deepEqual([a.orphans.length, a.cleared.length], [0, 0]);
	assert.match(a.unjudged[0].why, /second look at claw-fixture failed: ssh: connect timed out/);

	const unread = deps({
		listings: [listing({ name: WARM, busy: false }), { ok: false, reason: 'HTTP 502' }],
		probes: [{ ok: true, out: probeOf(row(4100)) }],
	});
	const b = await lookForOrphanWorkers({
		workers: parseWorkers('claw-fixture', probeOf(row(4100))),
		...unread,
	});
	assert.deepEqual([b.orphans.length, b.cleared.length], [0, 0]);
	assert.match(b.unjudged[0].why, /second listing: HTTP 502/);
});

test('a .runner naming the repo before its rename is judged against the canonical listing', async () => {
	const asked = [];
	const look = await lookForOrphanWorkers({
		workers: parseWorkers('claw-fixture', `WORKER ${DIR} WolffM/tenhands ${WARM} 10 4100`),
		readListing: async (repo) => (asked.push(repo), listing({ name: WARM, busy: true })),
		probeNode: async () => ({ ok: false, error: 'unused' }),
		canonical: async () => 'WolffM/hadoku-tenhands',
		sleep: async () => {},
	});
	assert.deepEqual([asked, look.busy], [['WolffM/hadoku-tenhands'], 1]);
});

test('listingReader refuses a truncated page: an absent runner there is not a runner GitHub lacks', async () => {
	const read = (data) => listingReader(async () => ({ ok: true, data }))('WolffM/r');
	assert.deepEqual(await read({ total_count: 1, runners: [{ name: 'a' }] }), {
		ok: true,
		runners: [{ name: 'a' }],
	});
	assert.match((await read({ total_count: 140, runners: [{ name: 'a' }] })).reason, /1 of 140/);
	assert.match((await read({ message: 'Not Found' })).reason, /no `runners` array/);
	const failed = await listingReader(async () => ({ ok: false, reason: 'HTTP 403 rate limit' }))(
		'WolffM/r'
	);
	assert.deepEqual(failed, { ok: false, reason: 'WolffM/r: HTTP 403 rate limit' });
});

test('recordWorkerLook appends one row a run, an empty look included, and says why when it cannot', () => {
	const dir = mkdtempSync(join(tmpdir(), 'worker-look-'));
	try {
		const empty = { seen: 0, busy: 0, orphans: [], cleared: [], unjudged: [] };
		const at = new Date().toISOString();
		assert.deepEqual(recordWorkerLook(dir, empty, at), { ok: true });
		assert.deepEqual(recordWorkerLook(dir, { ...empty, seen: 2, busy: 2 }, at), { ok: true });
		const rows = readFileSync(join(dir, WORKER_LOOK_FILE), 'utf8')
			.trim()
			.split('\n')
			.map((l) => JSON.parse(l));
		assert.deepEqual(
			rows.map((r) => [r.v, r.at, r.seen, r.busy]),
			[
				[1, at, 0, 0],
				[1, at, 2, 2],
			]
		);
		// A state dir that is a FILE cannot be written into.
		const blocked = join(dir, 'not-a-dir');
		writeFileSync(blocked, '');
		assert.match(recordWorkerLook(blocked, empty, at).reason, /not-a-dir/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
