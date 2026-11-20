/**
 * Every backstop outcome leaves a line, and a reservation names its holder.
 *
 * 2026-11-19: hokon stayed out of CI through two ticks while a job waited 40
 * minutes, and the log held nothing for either tick. "Not wanted" was the one
 * outcome with no line, and `reserved=true` never said what had reserved it.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { __setHostForTesting } from '../host.js';
import { testHost } from './install-test-host.js';
import { decideBackstop, explainBackstop, type BackstopState } from '../runners/backstop.js';
import { logBackstopEligibility } from '../runners/backstop-decision-report.js';

const FRESH: BackstopState = { calmTicks: 0, lastReason: null, promoted: null };
const base = { clawsOnline: 9, clawsRegistered: 9, clawsFree: 4, queuePressureSec: 0 };

afterEach(() => __setHostForTesting(testHost));

function linesFor(input: Parameters<typeof decideBackstop>[0]): string[] {
	const lines: string[] = [];
	const keep = (m: string): void => void lines.push(m);
	__setHostForTesting({ ...testHost, logger: { info: keep, warn: keep, error: keep } });
	const decision = decideBackstop(input, FRESH);
	logBackstopEligibility({
		backstopInput: input,
		decision,
		backstopWanted: decision.wanted,
		heldNodes: [],
		outage: decision.outage,
		saturationHost: () => ({ ok: true, why: 'idle' }),
		queuePressureSec: input.queuePressureSec,
		backstopNodes: ['claw-fixture'],
		drain: {},
		pm2BusyNodes: new Set(),
	});
	return lines;
}

test('a tick that does not want the backstop still says so, with its reading', () => {
	const lines = linesFor({ ...base, queuePressureSec: 40, reserved: false });
	assert.equal(lines.length, 1);
	assert.match(lines[0], /BACKSTOP not wanted: reason=none/);
	assert.match(lines[0], /queue=40s/);
	assert.match(lines[0], /reserved=false/);
});

test('a backlog overruled by a reservation names what reserved it', () => {
	const lines = linesFor({
		...base,
		queuePressureSec: 350,
		reserved: true,
		reservedWhy: 'cron-running: 1 cron job(s) in flight: fleet:hosting-converge',
	});
	assert.equal(lines.length, 1);
	assert.match(lines[0], /BACKSTOP not wanted/);
	assert.match(lines[0], /queue=350s/);
	assert.match(
		lines[0],
		/reserved=true \(cron-running: 1 cron job\(s\) in flight: fleet:hosting-converge\)/
	);
});

test('a reservation whose caller gave no holder says that, not nothing', () => {
	const i = { ...base, queuePressureSec: 350, reserved: true };
	assert.match(
		explainBackstop(i, decideBackstop(i, FRESH)),
		/reserved=true \(holder not reported\)/
	);
});
