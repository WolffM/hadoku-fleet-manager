import assert from 'node:assert/strict';
import { test } from 'node:test';

import { onAbort, runAbortHooks } from './qualify-abort.mjs';

void test('every registered stop runs once, a removed one does not, and failures are said', async () => {
	const ran = [];
	onAbort(async () => ran.push('load'));
	const off = onAbort(async () => ran.push('stopped already'));
	off();
	onAbort(async () => {
		throw new Error('LOAD_LEFT pid 7');
	});
	assert.deepEqual(await runAbortHooks(1000), ['LOAD_LEFT pid 7']);
	assert.deepEqual(ran, ['load']);
	assert.deepEqual(await runAbortHooks(1000), [], 'run once: the set is emptied');
});

void test('a stop that hangs cannot hold the exit past the budget', async () => {
	onAbort(() => new Promise(() => {}));
	const why = await runAbortHooks(50);
	assert.match(why[0], /1 stop\(s\) still running after 50 ms/);
});
