import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	HEAVY_MARK_MS,
	HEAVY_MARK_REFILL_MS,
	HEAVY_MARKS_FILE,
	heavyMarkWithholds,
	readHeavyMarks,
	writeHeavyMarks,
} from '../runners/heavy-marks.js';

const dir = () => mkdtempSync(join(tmpdir(), 'heavy-marks-'));

test('the marks a pass writes are the marks the canary reads back', () => {
	const d = dir();
	writeHeavyMarks(
		new Map([
			['claw-4', 1_000],
			['claw-8', 2_000],
		]),
		d
	);
	assert.deepEqual(readHeavyMarks(d), { 'claw-4': 1_000, 'claw-8': 2_000 });
});

test('no file yet is no marks; a file that will not parse is null, not "no marks"', () => {
	const d = dir();
	assert.deepEqual(readHeavyMarks(d), {});
	writeFileSync(join(d, HEAVY_MARKS_FILE), '{"claw-4": 1');
	assert.equal(readHeavyMarks(d), null);
	writeFileSync(join(d, HEAVY_MARKS_FILE), '[1,2]');
	assert.equal(readHeavyMarks(d), null);
});

test('a mark withholds through the mark and its refill, then lapses', () => {
	const marks = { 'claw-4': 1_000_000 };
	const end = 1_000_000 + HEAVY_MARK_MS + HEAVY_MARK_REFILL_MS;
	assert.equal(heavyMarkWithholds(marks, 'claw-4', 1_000_000), 0);
	assert.equal(heavyMarkWithholds(marks, 'claw-4', end - 1), end - 1 - 1_000_000);
	assert.equal(heavyMarkWithholds(marks, 'claw-4', end), null);
	assert.equal(heavyMarkWithholds(marks, 'claw-6', 1_000_000), null, 'an unmarked node');
	assert.equal(heavyMarkWithholds(marks, 'claw-4', 999_999), null, 'a mark from the future');
});

test('REPLAY 2026-11-05 20:00Z: claw-4, cardtable placed 19:59:04, canary 20:00:07, refilled 20:01:36', () => {
	const placed = Date.parse('2026-11-05T19:59:04.627Z');
	const marks = { 'claw-4': placed };
	assert.notEqual(heavyMarkWithholds(marks, 'claw-4', Date.parse('2026-11-05T20:00:07Z')), null);
	assert.notEqual(
		heavyMarkWithholds(marks, 'claw-4', Date.parse('2026-11-05T20:01:36Z')),
		null,
		'still inside the refill the warm cache took'
	);
});
