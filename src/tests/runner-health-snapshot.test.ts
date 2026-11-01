/**
 * Tests for `runner-health-snapshot.ts`: the persisted census a restarted
 * process serves until its own first tick replaces it, the restore-window
 * ceiling, and a corrupt file restoring nothing. Split out of
 * runner-health.test.ts (wave 5p lane B) — see
 * `src/tests/helpers/runner-health-rig.ts` for the shared fetch-stub fixture
 * every file that ticks the monitor installs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { writeFileSync } from 'node:fs';

import {
	tick,
	SNAPSHOT_RESTORE_MAX_AGE_MS,
	__resetRunnerHealthAlertsForTesting,
	getRunnerHealthSnapshot,
} from '../runner-health.js';
import {
	installRunnerHealthRig,
	installFetch,
	snapshotPath,
	FLEET_ALL_UP,
} from './helpers/runner-health-rig.js';

installRunnerHealthRig();

// --- The persisted snapshot ---
//
// Optional half of the same fix: a restarted process serves the previous
// process's last census, dated as it was, until its own first tick replaces it.

test('snapshot: a restarted process serves the last persisted census, dated as it was', async () => {
	installFetch({ runners: FLEET_ALL_UP });
	await tick('tok');
	const live = getRunnerHealthSnapshot();
	assert.ok(live, 'the tick produced a snapshot');
	// Forget the in-memory copy, as a restart does. The file is all that is left.
	__resetRunnerHealthAlertsForTesting();
	const restored = getRunnerHealthSnapshot();
	assert.deepEqual(restored, JSON.parse(JSON.stringify(live)), 'the file round-trips the census');
	assert.equal(restored?.at, live.at, 'stamped with ITS time, not re-stamped to now');
	// And a live tick replaces it.
	await tick('tok');
	assert.notEqual(getRunnerHealthSnapshot(), restored, 'the next tick replaces the restored copy');
});

test('snapshot: a census older than the restore window is not served', async () => {
	installFetch({ runners: FLEET_ALL_UP });
	await tick('tok');
	const stale = {
		...getRunnerHealthSnapshot(),
		at: new Date(Date.now() - SNAPSHOT_RESTORE_MAX_AGE_MS - 60_000).toISOString(),
	};
	writeFileSync(snapshotPath, JSON.stringify(stale));
	__resetRunnerHealthAlertsForTesting();
	assert.equal(
		getRunnerHealthSnapshot(),
		null,
		'an hour-old census is not a better answer than "not measured yet"'
	);
});

test('snapshot: a corrupt or malformed file restores nothing', () => {
	writeFileSync(snapshotPath, '{not json');
	assert.equal(getRunnerHealthSnapshot(), null, 'unparseable');
	__resetRunnerHealthAlertsForTesting();
	writeFileSync(snapshotPath, JSON.stringify({ at: new Date().toISOString() }));
	assert.equal(getRunnerHealthSnapshot(), null, 'parseable but not a snapshot');
});
