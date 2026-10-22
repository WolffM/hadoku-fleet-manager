import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { __setHostForTesting } from '../host.js';
import { testHost } from './install-test-host.js';
import {
	FORCE_DEFAULT_MINUTES,
	FORCE_MAX_MINUTES,
	activeForces,
	describeForce,
	forceRecord,
	isForced,
	parseForceMinutes,
	pruneForce,
	readForce,
	writeForce,
} from '../runners/backstop-force.js';

const NOW = Date.parse('2026-10-21T05:30:00Z');
const rec = (minutesFromNow: number, over: Partial<ReturnType<typeof forceRecord>> = {}) => ({
	...forceRecord(Math.abs(minutesFromNow), 'queue backed up', 'hadoku', NOW),
	...(minutesFromNow < 0 ? { until: new Date(NOW + minutesFromNow * 60_000).toISOString() } : {}),
	...over,
});

function withStateDir(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), 'backstop-force-'));
	__setHostForTesting({ ...testHost, stateDir: dir });
	try {
		fn(dir);
	} finally {
		__setHostForTesting(testHost);
		rmSync(dir, { recursive: true, force: true });
	}
}

test('a force in the future holds; an expired one is as good as absent', () => {
	const state = { hokon: rec(30), 'claw-9': rec(-5) };
	assert.equal(isForced('hokon', state, NOW), true);
	assert.equal(isForced('claw-9', state, NOW), false, 'expired five minutes ago');
	assert.equal(isForced('claw-1', state, NOW), false, 'never forced');
	assert.deepEqual(
		activeForces(state, NOW).map((f) => [f.node, f.remainingMin]),
		[['hokon', 30]]
	);
	assert.deepEqual(Object.keys(pruneForce(state, NOW)), ['hokon']);
});

test('a record whose until cannot be parsed is NOT forced — a corrupt switch routes nothing', () => {
	assert.equal(isForced('hokon', { hokon: rec(30, { until: 'soon' }) }, NOW), false);
});

test('durations: minutes by default, hours accepted, a typo is an error, the ceiling is six hours', () => {
	assert.equal(parseForceMinutes(undefined), FORCE_DEFAULT_MINUTES);
	assert.equal(parseForceMinutes(''), FORCE_DEFAULT_MINUTES);
	assert.equal(parseForceMinutes('90'), 90);
	assert.equal(parseForceMinutes('90m'), 90);
	assert.equal(parseForceMinutes('2h'), 120);
	assert.equal(parseForceMinutes('1.5h'), 90);
	assert.equal(parseForceMinutes('6h'), FORCE_MAX_MINUTES);
	assert.throws(() => parseForceMinutes('7h'), /ceiling/);
	assert.throws(() => parseForceMinutes('0m'), /under a minute/);
	assert.throws(() => parseForceMinutes('an hour'), /cannot read duration/);
});

test('forceRecord stamps since and until from one clock', () => {
	const r = forceRecord(60, 'why', 'who', NOW);
	assert.equal(r.since, '2026-10-21T05:30:00.000Z');
	assert.equal(r.until, '2026-10-21T06:30:00.000Z');
	assert.match(
		describeForce('hokon', r, NOW),
		/hokon forced eligible by who until .* \(60 min left\): why/
	);
});

test('the file round-trips through the state dir, and a missing file is no force', () => {
	withStateDir((dir) => {
		assert.deepEqual(readForce(), {}, 'missing file');
		writeForce({ hokon: rec(45) });
		assert.ok(existsSync(join(dir, 'fleet-backstop-force.json')));
		assert.equal(isForced('hokon', readForce(), NOW), true);
		writeForce({});
		assert.deepEqual(readForce(), {});
	});
});

test('an unreadable file THROWS — the caller must fail toward "not forced" and say so', () => {
	withStateDir((dir) => {
		writeFileSync(join(dir, 'fleet-backstop-force.json'), '{ not json');
		assert.throws(() => readForce(), SyntaxError);
	});
});
