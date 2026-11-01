/**
 * floor-probe's §5 flaky rule — split out of `floor-probe.test.mjs` (wave 5q
 * lane A, whole-block split) so that file reaches the 1,000-line test
 * ceiling. These exercise `floor-probe-flaky.mjs`, which also owns the
 * composite key (`tripleKey`/`TRIPLE_SEP`) the last two tests are about.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { FLAKY_POINTS, RECOVERY_PROBES, flakyVerdicts } from './floor-probe-flaky.mjs';

// ---------------------------------------------------------------------------
// The flaky rule
// ---------------------------------------------------------------------------

const point = (against, node = 'claw-3') => ({
	node,
	repo: 'WolffM/hadoku-pygmalion',
	job: 'test',
	conclusion: 'success',
	against,
});
const ran = (node, conclusion) => ({
	node,
	repo: 'WolffM/hadoku-pygmalion',
	job: 'test',
	conclusion,
});

test('one cross-node point is never a verdict', () => {
	assert.deepEqual(flakyVerdicts([point('claw-2')]), []);
});

test('two points against the same triple with no intervening pass IS the verdict', () => {
	const v = flakyVerdicts([point('claw-2'), point('claw-2')]);
	assert.equal(v.length, 1);
	assert.equal(v[0].node, 'claw-2');
	assert.equal(v[0].job, 'test');
	assert.equal(v[0].points, FLAKY_POINTS);
});

test('an intervening pass on that node for that unit resets the points', () => {
	assert.deepEqual(
		flakyVerdicts([point('claw-2'), ran('claw-2', 'success'), point('claw-2')]),
		[],
		'"two such points ... with no intervening pass" is the rule, verbatim'
	);
});

test('the verdict is scoped to the unit, never to the node', () => {
	const v = flakyVerdicts([
		point('claw-2'),
		point('claw-2'),
		{ node: 'claw-3', repo: 'WolffM/hadoku_site', job: 'lint', conclusion: 'success' },
	]);
	assert.equal(v.length, 1);
	assert.equal(v[0].repo, 'WolffM/hadoku-pygmalion');
});

test('five consecutive clean probes clear a flaky verdict', () => {
	const history = [point('claw-2'), point('claw-2')];
	for (let i = 0; i < RECOVERY_PROBES; i++) history.push(ran('claw-2', 'success'));
	assert.deepEqual(flakyVerdicts(history), [], 'recovery is symmetric and un-sticky');
});

test('a failure part-way through recovery restarts the count', () => {
	const history = [point('claw-2'), point('claw-2')];
	for (let i = 0; i < RECOVERY_PROBES - 1; i++) history.push(ran('claw-2', 'success'));
	history.push(ran('claw-2', 'failure'));
	history.push(ran('claw-2', 'success'));
	assert.equal(flakyVerdicts(history).length, 1, 'CONSECUTIVE means consecutive');
});

// ---------------------------------------------------------------------------
// The composite key
// ---------------------------------------------------------------------------

test('a job name containing a space survives the flaky triple key', () => {
	// `hadoku_site` really has a job called `Build variants`. With a SPACE
	// separator the key destructures to job `Build` — a verdict scoped to a unit
	// that does not exist, which is exactly the mis-attribution §5.4 forbids.
	const v = flakyVerdicts([
		{
			node: 'claw-3',
			repo: 'WolffM/hadoku_site',
			job: 'Build variants',
			conclusion: 'success',
			against: 'claw-2',
		},
		{
			node: 'claw-3',
			repo: 'WolffM/hadoku_site',
			job: 'Build variants',
			conclusion: 'success',
			against: 'claw-2',
		},
	]);
	assert.equal(v.length, 1);
	assert.deepEqual(
		{ node: v[0].node, repo: v[0].repo, job: v[0].job },
		{ node: 'claw-2', repo: 'WolffM/hadoku_site', job: 'Build variants' }
	);
});

test('this module carries no unprintable literals', () => {
	// It carried seven NUL bytes — the composite-key separator, typed rather than
	// escaped. Everything WORKED: join and split agreed. But git classifies a file
	// containing a NUL as binary, so `git diff`, `git grep` and code review all
	// went silent on it, which is how it survived a full review pass.
	//
	// SCANS THE WHOLE `floor-probe*.mjs` FAMILY, not just the two files this
	// repo started with (wave 5q lane A split both of them into several). A
	// hardcoded pair would stop covering the separator's new home the moment it
	// moved, and silently say nothing about every sibling split out beside it.
	const here = new URL('.', import.meta.url).pathname;
	const family = readdirSync(here).filter((f) => f.startsWith('floor-probe') && f.endsWith('.mjs'));
	assert.ok(family.length >= 2, 'the family scan itself found nothing — the glob is wrong');
	for (const f of family) {
		const raw = readFileSync(join(here, f));
		const at = raw.indexOf(0);
		assert.equal(at, -1, `${f} contains a NUL byte at offset ${at} — write it as \\u0000`);
	}
});
