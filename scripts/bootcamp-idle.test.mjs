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

import { cleanGitEnv, FIXTURE_IDENTITY } from './lib/test-git-identity.mjs';

import {
	BACKSTOP,
	CLAW,
	DOCKER_PRESENT_CASE,
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
const ALL_ANSWER = (bevy, load) =>
	[
		'CAP ffmpeg ok 7.1.5',
		`CAP cargo-bevy ${bevy}`,
		`LOAD cargo-bevy ${load}`,
		'PROBE-END',
		'',
	].join('\n');
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
	soleClaw = false,
	drains = null,
	labels = [],
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
					},
				}
			: {};
	const machines = {
		[CLAW]: { role: 'claw', labels, maxConcurrent: 2, minFreeMb: 1024, ...rec(CLAW) },
		...(soleClaw
			? {}
			: { [CLAW2]: { role: 'claw', labels: [], maxConcurrent: 2, minFreeMb: 1024 } }),
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
		measured: join(root, 'measured.txt'),
		busy: join(root, 'busy.txt'),
		calls: join(root, 'calls.log'),
		drainAtMeasure: join(root, 'drain-at-measure.json'),
	};
	writeFileSync(files.all, all);
	writeFileSync(files.measured, measured);
	writeFileSync(files.busy, `${busy}\n`);
	const drainFile = join(stateDir, 'fleet-drain.json');
	const q = JSON.stringify;
	writeFileSync(
		join(bin, 'ssh'),
		[
			'#!/bin/sh',
			// drain-node's own busy count passes its command as an ARGUMENT (ssh -n).
			`case "$*" in *pgrep*) cat ${q(files.busy)}; exit 0 ;; esac`,
			'script="$(cat)"',
			'case "$script" in',
			JDK_PRESENT_CASE,
			DOCKER_PRESENT_CASE,
			'  *"export CAP_PROBE_PHASE=measured"*)',
			`    echo MEASURED >>${q(files.calls)}`,
			// What the drain file said AT THE MOMENT of the measurement.
			`    cat ${q(drainFile)} >${q(files.drainAtMeasure)} 2>/dev/null`,
			// A node that drops off mid-run: no PROBE-END, and ssh's own exit 255.
			`    cat ${q(files.measured)}; grep -q PROBE-END ${q(files.measured)} || exit 255; exit 0 ;;`,
			'  *"capability-probe — EXECUTE"*)',
			`    echo PROBE >>${q(files.calls)}`,
			`    exec cat ${q(files.all)} ;;`,
			'  *"[R]unner"*)',
			`    echo BUSY >>${q(files.calls)}`,
			`    exec cat ${q(files.busy)} ;;`,
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
		const second = run(writeArgs, f.env);
		assert.equal(second.code, 0, `${second.out}\n${second.err}`);
		assert.equal(f.commits(), base + 1, 'a re-measure that changed no verdict redeployed mgmt-api');
		assert.deepEqual(f.record(), first);
		// A verdict that DOES move rewrites the entry, with the deciding number.
		f.answer('all', ALL_ANSWER('ok 1100', 0));
		assert.equal(run(writeArgs, f.env).code, 0);
		assert.equal(f.commits(), base + 2);
		assert.equal(f.record().measurements['cargo-bevy'].value, 1100);
		assert.equal(f.record().measurements['cargo-bevy'].earned, false);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});
