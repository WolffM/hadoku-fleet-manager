/**
 * src/host-pressure.ts — the production host's early warning. Fixtures are the
 * measured numbers in that module's header: each real event must warn, the
 * harmless capped write storm must not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	initialPressureState,
	ownCgroup,
	parsePsi,
	pressureReasons,
	pressureStatePath,
	stepPressure,
	unreadableParts,
	PRESSURE_CLEAR_SAMPLES,
	PRESSURE_REPOST_MS,
	type PressureSample,
	type PressureState,
} from '../host-pressure.js';

const psi = (some10: number, full10 = 0) => ({ some10, full10 });
const sample = (o: {
	hostIo?: [number, number];
	hostMem?: number;
	prodIo?: number;
	prodMem?: number;
}): PressureSample => ({
	host: { io: psi(...(o.hostIo ?? [3, 2])), mem: psi(o.hostMem ?? 0) },
	prod: {
		cgroup: '/system.slice/pm2-hadoku.service',
		io: psi(o.prodIo ?? 0),
		mem: psi(o.prodMem ?? 0),
	},
});

const QUIET = sample({});
// 2026-11-28 app.slice small-file storm under the 60M cap: harmless to prod.
const CAPPED_STORM = sample({ hostIo: [64.1, 44.5], prodIo: 22.9, hostMem: 2.8 });
const E1_WRITE_STORM = sample({ hostIo: [97.3, 58], prodIo: 45 });
const E2_IO_FULL = sample({ hostIo: [94.7, 64.9], prodIo: 12 });
const E4_PROD_MEMORY = sample({ hostMem: 44, prodMem: 84 });

test('parsePsi reads avg10 of some and full', () => {
	const t =
		'some avg10=1.76 avg60=1.03 avg300=1.07 total=47950326105\nfull avg10=0.92 avg60=0.61 avg300=0.60 total=1\n';
	assert.deepEqual(parsePsi(t), { some10: 1.76, full10: 0.92 });
	assert.equal(parsePsi('garbage'), null);
});

test('ownCgroup takes the cgroup v2 line', () => {
	assert.equal(
		ownCgroup('0::/system.slice/pm2-hadoku.service\n'),
		'/system.slice/pm2-hadoku.service'
	);
	assert.equal(ownCgroup('1:name=systemd:/x\n'), null);
});

test('every measured event crosses a line; quiet and the capped storm do not', () => {
	assert.deepEqual(pressureReasons(QUIET), []);
	assert.deepEqual(pressureReasons(CAPPED_STORM), []);
	assert.match(pressureReasons(E1_WRITE_STORM).join(), /prod io some 45%/);
	assert.match(pressureReasons(E2_IO_FULL).join(), /host io full 64.9%/);
	assert.match(pressureReasons(E4_PROD_MEMORY).join(), /prod memory some 84%/);
	assert.match(pressureReasons(E4_PROD_MEMORY).join(), /host memory some 44%/);
});

test('one sample over a line does not warn; two do, and post once', () => {
	let s: PressureState = initialPressureState();
	let r = stepPressure(s, E4_PROD_MEMORY, 1_000_000);
	assert.equal(r.event, null);
	assert.equal(r.next.level, 'ok');
	s = r.next;
	r = stepPressure(s, E4_PROD_MEMORY, 1_002_000);
	assert.equal(r.event, 'enter');
	assert.equal(r.post, true);
	assert.equal(r.next.level, 'warn');
	s = r.next;
	r = stepPressure(s, E4_PROD_MEMORY, 1_004_000);
	assert.equal(r.event, null, 'staying in warn is not a second enter');
});

test('a blip between over samples resets the count', () => {
	let s = stepPressure(initialPressureState(), E1_WRITE_STORM, 0).next;
	s = stepPressure(s, QUIET, 2_000).next;
	const r = stepPressure(s, E1_WRITE_STORM, 4_000);
	assert.equal(r.event, null);
});

test('clears only after PRESSURE_CLEAR_SAMPLES calm samples', () => {
	let s = stepPressure(initialPressureState(), E2_IO_FULL, 0).next;
	s = stepPressure(s, E2_IO_FULL, 2_000).next;
	assert.equal(s.level, 'warn');
	for (let i = 1; i < PRESSURE_CLEAR_SAMPLES; i++) {
		const r = stepPressure(s, QUIET, 2_000 + i * 2_000);
		assert.equal(r.event, null);
		s = r.next;
	}
	const r = stepPressure(s, QUIET, 100_000);
	assert.equal(r.event, 'clear');
	assert.equal(r.next.level, 'ok');
});

test('re-entering inside the repost window warns without posting again', () => {
	let s = stepPressure(initialPressureState(), E2_IO_FULL, 0).next;
	s = stepPressure(s, E2_IO_FULL, 2_000).next;
	for (let i = 0; i < PRESSURE_CLEAR_SAMPLES; i++)
		s = stepPressure(s, QUIET, 4_000 + i * 2_000).next;
	assert.equal(s.level, 'ok');
	s = stepPressure(s, E2_IO_FULL, 60_000).next;
	const again = stepPressure(s, E2_IO_FULL, 62_000);
	assert.equal(again.event, 'enter');
	assert.equal(again.post, false);
	s = again.next;
	for (let i = 0; i < PRESSURE_CLEAR_SAMPLES; i++)
		s = stepPressure(s, QUIET, 64_000 + i * 2_000).next;
	s = stepPressure(s, E2_IO_FULL, 2_000 + PRESSURE_REPOST_MS).next;
	assert.equal(stepPressure(s, E2_IO_FULL, 4_000 + PRESSURE_REPOST_MS).post, true);
});

test('an unreadable PSI is named, never read as calm', () => {
	const blind: PressureSample = {
		host: { io: null, mem: psi(0) },
		prod: { cgroup: null, io: null, mem: null },
	};
	assert.deepEqual(unreadableParts(blind), ['host io', 'prod io', 'prod memory']);
	assert.deepEqual(unreadableParts(QUIET), []);
});

test('the state file lives on the runtime tmpfs', () => {
	assert.equal(
		pressureStatePath({ XDG_RUNTIME_DIR: '/run/user/1000' }),
		'/run/user/1000/fleet/host-pressure.json'
	);
});
