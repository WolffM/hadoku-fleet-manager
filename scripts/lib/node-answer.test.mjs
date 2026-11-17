/**
 * askNode: a node is unreachable only when EVERY attempt missed, and the
 * reason keeps each attempt's own failure (fleet-manager#112).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ANSWER_ATTEMPTS, askNode, missReason, missesWhy } from './node-answer.mjs';

const parse = (stdout) => (String(stdout).includes('END') ? { ok: true } : null);
const TIMEOUT = {
	ok: false,
	stdout: 'BEGIN partial',
	stderr: '',
	error: 'no answer within 20s (killed by SIGTERM)',
};
const ANSWER = { ok: true, stdout: 'BEGIN x=1 END', stderr: '', error: null };

/** A `run` that returns the given results in order and records each call. */
function scripted(...results) {
	const calls = [];
	return {
		calls,
		run: async (node, script, opts) => {
			calls.push({ node, script, opts });
			return results[calls.length - 1];
		},
	};
}

test('a first answer is taken at once, with no misses', async () => {
	const s = scripted(ANSWER);
	const r = await askNode({ node: 'claw-fixture', script: 's', run: s.run, opts: {}, parse });
	assert.deepEqual(r, { value: { ok: true }, misses: [] });
	assert.equal(s.calls.length, 1);
});

test('one timeout then an answer is an answer, and the miss is kept', async () => {
	// The #112 shape: the path paused through the first attempt's deadline.
	const s = scripted(TIMEOUT, ANSWER);
	const opts = { as: 'admin', timeoutMs: 20_000 };
	const r = await askNode({ node: 'claw-fixture', script: 's', run: s.run, opts, parse });
	assert.deepEqual(r.value, { ok: true });
	assert.deepEqual(r.misses, ['no answer within 20s (killed by SIGTERM)']);
	assert.equal(s.calls.length, 2);
	assert.deepEqual(
		s.calls.map((c) => c.opts),
		[opts, opts],
		'the retry asks the same way'
	);
});

test('a node that misses every attempt is null, with every reason in order', async () => {
	const refused = {
		ok: false,
		stdout: '',
		stderr: 'ssh: connect: Connection refused\n',
		error: '',
	};
	const s = scripted(TIMEOUT, refused, ANSWER);
	const r = await askNode({ node: 'claw-fixture', script: 's', run: s.run, opts: {}, parse });
	assert.equal(ANSWER_ATTEMPTS, 2);
	assert.equal(r.value, null);
	assert.equal(s.calls.length, ANSWER_ATTEMPTS, 'no attempt past the limit');
	assert.deepEqual(r.misses, [
		'no answer within 20s (killed by SIGTERM)',
		'ssh: connect: Connection refused',
	]);
	assert.equal(
		missesWhy(r.misses),
		'no complete answer in 2 attempts: (1) no answer within 20s (killed by SIGTERM); (2) ssh: connect: Connection refused'
	);
});

test('missReason names a timeout before any stderr, and a cut-off answer as such', () => {
	// The old reason preferred stderr, so an ssh warning could hide a timeout.
	assert.equal(
		missReason({ ...TIMEOUT, stderr: 'Warning: Permanently added claw-fixture\n' }),
		'no answer within 20s (killed by SIGTERM)'
	);
	assert.equal(
		missReason({ ok: true, stdout: 'BEGIN', stderr: '', error: null }),
		'the node answered but its answer stopped short'
	);
	assert.equal(missReason({ ok: false, stdout: '', stderr: '', error: null }), 'no answer');
	assert.equal(missesWhy(['only one']), 'only one');
});
