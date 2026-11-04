import assert from 'node:assert/strict';
import { test } from 'node:test';

import { tenantSlices } from './hosting-demand.mjs';

const SOON = new Date(Date.now() + 15 * 60_000).toISOString();

test('a shrinking slice is declared, with its end and size; a plain end is ending; a standby is neither', () => {
	const on = {
		'claw-8': [
			{
				tenant: 'cardtable',
				mode: 'shared',
				memoryMb: 12288,
				cores: 12,
				until: SOON,
				shrinkTo: { memoryMb: 4096, cores: 4 },
			},
		],
		'claw-9': [
			{
				tenant: 'cardtable',
				mode: 'shared',
				memoryMb: 4096,
				cores: 4,
				until: SOON,
			},
		],
		'claw-10': [{ tenant: 'cardtable', mode: 'shared', memoryMb: 8192, cores: 8 }],
		'claw-5': [{ tenant: 'cardtable', mode: 'shared', memoryMb: 4096, cores: 4, role: 'standby' }],
	};
	const { declared, ending } = tenantSlices('cardtable', Object.keys(on), (n) => on[n]);
	assert.deepEqual(declared, [
		{
			node: 'claw-8',
			mode: 'shared',
			memoryMb: 12288,
			cores: 12,
			until: SOON,
			shrinkTo: { memoryMb: 4096, cores: 4 },
		},
		{ node: 'claw-10', mode: 'shared', memoryMb: 8192, cores: 8 },
	]);
	assert.deepEqual(ending, [{ node: 'claw-9', until: SOON }]);
});
