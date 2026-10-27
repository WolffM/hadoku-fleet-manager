import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSpawnPlan, buildWarmSpawnPlan, ciUnitProperties } from '../runners/ephemeral.js';
import { drainNotices, noticeRefusal, type DrainDoc } from '../runners/drain.js';
import {
	AGENT_UP_MIN_MB,
	CI_OOM_SCORE_ADJ,
	HOLD_FULL_MS,
	effectiveHosting,
	heldBackMb,
	hostingOn,
	parseHostingDoc,
	readHostingDoc,
	sliceUsageProbe,
	takeSliceUsage,
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
const shared = (rec: SharedHosting = slice()): HostingDoc => ({ nodes: { 'claw-9': rec } });
const noDrains: DrainDoc = { nodes: {}, planned: [] };

test('an unreadable record THROWS: what a tenant was promised is never read as nothing', () => {
	assert.deepEqual(parseHostingDoc(''), { nodes: {} });
	assert.throws(() => parseHostingDoc('{ not json'));
	assert.throws(() => parseHostingDoc('{"nodes":{"claw-9":{"tenant":"cardtable"}}}'), /claw-9/);
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
	assert.deepEqual(Object.keys(effectiveHosting(shared(slice({ until: ago(1) })), NOW)), []);
	assert.deepEqual(Object.keys(effectiveHosting(shared(slice({ until: ahead(60_000) })), NOW)), [
		'claw-9',
	]);
	assert.deepEqual(Object.keys(effectiveHosting(shared(slice({ until: 'soon' })), NOW)), [
		'claw-9',
	]);
});

test('hostingOn answers for both kinds, whole from the drain and shared from its own file', () => {
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
	assert.equal(hostingOn('claw-8', whole, { nodes: {} }, NOW)?.mode, 'whole');
	assert.equal(hostingOn('claw-9', noDrains, shared(), NOW)?.mode, 'shared');
	assert.equal(hostingOn('claw-4', noDrains, shared(), NOW), null);
	// A maintenance drain is not hosting.
	const maint: DrainDoc = {
		nodes: { 'claw-4': { since: ago(1), reason: 'x', by: 't', kind: 'maintenance' } },
		planned: [],
	};
	assert.equal(hostingOn('claw-4', maint, { nodes: {} }, NOW), null);
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

test("the slice's usage rides another probe's ssh and comes off it cleanly", () => {
	assert.match(
		sliceUsageProbe('cardtable'),
		/hosting\.slice\/hosting-cardtable\.slice\/memory\.current/
	);
	const raw = `1200 15900\n4000 8000\n90000\nhosting-slice ${1300 * 1048576}\n`;
	const { rest, sliceCurrentMb } = takeSliceUsage(raw);
	assert.equal(sliceCurrentMb, 1300);
	assert.equal(rest, '1200 15900\n4000 8000\n90000\n');
	assert.equal(takeSliceUsage('a\nhosting-slice -\n').sliceCurrentMb, null);
	assert.deepEqual(takeSliceUsage('a\nb\n'), { rest: 'a\nb\n', sliceCurrentMb: null });
	assert.equal(takeSliceUsage(null).sliceCurrentMb, null);
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

/** One dispatcher tick against claw-3 hosting a 4096 MiB slice whose cgroup reads `sliceMb`. */
async function tickFloor(
	sliceMb: number | null,
	declaredAgoMs: number
): Promise<{ floor: number; cmds: string[] }> {
	const { dispatchEphemeral } = await import('../runners/ephemeral-tick.js');
	const { stateDir } = await import('../host.js');
	const file = join(stateDir(), 'fleet-hosting.json');
	writeHostingDoc({
		nodes: { 'claw-3': slice({ since: new Date(Date.now() - declaredAgoMs).toISOString() }) },
	});
	try {
		const seen: { minFreeMb: number }[][] = [];
		const cmds: string[] = [];
		const sh = async (_n: string, cmd: string) => {
			cmds.push(cmd);
			if (!cmd.includes('$7, $2')) return '9000';
			return `9000 16000\n4000 8000\n90000\nhosting-slice ${sliceMb === null ? '-' : sliceMb * 1048576}\n`;
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
