import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	BACKLOG_OVERRIDABLE_RESERVATIONS,
	BACKLOG_QUEUE_SECONDS,
	decideBackstop,
	type BackstopInput,
	type BackstopState,
} from '../runners/backstop.js';
import { tick } from '../runner-health.js';
import { getRunnerHealthSnapshot } from '../runner-health-snapshot.js';
import { __setReservationForTesting } from '../runners/backstop-decision-state.js';
import { installRunnerHealthRig, installFetch, labelOps } from './helpers/runner-health-rig.js';
import { clawLabels, hokonLabels, minutesAgo } from './helpers/runner-health-fixtures.js';

installRunnerHealthRig();

const FRESH: BackstopState = { calmTicks: 0, lastReason: null, promoted: null };
const PROMOTED: BackstopState = { calmTicks: 0, lastReason: 'saturation', promoted: true };
// 2026-11-22 07:23:20Z, as runner-health logged it: 9/9 claws, 700 s queue,
// hokon held off by a hadoku_site PM2 deploy.
const NOV22: BackstopInput = {
	clawsOnline: 9,
	clawsRegistered: 9,
	clawsFree: 11,
	queuePressureSec: 700,
	reserved: true,
	reservedWhy: 'pm2-host: serving pm2-host work',
	reservedKind: 'pm2-host',
};

test('the 11-22 demote: a 700 s backlog behind a PM2 deploy fires the shadow', () => {
	const d = decideBackstop(NOV22, PROMOTED);
	assert.equal(d.shadowBacklogOverride, true);
	// SHADOW: the decision itself is what it was, hokon still stands down.
	assert.equal(d.wanted, false);
	assert.equal(d.reason, 'none');
	// Never promoted yet: the same backlog also fires it.
	assert.equal(decideBackstop(NOV22, FRESH).shadowBacklogOverride, true);
});

test('a cron-running hold yields too, a lease never does', () => {
	const cron = {
		...NOV22,
		reservedKind: 'cron-running',
		reservedWhy: 'cron-running: ops:hub-sync',
	};
	assert.equal(decideBackstop(cron, FRESH).shadowBacklogOverride, true);
	const lease = { ...NOV22, reservedKind: 'host-lease', reservedWhy: 'host-lease' };
	assert.equal(decideBackstop(lease, FRESH).shadowBacklogOverride, false);
	assert.deepEqual([...BACKLOG_OVERRIDABLE_RESERVATIONS].sort(), ['cron-running', 'pm2-host']);
});

test('a caller that sends only the boolean never fires it', () => {
	const boolOnly: BackstopInput = { ...NOV22, reservedKind: undefined };
	assert.equal(decideBackstop(boolOnly, FRESH).shadowBacklogOverride, false);
});

test('below the backlog line, or with nothing reserved, it stays quiet', () => {
	const under = { ...NOV22, queuePressureSec: BACKLOG_QUEUE_SECONDS - 1 };
	assert.equal(decideBackstop(under, FRESH).shadowBacklogOverride, false);
	const at = { ...NOV22, queuePressureSec: BACKLOG_QUEUE_SECONDS };
	assert.equal(decideBackstop(at, FRESH).shadowBacklogOverride, true);
	// Unreserved: saturation already promotes, so there is nothing to shadow.
	const free = decideBackstop({ ...NOV22, reserved: false, reservedKind: null }, FRESH);
	assert.equal(free.wanted, true);
	assert.equal(free.shadowBacklogOverride, false);
});

test('an outage already outranks the reservation, so the shadow has nothing to add', () => {
	const dark = { ...NOV22, clawsOnline: 1, clawsRegistered: 9 };
	const d = decideBackstop(dark, FRESH);
	assert.equal(d.wanted, true);
	assert.equal(d.shadowBacklogOverride, false);
});

test('unmeasured capacity decides nothing, the shadow included', () => {
	const d = decideBackstop({ ...NOV22, ephemeralUnknown: true }, PROMOTED);
	assert.equal(d.unmeasured, true);
	assert.equal(d.shadowBacklogOverride, false);
});

test('through a real tick: the shadow is recorded, and no label is written for it', async () => {
	installFetch({
		runners: {
			runners: [
				{ id: 1, name: 'hokon', status: 'online', busy: false, labels: hokonLabels() },
				{ id: 2, name: 'claw-1', status: 'online', busy: true, labels: clawLabels() },
			],
		},
		queuedRuns: { workflow_runs: [{ created_at: minutesAgo(12) }] },
	});
	__setReservationForTesting(() => ({
		reserved: true,
		reason: 'pm2-host',
		detail: 'serving pm2-host work',
	}));
	await tick('tok');
	const snap = getRunnerHealthSnapshot();
	assert.equal(snap?.backstop_shadow_override, true);
	assert.equal(snap?.backstop_reason, 'none', 'the reservation still wins: shadow only');
	assert.equal(labelOps.length, 0, 'hokon is not promoted');
});
