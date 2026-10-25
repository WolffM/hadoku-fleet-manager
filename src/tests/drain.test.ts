import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { __setHostForTesting } from '../host.js';
import {
	drainNotices,
	drainOverrides,
	drainStatus,
	effectiveDrains,
	HOSTING_NOTICE_MS,
	isDraining,
	noticeRefusal,
	parseDrainDoc,
	parseWhen,
	pruneDrainDoc,
	readDrain,
	writeDrain,
	type DrainDoc,
	type DrainState,
} from '../runners/drain.js';

const STATE: DrainState = {
	'claw-3': { since: '2026-09-02T06:00:00Z', reason: 'semi-annual stress test', by: 'hadoku' },
};

test('a drained node is never eligible, whatever the ladder wanted', () => {
	assert.deepEqual(drainOverrides('claw-3', true, STATE).eligible, false);
	assert.match(drainOverrides('claw-3', true, STATE).reason ?? '', /stress test/);
});

test('a drain beats even a backstop promotion', () => {
	// The backstop promotes to relieve a saturated fleet. If the alternative is
	// placing work on a machine somebody has opened, the queue waits.
	assert.equal(drainOverrides('claw-3', true, STATE).eligible, false);
});

test('a node not in the drain set is left exactly as the ladder decided', () => {
	// Both directions: drain must not accidentally PROMOTE anything either.
	assert.equal(drainOverrides('claw-1', true, STATE).eligible, true);
	assert.equal(drainOverrides('claw-1', false, STATE).eligible, false);
	assert.equal(drainOverrides('claw-1', false, STATE).reason, undefined);
});

test('DRAINING IS NOT DRAINED — the whole point of the word soft', () => {
	// Only `drained` is safe to start maintenance on.
	assert.equal(drainStatus('claw-3', 2, STATE), 'draining');
	assert.equal(drainStatus('claw-3', 0, STATE), 'drained');
	assert.equal(drainStatus('claw-1', 0, STATE), 'active');
});

test('a census that has not looked reports unknown, never drained', () => {
	// `null` is "nobody counted the running jobs". Calling that drained is how
	// somebody opens a case on a node that is mid-build.
	assert.equal(drainStatus('claw-3', null, STATE), 'unknown');
});

// ── #90: a live warm/JIT registration overrides `busy` ──────────────────────
//
// A warm listener sitting IDLE is exactly as assignable as a busy one — GitHub
// hands it work directly, without asking the dispatcher — so `busy === 0` on
// that registration is not evidence of anything safe. claw-5 read `drained`
// from a busy-process probe alone while `warm-claw-5-hadoku_site` sat there,
// idle and still live, and went on to serve 23 more jobs.

test('a live registration is `draining`, never `drained`, whatever `busy` says', () => {
	assert.equal(drainStatus('claw-3', 0, STATE, true), 'draining');
	assert.equal(drainStatus('claw-3', null, STATE, true), 'draining');
});

test('no registration falls through to the busy-only rule — the default, unchanged', () => {
	assert.equal(drainStatus('claw-3', 0, STATE, false), 'drained');
	assert.equal(drainStatus('claw-3', 2, STATE, false), 'draining');
	// The 4th argument defaults to `false`, so every caller written before it
	// existed — including every assertion above this block — reproduces
	// today's rule bit for bit.
	assert.equal(drainStatus('claw-3', 0, STATE), 'drained');
});

test('an unreadable registration listing is UNKNOWN, never drained', () => {
	// "I could not look" must never render as "nothing is there" (AGENTS.md).
	// This fails CLOSED exactly like the `busy === null` case, and takes
	// priority over `busy` even when the busy probe DID succeed — a census
	// that answered one question is not a census that answered both.
	assert.equal(drainStatus('claw-3', 0, STATE, null), 'unknown');
	assert.equal(drainStatus('claw-3', 3, STATE, null), 'unknown');
});

test('a node not in the drain set is still `active`, whatever the registration says', () => {
	// The registration check is scoped to `isDraining` exactly like `busy`
	// already was — it must never DRAIN a node on its own.
	assert.equal(drainStatus('claw-1', 0, STATE, true), 'active');
});

test('isDraining is exact, not prefix — claw-3 must not drain claw-30', () => {
	assert.equal(isDraining('claw-3', STATE), true);
	assert.equal(isDraining('claw-30', STATE), false);
	assert.equal(isDraining('claw', STATE), false);
});

// ── Where the file LIVES ────────────────────────────────────────────────────
//
// The 2026-09-04 bug was not in any rule above; every one of them was correct
// and none of them ran, because the dispatcher was reading a different file
// from the one `fleet drain` wrote. claw-5 was drained for a DRAM fault at
// 21:58Z and served jobs for the next nine hours. So the location is now
// asserted as hard as the semantics.

const HOST = (manifestDir: string, stateDir: string) =>
	({
		logger: { info() {}, warn() {}, error() {} },
		alerts: { post: async () => ({ posted: false, sinkRecorded: false }), recordQuietly() {} },
		jobs: { recordJobResult: async () => {} },
		githubToken: () => 'tok',
		manifestDir,
		stateDir,
		storeDoctorPath: '/tmp',
		cronProfilesPath: '/tmp',
	}) as never;

function withDirs(fn: (manifestDir: string, stateDir: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), 'drain-'));
	const manifestDir = join(root, 'manifest');
	const stateDir = join(root, 'state');
	mkdirSync(manifestDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	__setHostForTesting(HOST(manifestDir, stateDir));
	try {
		fn(manifestDir, stateDir);
	} finally {
		__setHostForTesting(null as never);
		rmSync(root, { recursive: true, force: true });
	}
}

const doc = (node: string) =>
	`${JSON.stringify({ nodes: { [node]: { since: 's', reason: 'r', by: 'b' } } })}\n`;

test('a drain is written to the STATE dir, not into a git checkout', () => {
	withDirs((manifestDir, stateDir) => {
		writeDrain({ 'claw-5': { since: 's', reason: 'DRAM', by: 'hadoku' } });
		assert.equal(
			existsSync(join(stateDir, 'fleet-drain.json')),
			true,
			'drain must land in the state dir, which both checkouts resolve identically'
		);
		assert.equal(
			existsSync(join(manifestDir, 'fleet-drain.json')),
			false,
			'writing into the manifest dir is the bug: two checkouts, two answers'
		);
	});
});

test('a LEGACY drain in the manifest dir is still honoured', () => {
	// The upgrade must not lift a drain an operator set before the move. That
	// would un-drain a machine somebody is about to open, silently.
	withDirs((manifestDir) => {
		writeFileSync(join(manifestDir, 'fleet-drain.json'), doc('claw-5'));
		assert.equal(isDraining('claw-5', readDrain()), true);
	});
});

test('the state dir wins when both exist', () => {
	withDirs((manifestDir, stateDir) => {
		writeFileSync(join(manifestDir, 'fleet-drain.json'), doc('claw-legacy'));
		writeFileSync(join(stateDir, 'fleet-drain.json'), doc('claw-current'));
		const s = readDrain();
		assert.equal(isDraining('claw-current', s), true);
		assert.equal(isDraining('claw-legacy', s), false);
	});
});

test('writing migrates: the legacy copy is removed, so one file answers', () => {
	withDirs((manifestDir, stateDir) => {
		writeFileSync(join(manifestDir, 'fleet-drain.json'), doc('claw-5'));
		writeDrain(readDrain()); // read legacy, write new
		assert.equal(existsSync(join(manifestDir, 'fleet-drain.json')), false);
		assert.equal(isDraining('claw-5', readDrain()), true);
		assert.equal(existsSync(join(stateDir, 'fleet-drain.json')), true);
	});
});

test('neither file is an EMPTY drain, not an error', () => {
	withDirs(() => {
		assert.deepEqual(readDrain(), {});
	});
});

// ── leases, planned drains and hosting notice ────────────────────────────────

const T0 = Date.parse('2026-10-25T05:00:00Z');
const at = (min: number): string => new Date(T0 + min * 60_000).toISOString();
const rec = { reason: 'cardtable stress lease', by: 'hadoku' };

test('a lease past its `until` is not a drain to ANY reader', () => {
	const doc: DrainDoc = {
		nodes: { 'claw-8': { ...rec, since: at(-60), kind: 'lease', until: at(-1) } },
		planned: [],
	};
	assert.equal(isDraining('claw-8', effectiveDrains(doc, T0)), false);
	assert.equal(isDraining('claw-8', effectiveDrains(doc, T0 - 2 * 60_000)), true);
});

test('an unparseable `until` holds the node — garbage must not read as "it ended"', () => {
	const doc: DrainDoc = {
		nodes: { 'claw-8': { ...rec, since: at(-60), until: 'soon' } },
		planned: [],
	};
	assert.equal(isDraining('claw-8', effectiveDrains(doc, T0)), true);
});

test('a planned drain is not in force before `from`, and is from then, measured from `from`', () => {
	const doc: DrainDoc = {
		nodes: {},
		planned: [{ ...rec, node: 'claw-3', since: at(-30), from: at(20), until: at(40) }],
	};
	assert.equal(isDraining('claw-3', effectiveDrains(doc, T0)), false);
	const live = effectiveDrains(doc, T0 + 25 * 60_000);
	assert.equal(live['claw-3'].since, at(20), 'drain-check must measure from when it took effect');
	assert.equal(isDraining('claw-3', effectiveDrains(doc, T0 + 41 * 60_000)), false);
});

test('a planned window over a hosting node wins while open and hands back the hosting record after', () => {
	const hosting = {
		...rec,
		since: at(-600),
		kind: 'hosting' as const,
		hosting: { tenant: 'cardtable', memoryMb: 8192, cores: 4, port: 7621 },
	};
	const doc: DrainDoc = {
		nodes: { 'claw-8': hosting },
		planned: [
			{ ...rec, node: 'claw-8', kind: 'maintenance', since: at(0), from: at(30), until: at(90) },
		],
	};
	assert.equal(effectiveDrains(doc, T0 + 45 * 60_000)['claw-8'].kind, 'maintenance');
	assert.equal(effectiveDrains(doc, T0 + 95 * 60_000)['claw-8'].kind, 'hosting');
});

test('notices list every start and end still ahead, soonest first, and nothing past', () => {
	const doc: DrainDoc = {
		nodes: {
			'claw-8': { ...rec, since: at(-60), kind: 'lease', until: at(120) },
			'claw-9': { ...rec, since: at(-60), kind: 'lease', until: at(-5) },
		},
		planned: [{ ...rec, node: 'claw-3', since: at(0), kind: 'lease', from: at(20), until: at(40) }],
	};
	const n = drainNotices(doc, T0);
	assert.deepEqual(
		n.map((x) => `${x.node}:${x.event}`),
		['claw-3:starts', 'claw-3:ends', 'claw-8:ends']
	);
});

test('a hosting node is owed notice; anything else is not', () => {
	const doc: DrainDoc = {
		nodes: {
			'claw-8': {
				...rec,
				since: at(-600),
				kind: 'hosting',
				hosting: { tenant: 'cardtable', memoryMb: 8192, cores: 4, port: 7621 },
			},
			'claw-9': { ...rec, since: at(-60), kind: 'lease', until: at(600) },
		},
		planned: [],
	};
	assert.match(noticeRefusal('claw-8', T0 + 5 * 60_000, doc, T0) ?? '', /cardtable.*15 min/);
	assert.equal(noticeRefusal('claw-8', T0 + HOSTING_NOTICE_MS, doc, T0), null);
	assert.equal(noticeRefusal('claw-9', T0, doc, T0), null);
	assert.equal(noticeRefusal('claw-1', T0, doc, T0), null);
});

test('prune drops only what has lapsed', () => {
	const doc: DrainDoc = {
		nodes: {
			a: { ...rec, since: at(-60), until: at(-1) },
			b: { ...rec, since: at(-60) },
		},
		planned: [
			{ ...rec, node: 'c', since: at(-60), from: at(-30), until: at(-1) },
			{ ...rec, node: 'd', since: at(-60), from: at(30) },
		],
	};
	const p = pruneDrainDoc(doc, T0);
	assert.deepEqual(Object.keys(p.nodes), ['b']);
	assert.deepEqual(
		p.planned.map((x) => x.node),
		['d']
	);
});

test('a pre-lease file (no `planned` key) reads as no plans', () => {
	assert.deepEqual(parseDrainDoc('{"nodes":{}}'), { nodes: {}, planned: [] });
	assert.deepEqual(parseDrainDoc(''), { nodes: {}, planned: [] });
	assert.throws(() => parseDrainDoc('{nope'));
});

test('parseWhen reads durations and zoned timestamps, and refuses everything else', () => {
	assert.equal(parseWhen('20m', T0), T0 + 20 * 60_000);
	assert.equal(parseWhen('48h', T0), T0 + 48 * 3_600_000);
	assert.equal(parseWhen('2d', T0), T0 + 2 * 86_400_000);
	assert.equal(parseWhen('2026-10-27T04:57:48Z', T0), Date.parse('2026-10-27T04:57:48Z'));
	assert.throws(() => parseWhen('2026-10-27T04:57', T0), /zone/);
	assert.throws(() => parseWhen('tomorrow', T0));
	assert.throws(() => parseWhen('20', T0));
});

test('planned drains survive a write and are read back through the effective view', () => {
	withDirs(() => {
		const now = Date.now();
		writeDrain({}, [
			{
				...rec,
				node: 'claw-4',
				since: new Date(now).toISOString(),
				from: new Date(now - 1000).toISOString(),
			},
		]);
		assert.equal(isDraining('claw-4', readDrain()), true);
	});
});
