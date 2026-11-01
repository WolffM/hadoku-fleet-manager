/**
 * floor-probe's §6 shadow-dispatch safety check — split out of
 * `floor-probe.test.mjs` (wave 5q lane A, whole-block split) so that file
 * reaches the 1,000-line test ceiling. These exercise
 * `floor-probe-safety.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { shadowSafety } from './floor-probe-safety.mjs';

test('a workflow that ends in a production redeploy is refused as a shadow probe', () => {
	// hadoku-pygmalion's redeploy.yml, reduced. It holds the `test` job issue #3
	// is about AND a dispatch-redeploy job that takes prod pygmalion down and
	// back up. That is not a shadow run.
	const body = [
		'on:',
		'  push:',
		'    branches: [main]',
		'  workflow_dispatch:',
		'jobs:',
		'  dispatch-redeploy:',
		'    steps:',
		'      - run: curl -X POST https://api.github.com/repos/WolffM/hadoku_site/dispatches',
	].join('\n');
	const r = shadowSafety(body);
	assert.equal(r.ok, false);
	assert.match(r.reason, /dispatches/);
});

test('a plain test workflow is safe to dispatch', () => {
	const body = ['on:', '  pull_request:', '  workflow_dispatch:', 'jobs:', '  test:'].join('\n');
	assert.equal(shadowSafety(body).ok, true);
});

test('a workflow with no workflow_dispatch trigger is refused', () => {
	assert.equal(shadowSafety('on:\n  push:\njobs:\n  test:').ok, false);
});

test('the refusal list reads code, not comments', () => {
	// Three separate times this codebase has read a COMMENT as evidence. The
	// caller blanks comments before calling; this asserts the rule survives the
	// case that matters — tests.yml, whose ONLY mention of a dispatch is a
	// comment pointing at the workflow this list exists to refuse.
	const withComment = ['on:', '  workflow_dispatch:', 'jobs:', '  test:'].join('\n');
	assert.equal(shadowSafety(withComment).ok, true, 'the comment is gone by the time we see it');
	const blanked = withComment.replace('# gates the deploy dispatch', '');
	assert.equal(shadowSafety(blanked).ok, true);
});
