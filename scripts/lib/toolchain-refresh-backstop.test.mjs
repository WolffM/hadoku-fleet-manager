/**
 * `refreshBackstopRecord` / `refreshBackstopDoctorFailed` against fixture
 * doctor reports — no node, no ssh, no manifest resolution. The claim under
 * test: `fleet converge-toolchain --refresh`'s report carries hadoku_site#527's
 * `backstop` field, shape unchanged from `runDoctor`'s own block, and never
 * drops a backstop node that could not be read into silence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	refreshBackstopDoctorFailed,
	refreshBackstopRecord,
} from './toolchain-refresh-backstop.mjs';

const CLAW_MANIFEST = { machines: { claw: { role: 'claw' } } };
const BACKSTOP_MANIFEST = { machines: { hokon: { role: 'backstop' } } };
const MIXED_MANIFEST = {
	machines: { claw: { role: 'claw' }, hokon: { role: 'backstop' } },
};

test('a backstop machine with a block is copied in unchanged, keyed by machine name', () => {
	const block = { advisory: true, availableMb: 4096, advisories: [] };
	const report = [{ machine: 'hokon', unreachable: false, backstop: block }];
	const out = refreshBackstopRecord(report, BACKSTOP_MANIFEST);
	assert.deepEqual(out, { hokon: block });
	// Unchanged in shape: the SAME reference, not a re-derived copy.
	assert.equal(out.hokon, block);
});

test('a claw (no backstop block, not the backstop) is left out entirely', () => {
	const report = [{ machine: 'claw', unreachable: false }];
	const out = refreshBackstopRecord(report, CLAW_MANIFEST);
	assert.deepEqual(out, {});
});

test('the backstop unreachable: no block was ever built, but the record keeps an {error} entry', () => {
	const report = [{ machine: 'hokon', unreachable: true, error: 'ssh: connect timed out' }];
	const out = refreshBackstopRecord(report, BACKSTOP_MANIFEST);
	assert.deepEqual(out, { hokon: { error: 'ssh: connect timed out' } });
});

test('the backstop unreachable with no error message still gets a non-empty reason', () => {
	const report = [{ machine: 'hokon', unreachable: true }];
	const out = refreshBackstopRecord(report, BACKSTOP_MANIFEST);
	assert.equal(typeof out.hokon.error, 'string');
	assert.ok(out.hokon.error.length > 0);
});

test('mixed fleet: only the backstop appears, the claw does not, regardless of order', () => {
	const report = [
		{ machine: 'claw', unreachable: false },
		{ machine: 'hokon', unreachable: false, backstop: { advisory: true } },
	];
	const out = refreshBackstopRecord(report, MIXED_MANIFEST);
	assert.deepEqual(Object.keys(out), ['hokon']);
});

test('runDoctor throwing before any machine was probed: the record names the doctor itself, not a node', () => {
	const out = refreshBackstopDoctorFailed(
		new Error('fleet-runner-manifest.json has no `toolchain` section')
	);
	assert.deepEqual(out, {
		_doctor: { error: 'fleet-runner-manifest.json has no `toolchain` section' },
	});
});

test('runDoctor throwing a non-Error value still stringifies into a reason', () => {
	const out = refreshBackstopDoctorFailed('plain string failure');
	assert.deepEqual(out, { _doctor: { error: 'plain string failure' } });
});

test('advisory-only: nothing here ever produces a "finding" or "ok" shaped key', () => {
	const report = [{ machine: 'hokon', unreachable: false, backstop: { advisory: true } }];
	const out = refreshBackstopRecord(report, BACKSTOP_MANIFEST);
	for (const block of Object.values(out)) {
		assert.ok(!('finding' in block));
		assert.ok(!('ok' in block));
	}
});
