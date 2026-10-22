import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
	DISPATCH_DAILY_FILE,
	dispatchForDay,
	readDispatchDaily,
	recordDispatchDay,
} from '../runners/dispatch-daily.js';
import { testStateDir } from './install-test-host.js';

const file = join(testStateDir, DISPATCH_DAILY_FILE);
beforeEach(() => rmSync(file, { force: true }));

const T = Date.parse('2026-10-09T10:00:00Z');

test('no file is null — never an empty history', () => {
	assert.equal(readDispatchDaily(), null);
	assert.equal(dispatchForDay(null, '2026-10-09'), null);
});

test('passes add up per UTC day and survive a re-read (a restart)', () => {
	recordDispatchDay(T, { minted: 2, failed: 0, mintedViaAffinity: 1 });
	recordDispatchDay(T + 60_000, { minted: 1, failed: 1, mintedViaAffinity: 0 });
	recordDispatchDay(T + 86_400_000, { minted: 5, failed: 0, mintedViaAffinity: 5 });
	const doc = readDispatchDaily();
	assert.deepEqual(dispatchForDay(doc, '2026-10-09'), {
		minted: 3,
		failed: 1,
		mintedViaAffinity: 1,
	});
	assert.deepEqual(dispatchForDay(doc, '2026-10-10'), {
		minted: 5,
		failed: 0,
		mintedViaAffinity: 5,
	});
});

test('before counting began is null; a quiet day since is zero', () => {
	recordDispatchDay(T, { minted: 1, failed: 0, mintedViaAffinity: 0 });
	recordDispatchDay(T + 2 * 86_400_000, { minted: 1, failed: 0, mintedViaAffinity: 0 });
	const doc = readDispatchDaily();
	assert.equal(dispatchForDay(doc, '2026-10-08'), null);
	assert.deepEqual(dispatchForDay(doc, '2026-10-10'), {
		minted: 0,
		failed: 0,
		mintedViaAffinity: 0,
	});
});

test('a pass that minted nothing and failed nothing writes nothing', () => {
	recordDispatchDay(T, { minted: 0, failed: 0, mintedViaAffinity: 0 });
	assert.equal(readDispatchDaily(), null);
});

test('days past the retention window are pruned', () => {
	recordDispatchDay(T, { minted: 1, failed: 0, mintedViaAffinity: 0 });
	recordDispatchDay(T + 30 * 86_400_000, { minted: 1, failed: 0, mintedViaAffinity: 0 });
	assert.deepEqual(Object.keys(readDispatchDaily()!.days), ['2026-11-08']);
});

test('a corrupt file is null, not an empty history', () => {
	writeFileSync(file, '{not json');
	assert.equal(readDispatchDaily(), null);
});
