/**
 * The pure judgement, and the per-tick registry seam — `runner-health.test.ts`
 * covers the alerting (`checkDiskWatch`) against this registry; this file
 * covers the registry and `judgeWorkDisk` on their own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	DISK_WATCH_ADVISORY_FREE_GB,
	DISK_WATCH_PAGE_FREE_GB,
	TMP_WATCH_ADVISORY_MARGIN_MB,
	TMP_WATCH_PAGE_MARGIN_MB,
	judgeTmpDisk,
	judgeWorkDisk,
	tmpAdvisoryLineMb,
	tmpIsSmall,
	worseDiskLevel,
	recordDiskReadings,
	diskReadingsForReport,
	__resetDiskReadingsForTesting,
	__setDiskReadingsForTesting,
} from '../runners/disk-watch.js';
import { dispatchEphemeral } from '../runners/ephemeral-tick.js';
import type { EphemeralTickInput } from '../runners/ephemeral-shared.js';

test('judgeTmpDisk: lines sit above the 2048MB mint floor — hokon at 1718MB on 2026-10-21 pages; 12GB is ok', () => {
	assert.equal(judgeTmpDisk(1718).level, 'page', 'already under the floor: refusing');
	assert.equal(
		judgeTmpDisk(2048 + TMP_WATCH_PAGE_MARGIN_MB - 1).level,
		'page',
		'half a floor of runway'
	);
	assert.equal(judgeTmpDisk(2048 + TMP_WATCH_PAGE_MARGIN_MB).level, 'advisory');
	assert.equal(
		judgeTmpDisk(2048 + TMP_WATCH_ADVISORY_MARGIN_MB - 1).level,
		'advisory',
		'one floor of runway'
	);
	assert.equal(judgeTmpDisk(2048 + TMP_WATCH_ADVISORY_MARGIN_MB).level, 'ok');
	assert.deepEqual(judgeTmpDisk(12_506), { level: 'ok', freeGb: 12.2 });
	assert.deepEqual(judgeTmpDisk(null), { level: 'unreadable', freeGb: null });
});

test("judgeTmpDisk #132: an 8GB claw's 3994MB tmpfs is judged by what it can hold — empty is ok, filling still pages", () => {
	// claw-2/claw-6 on 2026-10-21: ~5MB and ~100MB used, advisory every hour.
	assert.equal(judgeTmpDisk(3900, 3994).level, 'ok', 'nearly empty is not an advisory');
	assert.equal(
		judgeTmpDisk(3900).level,
		'advisory',
		'without the size, the old absolute line stands'
	);
	assert.equal(tmpAdvisoryLineMb(3994), 2048 + 973, 'half the room above the floor');
	assert.equal(judgeTmpDisk(2048 + 973, 3994).level, 'ok');
	assert.equal(judgeTmpDisk(2048 + 972, 3994).level, 'advisory', '~1GB actually consumed');
	assert.equal(judgeTmpDisk(2300, 3994).level, 'page', 'the page line does not move');
	assert.equal(judgeTmpDisk(2048 + TMP_WATCH_PAGE_MARGIN_MB - 1, 3994).level, 'page');
	assert.equal(tmpIsSmall(3994), true);
	assert.equal(tmpIsSmall(null), false, 'unknown size is not small');
});

test("judgeTmpDisk #132: hokon's 10GB tmpfs keeps the full floor of runway", () => {
	assert.equal(tmpAdvisoryLineMb(10_240), 2048 + TMP_WATCH_ADVISORY_MARGIN_MB);
	assert.equal(judgeTmpDisk(4000, 10_240).level, 'advisory');
	assert.equal(judgeTmpDisk(4096, 10_240).level, 'ok');
	assert.equal(tmpIsSmall(10_240), false);
});

test('worseDiskLevel: page > unreadable > advisory > ok, whichever filesystem it came from', () => {
	assert.equal(worseDiskLevel('ok', 'advisory'), 'advisory');
	assert.equal(worseDiskLevel('advisory', 'ok'), 'advisory');
	assert.equal(worseDiskLevel('ok', 'page'), 'page');
	assert.equal(worseDiskLevel('unreadable', 'advisory'), 'unreadable');
	assert.equal(worseDiskLevel('unreadable', 'page'), 'page');
	assert.equal(worseDiskLevel('ok', 'ok'), 'ok');
});

test('judgeWorkDisk: well above the advisory line is ok', () => {
	const v = judgeWorkDisk((DISK_WATCH_ADVISORY_FREE_GB + 50) * 1024);
	assert.equal(v.level, 'ok');
	assert.equal(v.freeGb, DISK_WATCH_ADVISORY_FREE_GB + 50);
});

test('judgeWorkDisk: just under the advisory line is advisory, not page', () => {
	const v = judgeWorkDisk((DISK_WATCH_ADVISORY_FREE_GB - 1) * 1024);
	assert.equal(v.level, 'advisory');
});

test('judgeWorkDisk: exactly on the advisory line is still ok — the line is a floor, crossed strictly under', () => {
	const v = judgeWorkDisk(DISK_WATCH_ADVISORY_FREE_GB * 1024);
	assert.equal(v.level, 'ok');
});

test('judgeWorkDisk: just under the page line is page', () => {
	const v = judgeWorkDisk((DISK_WATCH_PAGE_FREE_GB - 1) * 1024);
	assert.equal(v.level, 'page');
});

test('judgeWorkDisk: exactly on the page line is advisory, not page', () => {
	const v = judgeWorkDisk(DISK_WATCH_PAGE_FREE_GB * 1024);
	assert.equal(v.level, 'advisory');
});

test('judgeWorkDisk: null is unreadable, never "ok" and never "page" — its own level', () => {
	const v = judgeWorkDisk(null);
	assert.equal(v.level, 'unreadable');
	assert.equal(v.freeGb, null);
});

test('judgeWorkDisk: zero free is page, not a crash', () => {
	assert.equal(judgeWorkDisk(0).level, 'page');
});

test('the registry is empty until recordDiskReadings is called — "never looked yet", not "every node is fine"', () => {
	__resetDiskReadingsForTesting();
	assert.equal(diskReadingsForReport().size, 0);
});

test('recordDiskReadings pairs tmpFreeMb/workFreeMb by node, defaulting a missing workFreeMb entry to null', () => {
	__resetDiskReadingsForTesting();
	recordDiskReadings(
		new Map([
			['claw-1', 50_000],
			['claw-2', null],
		]),
		new Map([['claw-1', 30_000]]),
		// claw-2 absent from the work and size maps entirely — a caller that forgot to set it.
		new Map([['claw-1', 64_000]])
	);
	const out = diskReadingsForReport();
	assert.deepEqual(out.get('claw-1'), { tmpFreeMb: 50_000, tmpSizeMb: 64_000, workFreeMb: 30_000 });
	assert.deepEqual(out.get('claw-2'), { tmpFreeMb: null, tmpSizeMb: null, workFreeMb: null });
	assert.equal(out.size, 2);
});

test('recordDiskReadings REPLACES wholesale — a node missing from the new call disappears, not merges', () => {
	__resetDiskReadingsForTesting();
	recordDiskReadings(new Map([['claw-1', 1000]]), new Map([['claw-1', 1000]]));
	assert.equal(diskReadingsForReport().has('claw-1'), true);
	recordDiskReadings(new Map([['claw-2', 1000]]), new Map([['claw-2', 1000]]));
	const out = diskReadingsForReport();
	assert.equal(out.has('claw-1'), false, 'claw-1 dropped out of this tick’s ephemeral set');
	assert.equal(out.has('claw-2'), true);
});

test('diskReadingsForReport hands out a copy — mutating it never reaches the registry', () => {
	__resetDiskReadingsForTesting();
	recordDiskReadings(new Map([['claw-1', 1000]]), new Map([['claw-1', 1000]]));
	const out = diskReadingsForReport() as Map<
		string,
		{ tmpFreeMb: number | null; workFreeMb: number | null }
	>;
	out.delete('claw-1');
	assert.equal(diskReadingsForReport().has('claw-1'), true);
});

test('__setDiskReadingsForTesting injects the snapshot directly, bypassing recordDiskReadings', () => {
	__resetDiskReadingsForTesting();
	__setDiskReadingsForTesting(new Map([['claw-6', { tmpFreeMb: 500, workFreeMb: 500 }]]));
	assert.deepEqual(diskReadingsForReport().get('claw-6'), { tmpFreeMb: 500, workFreeMb: 500 });
});

// ── the production seam: ephemeral-tick.ts's real dispatchEphemeral pass ────
//
// Everything above drives the registry through its own test seams. This is
// the ONE test that drives the REAL `dispatchEphemeral` — the function
// `ephemeral-tick.ts` actually runs every 15s — end to end through a fake
// `sh`/`gh`/`run`, and asserts the registry this file owns comes out holding
// what that pass measured. It is the thing that fails if the one-line
// `recordDiskReadings(tmpFreeMbByNode, workFreeMbByNode);` hunk in
// `ephemeral-tick.ts` is ever removed — every other test in this file and in
// `runner-health.test.ts` would stay green regardless, because they inject the
// reading directly rather than through the real producer.
test('dispatchEphemeral (the real production tick) reaches this registry, not just the test seam', async () => {
	__resetDiskReadingsForTesting();

	const input: EphemeralTickInput = {
		fleetProbe: new Map([['claw-x', { reachable: true, busyRepos: new Map() }]]),
		ephemeral: new Set(['claw-x']),
		nodes: { 'claw-x': {} },
		isSick: () => false,
		repos: [],
	};
	// `free -m`'s `$7 $2` shape (8,000 MB available of 16,000 installed),
	// immediately followed by the `df -Pm` tail's two lines — `/tmp` (free,
	// then size) then `_work` — exactly the 3-non-empty-line shape `parseSpaceProbe` requires.
	const sh = async (_node: string, cmd: string): Promise<string | null> =>
		cmd.includes('free -m') ? '8000 16000\n12345 16000\n54321\n' : null;
	// `dispatchWarmCache` runs first and is NEVER allowed to throw past its own
	// try/catch in `dispatchEphemeral` — a minimal, mostly-empty `gh` is enough;
	// what this test cares about happens after it, unconditionally.
	const gh = {
		write: async () => ({ ok: true, status: 200 }),
		get: async () => ({ total_count: 0, runners: [] }),
	};
	// The real `runDispatchTick` needs a full queued-run/placement simulation
	// this test has no reason to build — injected away, same seam
	// `dispatchEphemeral`'s own `run` parameter exists for.
	const run = async () => ({ minted: 0, failed: 0, skipped: 0, inFlight: 0, reaped: 0 });

	await dispatchEphemeral(
		input,
		'tok',
		gh as unknown as Parameters<typeof dispatchEphemeral>[2],
		sh,
		run,
		new Map(),
		Date.now()
	);

	assert.deepEqual(diskReadingsForReport().get('claw-x'), {
		tmpFreeMb: 12345,
		tmpSizeMb: 16000,
		workFreeMb: 54321,
	});
});
