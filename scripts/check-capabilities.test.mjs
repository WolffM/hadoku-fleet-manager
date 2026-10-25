/**
 * `fleet capabilities` — WHO IT REACHES, run for real.
 *
 * The gate had no test at all, and the two things that went wrong with it are
 * both about SELECTION rather than about probing:
 *
 *   1. `--machine` was accepted and IGNORED. `selectMachines(manifest)` was
 *      called with no `only` and `machineArg` was never imported, so
 *      `fleet capabilities --machine claw-1` probed all eight machines. Measured
 *      2026-09-15: seven consecutive `--machine claw-N` runs each returned a
 *      `results` object keyed by every node in the fleet, hokon included. An
 *      operator scoping a run to one box got the whole fleet and no warning.
 *   2. A GUEST was probed. hokon lends the fleet a registration and is otherwise
 *      none of its business (operator, 2026-09-14), and this command is the fleet
 *      chain at its most invasive: it compiles on every core, launches a browser,
 *      runs ffmpeg encodes, and since #6 starts and kills a pm2 daemon.
 *
 * Both are asserted by SPAWNING the script against a temp manifest, the way
 * `node-role-gates.test.mjs` does — the wiring is what regressed, and a unit test
 * of the predicate would have passed throughout.
 *
 * NO REAL NODE IS REACHED. Every fixture machine is named so it resolves
 * nowhere: `isLocalNode` is false for each, so the transport tries ssh, ssh fails
 * to resolve, and the node lands in `unreachable`. That is what makes the
 * mutation safe to run — revert the guest skip and the fixture guest is "probed"
 * by attempting to ssh a hostname that does not exist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseJsonStdout, spawnCapture } from './lib/spawn-json.mjs';
import { writeProof } from '../dist/lib/measured.js';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));

/** Names that resolve NOWHERE, and are not this box. */
const CLAW = 'fixture-claw-1.invalid';
const GUEST = 'fixture-guest.invalid';

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'fleet-capabilities-'));
	const manifestDir = join(root, 'manifests');
	const stateDir = join(root, 'state');
	mkdirSync(manifestDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(
		join(manifestDir, 'fleet-runner-manifest.json'),
		JSON.stringify(
			{
				toolchain: { capabilities: ['ffmpeg'] },
				machines: {
					[CLAW]: { role: 'claw', labels: [], maxConcurrent: 2, minFreeMb: 1024 },
					[GUEST]: { role: 'guest', labels: ['pm2-host', 'taskauto'], minFreeMb: 8192 },
				},
			},
			null,
			2
		)
	);
	return {
		root,
		env: {
			...process.env,
			FLEET_MANIFEST_DIR: manifestDir,
			HADOKU_STATE_DIR: stateDir,
			HADOKU_SITE_ROOT: root,
		},
	};
}

/**
 * Run the gate. ASSERTIONS READ `out` ONLY — `--json` is a contract and the cron
 * parses stdout before it looks at the exit code, so folding stderr into the
 * payload would make a test pass against something production cannot read.
 * ssh's own "could not resolve hostname" goes to stderr and would have done
 * exactly that.
 *
 * stderr is still CAPTURED, because it is the only place a child that printed
 * no report says why (#45). It reaches a reader through `spawnCapture`'s
 * failure message and nowhere else.
 */
function run(args, env) {
	return spawnCapture(process.execPath, [join(SCRIPTS, 'check-capabilities.mjs'), ...args], {
		env,
		timeout: 120_000,
		label: `fleet capabilities ${args.join(' ')}`,
	});
}

/**
 * The report, or a failure naming the status, the signal, the elapsed time and
 * the child's stderr. Never a bare parse of an empty string: on 2026-09-20 that
 * turned a `dist/` deleted mid-run by a concurrent `pnpm run check` into
 * "Unexpected end of JSON input", and pointed the reader at the payload.
 */
function json(r) {
	return parseJsonStdout(r);
}

test('a GUEST is never probed, and is reported as role-declared rather than dropped', () => {
	const f = fixture();
	try {
		const r = run(['--json'], f.env);
		const report = json(r);

		// THE ASSERTION THIS FILE EXISTS FOR. Reverting the guest skip in
		// check-capabilities.mjs puts GUEST into `unreachable` — the gate tried,
		// which is the thing the role forbids.
		assert.ok(
			!report.unreachable.includes(GUEST),
			'a guest must not be probed, so it can never be "unreachable"'
		);
		assert.ok(!(GUEST in report.results), 'and it must produce no probe results');

		// NOT DROPPED EITHER. "I did not need to look" is a third answer, and a
		// machine that vanishes from the report is one nobody can tell was
		// considered. The declaration is the only evidence a guest's label has.
		assert.deepEqual(report.roleDeclared[GUEST], ['pm2-host', 'taskauto']);
		assert.ok(!(CLAW in report.roleDeclared), 'a claw earns its labels, it does not declare them');

		// The claw WAS attempted, so the run is not vacuously clean.
		assert.deepEqual(report.unreachable, [CLAW]);
		assert.equal(r.code, 1, 'a node that could not be probed is not a pass');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('--machine scopes the run instead of being silently ignored', () => {
	const f = fixture();
	try {
		const report = json(run(['--machine', CLAW, '--json'], f.env));
		// Before the fix this listed BOTH machines, whatever was asked for.
		assert.deepEqual(report.unreachable, [CLAW]);
		assert.deepEqual(report.roleDeclared, {}, 'a scoped run reports only what it selected');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('--machine naming a GUEST refuses, rather than reporting a fleet of zero', () => {
	// Nothing probed yields no findings, which is byte-identical to a healthy
	// fleet. The refusal names the guest so the operator learns WHY rather than
	// re-running it.
	const f = fixture();
	try {
		const r = run(['--machine', GUEST, '--json'], f.env);
		assert.equal(r.code, 1);
		assert.equal(r.out.trim(), '', 'a refusal must not emit a parseable clean report');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

/**
 * ISSUE #75. `fleet capabilities --machine hokon` refused outright, even
 * though "declared, not probed" was an answer this file already knew how to
 * give — the SAME `roleDeclared` shape the first test above asserts for a
 * guest caught inside a wider sweep. `--include-guests`, paired with
 * `--machine <that guest>` (the same two-flags convention
 * `deploy-ci-throttle` uses), turns the refusal into that honest answer
 * instead. The guest is STILL NEVER PROBED — no `results[GUEST]`, no
 * `unreachable` entry — only the REFUSAL lifts.
 *
 * MUTATION: drop `&& ONLY && INCLUDE_GUESTS` from the refusal's guard and this
 * test's sibling above (`--machine naming a GUEST refuses...`) goes red
 * instead — the flag would then also lift the refusal with no flag typed at
 * all.
 */
test('--machine <GUEST> --include-guests answers with roleDeclared instead of refusing', () => {
	const f = fixture();
	try {
		const r = run(['--machine', GUEST, '--include-guests', '--json'], f.env);
		assert.equal(r.code, 0, 'nothing is wrong: the guest was correctly left alone');
		const report = json(r);
		assert.deepEqual(report.roleDeclared[GUEST], ['pm2-host', 'taskauto']);
		assert.ok(!(GUEST in report.results), 'still never probed');
		assert.deepEqual(report.unreachable, [], 'never attempted, so never unreachable either');
		assert.deepEqual(report.findings, []);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('--include-guests alone, with no --machine, does not widen anything', () => {
	// The door needs BOTH flags. `--include-guests` with no target must not turn
	// into an implicit "probe every guest too" — that is the mutation risk this
	// file exists to refuse.
	const f = fixture();
	try {
		const r = run(['--include-guests', '--json'], f.env);
		const report = json(r);
		assert.deepEqual(
			report.unreachable,
			[CLAW],
			'the claw was still attempted and still unresolved'
		);
		assert.ok(!(GUEST in report.results), 'the guest is still never probed');
		assert.deepEqual(
			report.roleDeclared[GUEST],
			['pm2-host', 'taskauto'],
			'still reported, as always'
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('--machine naming nothing in the manifest refuses too', () => {
	const f = fixture();
	try {
		assert.equal(run(['--machine', 'claw-404', '--json'], f.env).code, 1);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// wave 4e follow-up (#102) — "the reason renders in fleet capabilities".
// A reachable node (ssh shimmed, like bootcamp.test.mjs's own fixture) so the
// probe actually answers `CAP jdk21 ok` and the workload-gate reason has
// something to attach to.
// ---------------------------------------------------------------------------

function reachableFixture({
	machine = { role: 'claw', labels: [], maxConcurrent: 2, minFreeMb: 1024 },
	probe = ['CAP ffmpeg ok 7.1.5', 'CAP jdk21 ok 21.0.1'],
	required = ['ffmpeg'],
	// What the #122 re-measure (`CAP_PROBE_PHASE=measured`) answers. Defaults
	// to the first probe's own lines: a node that reads the same twice.
	remeasure = probe,
} = {}) {
	const root = mkdtempSync(join(tmpdir(), 'fleet-capabilities-reachable-'));
	const manifestDir = join(root, 'manifests');
	const stateDir = join(root, 'state');
	const bin = join(root, 'bin');
	for (const d of [manifestDir, stateDir, bin]) mkdirSync(d, { recursive: true });
	writeFileSync(
		join(manifestDir, 'fleet-runner-manifest.json'),
		JSON.stringify({
			toolchain: { capabilities: required },
			machines: { [CLAW]: machine },
		})
	);
	writeFileSync(
		join(bin, 'ssh'),
		[
			'#!/bin/sh',
			'script=$(cat)',
			'case "$script" in',
			`*"export CAP_PROBE_PHASE=measured"*) printf '${[...remeasure, 'PROBE-END'].join('\\n')}\\n' ;;`,
			`*) printf '${[...probe, 'PROBE-END'].join('\\n')}\\n' ;;`,
			'esac',
		].join('\n')
	);
	chmodSync(join(bin, 'ssh'), 0o755);
	return {
		root,
		stateDir,
		env: {
			...process.env,
			FLEET_MANIFEST_DIR: manifestDir,
			HADOKU_STATE_DIR: stateDir,
			HADOKU_SITE_ROOT: root,
			PATH: `${bin}:${process.env.PATH}`,
			CAP_REMEASURE_SETTLE_MS: '0',
		},
	};
}

const proofRec = (over = {}) => ({
	node: CLAW,
	capability: 'jdk21',
	runId: 1,
	runner: 'jit-fixture-claw-1-proof-hadoku-cardtable-j0-r0-1',
	conclusion: 'success',
	durationSec: 300,
	evidenceMatched: true,
	budgetSec: null,
	verdict: 'pass',
	why: 'tool present, workload PASSED',
	at: new Date().toISOString(),
	...over,
});

test('fleet capabilities: no $proof at all — dormant, reads "workload gate dormant"', () => {
	const f = reachableFixture();
	try {
		const report = json(run(['--machine', CLAW, '--json'], f.env));
		assert.equal(report.results[CLAW].jdk21.ok, true, 'the probe itself must have answered ok');
		const gate = report.workloadGates[CLAW].jdk21;
		assert.equal(gate.offer, true);
		assert.match(gate.reason, /workload gate dormant: 0\/2/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('fleet capabilities: a FRESH PASS renders "workload PASSED", in --json AND in the human report', () => {
	const f = reachableFixture();
	try {
		// The gate is ACTIVE fleet-wide once minProven (2) nodes hold a fresh
		// pass — a second node's record, not read by THIS run at all, is what
		// bootstraps it; only then does claw-1's own pass read as "PASSED"
		// rather than "dormant".
		writeProof(proofRec({ node: 'claw-9', runner: 'jit-claw-9-proof-hadoku-cardtable-j0-r0-1' }), {
			dir: f.stateDir,
		});
		writeProof(proofRec(), { dir: f.stateDir });
		const r = run(['--machine', CLAW, '--json'], f.env);
		const report = json(r);
		const gate = report.workloadGates[CLAW].jdk21;
		assert.equal(gate.offer, true);
		assert.match(gate.reason, /workload PASSED/);

		const human = run(['--machine', CLAW], f.env);
		assert.match(human.out, /jdk21: tool present, workload PASSED/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('fleet capabilities: a FAILED canary renders the brief\'s own shape — "tool present, workload FAILED: ..."', () => {
	const f = reachableFixture();
	try {
		writeProof(
			proofRec({
				verdict: 'fail',
				why: '27/62 specs, 25.7 min against a 9.0 min budget, run 37672172494',
			}),
			{ dir: f.stateDir }
		);
		const report = json(run(['--machine', CLAW, '--json'], f.env));
		const gate = report.workloadGates[CLAW].jdk21;
		assert.equal(gate.offer, false);
		assert.match(
			gate.reason,
			/tool present, workload FAILED: 27\/62 specs, 25\.7 min against a 9\.0 min budget/
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('fleet capabilities: a corrupt $proof file is a FINDING, and every workload gate reads as withheld', () => {
	const f = reachableFixture();
	try {
		writeFileSync(join(f.stateDir, 'proof.json'), '{ not json');
		const report = json(run(['--machine', CLAW, '--json'], f.env));
		assert.ok(
			report.findings.some((m) => /\$proof is malformed/.test(m)),
			`expected a $proof finding, got: ${JSON.stringify(report.findings)}`
		);
		assert.equal(report.workloadGates[CLAW].jdk21.offer, false);
		assert.match(report.workloadGates[CLAW].jdk21.reason, /no workload proof/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// #98 — what a claw OFFERS is re-checked, not only what it declares.
// ---------------------------------------------------------------------------

/** A claw that declares nothing and EARNED `ids` in bootcamp — the live shape. */
const earnedClaw = (ids) => ({
	role: 'claw',
	labels: [],
	maxConcurrent: 2,
	minFreeMb: 1024,
	$capabilities: {
		at: new Date().toISOString(),
		by: 'fleet bootcamp',
		declared: [],
		earned: ['ffmpeg', ...ids],
		blocked: [],
		unprobed: [],
		prereqs: [{ id: 'ffmpeg', detail: '7.1.5' }],
	},
});

test('#98: an EARNED label the probe can no longer execute is a finding', () => {
	const f = reachableFixture({
		machine: earnedClaw(['jdk21']),
		probe: ['CAP ffmpeg ok 7.1.5', 'CAP jdk21 no javac-failed'],
	});
	try {
		const r = run(['--machine', CLAW, '--json'], f.env);
		const report = json(r);
		assert.equal(r.code, 1);
		assert.deepEqual(report.findings.length, 1, JSON.stringify(report.findings));
		assert.match(
			report.findings[0],
			/offers "jdk21" \(declared or earned\) but cannot execute it \(javac-failed\)/
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('#98: a MEASURED earned label is judged against its bar, not on `ok` alone', () => {
	// `ok` from a measured probe means "I measured it". 900/s is below
	// cargo-bevy's 1200 bar, so the node no longer clears what it earned.
	const f = reachableFixture({
		machine: earnedClaw(['cargo-bevy']),
		probe: ['CAP ffmpeg ok 7.1.5', 'CAP cargo-bevy ok 900', 'LOAD cargo-bevy 0'],
	});
	try {
		const report = json(run(['--machine', CLAW, '--json'], f.env));
		assert.equal(report.findings.length, 1, JSON.stringify(report.findings));
		assert.match(report.findings[0], /offers "cargo-bevy".*< 1200/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('#98: an earned label that still executes is clean', () => {
	const f = reachableFixture({
		machine: earnedClaw(['jdk21', 'cargo-bevy']),
		probe: [
			'CAP ffmpeg ok 7.1.5',
			'CAP jdk21 ok 21.0.1',
			'CAP cargo-bevy ok 2400',
			'LOAD cargo-bevy 0',
		],
	});
	try {
		const r = run(['--machine', CLAW, '--json'], f.env);
		assert.deepEqual(json(r).findings, []);
		assert.equal(r.code, 0);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

// ── MEASURED UNDER LOAD IS NOT JUDGED (2026-10-10) ──────────────────────────
//
// claw-4 2281 idle / 1169 beside CI; claw-6 1529 / 1024. This gate does not
// drain, so it must not go red because a claw was busy — and an IDLE reading
// below the bar must still be the finding #98 made it.

test('a MEASURED earned label taken beside a live job is "not judged" — exit 0, and SAID', () => {
	const f = reachableFixture({
		machine: earnedClaw(['cargo-bevy']),
		probe: ['CAP ffmpeg ok 7.1.5', 'CAP cargo-bevy ok 1024', 'LOAD cargo-bevy 2'],
	});
	try {
		const r = run(['--machine', CLAW, '--json'], f.env);
		const report = json(r);
		assert.deepEqual(report.findings, []);
		assert.equal(r.code, 0, 'a busy claw is not a capability fault');
		assert.equal(report.notJudged.length, 1);
		assert.equal(report.notJudged[0].capability, 'cargo-bevy');
		assert.match(report.notJudged[0].reason, /measured under load \(2 live Runner\.Worker\)/);
		// And the human report says it too — the absence of a verdict is visible.
		const human = run(['--machine', CLAW], f.env);
		assert.match(human.out, /cargo-bevy: measured under load/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('an UNCOUNTED load (no LOAD line, or "unknown") is not judged either — never read as idle', () => {
	for (const loadLine of [[], ['LOAD cargo-bevy unknown']]) {
		const f = reachableFixture({
			machine: earnedClaw(['cargo-bevy']),
			probe: ['CAP ffmpeg ok 7.1.5', 'CAP cargo-bevy ok 900', ...loadLine],
		});
		try {
			const report = json(run(['--machine', CLAW, '--json'], f.env));
			assert.deepEqual(report.findings, [], JSON.stringify(loadLine));
			assert.match(report.notJudged[0].reason, /count unknown/);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	}
});

test('an IDLE measurement below the bar IS a finding, and nothing is "not judged"', () => {
	const f = reachableFixture({
		machine: earnedClaw(['cargo-bevy']),
		probe: ['CAP ffmpeg ok 7.1.5', 'CAP cargo-bevy ok 1024', 'LOAD cargo-bevy 0'],
	});
	try {
		const r = run(['--machine', CLAW, '--json'], f.env);
		const report = json(r);
		assert.equal(r.code, 1);
		assert.match(report.findings.join('\n'), /offers "cargo-bevy".*1024.*< 1200/);
		assert.deepEqual(report.notJudged, []);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

/**
 * #122, claw-1 on 2026-10-19: 773 idle, 3-7 minutes after two builds, on a
 * laptop that throttles under any sustained load; a rerun was green. An idle
 * miss is measured again before it is drift.
 * MUTATION: report the first idle miss directly (skip the re-measure) and the
 * first test below fails.
 */
test('#122: an idle miss that PASSES on re-measure is not drift, and is reported as remeasured', () => {
	const f = reachableFixture({
		machine: earnedClaw(['cargo-bevy']),
		probe: ['CAP ffmpeg ok 7.1.5', 'CAP cargo-bevy ok 773', 'LOAD cargo-bevy 0'],
		remeasure: ['CAP cargo-bevy ok 1728', 'LOAD cargo-bevy 0'],
	});
	try {
		const r = run(['--machine', CLAW, '--json'], f.env);
		const report = json(r);
		assert.deepEqual(report.findings, []);
		assert.equal(r.code, 0);
		assert.equal(report.remeasured.length, 1);
		assert.match(report.remeasured[0].first, /773/);
		assert.match(report.remeasured[0].second, /1728/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('#122: an idle miss whose re-measure lands beside a job is not judged — never drift', () => {
	const f = reachableFixture({
		machine: earnedClaw(['cargo-bevy']),
		probe: ['CAP ffmpeg ok 7.1.5', 'CAP cargo-bevy ok 773', 'LOAD cargo-bevy 0'],
		remeasure: ['CAP cargo-bevy ok 700', 'LOAD cargo-bevy 1'],
	});
	try {
		const report = json(run(['--machine', CLAW, '--json'], f.env));
		assert.deepEqual(report.findings, []);
		assert.equal(report.notJudged.length, 1);
		assert.match(report.notJudged[0].reason, /773.*re-measured after 0s: measured under load/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('#122: a re-measure that returns nothing is not judged, not a pass', () => {
	const f = reachableFixture({
		machine: earnedClaw(['cargo-bevy']),
		probe: ['CAP ffmpeg ok 7.1.5', 'CAP cargo-bevy ok 773', 'LOAD cargo-bevy 0'],
		remeasure: [],
	});
	try {
		const report = json(run(['--machine', CLAW, '--json'], f.env));
		assert.deepEqual(report.findings, []);
		assert.deepEqual(report.remeasured, []);
		assert.match(report.notJudged[0].reason, /re-measure returned no result/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('#122: two idle misses are drift, and the finding carries both readings', () => {
	const f = reachableFixture({
		machine: earnedClaw(['cargo-bevy']),
		probe: ['CAP ffmpeg ok 7.1.5', 'CAP cargo-bevy ok 773', 'LOAD cargo-bevy 0'],
		remeasure: ['CAP cargo-bevy ok 790', 'LOAD cargo-bevy 0'],
	});
	try {
		const r = run(['--machine', CLAW, '--json'], f.env);
		const report = json(r);
		assert.equal(r.code, 1);
		assert.equal(report.findings.length, 1);
		assert.match(report.findings[0], /offers "cargo-bevy".*773.*re-measured after 0s:.*790/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('load excuses ONLY the idle-only measurement: a broken binary label on a busy node still fails', () => {
	const f = reachableFixture({
		machine: earnedClaw(['jdk21', 'cargo-bevy']),
		probe: [
			'CAP ffmpeg ok 7.1.5',
			'CAP jdk21 no javac-failed',
			'CAP cargo-bevy ok 1024',
			'LOAD cargo-bevy 3',
		],
	});
	try {
		const r = run(['--machine', CLAW, '--json'], f.env);
		const report = json(r);
		assert.equal(r.code, 1);
		assert.equal(report.findings.length, 1, JSON.stringify(report.findings));
		assert.match(report.findings[0], /offers "jdk21"/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('#98: an EMPTY toolchain.capabilities refuses — a bar of zero is not a pass', () => {
	const f = reachableFixture({ required: [] });
	try {
		const r = run(['--machine', CLAW, '--json'], f.env);
		assert.equal(r.code, 1);
		assert.equal(r.out.trim(), '', 'a refusal must not emit a parseable clean report');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

// ── REVOCATION (2026-10-25) ─────────────────────────────────────────────────
//
// claw-1 rebooted onto a kernel its NVIDIA module was not built for and went on
// advertising `nvenc-h264` for hours. A failed EXECUTION of an offered routing
// label now revokes it in the state dir — `nodeOffer` withholds it on the next
// tick — and a passing one clears it. Nothing else moves the record.

const revocationsFile = (f) => join(f.stateDir, 'capability-revocations.json');
const readRevoked = (f) =>
	existsSync(revocationsFile(f)) ? JSON.parse(readFileSync(revocationsFile(f), 'utf8')).nodes : {};

test('a failed execution of an earned label REVOKES it, and says so', () => {
	const f = reachableFixture({
		machine: earnedClaw(['jdk21']),
		probe: ['CAP ffmpeg ok 7.1.5', 'CAP jdk21 no javac-failed'],
	});
	try {
		const report = json(run(['--machine', CLAW, '--json'], f.env));
		assert.deepEqual(
			report.revocations.revoked.map((v) => `${v.node}:${v.capability}`),
			[`${CLAW}:jdk21`]
		);
		assert.equal(readRevoked(f)[CLAW].jdk21.by, 'capabilities');
		assert.match(readRevoked(f)[CLAW].jdk21.reason, /javac-failed/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a passing execution CLEARS a held revocation — and only a passing one', () => {
	const f = reachableFixture({
		machine: earnedClaw(['jdk21']),
		probe: ['CAP ffmpeg ok 7.1.5', 'CAP jdk21 ok 21.0.12'],
	});
	try {
		writeFileSync(
			revocationsFile(f),
			JSON.stringify({ nodes: { [CLAW]: { jdk21: { at: 'a', reason: 'r', by: 'capabilities' } } } })
		);
		const report = json(run(['--machine', CLAW, '--json'], f.env));
		assert.deepEqual(
			report.revocations.cleared.map((v) => v.capability),
			['jdk21']
		);
		assert.deepEqual(readRevoked(f), {});
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a measurement NOT JUDGED (taken beside a live job) neither revokes nor clears', () => {
	const f = reachableFixture({
		machine: earnedClaw(['cargo-bevy']),
		probe: ['CAP ffmpeg ok 7.1.5', 'CAP cargo-bevy ok 900', 'LOAD cargo-bevy 2'],
	});
	try {
		const held = { [CLAW]: { 'cargo-bevy': { at: 'a', reason: 'r', by: 'capabilities' } } };
		writeFileSync(revocationsFile(f), JSON.stringify({ nodes: held }));
		const report = json(run(['--machine', CLAW, '--json'], f.env));
		assert.deepEqual(report.revocations.revoked, []);
		assert.deepEqual(report.revocations.cleared, []);
		assert.deepEqual(readRevoked(f), held);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a corrupt record is a FINDING and is never overwritten from a partial view', () => {
	const f = reachableFixture({
		machine: earnedClaw(['jdk21']),
		probe: ['CAP ffmpeg ok 7.1.5', 'CAP jdk21 no javac-failed'],
	});
	try {
		writeFileSync(revocationsFile(f), '{ not json');
		const r = run(['--machine', CLAW, '--json'], f.env);
		assert.equal(r.code, 1);
		assert.ok(json(r).findings.some((x) => /revocation record is unreadable/.test(x)));
		assert.equal(readFileSync(revocationsFile(f), 'utf8'), '{ not json');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});
