/**
 * The warm cache of one — `fleetServedJobs` (every job in the fleet off the
 * shared job-history store) and `parseSpaceProbe` (the #101/#132 `df -Pm`
 * line parser). Split out of warm-cache.test.ts (wave 5p lane C) — see
 * `helpers/warm-cache-rig.ts` for the shared `tmp`/`histAt`/`writeRecord`
 * job-history fixture, `idleSlot`/`SITE`, and the file-wide
 * `beforeEach`/`afterEach` every split file installs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { __setHistoryPathForTesting, __resetJobHistoryForTesting } from '../job-history-store.js';
import { parseSpaceProbe } from '../runners/ephemeral-shared.js';
import { planWarmFleet } from '../runners/ephemeral-warm.js';
import { fleetServedJobs } from '../runners/dispatch-warm-cache.js';
import {
	SITE,
	histAt,
	idleSlot,
	installWarmCacheRig,
	tmp,
	writeRecord,
} from './helpers/warm-cache-rig.js';

installWarmCacheRig();

// --- fleetServedJobs ---------------------------------------------------------

test('fleetServedJobs: every job in the fleet, whichever runner served it', () => {
	// The joint allocation values a repo by the FLEET's demand: a warm listener
	// takes its repo's next job wherever GitHub would otherwise have sent it, so
	// hokon's jobs and an ineligible node's jobs are demand too.
	writeRecord({ runner: 'claw-1', repo: 'WolffM/hadoku_site', startedAt: histAt(0) });
	writeRecord({ runner: 'hokon', repo: 'WolffM/hadoku-rally', startedAt: histAt(60) });
	writeRecord({
		runner: 'jit-claw-2-hadoku-site-j1-r1-1700000000',
		repo: 'WolffM/hadoku_site',
		startedAt: histAt(120),
	});
	// writeRecord's default durationSec is 60: the duration rides along, because
	// it is what tells overlapping jobs from serial ones (warmUnitValues).
	assert.deepEqual(fleetServedJobs(), [
		{ repo: 'WolffM/hadoku_site', startedAtMs: Date.parse(histAt(0)), durationMs: 60_000 },
		{ repo: 'WolffM/hadoku-rally', startedAtMs: Date.parse(histAt(60)), durationMs: 60_000 },
		{ repo: 'WolffM/hadoku_site', startedAtMs: Date.parse(histAt(120)), durationMs: 60_000 },
	]);
});

test('fleetServedJobs: a missing history is empty, not a throw — and empty holds every slot', () => {
	__setHistoryPathForTesting(join(tmp, 'does-not-exist-either', 'job-history.jsonl'));
	__resetJobHistoryForTesting();
	const served = fleetServedJobs();
	assert.deepEqual(served, []);
	assert.deepEqual(
		planWarmFleet({
			nodes: [{ node: 'claw-1', current: idleSlot(SITE) }],
			served,
			nowMs: Date.now(),
		}).get('claw-1'),
		{ action: 'idle' }
	);
});

// --- parseSpaceProbe ----------------------------------------------------------
//
// #101 lane A5: `shellOnNode`'s real stdout (`execFile`'s `stdout`) ends in a
// trailing newline. The prior parser split on `\n` and read the LAST TWO
// elements of that array, so on a trailing newline it read [tmp, work, '']
// and shifted — tmp became WORK's figure, work became "unreadable". Every
// case below uses REALISTIC strings (with the newline real output has)
// rather than the no-trailing-newline shape every other fixture in this
// suite used to answer with.

test('parseSpaceProbe: the exact claw-4 capture (#101) reads tmp and work correctly', () => {
	const out = '12111 15936\n4824\n826946\n';
	const r = parseSpaceProbe(out);
	assert.equal(r.first, '12111 15936');
	assert.equal(r.tmpFreeMb, 4824);
	assert.equal(r.workFreeMb, 826946);
});

test('parseSpaceProbe #132: the /tmp line carries free THEN size; free alone reads a null size', () => {
	const r = parseSpaceProbe('12111 15936\n3900 3994\n826946\n');
	assert.equal(r.tmpFreeMb, 3900);
	assert.equal(r.tmpSizeMb, 3994);
	assert.equal(r.workFreeMb, 826946);
	assert.equal(parseSpaceProbe('12111 15936\n4824\n826946\n').tmpSizeMb, null);
	const bad = parseSpaceProbe('12111 15936\n3900 -1\n826946\n');
	assert.equal(bad.tmpFreeMb, null, 'a malformed size makes the whole line unreadable');
	assert.equal(bad.tmpSizeMb, null);
});

test('parseSpaceProbe: the warm-tick shape (single-column first line), trailing newline', () => {
	const r = parseSpaceProbe('15936\n4824\n826946\n');
	assert.equal(r.first, '15936');
	assert.equal(r.tmpFreeMb, 4824);
	assert.equal(r.workFreeMb, 826946);
});

test('parseSpaceProbe: same shape with NO trailing newline still reads correctly', () => {
	const r = parseSpaceProbe('12111 15936\n4824\n826946');
	assert.equal(r.first, '12111 15936');
	assert.equal(r.tmpFreeMb, 4824);
	assert.equal(r.workFreeMb, 826946);
});

test('parseSpaceProbe: CRLF line endings are stripped, not read as part of the figure', () => {
	const r = parseSpaceProbe('12111 15936\r\n4824\r\n826946\r\n');
	assert.equal(r.first, '12111 15936');
	assert.equal(r.tmpFreeMb, 4824);
	assert.equal(r.workFreeMb, 826946);
});

test('parseSpaceProbe: a blank line in the middle is dropped, not counted', () => {
	const r = parseSpaceProbe('12111 15936\n\n4824\n826946\n');
	assert.equal(r.first, '12111 15936');
	assert.equal(r.tmpFreeMb, 4824);
	assert.equal(r.workFreeMb, 826946);
});

test('parseSpaceProbe: only the first line present — both unreadable, never shifted', () => {
	const r = parseSpaceProbe('12111 15936\n');
	assert.equal(r.first, '12111 15936');
	assert.equal(r.tmpFreeMb, null);
	assert.equal(r.workFreeMb, null);
});

test('parseSpaceProbe: two lines (missing the jit figure) — both unreadable, not read as tmp+work', () => {
	const r = parseSpaceProbe('12111 15936\n4824\n');
	assert.equal(r.first, '12111 15936');
	assert.equal(r.tmpFreeMb, null);
	assert.equal(r.workFreeMb, null);
});

test('parseSpaceProbe: four lines (an extra one) — both unreadable, a shifted line is never read as the other', () => {
	const r = parseSpaceProbe('12111 15936\n4824\n826946\nextra\n');
	assert.equal(r.first, '12111 15936');
	assert.equal(r.tmpFreeMb, null);
	assert.equal(r.workFreeMb, null);
});

test('parseSpaceProbe: garbage on the tmp line — tmp unreadable, work still read (line count is right)', () => {
	const r = parseSpaceProbe('12111 15936\ndf: /tmp: No such file or directory\n826946\n');
	assert.equal(r.first, '12111 15936');
	assert.equal(r.tmpFreeMb, null);
	assert.equal(r.workFreeMb, 826946);
});

test('parseSpaceProbe: null input — unreachable, both unreadable, first is empty', () => {
	const r = parseSpaceProbe(null);
	assert.equal(r.first, '');
	assert.equal(r.tmpFreeMb, null);
	assert.equal(r.workFreeMb, null);
});

test('parseSpaceProbe: empty string input — both unreadable, first is empty', () => {
	const r = parseSpaceProbe('');
	assert.equal(r.first, '');
	assert.equal(r.tmpFreeMb, null);
	assert.equal(r.workFreeMb, null);
});
