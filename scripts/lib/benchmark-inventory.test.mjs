import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { degradedFinding } from './benchmark-inventory.mjs';

test('an UNPRIVILEGED capture that loses a field is told to re-run with root', () => {
	assert.match(
		degradedFinding({ node: 'hokon', lost: ['disk.smartHealth'], rooted: 'no' }),
		/^hokon: needs a rooted capture — .*disk\.smartHealth/
	);
	// A capture from before capture.root existed makes no claim either way.
	assert.doesNotMatch(
		degradedFinding({ node: 'claw-9', lost: ['x'], rooted: null }),
		/rooted capture/
	);
});
