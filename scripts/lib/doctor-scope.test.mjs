import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { diskVerdict, DISK_CATEGORIES } from './doctor-scope.mjs';
import { ADVISORY, backstopAdvisory } from './preflight.mjs';

const f = (node, category, cls = 'blocking') => ({
	node,
	category,
	class: cls,
	status: 'full',
	why: `${node} ${category}`,
});

// The 2026-11-22 record, shape for shape: claw-5's root at 2.9%, the backstop's
// root and _work at 5.6%, and the backstop's two every-night findings.
const NIGHT = [
	f('claw-5', 'disk-free'),
	f('hokon', 'disk-free'),
	f('hokon', 'disk-work-free'),
	f('hokon', 'cpu-thermal'),
	f('hokon', 'smart-health'),
	f('claw-4', 'cpu-load', ADVISORY),
	f('claw-9', 'disk-free', ADVISORY),
];

test('--disk judges disk findings only, backstop included', () => {
	const classified = backstopAdvisory(NIGHT, new Set(['hokon']));
	const judged = diskVerdict(classified).map((x) => `${x.node}:${x.category}`);
	assert.deepEqual(judged, ['claw-5:disk-free', 'hokon:disk-free', 'hokon:disk-work-free']);
});

test("the backstop's every-night findings do not decide a --disk run", () => {
	const classified = backstopAdvisory(
		[f('hokon', 'cpu-thermal'), f('hokon', 'smart-health')],
		new Set(['hokon'])
	);
	assert.deepEqual(diskVerdict(classified), []);
});

test('an advisory disk finding (under 20%, over 10%) does not fail it', () => {
	assert.deepEqual(diskVerdict([f('claw-9', 'disk-free', ADVISORY)]), []);
});

test('a node with no usable record fails it: could not look is not healthy', () => {
	const judged = diskVerdict([f('claw-7', 'unreachable')]);
	assert.equal(judged.length, 1);
	assert.equal(judged[0].category, 'unreachable');
});

// A renamed category would leave --disk judging nothing and passing forever, so
// the scope is pinned to the strings the storage findings actually emit.
test('every scoped category is one doctor-findings-storage emits', () => {
	const src = readFileSync(new URL('./doctor-findings-storage.mjs', import.meta.url), 'utf8');
	for (const c of DISK_CATEGORIES) assert.ok(src.includes(`'${c}'`), `${c} is not emitted`);
});
