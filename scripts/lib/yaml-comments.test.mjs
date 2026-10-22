import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stripYamlComments } from './yaml-comments.mjs';

test('a comment cannot be evidence for a rule', () => {
	// The 2026-08-30 case, exactly: a workflow moved OFF the fleet, annotated
	// with a comment explaining that self-hosted here queues forever, read by the
	// reconciler as wanting self-hosted runners.
	const wf = [
		'jobs:',
		'  build:',
		'    # Hosted ON PURPOSE — `self-hosted,hadoku-builder` here queues forever.',
		'    runs-on: ubuntu-latest',
	].join('\n');
	assert.match(wf, /self-hosted/, 'the raw body says it');
	assert.doesNotMatch(stripYamlComments(wf), /self-hosted/, 'the code does not');
});

test('a comment cannot clear a rule either', () => {
	// The inverse, and the reason reconcile-repo-policy strips before matching:
	// deleting a guard while keeping the comment above it kept repos green.
	const wf = '    # gated on github.event.pull_request.author_association\n    runs-on: x\n';
	assert.doesNotMatch(stripYamlComments(wf), /author_association/);
});

test('a # inside a token is not a comment', () => {
	// `ubuntu-latest#1`, a URL fragment, a colour literal. A comment opens only at
	// the start of a line or after whitespace.
	assert.equal(stripYamlComments('    runs-on: ubuntu-latest#1'), '    runs-on: ubuntu-latest#1');
	assert.equal(stripYamlComments('  url: https://x/y#frag'), '  url: https://x/y#frag');
});

test('line numbers survive', () => {
	// A finding reports a line number against the stripped source; blanking a
	// whole-line comment away would shift every line after it.
	assert.equal(stripYamlComments('a\n# gone\nb').split('\n').length, 3);
});

test('a full-line comment leaves an empty line, not its text', () => {
	assert.equal(stripYamlComments('# whole line'), '');
	assert.equal(stripYamlComments('   # indented'), '   ');
});
