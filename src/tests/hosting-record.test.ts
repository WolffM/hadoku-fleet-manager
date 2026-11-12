import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ciUnitProperties } from '../runners/ci-unit-properties.js';
import { buildSpawnPlan, buildWarmSpawnPlan } from '../runners/ephemeral-mint.js';
import { drainNotices, noticeRefusal, type DrainDoc } from '../runners/drain.js';
import { endingSlice } from '../lib/hosting-slice.js';
import {
	AGENT_UP_MIN_MB,
	CI_OOM_SCORE_ADJ,
	ENDED_KEEP_MS,
	HOLD_FULL_MS,
	effectiveSlices,
	heldBackMb,
	hostingNotices,
	hostingsOn,
	lapsed,
	issueEpoch,
	parseHostingDoc,
	readHostingDoc,
	sharedMbOn,
	sliceUsageProbe,
	takeSliceUsage,
	withEnded,
	withMoveClosed,
	withMoveOpen,
	withSlice,
	withoutSlice,
	writeHostingDoc,
	type HostingDoc,
	type SharedHosting,
} from '../runners/hosting-record.js';

const NOW = Date.parse('2026-10-25T20:00:00Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const ahead = (ms: number): string => new Date(NOW + ms).toISOString();

const slice = (over: Partial<SharedHosting> = {}): SharedHosting => ({
	tenant: 'cardtable',
	memoryMb: 4096,
	cores: 4,
	port: 7621,
	since: ago(3_600_000),
	by: 'test',
	reason: 'test slice',
	...over,
});
const shared = (rec: SharedHosting = slice()): HostingDoc => ({ nodes: { 'claw-9': [rec] } });
const noDrains: DrainDoc = { nodes: {}, planned: [] };

test('an unreadable record THROWS: what a tenant was promised is never read as nothing', () => {
	assert.deepEqual(parseHostingDoc(''), { nodes: {} });
	assert.throws(() => parseHostingDoc('{ not json'));
	assert.throws(() => parseHostingDoc('{"nodes":{"claw-9":{"tenant":"cardtable"}}}'), /claw-9/);
	assert.throws(() => parseHostingDoc('{"nodes":{"claw-9":[{"tenant":"cardtable"}]}}'), /claw-9/);
	// fleet-manager#83: a steady mark past the slice, or not a size, is not one.
	for (const steadyMb of [0, 5000, 'x'])
		assert.throws(
			() =>
				parseHostingDoc(JSON.stringify({ nodes: { 'claw-9': [slice({ steadyMb } as never)] } })),
			/steadyMb/
		);
	const steady = slice({ steadyMb: 180 });
	assert.deepEqual(
		parseHostingDoc(JSON.stringify({ nodes: { 'claw-9': [steady] } })),
		shared(steady)
	);
});

// fleet-manager#32: the file held one record per node before 2026-10-31.
test('a node written as one record reads as a list of one; a tenant listed twice THROWS', () => {
	const rec = slice();
	assert.deepEqual(parseHostingDoc(JSON.stringify({ nodes: { 'claw-9': rec } })), shared(rec));
	assert.throws(
		() => parseHostingDoc(JSON.stringify({ nodes: { 'claw-9': [rec, slice({ memoryMb: 1 })] } })),
		/claw-9 lists cardtable twice/
	);
});

test('withSlice adds or replaces ONE tenant and never another; withoutSlice drops only that one', () => {
	const archivebot = slice({ tenant: 'archivebot', memoryMb: 1024, cores: 1, port: 0 });
	const pygmalion = slice({ tenant: 'pygmalion', memoryMb: 512, cores: 1, port: 9002 });
	// The claw-4 incident: a second tenant declared on the node kept the first.
	let doc = withSlice({ nodes: {} }, 'claw-4', archivebot);
	doc = withSlice(doc, 'claw-4', pygmalion);
	assert.deepEqual(
		doc.nodes['claw-4'].map((r) => r.tenant),
		['archivebot', 'pygmalion']
	);
	// A re-declare of the same tenant replaces only its own record.
	doc = withSlice(doc, 'claw-4', { ...pygmalion, memoryMb: 768 });
	assert.deepEqual(
		doc.nodes['claw-4'].map((r) => [r.tenant, r.memoryMb]),
		[
			['archivebot', 1024],
			['pygmalion', 768],
		]
	);
	assert.equal(sharedMbOn(doc, 'claw-4', NOW), 1024 + 768);
	doc = withoutSlice(doc, 'claw-4', 'pygmalion');
	assert.deepEqual(
		doc.nodes['claw-4'].map((r) => r.tenant),
		['archivebot']
	);
	assert.deepEqual(withoutSlice(doc, 'claw-4', 'archivebot'), { nodes: {} });
});

test('the record round-trips through its own state dir, and a missing file is no hosting', () => {
	const dir = mkdtempSync(join(tmpdir(), 'hosting-record-'));
	try {
		assert.deepEqual(readHostingDoc(dir), { nodes: {} });
		writeHostingDoc(shared(), dir);
		assert.deepEqual(readHostingDoc(dir), shared());
		assert.match(readFileSync(join(dir, 'fleet-hosting.json'), 'utf8'), /\$comment/);
		writeFileSync(join(dir, 'fleet-hosting.json'), 'garbage');
		assert.throws(() => readHostingDoc(dir));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a slice past its end is no longer in force; an unparseable end still is', () => {
	assert.deepEqual(Object.keys(effectiveSlices(shared(slice({ until: ago(1) })), NOW)), []);
	assert.deepEqual(Object.keys(effectiveSlices(shared(slice({ until: ahead(60_000) })), NOW)), [
		'claw-9',
	]);
	assert.deepEqual(Object.keys(effectiveSlices(shared(slice({ until: 'soon' })), NOW)), ['claw-9']);
	// One tenant's lapsed slice leaves the other's in force, and out of the sum.
	const two: HostingDoc = {
		nodes: {
			'claw-4': [slice({ until: ago(1) }), slice({ tenant: 'archivebot', memoryMb: 1024 })],
		},
	};
	assert.deepEqual(
		effectiveSlices(two, NOW)['claw-4'].map((r) => r.tenant),
		['archivebot']
	);
	assert.equal(sharedMbOn(two, 'claw-4', NOW), 1024);
	assert.equal(sharedMbOn(two, 'claw-9', NOW), 0);
});

test('hostingsOn answers for both kinds, whole from the drain and shared from its own file', () => {
	const whole: DrainDoc = {
		nodes: {
			'claw-8': {
				since: ago(1),
				reason: 'x',
				by: 't',
				kind: 'hosting',
				hosting: { tenant: 'cardtable', memoryMb: 12288, cores: 6, port: 7621 },
			},
		},
		planned: [],
	};
	assert.equal(hostingsOn('claw-8', whole, { nodes: {} }, NOW)[0]?.mode, 'whole');
	assert.equal(hostingsOn('claw-9', noDrains, shared(), NOW)[0]?.mode, 'shared');
	assert.deepEqual(hostingsOn('claw-4', noDrains, shared(), NOW), []);
	// Several shared tenants: every one, oldest declaration first.
	const two: HostingDoc = {
		nodes: {
			'claw-4': [
				slice({ tenant: 'pygmalion', since: ago(60_000) }),
				slice({ tenant: 'archivebot', since: ago(3_600_000) }),
			],
		},
	};
	assert.deepEqual(
		hostingsOn('claw-4', noDrains, two, NOW).map((h) => h.tenant),
		['archivebot', 'pygmalion']
	);
	// A maintenance drain is not hosting.
	const maint: DrainDoc = {
		nodes: { 'claw-4': { since: ago(1), reason: 'x', by: 't', kind: 'maintenance' } },
		planned: [],
	};
	assert.deepEqual(hostingsOn('claw-4', maint, { nodes: {} }, NOW), []);
});

test('hostingsOn carries a standby role, and a primary record stays without one', () => {
	assert.equal(
		hostingsOn('claw-9', noDrains, shared(slice({ role: 'standby' })), NOW)[0]?.role,
		'standby'
	);
	assert.ok(!('role' in (hostingsOn('claw-9', noDrains, shared(), NOW)[0] ?? {})));
	const whole: DrainDoc = {
		nodes: {
			'claw-8': {
				since: ago(1),
				reason: 'x',
				by: 't',
				kind: 'hosting',
				hosting: { tenant: 'pygmalion', memoryMb: 1024, cores: 1, port: 9002, role: 'standby' },
			},
		},
		planned: [],
	};
	assert.equal(hostingsOn('claw-8', whole, { nodes: {} }, NOW)[0]?.role, 'standby');
});

test('hold-back: the unused share once the agent is up, everything before it', () => {
	const settled = { declaredMb: 4096, since: ago(HOLD_FULL_MS + 1), nowMs: NOW };
	assert.equal(heldBackMb({ ...settled, sliceCurrentMb: 1200 }), 2896);
	assert.equal(heldBackMb({ ...settled, sliceCurrentMb: 5000 }), 0);
	// The agent's JVMs are not up yet (cardtable A4): hold back everything.
	assert.equal(heldBackMb({ ...settled, sliceCurrentMb: AGENT_UP_MIN_MB - 1 }), 4096);
	// Freshly declared: everything, whatever the slice holds.
	assert.equal(
		heldBackMb({ declaredMb: 4096, sliceCurrentMb: 3000, since: ago(60_000), nowMs: NOW }),
		4096
	);
	// Could not look: everything.
	assert.equal(heldBackMb({ ...settled, sliceCurrentMb: null }), 4096);
	assert.equal(heldBackMb({ ...settled, since: 'garbage', sliceCurrentMb: 3000 }), 4096);
});

// fleet-manager#83: archivebot idles at 164 MiB on claw-4 (measured 2026-11-11)
// and declares steadyMb 180. Under 256 it read as "not started" forever.
test('hold-back: a declared steadyMb below 256 is where the agent counts as up', () => {
	const settled = { declaredMb: 1024, since: ago(HOLD_FULL_MS + 1), nowMs: NOW };
	// Up at its steady mark: only the unused share is held.
	assert.equal(heldBackMb({ ...settled, steadyMb: 128, sliceCurrentMb: 164 }), 860);
	// Below its own steady mark it has not started: everything.
	assert.equal(heldBackMb({ ...settled, steadyMb: 180, sliceCurrentMb: 164 }), 1024);
	// A steady mark above 256 never raises the bar past it.
	assert.equal(heldBackMb({ ...settled, steadyMb: 600, sliceCurrentMb: 300 }), 724);
	// The grace window and could-not-look still hold everything.
	assert.equal(
		heldBackMb({ ...settled, steadyMb: 128, sliceCurrentMb: 164, since: ago(60_000) }),
		1024
	);
	assert.equal(heldBackMb({ ...settled, steadyMb: 128, sliceCurrentMb: null }), 1024);
});

test("each slice's usage rides another probe's ssh and comes off it cleanly", () => {
	const probe = sliceUsageProbe(['cardtable', 'archivebot']);
	assert.match(probe, /hosting\.slice\/hosting-cardtable\.slice\/memory\.current/);
	assert.match(probe, /hosting\.slice\/hosting-archivebot\.slice\/memory\.current/);
	const raw = `1200 15900\n4000 8000\n90000\nhosting-slice cardtable ${1300 * 1048576}\nhosting-slice archivebot -\n`;
	const { rest, sliceCurrentMb } = takeSliceUsage(raw);
	assert.equal(sliceCurrentMb.get('cardtable'), 1300);
	assert.equal(sliceCurrentMb.get('archivebot'), null);
	assert.equal(rest, '1200 15900\n4000 8000\n90000\n');
	assert.deepEqual(takeSliceUsage('a\nb\n'), { rest: 'a\nb\n', sliceCurrentMb: new Map() });
	assert.equal(takeSliceUsage(null).sliceCurrentMb.size, 0);
});

test('notice: a shared slice is owed it for a reboot or its end, not for CI coming off', () => {
	const soon = NOW + 60_000;
	const later = NOW + 20 * 60_000;
	const doc = shared();
	assert.match(
		noticeRefusal('claw-9', soon, noDrains, NOW, { hostingDoc: doc, kind: 'reboot' }) ?? '',
		/owed 15 min notice/
	);
	assert.ok(noticeRefusal('claw-9', soon, noDrains, NOW, { hostingDoc: doc, kind: 'end' }));
	assert.equal(
		noticeRefusal('claw-9', later, noDrains, NOW, { hostingDoc: doc, kind: 'reboot' }),
		null
	);
	assert.equal(
		noticeRefusal('claw-9', soon, noDrains, NOW, { hostingDoc: doc, kind: 'maintenance' }),
		null
	);
	// No shared doc passed: the old whole-box behaviour, unchanged.
	assert.equal(noticeRefusal('claw-9', soon, noDrains, NOW), null);
});

test('every CI unit ranks below the tenant: JIT, warm and the --ci-shaped test unit', () => {
	const oom = `--property=OOMScoreAdjust=${CI_OOM_SCORE_ADJ}`;
	assert.ok(ciUnitProperties({ memoryMaxMb: 100 }).includes(oom));
	const jit = buildSpawnPlan({
		unit: 'jit-claw-9-x-r1-1',
		slot: '/s',
		jitConfig: 'c',
		ttlSeconds: 60,
		memoryMaxMb: 100,
	} as Parameters<typeof buildSpawnPlan>[0]);
	assert.ok(jit.argv.includes(oom));
	assert.ok(
		buildWarmSpawnPlan({ unit: 'warm-x', slot: '/s', memoryMaxMb: 100 }).argv.includes(oom)
	);
});

/**
 * One dispatcher tick against claw-3 hosting a 4096 MiB cardtable slice whose
 * cgroup reads `sliceMb`, plus `beside` (a second tenant's slice, settled,
 * whose cgroup reads `besideMb`).
 */
async function tickFloor(
	sliceMb: number | null,
	declaredAgoMs: number,
	beside?: { rec: SharedHosting; mb: number | null }
): Promise<{ floor: number; cmds: string[] }> {
	const { dispatchEphemeral } = await import('../runners/ephemeral-tick.js');
	const { stateDir } = await import('../host.js');
	const file = join(stateDir(), 'fleet-hosting.json');
	writeHostingDoc({
		nodes: {
			'claw-3': [
				slice({ since: new Date(Date.now() - declaredAgoMs).toISOString() }),
				...(beside ? [beside.rec] : []),
			],
		},
	});
	try {
		const seen: { minFreeMb: number }[][] = [];
		const cmds: string[] = [];
		const sh = async (_n: string, cmd: string) => {
			cmds.push(cmd);
			if (!cmd.includes('$7, $2')) return '9000';
			const line = (t: string, mb: number | null) =>
				`hosting-slice ${t} ${mb === null ? '-' : mb * 1048576}\n`;
			return (
				`9000 16000\n4000 8000\n90000\n${line('cardtable', sliceMb)}` +
				(beside ? line(beside.rec.tenant, beside.mb) : '')
			);
		};
		await dispatchEphemeral(
			{
				fleetProbe: new Map([['claw-3', { reachable: true, busyRepos: new Map() }]]),
				ephemeral: new Set(['claw-3']),
				nodes: { 'claw-3': { labels: ['hadoku-builder'], maxConcurrent: 3, minFreeMb: 1536 } },
				isSick: () => false,
				repos: ['WolffM/hadoku_site'],
				standingEligible: new Set(),
			} as never,
			'tok',
			{} as never,
			sh as never,
			(async (i: { nodes: { minFreeMb: number }[] }) => {
				seen.push(i.nodes);
				return { minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: 0 };
			}) as never
		);
		assert.equal(seen.length, 1, 'the tick must actually run');
		return { floor: seen[0][0].minFreeMb, cmds };
	} finally {
		rmSync(file, { force: true });
	}
}

// cardtable A4: "no new CI job admitted into the declared share at any point,
// including before our JVMs start". The floor is the node's own 1536 MiB plus
// the part of the 4096 MiB slice the tenant is not yet using.
test('A4: the dispatcher holds back the unused share, read on the same ssh as free memory', async () => {
	const settled = HOLD_FULL_MS + 60_000;
	const { floor, cmds } = await tickFloor(1200, settled);
	assert.ok(cmds.some((c) => c.includes('hosting-cardtable.slice/memory.current')));
	assert.equal(floor, 1536 + 4096 - 1200);
	// The same reading is recorded for the learned hold-back's shadow (hosting-usage.ts).
	const { readHostingUsage } = await import('../runners/hosting-usage.js');
	const { stateDir } = await import('../host.js');
	const hours = Object.values(readHostingUsage(stateDir())?.slices['claw-3/cardtable'] ?? {});
	assert.ok(
		hours.some((b) => b[3] === 1200),
		'the tick recorded the slice reading'
	);
	// Empty: the agent's JVMs are not up, so all of it is held.
	assert.equal((await tickFloor(0, settled)).floor, 1536 + 4096);
	// Half full.
	assert.equal((await tickFloor(2048, settled)).floor, 1536 + 2048);
	// Full: the tenant's own pages already left the node's free memory; nothing more to hold.
	assert.equal((await tickFloor(4096, settled)).floor, 1536);
	// Before the JVMs start: a fresh declaration holds everything, whatever the cgroup reads.
	assert.equal((await tickFloor(3000, 60_000)).floor, 1536 + 4096);
	// Could not read the slice: everything.
	assert.equal((await tickFloor(null, settled)).floor, 1536 + 4096);
});

// fleet-manager#32: claw-4 holds archivebot and pygmalion. The floor holds back
// what EACH slice is not yet using; one record per node held back only one.
test('two slices on one node: the dispatcher holds back the unused share of each', async () => {
	const settled = HOLD_FULL_MS + 60_000;
	const archivebot = slice({
		tenant: 'archivebot',
		memoryMb: 1024,
		since: new Date(Date.now() - settled).toISOString(),
	});
	const { floor, cmds } = await tickFloor(1200, settled, { rec: archivebot, mb: 300 });
	assert.ok(cmds.some((c) => c.includes('hosting-archivebot.slice/memory.current')));
	// archivebot at 300 MiB is past AGENT_UP_MIN_MB, so only its unused 724 is held.
	assert.equal(floor, 1536 + (4096 - 1200) + (1024 - 300));
	// fleet-manager#83: idle at 164 MiB with steadyMb 128 is up, so only 860 is held.
	const steady = { ...archivebot, steadyMb: 128 };
	assert.equal(
		(await tickFloor(1200, settled, { rec: steady, mb: 164 })).floor,
		1536 + (4096 - 1200) + (1024 - 164)
	);
	// Without a steady mark, 164 is under 256: all of it is held.
	assert.equal(
		(await tickFloor(1200, settled, { rec: archivebot, mb: 164 })).floor,
		1536 + (4096 - 1200) + 1024
	);
	// Its slice unreadable: all of it is held, and cardtable's figure is unchanged.
	assert.equal(
		(await tickFloor(1200, settled, { rec: archivebot, mb: null })).floor,
		1536 + (4096 - 1200) + 1024
	);
});

// cardtable's lane D drains its matches off a node from `notices` (asks a and b,
// 2026-10-27): every scheduled drain, whatever its kind, is visible from the
// moment it is scheduled, and so is its end.
test('lane D: a planned drain of ANY kind is a notice the moment it is scheduled', () => {
	for (const kind of ['maintenance', 'reboot', 'hosting', 'lease'] as const) {
		const doc: DrainDoc = {
			nodes: {},
			planned: [
				{
					node: 'claw-9',
					from: ahead(40 * 60_000),
					until: ahead(100 * 60_000),
					since: ago(1),
					reason: 'r',
					by: 't',
					kind,
				},
			],
		};
		const n = drainNotices(doc, NOW);
		assert.deepEqual(
			n.map((x) => [x.node, x.event, x.kind]),
			[
				['claw-9', 'starts', kind],
				['claw-9', 'ends', kind],
			]
		);
	}
	// A drain already in force with an end ahead shows that end.
	const held: DrainDoc = {
		nodes: {
			'claw-9': { since: ago(1), until: ahead(60_000), reason: 'r', by: 't', kind: 'maintenance' },
		},
		planned: [],
	};
	assert.equal(drainNotices(held, NOW)[0].event, 'ends');
});

// fleet-manager#16: the placement record's app half.
test('the epoch only goes up: past the counter, past every record, and across a removal', () => {
	const first = issueEpoch({ nodes: {} }, 'watchparty');
	assert.equal(first.epoch, 1);
	// A record carrying a higher token than the counter (a hand edit) is never repeated.
	const past = issueEpoch(first.doc, 'watchparty', [7]);
	assert.equal(past.epoch, 8);
	// The slice is removed; the counter is not.
	const removed = withoutSlice(
		withSlice(past.doc, 'claw-6', slice({ tenant: 'watchparty', epoch: 8 })),
		'claw-6',
		'watchparty'
	);
	assert.equal(removed.nodes['claw-6'], undefined);
	assert.equal(issueEpoch(removed, 'watchparty').epoch, 9);
	// Another app keeps its own count.
	assert.equal(issueEpoch(removed, 'archivebot').epoch, 1);
});

test('the app half survives every slice edit and a write and read back', () => {
	const dir = mkdtempSync(join(tmpdir(), 'hosting-apps-'));
	try {
		let doc = issueEpoch({ nodes: {} }, 'watchparty').doc;
		doc = withSlice(doc, 'claw-6', slice({ tenant: 'watchparty', epoch: 1 }));
		doc = withSlice(doc, 'claw-6', slice({ tenant: 'archivebot', port: 3004 }));
		doc = withoutSlice(doc, 'claw-6', 'archivebot');
		writeHostingDoc(doc, dir);
		const back = readHostingDoc(dir);
		assert.equal(back.apps?.watchparty.epoch, 1);
		assert.equal(back.nodes['claw-6'][0].epoch, 1);
		assert.equal(hostingsOn('claw-6', noDrains, back, NOW)[0].epoch, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a file without an app half reads exactly as before; a broken one THROWS', () => {
	assert.deepEqual(parseHostingDoc(JSON.stringify({ nodes: {} })), { nodes: {} });
	assert.throws(
		() => parseHostingDoc(JSON.stringify({ nodes: {}, apps: { watchparty: {} } })),
		/watchparty has no whole-number epoch/
	);
	assert.throws(
		() => parseHostingDoc(JSON.stringify({ nodes: {}, apps: { watchparty: { epoch: -1 } } })),
		/whole-number epoch/
	);
	assert.throws(
		() =>
			parseHostingDoc(
				JSON.stringify({ nodes: {}, apps: { watchparty: { epoch: 2, move: { from: 'claw-6' } } } })
			),
		/move has no from, to and epoch/
	);
});

test('a move opens with its epoch and closes into lastMove; the epoch is never given back', () => {
	const issued = issueEpoch({ nodes: {}, apps: { watchparty: { epoch: 3 } } }, 'watchparty');
	const move = {
		from: 'claw-6',
		to: 'claw-4',
		epoch: issued.epoch,
		openedAt: ago(60_000),
		by: 't',
	};
	const open = withMoveOpen(issued.doc, 'watchparty', move);
	assert.deepEqual(open.apps?.watchparty, { epoch: 4, move });
	const aborted = withMoveClosed(open, 'watchparty', 'aborted', ago(0));
	assert.equal(aborted.apps?.watchparty.move, undefined);
	assert.deepEqual(aborted.apps?.watchparty.lastMove, {
		...move,
		closedAt: ago(0),
		outcome: 'aborted',
	});
	assert.equal(aborted.apps?.watchparty.epoch, 4);
	// Closing with nothing open changes nothing.
	assert.equal(withMoveClosed(aborted, 'watchparty', 'committed', ago(0)), aborted);
});

test('a removed slice is kept for a day, then dropped on the next write', () => {
	const old = { node: 'claw-5', removedAt: ago(ENDED_KEEP_MS + 1), epoch: 1 };
	let doc = withEnded({ nodes: {} }, 'cardtable', old, NOW - ENDED_KEEP_MS);
	assert.deepEqual(doc.apps?.cardtable, { epoch: 0, ended: [old] });
	doc = withEnded(doc, 'cardtable', { node: 'claw-9', until: ago(1), removedAt: ago(0) }, NOW);
	assert.deepEqual(
		doc.apps?.cardtable.ended?.map((e) => e.node),
		['claw-9']
	);
});

test('a SHRINK never lapses: it stays reserved at full size past its end, and its notice says the size it goes to', () => {
	const now = Date.parse('2026-11-04T20:00:00Z');
	const rec = (until: string, shrinkTo?: { memoryMb: number; cores: number }) => ({
		tenant: 'cardtable',
		memoryMb: 12288,
		cores: 12,
		port: 7621,
		since: '2026-11-04T10:00:00Z',
		by: 't',
		reason: 'r',
		until,
		...(shrinkTo ? { shrinkTo } : {}),
	});
	const shrink = {
		nodes: { 'claw-8': [rec('2026-11-04T19:00:00Z', { memoryMb: 4096, cores: 4 })] },
	};
	const end = { nodes: { 'claw-8': [rec('2026-11-04T19:00:00Z')] } };
	assert.equal(effectiveSlices(shrink, now)['claw-8']?.[0]?.memoryMb, 12288);
	assert.equal(effectiveSlices(end, now)['claw-8'], undefined, 'a plain end lapses');
	const drain: DrainDoc = { nodes: {}, planned: [] };
	assert.deepEqual(hostingsOn('claw-8', drain, shrink, now)[0]?.shrinkTo, {
		memoryMb: 4096,
		cores: 4,
	});
	const ahead = {
		nodes: { 'claw-8': [rec('2026-11-04T21:00:00Z', { memoryMb: 4096, cores: 4 })] },
	};
	assert.deepEqual(hostingNotices(ahead, now)[0]?.shrinkTo, { memoryMb: 4096, cores: 4 });
	assert.throws(
		() =>
			parseHostingDoc(
				JSON.stringify({ nodes: { 'claw-8': [{ ...rec('x'), shrinkTo: { memoryMb: 1 } }] } })
			),
		/shrinkTo has no memoryMb or cores/
	);
});

void test('lapsed is built on endingSlice: a shrink never lapses, an unparseable end is not lapsed, a passed end is', () => {
	const now = Date.now();
	const past = new Date(now - 3_600_000).toISOString();
	const future = new Date(now + 3_600_000).toISOString();
	const shrink = { memoryMb: 2048, cores: 2 };
	assert.equal(endingSlice({}), false);
	assert.equal(endingSlice({ until: null }), false);
	assert.equal(endingSlice({ until: future }), true);
	assert.equal(endingSlice({ until: future, shrinkTo: shrink }), false);
	assert.equal(lapsed({ until: past }, now), true);
	assert.equal(lapsed({ until: future }, now), false);
	assert.equal(lapsed({ until: past, shrinkTo: shrink }, now), false);
	assert.equal(lapsed({ until: 'not a date' }, now), false);
});
