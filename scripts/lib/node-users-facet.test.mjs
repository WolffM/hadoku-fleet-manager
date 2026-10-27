import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { judgeNodeUsers, parseUsersObservation, usersObserveScript } from './node-users-facet.mjs';

const CUT = { users: { admin: 'hadoku', ci: 'hadoku-ci' } };

/** A cut-over claw as it must be. */
const answer = (over = {}) =>
	[
		'USERS-BEGIN',
		...Object.entries({
			ciUid: 1001,
			ciHome: '/home/hadoku-ci',
			ciShell: '/bin/bash',
			ciGroups: 'hadoku-ci video render',
			ciHomeStat: 'hadoku-ci:700',
			ciLinger: 'yes',
			ciSudo: 0,
			sudoReadable: 'yes',
			keysRead: 'yes',
			keyLines: 1,
			keyUnrestricted: 0,
			runnerProcs: 4,
			runnersNotCi: 0,
			...over,
		}).map(([k, v]) => `${k}=${v}`),
		'USERS-END',
	].join('\n');

const judge = (over, machine = CUT) => judgeNodeUsers(machine, parseUsersObservation(answer(over)));
const why = (r) => r.findings.filter((f) => f.class === 'blocking').map((f) => f.why);

test('a cut-over node serving exactly the ci contract is ok', () => {
	assert.deepEqual(judge(), { state: 'ok', findings: [] });
});

test('a node not cut over says what that means today, as an advisory, not drift', () => {
	const r = judge({ ciSudo: 1 }, {});
	assert.equal(r.state, 'not-cut-over');
	assert.equal(r.findings[0].class, 'advisory');
	assert.match(r.findings[0].why, /has sudo: any job can become root/);
});

test('every guarantee of a declared ci user is BLOCKING when it does not hold', () => {
	assert.match(why(judge({ ciSudo: 1 }))[0], /may run sudo/);
	assert.match(why(judge({ ciGroups: 'hadoku-ci docker' }))[0], /in docker/);
	assert.match(why(judge({ ciGroups: 'hadoku-ci sudo adm' }))[0], /sudo, adm/);
	assert.match(why(judge({ ciLinger: 'no' }))[0], /no linger/);
	assert.match(why(judge({ ciHomeStat: 'hadoku-ci:755' }))[0], /not hadoku-ci-owned 0700/);
	assert.match(why(judge({ ciHome: '/var/lib/ci' }))[0], /not \/home\/hadoku-ci/);
	assert.match(why(judge({ keyUnrestricted: 1 }))[0], /lack from= and restrict/);
	assert.match(why(judge({ keyLines: 0 }))[0], /no authorized key/);
	// The one that catches a code path still minting as admin.
	assert.match(
		why(judge({ runnersNotCi: 2 }))[0],
		/2 of 4 runner process\(es\) do not run as hadoku-ci/
	);
});

test('could not look is never a pass', () => {
	assert.match(why(judge({ sudoReadable: 'no' }))[0], /could not read hadoku-ci's sudo/);
	assert.match(why(judge({ keysRead: 'no' }))[0], /could not read hadoku-ci's authorized_keys/);
	assert.match(why(judge({ runnerProcs: '' }))[0], /could not count/);
	const gone = judgeNodeUsers(CUT, parseUsersObservation(answer().replace('USERS-END', '')));
	assert.equal(gone.state, 'unobserved');
	assert.equal(gone.findings[0].class, 'blocking');
	const missing = judgeNodeUsers(
		CUT,
		parseUsersObservation('USERS-BEGIN\nrunnerProcs=0\nUSERS-END')
	);
	assert.match(why(missing)[0], /does not exist/);
});

test('the observation names users from the registry and counts runners by process name', () => {
	const s = usersObserveScript(CUT);
	assert.match(s, /^CI=hadoku-ci$/m);
	assert.match(s, /^CI_HOME=\/home\/hadoku-ci$/m);
	assert.doesNotMatch(s, /pgrep -[a-z]*f/);
	assert.match(usersObserveScript({}), /^CI=hadoku$/m);
});
