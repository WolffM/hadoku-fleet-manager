/**
 * `rollup-cli.mjs` — wave shrink-1 lane A dedup. `rawFlag`, the `--days`
 * validation and the "name every gap" missing-day loop were byte-identical
 * across `job-rollups.mjs`, `failures.mjs` and `stats.mjs` before this move;
 * `readRollupStore` folds the two shapes (`job-rollups.mjs`'s own
 * `!read.exists` only, `failures.mjs`/`stats.mjs`'s `!read.exists ||
 * !read.days.length`) behind one flag.
 *
 * `missingDaysSince` had NO test anywhere before this: none of the three
 * CLIs' own test suites exercised a day-gap fixture. Characterized here
 * directly, with a controlled `now`/`fromDay` rather than a fixture store
 * timed off the real clock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	makeFail,
	missingDaysSince,
	parseDaysArg,
	rawFlag,
	readRollupStore,
	rollupWindow,
	tryReadStore,
} from './rollup-cli.mjs';

// ── makeFail ─────────────────────────────────────────────────────────────────

test('makeFail: --json mode emits {ok:false, error} and exits 1', () => {
	const emitted = [];
	const out = { json: true, emit: (doc) => emitted.push(doc) };
	let exitCode = null;
	const realExit = process.exit;
	process.exit = (code) => {
		exitCode = code;
	};
	try {
		makeFail(out)('boom');
	} finally {
		process.exit = realExit;
	}
	assert.deepEqual(emitted, [{ ok: false, error: 'boom' }]);
	assert.equal(exitCode, 1);
});

test('makeFail: human mode prints to stderr and exits 1, never emits a doc', () => {
	const out = { json: false, emit: () => assert.fail('must not emit in human mode') };
	let exitCode = null;
	const realExit = process.exit;
	const realError = console.error;
	const lines = [];
	process.exit = (code) => {
		exitCode = code;
	};
	console.error = (line) => lines.push(line);
	try {
		makeFail(out)('boom');
	} finally {
		process.exit = realExit;
		console.error = realError;
	}
	assert.deepEqual(lines, ['✗ boom']);
	assert.equal(exitCode, 1);
});

// ── rollupWindow ─────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
/** A day string `n` days before `now` — never an absolute calendar date. */
const dayBefore = (now, n) => new Date(now - n * DAY_MS).toISOString().slice(0, 10);

test('rollupWindow: filters to days at or after fromDay, inclusive', () => {
	const now = Date.now();
	const read = {
		days: [{ day: dayBefore(now, 9) }, { day: dayBefore(now, 5) }, { day: dayBefore(now, 1) }],
	};
	const { fromDay, inRange } = rollupWindow(read, { days: 5, now });
	assert.equal(fromDay, dayBefore(now, 5));
	assert.deepEqual(
		inRange.map((d) => d.day),
		[dayBefore(now, 5), dayBefore(now, 1)]
	);
});

// ── tryReadStore ─────────────────────────────────────────────────────────────

test('tryReadStore: a successful read is passed through unwrapped', () => {
	const r = tryReadStore(() => ({ exists: true, rows: [1, 2] }), '/tmp/x');
	assert.equal(r.ok, true);
	assert.deepEqual(r.read, { exists: true, rows: [1, 2] });
});

test('tryReadStore: a thrown read is "could not read", never an uncaught exception', () => {
	const r = tryReadStore(() => {
		throw new Error('EACCES');
	}, '/tmp/locked');
	assert.equal(r.ok, false);
	assert.match(r.why, /could not read \/tmp\/locked: EACCES/);
});

// ── rawFlag ──────────────────────────────────────────────────────────────────

test('rawFlag: absent is null, present-with-nothing-after is empty string', () => {
	const parsed = { value: (n) => (n === '--days' ? null : '14') };
	assert.equal(rawFlag(['--node', 'claw-1'], parsed, '--days'), null);
	assert.equal(rawFlag(['--days'], parsed, '--days'), '');
	assert.equal(rawFlag(['--days=14'], { value: () => '14' }, '--days'), '14');
});

// ── parseDaysArg ─────────────────────────────────────────────────────────────

test('parseDaysArg: absent defaults to 14', () => {
	assert.deepEqual(parseDaysArg(null), { days: 14, error: null });
});

test('parseDaysArg: a custom fallback is honoured', () => {
	assert.deepEqual(parseDaysArg(null, 7), { days: 7, error: null });
});

test('parseDaysArg: a valid override parses to a number', () => {
	assert.deepEqual(parseDaysArg('30'), { days: 30, error: null });
});

for (const bad of ['nope', '0', '-1', '1.5', '']) {
	test(`parseDaysArg: "${bad}" is rejected, never silently defaulted`, () => {
		const r = parseDaysArg(bad);
		assert.equal(r.days, null);
		assert.match(r.error, /--days must be a positive integer/);
		assert.match(r.error, new RegExp(`got "${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
	});
}

// ── missingDaysSince ─────────────────────────────────────────────────────────

test('missingDaysSince: a contiguous range has no gaps', () => {
	const now = Date.now();
	const fromDay = dayBefore(now, 10);
	// Every day from `fromDay` through TODAY is held — well past whatever
	// SETTLE_HOURS makes closable by `now`, deliberately not hard-coding that
	// boundary here.
	const inRangeDays = Array.from({ length: 11 }, (_, n) => ({ day: dayBefore(now, n) }));
	const missing = missingDaysSince(inRangeDays, { fromDay, now });
	assert.deepEqual(missing, []);
});

test('missingDaysSince: a day the store never closed is named, not skipped', () => {
	const now = Date.now();
	const fromDay = dayBefore(now, 10);
	// 9-days-ago is held; 10-days-ago (and whatever else falls before the
	// settle ceiling) is not — both must be named.
	const inRangeDays = [{ day: dayBefore(now, 9) }];
	const missing = missingDaysSince(inRangeDays, { fromDay, now });
	assert.ok(missing.includes(fromDay), JSON.stringify(missing));
	assert.ok(!missing.includes(dayBefore(now, 9)), JSON.stringify(missing));
});

test('missingDaysSince: an empty store names every closable day in range', () => {
	const now = Date.now();
	const fromDay = dayBefore(now, 10);
	const missing = missingDaysSince([], { fromDay, now });
	assert.ok(missing.length > 0);
	assert.ok(missing.every((d) => d >= fromDay));
	assert.deepEqual(missing, [...missing].sort());
});

// ── readRollupStore ──────────────────────────────────────────────────────────

function withTmp(fn) {
	const dir = mkdtempSync(join(tmpdir(), 'rollup-cli-'));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test('readRollupStore: a missing file is "no rollups", not a thrown error', () => {
	withTmp((dir) => {
		const file = join(dir, 'job-rollups.jsonl');
		const r = readRollupStore(file, { requireDays: false, contrastPhrase: '"no jobs"' });
		assert.equal(r.read, null);
		assert.match(r.error, /no rollups at/);
		assert.match(r.error, /not "no jobs"/);
	});
});

test("readRollupStore: requireDays=false (job-rollups.mjs's case) accepts an existing store with zero days", () => {
	withTmp((dir) => {
		const file = join(dir, 'job-rollups.jsonl');
		writeFileSync(file, '');
		const r = readRollupStore(file, { requireDays: false, contrastPhrase: '"no jobs"' });
		assert.equal(r.error, null);
		assert.equal(r.read.exists, true);
		assert.deepEqual(r.read.days, []);
	});
});

test('readRollupStore: requireDays=true (failures.mjs/stats.mjs\'s case) treats an existing-but-empty store as "could not look" too', () => {
	withTmp((dir) => {
		const file = join(dir, 'job-rollups.jsonl');
		writeFileSync(file, '');
		const r = readRollupStore(file, { requireDays: true, contrastPhrase: '"zero failures"' });
		assert.equal(r.read, null);
		assert.match(r.error, /not "zero failures"/);
	});
});

test('readRollupStore: a real row makes it through with requireDays true', () => {
	withTmp((dir) => {
		const file = join(dir, 'job-rollups.jsonl');
		const now = Date.now();
		const dayString = dayBefore(now, 1);
		const row = {
			schema: 1,
			day: dayString,
			writtenAt: `${dayString}T06:00:00.000Z`,
			completeSince: `${dayString}T00:00:00.000Z`,
			records: 1,
			probesExcluded: 0,
			rows: [],
		};
		writeFileSync(file, `${JSON.stringify(row)}\n`);
		const r = readRollupStore(file, { requireDays: true, contrastPhrase: '"zero failures"' });
		assert.equal(r.error, null);
		assert.equal(r.read.days.length, 1);
	});
});
