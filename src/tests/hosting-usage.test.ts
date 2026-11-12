import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HOLD_FULL_MS } from '../runners/hosting-record.js';
import {
	HOSTING_USAGE_FILE,
	LEARN_MIN_HOURS,
	USAGE_FLUSH_MS,
	USAGE_KEEP_HOURS,
	__resetHostingUsageForTesting,
	addReading,
	learnedHold,
	observeSliceUsage,
	readHostingUsage,
	usageStats,
	type UsageDoc,
} from '../runners/hosting-usage.js';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-11-01T00:00:00Z');
const dir = () => mkdtempSync(join(tmpdir(), 'hosting-usage-'));
const settled = new Date(T0 - 30 * 24 * HOUR).toISOString();

/** `hours` hours of readings, four an hour, from `perHour(h)`. */
function history(hours: number, perHour: (h: number) => number[], start = T0): UsageDoc {
	const doc: UsageDoc = { version: 1, slices: {} };
	for (let h = 0; h < hours; h++)
		for (const [i, mb] of perHour(h).entries())
			addReading(doc, 'claw-4/archivebot', mb, start + h * HOUR + i * 60_000);
	return doc;
}

test('readings fold into hourly buckets: count, sum, sum of squares, min, max', () => {
	const doc = history(2, (h) => (h === 0 ? [100, 200] : [150]));
	assert.deepEqual(doc.slices['claw-4/archivebot'], {
		'2026-11-01T00': [2, 300, 50_000, 100, 200],
		'2026-11-01T01': [1, 150, 22_500, 150, 150],
	});
	const s = usageStats(doc.slices['claw-4/archivebot'])!;
	assert.deepEqual(s, { hours: 2, meanMb: 150, sdMb: 41, peakMb: 200, idleMb: 100 });
	assert.equal(usageStats(undefined), null);
});

test('hours older than the window drop out, and a slice with none left is gone', () => {
	const doc = history(1, () => [500]);
	addReading(doc, 'claw-6/pygmalion', 200, T0 + USAGE_KEEP_HOURS * HOUR + HOUR);
	assert.equal(doc.slices['claw-4/archivebot'], undefined);
	assert.deepEqual(Object.keys(doc.slices), ['claw-6/pygmalion']);
});

test('no learned value until a slice has a day of readings', () => {
	const stats = usageStats(
		history(LEARN_MIN_HOURS - 1, () => [160])['slices']['claw-4/archivebot']
	);
	assert.equal(
		learnedHold({ declaredMb: 1024, currentMb: 160, since: settled, stats, nowMs: T0 }),
		null
	);
});

test('steady at ~160 MiB: the envelope is the peak, the up mark 80% of idle, the hold what is left of it', () => {
	const stats = usageStats(history(48, () => [150, 160, 170, 160]).slices['claw-4/archivebot'])!;
	const got = learnedHold({ declaredMb: 1024, currentMb: 160, since: settled, stats, nowMs: T0 });
	// mean 160, sd 7: mean+3sd = 181 > peak 170.
	assert.deepEqual(got, { envelopeMb: 181, upMarkMb: 120, holdMb: 21 });
});

test('the learned hold holds everything when the live rule would: down, unread, or just declared', () => {
	const stats = usageStats(history(48, () => [150, 160, 170, 160]).slices['claw-4/archivebot'])!;
	const base = { declaredMb: 1024, since: settled, stats, nowMs: T0 };
	assert.equal(learnedHold({ ...base, currentMb: 100 })!.holdMb, 1024, 'below the up mark');
	assert.equal(learnedHold({ ...base, currentMb: null })!.holdMb, 1024, 'unread');
	const young = new Date(T0 - HOLD_FULL_MS + 60_000).toISOString();
	assert.equal(learnedHold({ ...base, currentMb: 160, since: young })!.holdMb, 1024, 'young');
});

test('the envelope never exceeds the declaration, and the up mark stays inside its band', () => {
	const big = usageStats(history(48, () => [900, 1000, 1100]).slices['claw-4/archivebot'])!;
	const got = learnedHold({
		declaredMb: 1024,
		currentMb: 1000,
		since: settled,
		stats: big,
		nowMs: T0,
	})!;
	assert.equal(got.envelopeMb, 1024);
	assert.equal(got.upMarkMb, 256);
	assert.equal(got.holdMb, 24);
	const tiny = usageStats(history(48, () => [20, 30]).slices['claw-4/archivebot'])!;
	assert.equal(
		learnedHold({ declaredMb: 1024, currentMb: 30, since: settled, stats: tiny, nowMs: T0 })!
			.upMarkMb,
		64
	);
});

test('a tenant that starts doing more raises the envelope the hour it does; doing less lowers it as hours age out', () => {
	const doc = history(48, () => [160]);
	const before = usageStats(doc.slices['claw-4/archivebot'])!;
	addReading(doc, 'claw-4/archivebot', 600, T0 + 48 * HOUR);
	const after = usageStats(doc.slices['claw-4/archivebot'])!;
	assert.ok(after.peakMb === 600 && before.peakMb === 160);
	const grown = learnedHold({
		declaredMb: 1024,
		currentMb: 160,
		since: settled,
		stats: after,
		nowMs: T0,
	})!;
	assert.equal(grown.envelopeMb, 600);
	// The busy hour ages out after the window; the envelope falls back.
	const later = T0 + 48 * HOUR + USAGE_KEEP_HOURS * HOUR + HOUR;
	for (let h = 0; h < 48; h++) addReading(doc, 'claw-4/archivebot', 160, later + h * HOUR);
	assert.equal(usageStats(doc.slices['claw-4/archivebot'])!.peakMb, 160);
});

test('the record on disk: missing is empty, corrupt is null, a flush reads back', () => {
	__resetHostingUsageForTesting();
	const d = dir();
	assert.deepEqual(readHostingUsage(d), { version: 1, slices: {} });
	const stats = observeSliceUsage(
		[
			{ node: 'claw-4', tenant: 'archivebot', mb: 164 },
			{ node: 'claw-4', tenant: 'pygmalion', mb: null },
		],
		{ dir: d, nowMs: T0 }
	);
	assert.equal(stats.get('claw-4/archivebot')!.meanMb, 164);
	assert.equal(stats.get('claw-4/pygmalion'), null, 'an unread slice records nothing');
	assert.deepEqual(readHostingUsage(d)!.slices, {
		'claw-4/archivebot': { '2026-11-01T00': [1, 164, 164 * 164, 164, 164] },
	});
	// Inside the flush interval the reading is kept in memory, not written.
	observeSliceUsage([{ node: 'claw-4', tenant: 'archivebot', mb: 200 }], {
		dir: d,
		nowMs: T0 + 1000,
	});
	assert.equal(readHostingUsage(d)!.slices['claw-4/archivebot']['2026-11-01T00'][0], 1);
	observeSliceUsage([{ node: 'claw-4', tenant: 'archivebot', mb: 180 }], {
		dir: d,
		nowMs: T0 + USAGE_FLUSH_MS,
	});
	assert.equal(readHostingUsage(d)!.slices['claw-4/archivebot']['2026-11-01T00'][0], 3);

	writeFileSync(join(d, HOSTING_USAGE_FILE), '{"version":1,"slices":{"x":{"h":[1,2]}}}');
	assert.equal(readHostingUsage(d), null);
});

test('a corrupt record is reported and replaced, not left broken', () => {
	__resetHostingUsageForTesting();
	const d = dir();
	writeFileSync(join(d, HOSTING_USAGE_FILE), '{"version":1,');
	const unreadable: string[] = [];
	observeSliceUsage([{ node: 'claw-6', tenant: 'watchparty', mb: 300 }], {
		dir: d,
		nowMs: T0,
		onUnreadable: (p) => unreadable.push(p),
	});
	assert.deepEqual(unreadable, [join(d, HOSTING_USAGE_FILE)]);
	assert.equal(JSON.parse(readFileSync(join(d, HOSTING_USAGE_FILE), 'utf8')).version, 1);
});
