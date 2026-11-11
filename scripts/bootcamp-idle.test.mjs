import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { classifyEmittedDoc } from '../dist/job-run-store.js';
import { cleanGitEnv, FIXTURE_IDENTITY } from './lib/test-git-identity.mjs';

import {
	BACKSTOP,
	CLAW,
	DOCKER_PRESENT_CASE,
	BACKSTOP_TOOLS_PRESENT_CASE,
	JDK_PRESENT_CASE,
	NO_DATA_ENDPOINT,
	run,
	SCRIPTS,
} from './lib/bootcamp-fixtures.mjs';

// ---------------------------------------------------------------------------
// IDLE-ONLY MEASUREMENTS ARE TAKEN IDLE, OR NOT AT ALL (2026-10-10).
//
// claw-4 scored 2281 on cargo-bevy idle and 1169 beside CI; claw-6 1529 and
// 1024. `--write` re-takes a busy measurement on a node it DRAINS and waits
// out; a node that never goes quiet keeps its previous verdict. Driven for real: the real `drain-node.mjs` writes the
// fixture state dir's `fleet-drain.json`, and the ssh shim answers the probe
// by phase and the busy count from a file the test controls.
// ---------------------------------------------------------------------------

const CLAW2 = 'fixture-claw-2.invalid';
const CLAW3 = 'fixture-claw-3.invalid';
const ALL_ANSWER = (bevy, load) =>
	[
		'CAP ffmpeg ok 7.1.5',
		`CAP cargo-bevy ${bevy}`,
		`LOAD cargo-bevy ${load}`,
		'PROBE-END',
		'',
	].join('\n');
const PRESENCE_ANSWER = ['CAP ffmpeg ok 7.1.5', 'PROBE-END', ''].join('\n');
const MEASURED_ANSWER = (bevy, load) =>
	[`CAP cargo-bevy ${bevy}`, `LOAD cargo-bevy ${load}`, 'PROBE-END', ''].join('\n');

/**
 * Two claws (so the real `drain-node` capacity guard lets one go) and the backstop,
 * in a throwaway git repo. `prevEarned` seeds each node's `$capabilities` —
 * the record an unjudged measurement must keep.
 */
function idleFixture({
	all = ALL_ANSWER('ok 1024', 2),
	measured = MEASURED_ANSWER('ok 2281', 0),
	busy = 0,
	prevEarned = {},
	prevMeasured = null,
	soleClaw = false,
	drains = null,
	labels = [],
	extraClaw = false,
	shimPre = () => [],
} = {}) {
	const root = mkdtempSync(join(tmpdir(), 'fleet-bootcamp-idle-'));
	const manifestDir = join(root, 'manifests');
	const stateDir = join(root, 'state');
	const bin = join(root, 'bin');
	for (const d of [manifestDir, stateDir, bin]) mkdirSync(d, { recursive: true });
	const rec = (name) =>
		prevEarned[name]
			? {
					$capabilities: {
						at: new Date(Date.now() - 26 * 86_400_000).toISOString(),
						by: 'fleet bootcamp',
						declared: [],
						earned: prevEarned[name],
						unclaimed: [],
						unearned: [],
						blocked: [],
						prereqs: [{ id: 'ffmpeg', detail: '7.1.5' }],
						unprobed: [],
						...(prevMeasured ? { measurements: prevMeasured } : {}),
					},
				}
			: {};
	const machines = {
		[CLAW]: { role: 'claw', labels, maxConcurrent: 2, minFreeMb: 1024, ...rec(CLAW) },
		...(soleClaw
			? {}
			: { [CLAW2]: { role: 'claw', labels: [], maxConcurrent: 2, minFreeMb: 1024 } }),
		...(extraClaw
			? { [CLAW3]: { role: 'claw', labels: [], maxConcurrent: 2, minFreeMb: 1024 } }
			: {}),
		[BACKSTOP]: { role: 'backstop', labels: [], minFreeMb: 8192, ...rec(BACKSTOP) },
	};
	const manifestPath = join(manifestDir, 'fleet-runner-manifest.json');
	writeFileSync(
		manifestPath,
		JSON.stringify({ toolchain: { capabilities: ['ffmpeg'] }, machines }, null, 2) + '\n'
	);
	if (drains) {
		writeFileSync(join(stateDir, 'fleet-drain.json'), JSON.stringify({ nodes: drains }, null, 2));
	}
	const files = {
		all: join(root, 'all.txt'),
		presence: join(root, 'presence.txt'),
		measured: join(root, 'measured.txt'),
		busy: join(root, 'busy.txt'),
		calls: join(root, 'calls.log'),
		drainAtMeasure: join(root, 'drain-at-measure.json'),
	};
	writeFileSync(files.all, all);
	writeFileSync(files.presence, PRESENCE_ANSWER);
	writeFileSync(files.measured, measured);
	writeFileSync(files.busy, `${busy}\n`);
	const drainFile = join(stateDir, 'fleet-drain.json');
	const q = JSON.stringify;
	writeFileSync(
		join(bin, 'ssh'),
		[
			'#!/bin/sh',
			...shimPre({ root, drainFile, q }),
			// drain-node's own busy count passes its command as an ARGUMENT (ssh -n).
			// A `shimPre` may set BUSY_NOW (this host's job count) or ALL_FILE.
			`case "$*" in *pgrep*) [ -n "$BUSY_NOW" ] && echo "$BUSY_NOW" || cat ${q(files.busy)}; exit 0 ;; esac`,
			'script="$(cat)"',
			'case "$script" in',
			JDK_PRESENT_CASE,
			DOCKER_PRESENT_CASE,
			BACKSTOP_TOOLS_PRESENT_CASE,
			'  *"export CAP_PROBE_PHASE=measured"*)',
			`    echo MEASURED >>${q(files.calls)}`,
			// What the drain file said AT THE MOMENT of the measurement.
			`    cat ${q(drainFile)} >${q(files.drainAtMeasure)} 2>/dev/null`,
			// A node that drops off mid-run: no PROBE-END, and ssh's own exit 255.
			`    cat ${q(files.measured)}; grep -q PROBE-END ${q(files.measured)} || exit 255; exit 0 ;;`,
			'  *"export CAP_PROBE_PHASE=presence"*)',
			`    echo PRESENCE >>${q(files.calls)}`,
			`    exec cat ${q(files.presence)} ;;`,
			'  *"capability-probe — EXECUTE"*)',
			`    echo PROBE >>${q(files.calls)}`,
			`    exec cat "\${ALL_FILE:-${files.all}}" ;;`,
			'  *"[R]unner"*)',
			`    echo BUSY >>${q(files.calls)}`,
			`    [ -n "$BUSY_NOW" ] && echo "$BUSY_NOW" || cat ${q(files.busy)}; exit 0 ;;`,
			'esac',
			'',
		].join('\n')
	);
	chmodSync(join(bin, 'ssh'), 0o755);
	const env = cleanGitEnv({
		FLEET_MANIFEST_DIR: manifestDir,
		HADOKU_STATE_DIR: stateDir,
		HADOKU_SITE_ROOT: root,
		FLEET_DATA_URL: NO_DATA_ENDPOINT,
		PATH: `${bin}:${process.env.PATH}`,
		FLEET_TEST_IDLE_TIMING: JSON.stringify({ pollMs: 20, settleMs: 0, timeoutMs: 400 }),
	});
	const git = (...a) => execFileSync('git', a, { cwd: root, env, encoding: 'utf8' });
	git('init', '-q', '-b', 'main');
	const cfg = join(root, '.git', 'config');
	git('config', '--file', cfg, 'user.name', FIXTURE_IDENTITY.name);
	git('config', '--file', cfg, 'user.email', FIXTURE_IDENTITY.email);
	git('add', '-A');
	git('commit', '-q', '-m', 'base');
	const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
	return {
		root,
		env,
		manifestPath,
		drainFile,
		calls: () => (read(files.calls) ?? '').trim().split('\n').filter(Boolean),
		drains: () => (read(drainFile) ? JSON.parse(read(drainFile)).nodes : {}),
		drainAtMeasure: () =>
			read(files.drainAtMeasure) ? JSON.parse(read(files.drainAtMeasure)).nodes : null,
		commits: () => Number(git('rev-list', '--count', 'HEAD').trim()),
		record: (name = CLAW) =>
			JSON.parse(readFileSync(manifestPath, 'utf8')).machines[name].$capabilities ?? null,
		answer: (which, text) => writeFileSync(files[which], text),
	};
}

const writeArgs = ['--machine', CLAW, '--write', '--no-push', '--json'];

test('busy in the first pass: --write DRAINS, waits out, re-measures idle, UNDRAINS — and earns on the idle number', () => {
	// claw-4's shape: 1024 beside a job, 2281 alone.
	const f = idleFixture();
	try {
		const r = run(writeArgs, f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		const doc = JSON.parse(r.out);
		assert.deepEqual(
			f.calls().filter((c) => c !== 'BUSY'),
			['PROBE', 'MEASURED']
		);
		// THE HOLD WAS REAL: the measurement ran under bootcamp's own drain row…
		const atMeasure = f.drainAtMeasure();
		assert.ok(atMeasure?.[CLAW], 'the idle measurement ran on an UNDRAINED node');
		assert.equal(atMeasure[CLAW].kind, 'training');
		assert.match(atMeasure[CLAW].reason, /^fleet bootcamp: idle measurement: cargo-bevy/);
		// …and it is gone afterwards.
		assert.deepEqual(f.drains(), {}, 'bootcamp left its drain behind');
		assert.equal(doc.report[CLAW].idleHold.status, 'measured');
		assert.equal(doc.report[CLAW].idleHold.heldBy, 'bootcamp');
		const rec = f.record();
		assert.ok(rec.earned.includes('cargo-bevy'), `the idle 2281 must earn: ${rec.earned}`);
		assert.deepEqual(
			{ ...rec.measurements['cargo-bevy'], at: 'x' },
			{ value: 2281, idle: true, earned: true, at: 'x' }
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a node that never goes quiet is INCONCLUSIVE: the previous EARN stands, nothing measured, drain lifted, run fails loudly', () => {
	// claw-6's shape: earned 1529 on 2026-09-14, reads 1024 beside CI today.
	const f = idleFixture({ busy: 1, prevEarned: { [CLAW]: ['cargo-bevy', 'ffmpeg'] } });
	try {
		const r = run(writeArgs, f.env);
		assert.equal(r.code, 1, 'an asked-for measurement that could not be taken is a finding');
		const doc = JSON.parse(r.out);
		assert.ok(!f.calls().includes('MEASURED'), 'busy must never become a reading');
		assert.deepEqual(f.drains(), {}, 'the drain is lifted on the timeout path too');
		const inc = doc.report[CLAW].inconclusive;
		assert.equal(inc.length, 1);
		assert.equal(inc[0].id, 'cargo-bevy');
		assert.equal(inc[0].kept, 'earned');
		assert.match(inc[0].reason, /never went quiet/);
		assert.ok(f.record().earned.includes('cargo-bevy'), 'a busy 1024 stripped an idle 1529');
		assert.equal(f.record().measurements, undefined, 'nothing new is written for it');
		const human = run(['--machine', CLAW, '--write', '--no-push'], f.env);
		assert.match(human.out, /INCONCLUSIVE: cargo-bevy — .*previous record kept \(earned\)/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('…and in the other direction: a busy HIGH reading never earns a node that had not', () => {
	const f = idleFixture({
		all: ALL_ANSWER('ok 2900', 1),
		busy: 1,
		prevEarned: { [CLAW]: ['ffmpeg'] },
	});
	try {
		const r = run(writeArgs, f.env);
		assert.equal(r.code, 1);
		const report = JSON.parse(r.out).report[CLAW];
		assert.equal(report.inconclusive[0].kept, 'not earned');
		assert.ok(!f.record().earned.includes('cargo-bevy'), 'earned on a reading taken beside a job');
		// Said ONCE, as inconclusive — not also as a "not earned" reason, which
		// would read as a verdict the run never reached.
		assert.ok(
			!report.notEarned.some((n) => n.id === 'cargo-bevy'),
			JSON.stringify(report.notEarned)
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('IDLE in the first pass: judged on the spot — below the bar STRIPS, and nothing is drained', () => {
	const f = idleFixture({
		all: ALL_ANSWER('ok 1024', 0),
		prevEarned: { [CLAW]: ['cargo-bevy', 'ffmpeg'] },
	});
	try {
		const r = run(writeArgs, f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		assert.deepEqual(f.calls(), ['PROBE'], 'a quiet measurement needs no drain');
		assert.ok(!existsSync(f.drainFile), 'no drain was ever written');
		const rec = f.record();
		assert.ok(!rec.earned.includes('cargo-bevy'), 'an IDLE 1024 is a verdict');
		assert.equal(rec.measurements['cargo-bevy'].earned, false);
		assert.equal(rec.measurements['cargo-bevy'].value, 1024);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('without --write nothing is drained: a busy measurement is "not judged", carried, and not a finding', () => {
	const f = idleFixture({ prevEarned: { [CLAW]: ['cargo-bevy', 'ffmpeg'] } });
	try {
		const before = readFileSync(f.manifestPath, 'utf8');
		const r = run(['--machine', CLAW, '--json'], f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		const doc = JSON.parse(r.out);
		assert.deepEqual(f.calls(), ['PROBE'], 'a read-only run must not take a node out of service');
		assert.ok(doc.report[CLAW].earned.includes('cargo-bevy'));
		assert.equal(doc.report[CLAW].inconclusive[0].kept, 'earned');
		assert.equal(readFileSync(f.manifestPath, 'utf8'), before);
		const human = run(['--machine', CLAW], f.env);
		assert.match(
			human.out,
			/not judged: cargo-bevy — measured under load \(2 live Runner\.Worker\)/
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('an unjudged measurement never makes a DECLARED label UNEARNED — it is not a verdict', () => {
	const f = idleFixture({ labels: ['cargo-bevy'] });
	try {
		const r = run(['--machine', CLAW, '--json'], f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		const report = JSON.parse(r.out).report[CLAW];
		assert.deepEqual(report.unearned, []);
		assert.equal(report.inconclusive[0].id, 'cargo-bevy');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a second busy node is held BESIDE the first, so its quiet window is not spent waiting (fleet-manager#70)', () => {
	// 2026-11-07: claw-10 sat idle 12:15–12:32 while bootcamp waited out claw-9,
	// then took a 45-minute job a minute before its own drain. Replayed: CLAW
	// never goes quiet; CLAW2 is quiet until CLAW's hold has come and gone, then
	// picks up a job. Held one at a time, CLAW2 is drained too late; held
	// together, it is measured while CLAW is still waiting. CLAW3 and the
	// backstop are quiet in the first pass, so neither is held.
	const f = idleFixture({
		extraClaw: true,
		prevEarned: { [CLAW]: ['cargo-bevy', 'ffmpeg'] },
		shimPre: ({ root, drainFile, q }) => {
			const mark = q(join(root, 'claw-1-was-held'));
			const quiet = join(root, 'all-quiet.txt');
			writeFileSync(quiet, ALL_ANSWER('ok 2281', 0));
			const held1 = `grep -q '"${CLAW}"' ${q(drainFile)} 2>/dev/null`;
			return [
				'case "$*" in',
				`  *${CLAW}*) ${held1} && touch ${mark}; BUSY_NOW=1 ;;`,
				`  *${CLAW2}*) if [ -e ${mark} ] && ! ${held1}; then BUSY_NOW=1; else BUSY_NOW=0; fi ;;`,
				`  *${CLAW3}*|*${BACKSTOP}*) ALL_FILE=${q(quiet)}; BUSY_NOW=0 ;;`,
				'esac',
			];
		},
	});
	try {
		const r = run(['--write', '--no-push', '--json'], f.env);
		const report = JSON.parse(r.out).report;
		assert.equal(report[CLAW2].idleHold?.status, 'measured', `${r.out}\n${r.err}`);
		assert.ok(f.record(CLAW2).earned.includes('cargo-bevy'));
		assert.equal(report[CLAW].idleHold?.status, 'inconclusive');
		assert.match(report[CLAW].idleHold.reason, /never went quiet/);
		assert.equal(report[CLAW3].idleHold, undefined);
		assert.equal(report[BACKSTOP].idleHold, undefined);
		assert.deepEqual(f.drains(), {}, 'bootcamp left a drain behind');
		assert.equal(r.code, 1, 'CLAW is still INCONCLUSIVE, and that is still a finding');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('killed mid-wait, bootcamp lifts its own drain on the way out', async () => {
	// A drain nobody lifts is an outage by accident. The busy node never goes
	// quiet; the test waits until bootcamp's drain row lands, then SIGTERMs it.
	const f = idleFixture({ busy: 1 });
	try {
		const env = {
			...f.env,
			FLEET_TEST_IDLE_TIMING: JSON.stringify({ pollMs: 50, settleMs: 0, timeoutMs: 60_000 }),
		};
		const child = spawn(process.execPath, [join(SCRIPTS, 'bootcamp.mjs'), ...writeArgs], {
			env,
			stdio: 'ignore',
		});
		const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
		const deadline = Date.now() + 30_000;
		while (!f.drains()[CLAW]) {
			assert.ok(Date.now() < deadline, 'bootcamp never drained the busy node');
			await new Promise((r) => setTimeout(r, 25));
		}
		child.kill('SIGTERM');
		assert.equal(await exited, 143);
		assert.deepEqual(f.drains(), {}, 'a killed bootcamp left the node drained');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("someone else's drain is measured UNDER, never rewritten and never lifted", () => {
	const theirs = {
		since: new Date().toISOString(),
		kind: 'training',
		reason: 'toolchain refresh (automated); returns after re-probe',
		by: 'fixture',
	};
	const f = idleFixture({ drains: { [CLAW]: theirs } });
	try {
		const r = run(writeArgs, f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		assert.ok(f.calls().includes('MEASURED'));
		assert.deepEqual(f.drains(), { [CLAW]: theirs }, 'their hold must survive, byte-for-byte');
		assert.equal(JSON.parse(r.out).report[CLAW].idleHold.heldBy, 'someone-else');
		assert.ok(f.record().earned.includes('cargo-bevy'));
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a drain the capacity guard REFUSES is inconclusive — nothing measured, nothing left drained', () => {
	// One claw: draining it would leave the fleet nobody, which `drain-node` refuses.
	const f = idleFixture({ soleClaw: true, prevEarned: { [CLAW]: ['cargo-bevy', 'ffmpeg'] } });
	try {
		const r = run(writeArgs, f.env);
		assert.equal(r.code, 1);
		assert.ok(!f.calls().includes('MEASURED'));
		assert.deepEqual(f.drains(), {});
		assert.match(
			JSON.parse(r.out).report[CLAW].inconclusive[0].reason,
			/drain (refused|failed): .*would leave NO node/
		);
		assert.ok(f.record().earned.includes('cargo-bevy'));
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a node that drops off during the idle re-measure is inconclusive, and still undrained', () => {
	const f = idleFixture({ measured: 'ssh: connect to host: Connection timed out\n' });
	try {
		const r = run(writeArgs, f.env);
		assert.equal(r.code, 1);
		assert.deepEqual(f.drains(), {});
		assert.match(
			JSON.parse(r.out).report[CLAW].inconclusive[0].reason,
			/unreachable during the idle re-measurement/
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('the backstop is drained for its idle measurement like a claw', () => {
	const f = idleFixture();
	try {
		const r = run(['--machine', BACKSTOP, '--write', '--no-push', '--json'], f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		assert.deepEqual(
			f.calls().filter((c) => c !== 'BUSY'),
			['PROBE', 'MEASURED']
		);
		assert.equal(f.drainAtMeasure()?.[BACKSTOP]?.kind, 'training');
		assert.deepEqual(f.drains(), {}, 'bootcamp left its drain behind');
		assert.ok(f.record(BACKSTOP).earned.includes('cargo-bevy'));
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('the idle measurement entry moves only with the VERDICT: a second idle run at a new number commits nothing (#59)', () => {
	const f = idleFixture({ all: ALL_ANSWER('ok 2281', 0) });
	try {
		const base = f.commits();
		assert.equal(run(writeArgs, f.env).code, 0);
		assert.equal(f.commits(), base + 1);
		const first = f.record();
		f.answer('all', ALL_ANSWER('ok 2310', 0)); // same verdict, fresh figure
		// Recorded now, so off its weekday the benchmark would be deferred.
		const second = run([...writeArgs, '--measure'], f.env);
		assert.equal(second.code, 0, `${second.out}\n${second.err}`);
		assert.equal(f.commits(), base + 1, 'a re-measure that changed no verdict redeployed mgmt-api');
		assert.deepEqual(f.record(), first);
		// A verdict that DOES move rewrites the entry, with the deciding number.
		f.answer('all', ALL_ANSWER('ok 1100', 0));
		assert.equal(run([...writeArgs, '--measure'], f.env).code, 0);
		assert.equal(f.commits(), base + 2);
		assert.equal(f.record().measurements['cargo-bevy'].value, 1100);
		assert.equal(f.record().measurements['cargo-bevy'].earned, false);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// ONCE A WEEK PER NODE (operator, 2026-11-11; lib/bootcamp-schedule.mjs).
//
// Off its weekday a node that already has a measurement runs only the presence
// half of the probe: no benchmark, no drain, no commit, and its earned
// benchmark label stays. The fixture fleet sorts to [backstop, claw, claw-2],
// so CLAW (fixture-claw.invalid) is index 1 → Monday.
// ---------------------------------------------------------------------------

const MON = '2026-11-09T12:00:00Z';
const TUE = '2026-11-10T12:00:00Z';
const RECORDED = {
	'cargo-bevy': { value: 2281, idle: true, earned: true, at: '2026-10-11T02:06:26.294Z' },
};

test('off its weekday: presence only, nothing drained or written, the earned benchmark label kept', () => {
	// Monday writes the record the way bootcamp writes it (idle, earned);
	// Tuesday must leave it exactly as it is.
	const f = idleFixture({ all: ALL_ANSWER('ok 2281', 0) });
	try {
		assert.equal(run(writeArgs, { ...f.env, FLEET_TEST_NOW: MON }).code, 0);
		assert.ok(f.record().earned.includes('cargo-bevy'));
		f.answer('all', ALL_ANSWER('ok 900', 0)); // would STRIP, if it ran
		const base = f.commits();
		const before = f.record();
		const callsBefore = f.calls().length;
		const r = run(writeArgs, { ...f.env, FLEET_TEST_NOW: TUE });
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		assert.deepEqual(
			f
				.calls()
				.slice(callsBefore)
				.filter((c) => c !== 'BUSY'),
			['PRESENCE'],
			'the benchmark ran off its weekday'
		);
		const doc = JSON.parse(r.out);
		assert.deepEqual(doc.report[CLAW].deferred, [
			{ id: 'cargo-bevy', nextOn: '2026-11-16', kept: 'earned' },
		]);
		assert.deepEqual(doc.report[CLAW].inconclusive, [], 'a schedule is not a finding');
		assert.equal(doc.revocations?.revoked?.length ?? 0, 0);
		assert.deepEqual(f.drains(), {});
		assert.equal(f.commits(), base, 'a deferred benchmark changed the record');
		assert.deepEqual(f.record(), before);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('…and a deferred benchmark the node had NOT earned is not earned by skipping it', () => {
	const f = idleFixture({
		prevEarned: { [CLAW]: ['ffmpeg'] },
		prevMeasured: { 'cargo-bevy': { ...RECORDED['cargo-bevy'], value: 900, earned: false } },
	});
	try {
		const r = run(writeArgs, { ...f.env, FLEET_TEST_NOW: TUE });
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		assert.equal(JSON.parse(r.out).report[CLAW].deferred[0].kept, 'not earned');
		assert.ok(!f.record().earned.includes('cargo-bevy'));
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('on its weekday the benchmark runs, drains when busy, and judges as before', () => {
	const f = idleFixture({
		prevEarned: { [CLAW]: ['cargo-bevy', 'ffmpeg'] },
		prevMeasured: RECORDED,
	});
	try {
		const r = run(writeArgs, { ...f.env, FLEET_TEST_NOW: MON });
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		assert.deepEqual(
			f.calls().filter((c) => c !== 'BUSY'),
			['PROBE', 'MEASURED']
		);
		assert.deepEqual(JSON.parse(r.out).report[CLAW].deferred, []);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('--measure runs the benchmark off the weekday', () => {
	const f = idleFixture({
		prevEarned: { [CLAW]: ['cargo-bevy', 'ffmpeg'] },
		prevMeasured: RECORDED,
	});
	try {
		const r = run([...writeArgs, '--measure'], { ...f.env, FLEET_TEST_NOW: TUE });
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		assert.ok(f.calls().includes('PROBE'), 'the full probe did not run');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('the --json document says WHY it failed, in the shape the job-run store reads', () => {
	// 2026-11-06/07/10: three nights of exactly this (claw-1, claw-10, claw-4 never
	// went quiet) were recorded as "ok:false with no findings/unreadable/error",
	// because the document carried a count and no list.
	const f = idleFixture({ busy: 1, prevEarned: { [CLAW]: ['cargo-bevy', 'ffmpeg'] } });
	try {
		const r = run(writeArgs, f.env);
		assert.equal(r.code, 1);
		const doc = JSON.parse(r.out);
		assert.deepEqual(doc.unreadable, []);
		assert.equal(doc.findings.length, 1);
		assert.equal(doc.findings[0].node, CLAW);
		assert.equal(doc.findings[0].kind, 'inconclusive');
		assert.match(
			doc.findings[0].reason,
			/^cargo-bevy: .*never went quiet.*previous record kept \(earned\)/
		);
		const c = classifyEmittedDoc(doc);
		assert.equal(c.verdict, 'findings');
		assert.equal(c.findings, 1);
		assert.equal(c.why, doc.findings[0].reason);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a clean run emits empty lists, and the store reads it as ok', () => {
	const f = idleFixture({ all: ALL_ANSWER('ok 2281', 0) });
	try {
		const r = run(writeArgs, f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		const doc = JSON.parse(r.out);
		assert.deepEqual([doc.findings, doc.unreadable], [[], []]);
		assert.equal(classifyEmittedDoc(doc).verdict, 'ok');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});
