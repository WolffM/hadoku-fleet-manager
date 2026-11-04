import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shrinkOf, unitsRefusal } from './hosting-units.mjs';

const request = {
	app: 'cardtable',
	slices: { unit: { memoryMb: 4096, cores: 4 }, min: 2, max: 4 },
};

test('an end with a size is a shrink only of a shared slice, to less memory and no more cores', () => {
	const rec = { memoryMb: 12288, cores: 12 };
	assert.deepEqual(shrinkOf(null, null, rec), { shrinkTo: null }, 'no size: a plain end');
	assert.deepEqual(shrinkOf('4G', '4', rec), { shrinkTo: { memoryMb: 4096, cores: 4 } });
	assert.match(shrinkOf('12G', '4', rec).why, /less memory than its 12288 MiB/);
	assert.match(shrinkOf('4G', '16', rec).why, /no more cores/);
	assert.match(shrinkOf('4G', '4', false).why, /shared slice/, 'a whole-box slice is not shrunk');
	assert.ok(shrinkOf('lots', '4', rec).why, 'an unreadable size is refused, never guessed');
});

test('slices.max counts units across every primary, a resize counting the new size', () => {
	const elsewhere = [{ memoryMb: 8192 }, { memoryMb: 4096 }];
	assert.equal(unitsRefusal(request, elsewhere, 4096), null, '2 + 1 + 1 = 4 of 4');
	assert.equal(
		unitsRefusal(request, elsewhere, 8192),
		'cardtable would hold 5 units; its slices.max is 4.'
	);
});
