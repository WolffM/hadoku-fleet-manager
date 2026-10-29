import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
	judgeNodeAccounts,
	judgeNodeUsers,
	parseUsersObservation,
	usersObserveScript,
} from './node-users-facet.mjs';
import { TENANT_USER_SUFFIXES } from './tenant-registry.mjs';

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
			secretArgv: 0,
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

test('a runner with --jitconfig on its command line is blocking, cut over or not', () => {
	const cut = judge({ secretArgv: 1 });
	assert.equal(cut.state, 'drift');
	assert.match(why(cut)[0], /--jitconfig on a world-readable command line/);
	const admin = judge({ secretArgv: 2 }, {});
	assert.equal(admin.state, 'not-cut-over');
	assert.ok(
		admin.findings.some((f) => f.category === 'runner-secret-in-argv' && f.class === 'blocking')
	);
	assert.match(usersObserveScript(CUT), /grep -qx -- '--jitconfig'/);
});

// ── phase 2: every account claimed from the record that creates it ──────────

// VERBATIM, 2026-10-29, the account lines of usersObserveScript on claw-4.
const CLAW4_ACCOUNTS = [
	'accountsRead=yes',
	'account=hadoku:1000:/bin/bash:hadoku,adm,sudo,users,systemd-journal,docker:1:-',
	'account=hadoku-ci:1001:/bin/bash:hadoku-ci:0:-',
	'account=archivebot-svc:988:/usr/sbin/nologin:archivebot-svc:0:33',
	'account=pygmalion-svc:987:/usr/sbin/nologin:pygmalion-svc:0:30',
];
const REGISTERED = [
	{ app: 'archivebot', user: 'archivebot-svc' },
	{ app: 'pygmalion', user: 'pygmalion-svc' },
	{ app: 'cardtable', user: 'cardtable-agent' },
];
const observe = (lines) =>
	parseUsersObservation(['USERS-BEGIN', 'runnerProcs=0', ...lines, 'USERS-END'].join('\n'));
const accounts = (lines, machine = CUT) => judgeNodeAccounts(machine, observe(lines), REGISTERED);
const one = (line, machine) => accounts(['accountsRead=yes', line], machine);

test('the account lines parse, groups and slice processes included', () => {
	const obs = observe(CLAW4_ACCOUNTS);
	assert.equal(obs.accounts.length, 4);
	assert.deepEqual(obs.accounts[2], {
		name: 'archivebot-svc',
		uid: 988,
		shell: '/usr/sbin/nologin',
		groups: ['archivebot-svc'],
		sudo: 0,
		sliceTasks: 33,
	});
	assert.equal(obs.accounts[0].sliceTasks, null, "'-' is no slice, not zero tasks");
});

test('admin, ci and every running registered tenant are claimed, with nothing to say', () => {
	assert.deepEqual(accounts(CLAW4_ACCOUNTS), []);
});

test('a kept tenant user with nothing running is advisory: --remove keeps it by design', () => {
	// claw-5, cardtable's A11 test (declare, then --remove, 2026-10-27).
	for (const procs of ['0', '-']) {
		const f = one(`account=cardtable-agent:988:/usr/sbin/nologin:cardtable-agent:0:${procs}`);
		assert.deepEqual(
			f.map((x) => [x.class, x.category]),
			[['advisory', 'tenant-user-kept']],
			procs
		);
	}
});

test("a tenant slice whose task count cannot be read is could not look, never 'nothing running'", () => {
	// claw-8, 2026-10-29: cardtable delegates sub-cgroups admin cannot enter, so
	// walking cgroup.procs counted 0 under a live 2.5 GB slice. pids.current is
	// the kernel's own subtree count; an unreadable one must not read as kept.
	const f = one('account=cardtable-agent:999:/usr/sbin/nologin:cardtable-agent:0:U');
	assert.deepEqual(
		f.map((x) => [x.class, x.category]),
		[['blocking', 'tenant-user-drift']]
	);
	assert.match(f[0].why, /could not read whether cardtable runs here/);
	assert.match(usersObserveScript(CUT), /cat "\$c\/pids.current"/);
});

test('an account no role and no tenant claims is BLOCKING', () => {
	// claw-1/2/3 until 2026-10-29: openclaw, uid 1001, sudo.
	const f = one('account=openclaw:1001:/bin/bash:openclaw,sudo:1:-');
	assert.equal(f[0].class, 'blocking');
	assert.equal(f[0].category, 'unclaimed-user');
	assert.match(f[0].why, /openclaw \(uid 1001, \/bin\/bash\) is claimed by no role/);
});

test("a tenant's user may not log in, sudo, or share a group with ci, running or kept", () => {
	const drift = (line) =>
		one(line)
			.filter((x) => x.class === 'blocking')
			.map((x) => [x.category, x.why]);
	assert.deepEqual(drift('account=archivebot-svc:988:/bin/bash:archivebot-svc:0:3'), [
		['tenant-user-drift', 'archivebot-svc has a login shell, /bin/bash'],
	]);
	assert.deepEqual(drift('account=archivebot-svc:988:/usr/sbin/nologin:archivebot-svc:1:-'), [
		['tenant-user-drift', 'archivebot-svc may run sudo'],
	]);
	assert.deepEqual(
		drift('account=archivebot-svc:988:/usr/sbin/nologin:archivebot-svc,hadoku-ci:0:3'),
		[['tenant-user-drift', 'archivebot-svc shares the group hadoku-ci with CI']]
	);
	assert.deepEqual(drift('account=archivebot-svc:988:/usr/sbin/nologin:archivebot-svc:U:3'), [
		['tenant-user-drift', "could not read archivebot-svc's sudo rights"],
	]);
});

test('on a node not cut over, a user named like the ci user is not claimed by it', () => {
	assert.equal(
		one('account=hadoku-ci:1001:/bin/bash:hadoku-ci:0:-', {})[0].category,
		'unclaimed-user'
	);
});

test('an unreadable account database is could not look, never a clean node', () => {
	const f = judgeNodeAccounts(CUT, observe(['accountsRead=no']), []);
	assert.equal(f[0].class, 'blocking');
	assert.equal(f[0].category, 'accounts-unobserved');
	assert.equal(judgeNodeAccounts(CUT, null, [])[0].category, 'accounts-unobserved');
});

test("the observation selects tenant users by the runtimes' own suffixes", () => {
	assert.deepEqual(TENANT_USER_SUFFIXES, ['-agent', '-svc']);
	const s = usersObserveScript(CUT);
	for (const x of TENANT_USER_SUFFIXES) assert.ok(s.includes(`$1 ~ /${x}$/`), x);
	assert.match(s, /\$3!=0 && \(\(\$3>=1000 && \$3<60000\)/);
});
