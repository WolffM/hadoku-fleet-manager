import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
	DEFAULT_ADMIN_USER,
	ciIsSeparate,
	nodeCommand,
	nodeHome,
	nodeUser,
} from '../lib/node-users.js';

const migrated = { users: { admin: 'hadoku', ci: 'hadoku-ci' } };

test('a node that names no users runs everything as the admin default: what is true before a cutover', () => {
	assert.equal(nodeUser({}, 'admin'), DEFAULT_ADMIN_USER);
	assert.equal(nodeUser({}, 'ci'), DEFAULT_ADMIN_USER);
	assert.equal(nodeUser(null, 'ci'), DEFAULT_ADMIN_USER);
	assert.equal(ciIsSeparate({}), false);
});

test('a migrated node answers each role with its own user', () => {
	assert.equal(nodeUser(migrated, 'admin'), 'hadoku');
	assert.equal(nodeUser(migrated, 'ci'), 'hadoku-ci');
	assert.equal(ciIsSeparate(migrated), true);
	assert.equal(nodeHome(migrated, 'ci'), '/home/hadoku-ci');
});

test('a malformed name THROWS: falling back to admin would run jobs as the user roles keep them from', () => {
	assert.throws(() => nodeUser({ users: { ci: 'Hadoku CI' } }, 'ci'), /users\.ci/);
	assert.throws(() => nodeUser({ users: { ci: 42 } }, 'admin'), /users\.ci/);
	assert.throws(() => nodeUser({ users: { admin: '' } }, 'ci'), /users\.admin/);
});

test('remote: ssh logs in AS the role', () => {
	const [bin, argv] = nodeCommand('claw-5', 'ci', 'echo hi', migrated, { self: 'hokon' });
	assert.equal(bin, 'ssh');
	assert.equal(argv.at(-2), 'hadoku-ci@claw-5');
	assert.equal(argv.at(-1), 'echo hi');
	assert.equal(
		nodeCommand('claw-5', 'admin', 'x', migrated, { self: 'hokon' })[1].at(-2),
		'hadoku@claw-5'
	);
});

test('local: a role admin plays runs as this process; a role with its own user only if this process IS it', () => {
	const self = { self: 'claw-5', localUser: 'hadoku' };
	assert.deepEqual(nodeCommand('claw-5', 'admin', 'x', migrated, self), ['bash', ['-c', 'x']]);
	assert.deepEqual(nodeCommand('claw-5', 'ci', 'x', {}, self), ['bash', ['-c', 'x']]);
	assert.throws(() => nodeCommand('claw-5', 'ci', 'x', migrated, self), /needs hadoku-ci/);
	assert.deepEqual(
		nodeCommand('claw-5', 'ci', 'x', migrated, { self: 'claw-5', localUser: 'hadoku-ci' }),
		['bash', ['-c', 'x']]
	);
});
