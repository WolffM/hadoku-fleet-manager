import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments } from './blank-comments.mjs';
import {
	asRole,
	COUNTERS,
	DECOY_LIFETIME_SEC,
	decoyStartScript,
	decoyStopScript,
	HOSTING_CI_WORKERS,
	judgeCounters,
	lineStarting,
	makeObserversTest,
	NOT_RUN,
	parseDecoy,
	parseReaders,
	PLAIN_PGREP,
	readersScript,
	READER_TIMEOUT_SEC,
	test as observersTest,
} from './qualify-observers.mjs';
import { validateTest } from './qualify-registry.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const src = (rel) => readFileSync(join(ROOT, rel), 'utf8');
/** A runtime string as it is spelled inside a single-quoted JS literal. */
const spelled = (s) => s.replace(/\\/g, '\\\\');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SAME = { adminUser: 'adm', ciUser: 'adm' };
const SPLIT = { adminUser: 'adm', ciUser: 'adm-ci' };
const CUTOVER_USERS = {
	admin: 'adm',
	ci: 'adm-ci',
	adminHome: '/home/adm',
	ciHome: '/home/adm-ci',
};
const sh = (script) => execFileSync('bash', ['-s'], { input: script, encoding: 'utf8' });

// ── the contract ───────────────────────────────────────────────────────────

void test('busy-counters meets the registry contract, acts as admin, and outlives its decoy', () => {
	assert.deepEqual(validateTest(observersTest), []);
	assert.equal(observersTest.id, 'busy-counters');
	assert.equal(observersTest.runsAs, 'admin');
	assert.equal(observersTest.needsDrain, true);
	// The decoy must live through its start and the read beside it (each
	// capped), and end by itself inside the test's own budget, which holds
	// both reads, the start and the stop.
	assert.ok(DECOY_LIFETIME_SEC > 30 + 120, 'the decoy can die before the read beside it');
	assert.ok(120 + 30 + 120 + 30 <= observersTest.minutes * 60, 'minutes does not cover the run');
	assert.ok(DECOY_LIFETIME_SEC < observersTest.minutes * 60, 'the decoy can outlive the test');
});

void test('every reader builds its command from the tree as it stands', () => {
	const ids = new Set();
	for (const c of COUNTERS) {
		assert.ok(!ids.has(c.id), `duplicate ${c.id}`);
		ids.add(c.id);
		assert.ok(['ci', 'admin', 'root'].includes(c.role), `${c.id} role ${c.role}`);
		assert.ok(existsSync(join(ROOT, c.file)), `${c.id}: ${c.file} does not exist`);
		const text = c.script(CUTOVER_USERS);
		assert.match(text, /Runner|unner/, `${c.id} builds no job count`);
	}
});

// ── the copies, held to their source ───────────────────────────────────────

void test('the copied plain pgrep is still the text busyCount, drain, retire and traffic run', () => {
	const literal = `'${spelled(PLAIN_PGREP)}'`;
	for (const f of [
		'scripts/lib/drain-wait.mjs',
		'scripts/drain-node.mjs',
		'scripts/retire-node.mjs',
		'scripts/traffic-status.mjs',
	])
		assert.ok(src(f).includes(literal), `${f} no longer runs ${literal}; update COUNTERS`);
});

void test("the copied hosting lines are still in hosting-ci-rank's CI_OBSERVE_SCRIPT", () => {
	const rank = src('scripts/lib/hosting-ci-rank.mjs');
	for (const line of HOSTING_CI_WORKERS.split('\n'))
		assert.ok(rank.includes(spelled(line)), `hosting-ci-rank.mjs lost ${JSON.stringify(line)}`);
});

/**
 * Each reader's ROLE, read from its call site: a role in COUNTERS is a claim
 * about production, and a claim this test cannot check is a comment.
 */
const ROLE_SITES = {
	'busy-count': [
		'scripts/lib/drain-wait.mjs',
		new RegExp(`${esc(spelled(PLAIN_PGREP))}', \\{\\s*as: 'ci'`),
	],
	'drain-status': ['scripts/drain-node.mjs', /remoteCommand\(node, 'admin', PROBE/],
	'retire-busy': ['scripts/retire-node.mjs', /remoteCommand\(node, 'admin', PROBE/],
	'traffic-status': [
		'scripts/traffic-status.mjs',
		new RegExp(`${esc(spelled(PLAIN_PGREP))}', \\{\\s*as: 'admin'`),
	],
	'fast-loop-probe': ['src/lib/node-probe.ts', /nodeShell\(node, 'ci', PROBE_CMD\)/],
	'perf-workers': ['src/perf-sample.ts', /nodeShell\(node, 'admin', 'bash -s'\)/],
	'qualify-sampler': [
		'scripts/lib/qualify-runner.mjs',
		/deps\.runOn\(node, script, \{[^}]*as: test\.runsAs/,
	],
	'bootcamp-live-workers': ['scripts/bootcamp.mjs', /probeScript\(phase[^\n]*\n\s*\{\s*as: 'ci'/],
	'seed-busy': [
		'scripts/lib/capability-seeds.mjs',
		/deps\.ssh\(name, BUSY_CHECK_SCRIPT, \{ as: 'ci'/,
	],
	'doctor-busy': ['scripts/lib/doctor-run.mjs', /runOn\(name, probeFor\(name\), \{\s*as: 'admin'/],
	'hosting-ci-workers': ['scripts/lib/hosting.mjs', /const opts = \{ as: 'admin'/],
	'cutover-busy': [
		'scripts/node-users-cutover.mjs',
		/runOn\(NODE, inventoryScript\(users\), \{ as: 'admin'/,
	],
	'benchmark-busy': [
		'scripts/lib/benchmark-measure.mjs',
		/scriptExecCommand\(node, 'admin', \{\s*connectTimeout: 8,\s*interpreter: 'sh',\s*sudo: true/,
	],
};

void test("every reader's role is the one its production call site uses", () => {
	assert.deepEqual(Object.keys(ROLE_SITES).sort(), COUNTERS.map((c) => c.id).sort());
	for (const [id, [file, re]] of Object.entries(ROLE_SITES))
		assert.match(src(file), re, `${id}: ${file} no longer shows the role COUNTERS claims`);
	assert.equal(COUNTERS.find((c) => c.id === 'benchmark-busy').shell, 'sh');
});

// ── completeness: no job counter without a decision ────────────────────────

function files(dir, out = []) {
	for (const e of readdirSync(dir)) {
		if (['node_modules', 'dist', 'planning'].includes(e)) continue;
		const p = join(dir, e);
		if (statSync(p).isDirectory()) files(p, out);
		else if (/\.(ts|mjs|sh)$/.test(e) && !/\.test\./.test(e) && !/fixtures?\.mjs$/.test(e))
			out.push(p);
	}
	return out;
}
const blank = (rel, text) =>
	rel.endsWith('.sh')
		? text
				.split('\n')
				.map((l) => l.replace(/(^|\s)#.*$/, '$1'))
				.join('\n')
		: blankComments(text);
/** A line that asks pgrep about a Runner.Worker (any spelling the tree uses). */
const COUNTS_WORKERS = /pgrep.*(?:Runner(?:\\*\.|\[\.\])Worker|\[R\]unner)/;

void test('every pgrep of a Runner.Worker in src/, scripts/ and deploy/ is run here or named in NOT_RUN', () => {
	const found = new Set();
	for (const abs of ['src', 'scripts', 'deploy'].flatMap((d) => files(join(ROOT, d)))) {
		const rel = relative(ROOT, abs);
		if (rel === 'scripts/lib/qualify-observers.mjs') continue;
		const code = blank(rel, readFileSync(abs, 'utf8'));
		if (code.split('\n').some((l) => COUNTS_WORKERS.test(l) && !/Listener/.test(l))) found.add(rel);
	}
	const run = new Set(COUNTERS.map((c) => c.file));
	// Readers whose pgrep lives in a file the COUNTER cites by its import.
	const covered = (f) => run.has(f) || f in NOT_RUN;
	const undecided = [...found].filter((f) => !covered(f));
	assert.deepEqual(undecided, [], 'a job counter with no decision: add it to COUNTERS or NOT_RUN');
	const stale = Object.keys(NOT_RUN).filter((f) => !found.has(f));
	assert.deepEqual(stale, [], 'NOT_RUN names a file that no longer counts jobs');
	for (const [f, why] of Object.entries(NOT_RUN)) assert.ok(why.trim(), `${f} has no reason`);
});

// ── the pure parts ─────────────────────────────────────────────────────────

const row = (id, role, baseline, withDecoy, extra = {}) => ({
	id,
	role,
	baseline,
	withDecoy,
	...extra,
});

void test('judge: every reader counting one more is a pass', () => {
	const v = judgeCounters([row('a', 'ci', 0, 1), row('b', 'admin', 2, 3)]);
	assert.equal(v.status, 'pass');
	assert.match(v.reason, /all 2 job counters saw/);
});

void test('judge: a reader that counts no more is a FAIL naming it and its role', () => {
	const v = judgeCounters([row('busy-count', 'ci', 0, 1), row('doctor-busy', 'admin', 0, 0)]);
	assert.equal(v.status, 'fail');
	assert.match(v.reason, /doctor-busy \(as admin\) counted 0 with a ci job live and 0 without it/);
	assert.doesNotMatch(v.reason, /busy-count/);
});

void test('judge: a count that stays put above zero is still a miss', () => {
	assert.equal(judgeCounters([row('x', 'admin', 2, 2)]).status, 'fail');
});

void test('judge: an unreadable reader is could-not-look naming it, never a pass', () => {
	const v = judgeCounters([row('a', 'ci', 0, 1), row('perf-workers', 'admin', null, 1)]);
	assert.equal(v.status, 'could-not-look');
	assert.match(v.reason, /perf-workers \(as admin\): could not count/);
	const w = judgeCounters([
		row('b', 'root', null, null, { why: 'its command could not be built: x' }),
	]);
	assert.match(w.reason, /b \(as root \(admin via sudo -n\)\): its command could not be built/);
});

void test('judge: a miss outranks an unreadable reader, and both are said', () => {
	const v = judgeCounters([row('a', 'admin', 0, 0), row('b', 'ci', null, null)]);
	assert.equal(v.status, 'fail');
	assert.match(v.reason, /Also could not look: b/);
});

void test('judge: a busy/idle reader that already read busy cannot show the decoy', () => {
	const v = judgeCounters([row('seed-busy', 'ci', 1, 1, { max: 1 })]);
	assert.equal(v.status, 'could-not-look');
	assert.match(v.reason, /already read busy/);
	assert.equal(judgeCounters([row('seed-busy', 'ci', 0, 1, { max: 1 })]).status, 'pass');
});

void test('judge: nothing run is could-not-look', () => {
	assert.equal(judgeCounters([]).status, 'could-not-look');
});

void test('asRole: admin runs as the login, ci through sudo -H -u, root through sudo -n', () => {
	assert.match(asRole('admin', 'X', SPLIT), /^timeout \d+ bash -s <</);
	assert.match(asRole('ci', 'X', SPLIT), /^timeout \d+ sudo -n -H -u 'adm-ci' bash -s <<.*\ncd ~/);
	assert.match(asRole('ci', 'X', SAME), /^timeout \d+ bash -s <<'[A-Z0-9_]+'\nX\n/);
	assert.match(asRole('root', 'X', SPLIT, { shell: 'sh' }), /^timeout \d+ sudo -n sh -s <</);
	assert.throws(() => asRole('nobody', 'X', SPLIT), /unknown role/);
	assert.throws(() => asRole('admin', 'a\nQ5_OBSERVER_SCRIPT_END\nb', SPLIT), /delimiter/);
});

void test('parseReaders splits each reader out with its exit code; one with no END is absent', () => {
	const out = 'noise\nQ5-BEGIN a\n3\nQ5-END a 0\nQ5-BEGIN b\nBUSY\nQ5-END b 1\nQ5-BEGIN c\n4\n';
	assert.deepEqual(parseReaders(out), { a: { out: '3', rc: 0 }, b: { out: 'BUSY', rc: 1 } });
});

void test('REAL SHELL: a reader that prints no trailing newline is still read (PROBE_CMD ends in a bare printf)', () => {
	const built = [
		{ id: 'bare', role: 'admin', text: 'printf "7 8 0"' },
		{ id: 'lined', role: 'ci', text: 'echo 3' },
	];
	const by = parseReaders(sh(readersScript(built, SAME)));
	assert.equal(by.bare?.out.trim(), '7 8 0');
	assert.equal(by.lined?.out.trim(), '3');
	assert.equal(by.bare.rc, 0);
});

void test('parseDecoy takes the pid and a decoy dir, and nothing else', () => {
	assert.deepEqual(parseDecoy('DECOY 4242 /tmp/qualify-decoy.Ab12\n'), {
		pid: 4242,
		dir: '/tmp/qualify-decoy.Ab12',
	});
	assert.match(parseDecoy('DECOY-FAILED mktemp refused').why, /mktemp refused/);
	assert.ok(parseDecoy('DECOY 4242 /home/x').why, 'a dir that is not a decoy dir is refused');
	assert.ok(parseDecoy('').why);
});

void test('the stop script refuses a pid or dir it did not get from a decoy start', () => {
	assert.throws(
		() => decoyStopScript(SAME, { pid: 1, dir: '/tmp/qualify-decoy.a' }),
		/refusing pid/
	);
	assert.throws(() => decoyStopScript(SAME, { pid: 99, dir: '/tmp' }), /refusing decoy dir/);
	assert.throws(() => decoyStopScript(SAME, { pid: 99, dir: "/tmp/qualify-decoy.a'; rm -rf /" }));
	const s = decoyStopScript(SAME, { pid: 99, dir: '/tmp/qualify-decoy.a' });
	assert.doesNotMatch(s, /pkill|killall/);
});

void test('the production decoy is job-shaped: argv ends in spawnclient, comm is Runner.Worker', () => {
	const s = decoyStartScript(SPLIT);
	assert.match(s, /spawnclient 0 0/);
	assert.match(s, /bin\/Runner\.Worker/);
	assert.match(s, /^timeout \d+ sudo -n -H -u 'adm-ci'/);
	assert.doesNotMatch(decoyStartScript(SPLIT, { spawnclient: false }), /spawnclient/);
	assert.match(s, new RegExp(`" ${DECOY_LIFETIME_SEC} spawnclient`));
});

// ── the whole run, against a fake hidepid node ─────────────────────────────

/**
 * A node whose /proc hides ci's processes from admin unless through sudo: the
 * readers script is split by its wrappers, and each reader sees the decoy only
 * if its wrapper can.
 */
function hidepidNode({ hidepid = true, failStop = false, throwOnRead = false } = {}) {
	const calls = [];
	let decoy = false;
	let pid = 0;
	const exec = async (script) => {
		calls.push(script);
		if (script.includes('qualify-decoy.XXXXXX')) {
			decoy = true;
			pid = 31337;
			return { ok: true, stdout: `DECOY ${pid} /tmp/qualify-decoy.Fake01\n`, stderr: '' };
		}
		if (script.includes('DECOY-GONE')) {
			decoy = failStop;
			return {
				ok: true,
				stdout: failStop ? `DECOY-ALIVE ${pid}\n` : `DECOY-GONE ${pid}\n`,
				stderr: '',
			};
		}
		if (decoy && throwOnRead) throw new Error('ssh died');
		const out = [];
		for (const block of script.split(/(?=^echo "Q5-BEGIN )/m)) {
			const id = /^echo "Q5-BEGIN (\S+)"/.exec(block)?.[1];
			if (!id) continue;
			const sees = !hidepid || /sudo -n/.test(block);
			out.push(`Q5-BEGIN ${id}`, String(decoy && sees ? 1 : 0), `Q5-END ${id} 0`);
		}
		return { ok: true, stdout: out.join('\n') + '\n', stderr: '' };
	};
	return { calls, exec };
}

const fakeCounters = [
	{ id: 'as-ci', file: 'x', role: 'ci', script: () => 'COUNT', parse: (o) => Number(o) },
	{ id: 'as-admin', file: 'x', role: 'admin', script: () => 'COUNT', parse: (o) => Number(o) },
	{ id: 'as-root', file: 'x', role: 'root', script: () => 'COUNT', parse: (o) => Number(o) },
];
const ctxOf = (node, machine = { users: { admin: 'adm', ci: 'adm-ci' } }) => ({
	node: 'claw-fixture',
	machine,
	exec: node.exec,
});

void test('run: on a hidepid node the admin reader without sudo FAILS, named with its role', async () => {
	const node = hidepidNode();
	const r = await makeObserversTest({ counters: fakeCounters }).run(ctxOf(node));
	assert.equal(r.status, 'fail');
	assert.match(r.reason, /as-admin \(as admin\) counted 0 with a ci job live and 0 without it/);
	assert.doesNotMatch(r.reason, /as-ci|as-root/);
	assert.deepEqual(r.metrics.counters['as-ci'], { role: 'ci', baseline: 0, withDecoy: 1 });
	assert.equal(r.metrics.decoyGone, true);
	// baseline, start, with-decoy, stop — in that order, the stop by the pid it was given
	assert.equal(node.calls.length, 4);
	assert.match(node.calls[3], /p=31337; d='\/tmp\/qualify-decoy\.Fake01'/);
});

void test('run: a node without hidepid passes every reader', async () => {
	const r = await makeObserversTest({ counters: fakeCounters }).run(
		ctxOf(hidepidNode({ hidepid: false }))
	);
	assert.equal(r.status, 'pass', r.reason);
});

void test('run: the decoy is stopped even when the read beside it throws', async () => {
	const node = hidepidNode({ throwOnRead: true });
	await assert.rejects(makeObserversTest({ counters: fakeCounters }).run(ctxOf(node)), /ssh died/);
	assert.match(node.calls.at(-1), /DECOY-GONE/, 'the last call was not the stop');
});

void test('run: a decoy not confirmed gone turns a pass into could-not-look, and says so', async () => {
	const r = await makeObserversTest({ counters: fakeCounters }).run(
		ctxOf(hidepidNode({ hidepid: false, failStop: true }))
	);
	assert.equal(r.status, 'could-not-look');
	assert.match(r.reason, /decoy pid 31337 was not confirmed gone/);
});

void test('run: a decoy that would not start is could-not-look, and no reader is judged', async () => {
	const exec = async (s) =>
		s.includes('qualify-decoy.XXXXXX')
			? { ok: true, stdout: 'DECOY-FAILED could not build it in /tmp/x\n', stderr: '' }
			: { ok: true, stdout: '', stderr: '' };
	const r = await makeObserversTest({ counters: fakeCounters }).run({ machine: {}, exec });
	assert.equal(r.status, 'could-not-look');
	assert.match(r.reason, /the ci decoy did not start: could not build it/);
});

void test('run: a reader whose command cannot be built is could-not-look naming it', async () => {
	const broken = [
		...fakeCounters.slice(0, 1),
		{
			id: 'moved',
			file: 'x',
			role: 'ci',
			script: () => lineStarting('nothing here', 'busy=', 'f.mjs'),
			parse: Number,
		},
	];
	const r = await makeObserversTest({ counters: broken }).run(ctxOf(hidepidNode()));
	assert.equal(r.status, 'could-not-look');
	assert.match(
		r.reason,
		/moved \(as ci\): its command could not be built: f\.mjs: expected one line/
	);
});

void test('run: a malformed user name is could-not-look before anything runs', async () => {
	const node = hidepidNode();
	const r = await makeObserversTest({ counters: fakeCounters }).run(
		ctxOf(node, { users: { ci: 'Not A Name' } })
	);
	assert.equal(r.status, 'could-not-look');
	assert.equal(node.calls.length, 0);
});

// ── the real shell: start, be counted, be killed, be gone ──────────────────

void test('REAL SHELL: the decoy starts, every no-sudo reader counts it, and it is gone after the stop', () => {
	// `spawnclient: false`: a suite run on a claw must not be a phantom job to
	// the fast loop (node-probe.ts). Every reader here matches by comm or by
	// `[R]unner.Worker` in argv, which the decoy carries either way.
	const local = new Set([
		'busy-count',
		'qualify-sampler',
		'bootcamp-live-workers',
		'seed-busy',
		'doctor-busy',
		'cutover-busy',
	]);
	const built = COUNTERS.filter((c) => local.has(c.id)).map((c) => ({
		...c,
		text: c.script(CUTOVER_USERS),
	}));
	assert.equal(built.length, local.size);

	const d = parseDecoy(sh(decoyStartScript(SAME, { lifetimeSec: 60, spawnclient: false })));
	assert.ok(d.pid, `the decoy did not start: ${d.why}`);
	try {
		assert.equal(readFileSync(`/proc/${d.pid}/comm`, 'utf8').trim(), 'Runner.Worker');
		const listed = sh(`pgrep -af '[R]unner\\.Worker' || true`);
		assert.match(listed, new RegExp(`^${d.pid} ${esc(d.dir)}/bin/Runner\\.Worker `, 'm'));
		const by = parseReaders(sh(readersScript(built, SAME)));
		for (const c of built) {
			const n = c.parse(by[c.id]?.out ?? '');
			assert.ok(
				n !== null && n >= 1,
				`${c.id} read ${JSON.stringify(by[c.id])} with the decoy live`
			);
		}
	} finally {
		const stopped = sh(decoyStopScript(SAME, d));
		assert.match(stopped, new RegExp(`^DECOY-GONE ${d.pid}$`, 'm'));
	}
	assert.equal(
		existsSync(`/proc/${d.pid}/cmdline`) &&
			readFileSync(`/proc/${d.pid}/cmdline`, 'utf8').includes(d.dir),
		false
	);
	assert.equal(existsSync(d.dir), false, 'the decoy directory was left behind');
	assert.ok(READER_TIMEOUT_SEC <= 60);
});
