import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	BENCHMARK_LEDGER_FILE,
	benchmarkPlan,
	benchmarkWeekday,
	lastMeasuredMs,
	readBenchmarkLedger,
	recordBenchmarks,
	WEEKDAYS,
} from './bootcamp-schedule.mjs';

const FLEET = [
	'hokon',
	'claw-1',
	'claw-2',
	'claw-3',
	'claw-4',
	'claw-5',
	'claw-6',
	'claw-8',
	'claw-9',
	'claw-10',
];
const MEASURED = {
	$capabilities: { measurements: { 'cargo-bevy': { value: 2000, earned: true } } },
};
// 2026-11-11 is a Wednesday (UTC day 3).
const WED = Date.parse('2026-11-11T12:00:00Z');

void test('every weekday carries one or two of ten nodes, never more and never none', () => {
	const perDay = Array(7).fill(0);
	for (const n of FLEET) perDay[benchmarkWeekday(n, FLEET)]++;
	assert.deepEqual(perDay.toSorted(), [1, 1, 1, 1, 2, 2, 2]);
});

void test("a node's weekday depends on the fleet, not on the order the manifest lists it", () => {
	for (const n of FLEET)
		assert.equal(benchmarkWeekday(n, FLEET), benchmarkWeekday(n, FLEET.toReversed()));
	assert.equal(benchmarkWeekday('claw-7', FLEET), null);
});

void test('a measured node off its weekday defers every idle-only id, with the next date', () => {
	const node = FLEET.find((n) => benchmarkWeekday(n, FLEET) === 4); // Thursday
	const plan = benchmarkPlan({
		node,
		machine: MEASURED,
		fleet: FLEET,
		idleOnly: ['cargo-bevy'],
		nowMs: WED,
	});
	assert.equal(plan.measure, false);
	assert.equal(plan.weekday, 'Thu');
	assert.deepEqual(plan.deferred, [{ id: 'cargo-bevy', nextOn: '2026-11-12' }]);
});

void test('on its own weekday the node is measured, and the next slot is a week out, not today', () => {
	const node = FLEET.find((n) => benchmarkWeekday(n, FLEET) === 3);
	const on = benchmarkPlan({
		node,
		machine: MEASURED,
		fleet: FLEET,
		idleOnly: ['cargo-bevy'],
		nowMs: WED,
	});
	assert.equal(on.measure, true);
	assert.deepEqual(on.deferred, []);
	const after = benchmarkPlan({
		node,
		machine: MEASURED,
		fleet: FLEET,
		idleOnly: ['cargo-bevy'],
		nowMs: WED + 86_400_000,
	});
	assert.deepEqual(after.deferred, [{ id: 'cargo-bevy', nextOn: '2026-11-18' }]);
});

void test('a node with no measurement on record is measured tonight, whatever the day', () => {
	const node = FLEET.find((n) => benchmarkWeekday(n, FLEET) === 4);
	const plan = benchmarkPlan({
		node,
		machine: {},
		fleet: FLEET,
		idleOnly: ['cargo-bevy'],
		nowMs: WED,
	});
	assert.equal(plan.measure, true);
	assert.match(plan.why, /no measurement on record: cargo-bevy/);
});

void test('--measure measures off the weekday', () => {
	const node = FLEET.find((n) => benchmarkWeekday(n, FLEET) === 4);
	const plan = benchmarkPlan({
		node,
		machine: MEASURED,
		fleet: FLEET,
		idleOnly: ['cargo-bevy'],
		nowMs: WED,
		force: true,
	});
	assert.equal(plan.measure, true);
});

void test('WEEKDAYS is indexed like Date#getUTCDay', () => {
	assert.equal(WEEKDAYS[new Date(WED).getUTCDay()], 'Wed');
});

// ── a missed slot is retried nightly until it lands ────────────────────────

const DAY = 86_400_000;
const MON_NODE = FLEET.find((n) => benchmarkWeekday(n, FLEET) === 1);
const plan = (nowMs, measuredMs) =>
	benchmarkPlan({
		node: MON_NODE,
		machine: MEASURED,
		fleet: FLEET,
		idleOnly: ['cargo-bevy'],
		nowMs,
		measuredMs,
	});
// WED is 2026-11-11; Monday 11-09 is the most recent slot.
const LAST_WEEK_MON = Date.parse('2026-11-02T12:10:00Z');
const THIS_MON = Date.parse('2026-11-09T12:10:00Z');

void test('a slot the node missed is retried every night until a measurement lands', () => {
	const tue = plan(WED - DAY, LAST_WEEK_MON);
	assert.equal(tue.measure, true);
	assert.match(tue.why, /missed its Mon 2026-11-09 benchmark \(last measured 2026-11-02\)/);
	assert.equal(plan(WED, LAST_WEEK_MON).measure, true, 'still missed on Wednesday');
	assert.equal(plan(WED + 4 * DAY, LAST_WEEK_MON).measure, true, 'and on Sunday');
});

void test('once it lands, the node waits for its next weekday', () => {
	const p = plan(WED, THIS_MON);
	assert.equal(p.measure, false);
	assert.deepEqual(p.deferred, [{ id: 'cargo-bevy', nextOn: '2026-11-16' }]);
	assert.equal(plan(Date.parse('2026-11-16T12:00:00Z'), THIS_MON).measure, true, 'next Monday');
});

void test('a node the ledger never saw waits for its weekday instead of all measuring at once', () => {
	assert.equal(plan(WED, null).measure, false);
	assert.equal(plan(Date.parse('2026-11-16T12:00:00Z'), null).measure, true);
});

void test('lastMeasuredMs is the OLDEST idle-only id, and null when any is missing', () => {
	const ledger = { n: { a: { at: '2026-11-09T00:00:00Z' }, b: { at: '2026-11-02T00:00:00Z' } } };
	assert.equal(lastMeasuredMs(ledger, 'n', ['a', 'b']), Date.parse('2026-11-02T00:00:00Z'));
	assert.equal(lastMeasuredMs(ledger, 'n', ['a', 'c']), null);
	assert.equal(lastMeasuredMs({}, 'n', ['a']), null);
});

void test('the ledger: missing is empty, written per node, and an unreadable one is never overwritten', () => {
	const dir = mkdtempSync(join(tmpdir(), 'bench-ledger-'));
	try {
		assert.deepEqual(readBenchmarkLedger(dir), { ok: true, ledger: {} });
		assert.deepEqual(recordBenchmarks(dir, { a: ['cargo-bevy'], b: [] }, THIS_MON), {
			ok: true,
			wrote: 1,
		});
		assert.deepEqual(readBenchmarkLedger(dir).ledger, {
			a: { 'cargo-bevy': { at: '2026-11-09T12:10:00.000Z' } },
		});
		writeFileSync(join(dir, BENCHMARK_LEDGER_FILE), '{ torn');
		const r = recordBenchmarks(dir, { a: ['cargo-bevy'] }, WED);
		assert.equal(r.ok, false);
		assert.equal(readFileSync(join(dir, BENCHMARK_LEDGER_FILE), 'utf8'), '{ torn', 'it overwrote');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
