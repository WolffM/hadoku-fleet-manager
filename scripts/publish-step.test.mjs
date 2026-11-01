/**
 * publish.yml's version and publish wiring.
 *
 * The version decision itself (registry newest + 1, never written back, and a
 * re-run of the publishing commit recognised by its gitHead) is hadoku-actions'
 * next-version, tested there against a stand-in npm.
 * What can break HERE is the wiring: the Publish step must run only when
 * next-version says this commit has not already published, and nothing in this
 * workflow may refuse an "already published" version or commit one back, which
 * is the flow ppe promotion retired (2026-11-01).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripYamlComments } from './lib/yaml-comments.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = stripYamlComments(
	readFileSync(join(ROOT, '.github', 'workflows', 'publish.yml'), 'utf8')
);

/** The lines of the step named `name`, up to the next step. */
function step(name) {
	const lines = WORKFLOW.split('\n');
	const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
	assert.notEqual(at, -1, `no step named "${name}" in publish.yml`);
	const indent = lines[at].search(/\S/);
	const end = lines.findIndex(
		(l, i) => i > at && l.search(/\S/) === indent && l.trim().startsWith('- ')
	);
	return lines.slice(at, end === -1 ? undefined : end).join('\n');
}

test('the version comes from next-version, before the publish', () => {
	const version = step('Version');
	assert.match(version, /uses: WolffM\/hadoku-actions\/next-version@v1/);
	assert.match(version, /id: version/);
	assert.ok(WORKFLOW.indexOf('- name: Version') < WORKFLOW.indexOf('- name: Publish'));
});

test('a re-run of the commit that published skips the publish, and still reaches the dispatch', () => {
	assert.match(step('Publish'), /if: .*steps\.version\.outputs\.published != 'true'/);
	assert.doesNotMatch(
		step('Dispatch packages_updated to hadoku_site'),
		/steps\.version\.outputs\.published/,
		'the dispatch is what a re-run exists to retry'
	);
});

test('nothing refuses an already-published version or writes one back', () => {
	assert.doesNotMatch(WORKFLOW, /already published/i);
	assert.doesNotMatch(WORKFLOW, /git (commit|push)/);
	assert.doesNotMatch(WORKFLOW, /contents: write/);
});
