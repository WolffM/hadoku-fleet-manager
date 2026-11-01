/**
 * floor-probe's §7 quiet-window predicate — split out of
 * `floor-probe.test.mjs` (wave 5q lane A, whole-block split) so that file
 * reaches the 1,000-line test ceiling. These exercise
 * `floor-probe-window.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { dailyCronMinutes, quietWindow } from './floor-probe-window.mjs';

// ---------------------------------------------------------------------------
// §7 — the quiet window
// ---------------------------------------------------------------------------

/** The 11 staggered daily crons, hour 06 UTC, minutes 3..53 (board P6.6). */
const FLEET_SCHEDULES = Array.from({ length: 11 }, (_, i) => ({
	name: `repo-${i}`,
	minutesOfDay: 6 * 60 + 3 + i * 5,
}));

test('the fan-out band is not quiet, at fleet size', () => {
	// Every one of the 11 firings must close the window for the following 15
	// minutes, so the whole 06:03-06:53 band plus its tail is refused.
	for (let m = 6 * 60 + 3; m <= 6 * 60 + 53 + 14; m++) {
		const r = quietWindow({ nowMinutesOfDay: m, schedules: FLEET_SCHEDULES });
		assert.equal(r.quiet, false, `minute-of-day ${m} should not be quiet`);
		assert.equal(r.why, 'cron');
	}
});

test('the rest of the day is quiet — the cap is what bounds cost, not the window', () => {
	for (const m of [0, 5 * 60, 6 * 60 + 2, 7 * 60 + 8, 13 * 60, 23 * 60 + 59]) {
		assert.equal(
			quietWindow({ nowMinutesOfDay: m, schedules: FLEET_SCHEDULES }).quiet,
			true,
			`${m}`
		);
	}
});

test('a reserved hokon closes the window', () => {
	const r = quietWindow({
		nowMinutesOfDay: 13 * 60,
		reserved: true,
		reservationReason: 'cron-running',
		schedules: FLEET_SCHEDULES,
	});
	assert.equal(r.quiet, false);
	assert.equal(r.why, 'reserved');
});

test('no readable schedules is "could not tell", NEVER a quiet window', () => {
	// Eleven repos are known to carry daily crons, so zero schedules means the
	// reader failed. Probing on that basis is "I could not look" rendering as
	// "nothing is wrong" — the failure CLAUDE.md names first.
	const r = quietWindow({ nowMinutesOfDay: 13 * 60, schedules: [] });
	assert.equal(r.quiet, false);
	assert.equal(r.why, 'could-not-tell');
});

test('the cron parser refuses everything it does not fully understand', () => {
	assert.equal(dailyCronMinutes('3 6 * * *'), 6 * 60 + 3);
	assert.equal(dailyCronMinutes('0 6 * * SUN'), null, 'weekly would block the wrong day');
	assert.equal(dailyCronMinutes('*/10 * * * *'), null, 'a step field would block forever');
	assert.equal(dailyCronMinutes('0,30 6 * * *'), null);
	assert.equal(dailyCronMinutes('nonsense'), null);
	assert.equal(dailyCronMinutes(undefined), null);
});
