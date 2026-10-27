import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { USER_HALF, ciNotes, mergeSplitSummary } from './slice-split.mjs';

const ADMIN = {
	sudo_ok: 'yes',
	live_max: '27904M',
	cfg_max: '27904M',
	user_max: 'max',
	in_slice: '0',
	mint_total: '0',
	changed: '1',
	failed: '0',
	busy: '0',
};
const CI = {
	sudo_ok: 'no',
	live_max: '-',
	user_max: '29262610432',
	in_slice: '3',
	mint_total: '3',
	mint_in_slice: '3',
	changed: '2',
	failed: '0',
	busy: '1',
};

test("a cut-over node's slice: the system half from admin, the user-manager half from ci", () => {
	const m = mergeSplitSummary(ADMIN, CI);
	// System half: only admin can see or write it.
	assert.equal(m.sudo_ok, 'yes');
	assert.equal(m.live_max, '27904M');
	assert.equal(m.cfg_max, '27904M');
	// User half: the manager every minted unit lives in is ci's.
	assert.equal(m.user_max, '29262610432');
	assert.equal(m.in_slice, '3');
	assert.equal(m.mint_in_slice, '3');
	// Counters add up.
	assert.equal(m.changed, '3');
	assert.equal(m.busy, '1');
	assert.ok(USER_HALF.includes('user_max') && !USER_HALF.includes('live_max'));
});

test("ci's NEEDS-OPERATOR is the system half it cannot write, which admin's run already owns", () => {
	assert.deepEqual(
		ciNotes(['NEEDS-OPERATOR system slice needs sudo', 'UNIT-CAP-DRIFT jit-x', 'BUSY warm-y']),
		['UNIT-CAP-DRIFT jit-x', 'BUSY warm-y']
	);
});
