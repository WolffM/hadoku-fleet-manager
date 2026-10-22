import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	parseLogLines,
	reapTrendVerdict,
	RECENT_HOURS,
	BASELINE_HOURS,
	MIN_RECENT_PER_HOUR,
} from './reap-trend.mjs';

const HOUR = 3_600_000;
const line = (ms, timeout) =>
	`[${new Date(ms).toISOString()}] [WARN] [mgmt-api] [runner-health] GET /actions/` +
	`runners?per_page=100 ${timeout ? 'failed: fetch failed' : 'succeeded'}`;

test('parseLogLines tags every timestamped line, timeout or not', () => {
	const now = Date.now();
	const text = [line(now, true), line(now, false), 'no timestamp here, ever'].join('\n');
	const parsed = parseLogLines(text);
	assert.equal(parsed.length, 2);
	assert.equal(parsed[0].isTimeout, true);
	assert.equal(parsed[1].isTimeout, false);
});

test('parseLogLines ignores lines that merely mention the pattern without a timestamp', () => {
	assert.deepEqual(parseLogLines('runners?per_page=100 failed, no bracket'), []);
});

test('reapTrendVerdict: no entries at all is "could not look", not a pass', () => {
	const v = reapTrendVerdict([]);
	assert.equal(v.ok, false);
	assert.match(v.error, /could not look/);
});

test('reapTrendVerdict: log window shorter than recent+baseline refuses a verdict', () => {
	const now = Date.now();
	const entries = [{ ms: now - HOUR, isTimeout: true }];
	const v = reapTrendVerdict(entries, { nowMs: now });
	assert.equal(v.ok, false);
	assert.match(v.error, /need/);
});

/** Build entries with N timeouts spread evenly across [startMs, endMs). */
function spread(startMs, endMs, count) {
	const span = endMs - startMs;
	return Array.from({ length: count }, (_, i) => ({
		ms: startMs + Math.floor((span * i) / Math.max(count, 1)),
		isTimeout: true,
	}));
}

test('reapTrendVerdict: steady state at the documented ~35/hr baseline passes', () => {
	const now = Date.now();
	const recentStart = now - RECENT_HOURS * HOUR;
	const baselineStart = recentStart - BASELINE_HOURS * HOUR;
	const entries = [
		...spread(baselineStart, recentStart, Math.round(35 * BASELINE_HOURS)),
		...spread(recentStart, now, Math.round(35 * RECENT_HOURS)),
	];
	const v = reapTrendVerdict(entries, { nowMs: now });
	assert.equal(v.ok, true);
	assert.deepEqual(v.findings, []);
});

test('reapTrendVerdict: a small absolute bump under the floor is not a finding', () => {
	// 2/hr baseline -> 8/hr recent is 4x, comfortably over RISE_FACTOR, but both
	// numbers are noise-sized and MIN_RECENT_PER_HOUR must suppress it.
	const now = Date.now();
	const recentStart = now - RECENT_HOURS * HOUR;
	const baselineStart = recentStart - BASELINE_HOURS * HOUR;
	const entries = [
		...spread(baselineStart, recentStart, 2 * BASELINE_HOURS),
		...spread(recentStart, now, 8 * RECENT_HOURS),
	];
	const v = reapTrendVerdict(entries, { nowMs: now });
	assert.equal(v.ok, true);
});

test('reapTrendVerdict: a climb past the floor and the rise factor is a finding', () => {
	const now = Date.now();
	const recentStart = now - RECENT_HOURS * HOUR;
	const baselineStart = recentStart - BASELINE_HOURS * HOUR;
	const entries = [
		...spread(baselineStart, recentStart, 35 * BASELINE_HOURS),
		...spread(recentStart, now, (MIN_RECENT_PER_HOUR + 50) * RECENT_HOURS),
	];
	const v = reapTrendVerdict(entries, { nowMs: now });
	assert.equal(v.ok, false);
	assert.equal(v.findings.length, 1);
	assert.match(v.findings[0], /RISING/);
});

test('reapTrendVerdict: the 460/hr outage shape is caught', () => {
	const now = Date.now();
	const recentStart = now - RECENT_HOURS * HOUR;
	const baselineStart = recentStart - BASELINE_HOURS * HOUR;
	const entries = [
		...spread(baselineStart, recentStart, 35 * BASELINE_HOURS),
		...spread(recentStart, now, 460 * RECENT_HOURS),
	];
	const v = reapTrendVerdict(entries, { nowMs: now });
	assert.equal(v.ok, false);
});

test('reapTrendVerdict: non-timeout lines never count toward either window', () => {
	const now = Date.now();
	const recentStart = now - RECENT_HOURS * HOUR;
	const baselineStart = recentStart - BASELINE_HOURS * HOUR;
	const entries = [
		...spread(baselineStart, recentStart, 35 * BASELINE_HOURS),
		...spread(recentStart, now, 500 * RECENT_HOURS).map((e) => ({ ...e, isTimeout: false })),
	];
	const v = reapTrendVerdict(entries, { nowMs: now });
	assert.equal(v.ok, true);
});
