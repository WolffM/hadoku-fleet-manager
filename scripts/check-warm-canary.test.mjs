/**
 * check-warm-canary, run for real against a fixture manifest and a stand-in
 * `ssh` — the GateDoc half (wave 5f lane B). `scripts/lib/warm-canary.test.mjs`
 * already proves `warmCanaryVerdict` itself at the unit level (including the
 * "warm" / eligible-but-not-warm distinction); this proves the SCRIPT wires
 * that verdict into a `GateDoc`, through the real I/O paths (manifest
 * selection, ssh, the additive legacy fields), not the decision logic again.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tempDir, cleanupTempDirs } from './lib/test-tmpdir.mjs';

afterEach(cleanupTempDirs);

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-warm-canary.mjs');

/**
 * `ssh` is shadowed on PATH and reads the piped script off its own stdin —
 * `runOnSync` always invokes `ssh <dest> bash -s` with the probe fed that way
 * (`scripts/lib/fleet-exec.mjs`'s `scriptCommand`) — so the stub can tell the
 * three probes `measure()` makes apart by substring, without caring about argv.
 *
 *   `reachable: false` — exit 255, ssh's own reserved "could not connect".
 *   `reachable: true, activeRepo` unset — answers memory and "is-active" but
 *     the warm marker file read comes back empty: eligible, never warm.
 */
function sshStub(bin, { reachable, activeRepo }) {
	const path = join(bin, 'ssh');
	if (!reachable) {
		writeFileSync(path, '#!/bin/sh\nexit 255\n');
	} else {
		writeFileSync(
			path,
			[
				'#!/bin/sh',
				'input="$(cat)"',
				'case "$input" in',
				'  *"free -m"*) echo 65536 ;;', // 64GB — comfortably eligible
				'  *"warm/repo"*)',
				activeRepo ? `    echo "${activeRepo}" ;;` : '    : ;;', // no marker: never warm
				'  *"systemctl --user is-active"*) echo active ;;',
				'  *) exit 1 ;;',
				'esac',
			].join('\n')
		);
	}
	chmodSync(path, 0o755);
}

/**
 * Every fixture node declares a cap of 3 unless it says otherwise: the canary
 * judges eligibility by the warm tick's rule, under which an UNDECLARED cap
 * holds no listener at all (fleet-manager#79).
 */
function manifestWith(machines) {
	return JSON.stringify({
		machines: Object.fromEntries(
			Object.entries(machines).map(([n, m]) => [n, { maxConcurrent: 3, ...m }])
		),
	});
}

function run(
	machines,
	{ reachable, activeRepo, heavyMarks, warmYields, warmHolds, knownDown } = {},
	extraArgv = []
) {
	const dir = tempDir('warm-canary-');
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	sshStub(bin, { reachable: reachable ?? false, activeRepo });
	writeFileSync(join(dir, 'fleet-runner-manifest.json'), manifestWith(machines));
	if (heavyMarks !== undefined) writeFileSync(join(dir, 'heavy-marks.json'), heavyMarks);
	if (warmYields !== undefined) writeFileSync(join(dir, 'warm-yields.json'), warmYields);
	if (warmHolds !== undefined) writeFileSync(join(dir, 'warm-holds.json'), warmHolds);
	// `knownDown`: node names runner-health's own per-node offline alert has
	// ALREADY paged, LOUDLY — see lib/known-down.mjs. Written straight into
	// the fixture's state dir, the real `runner-down-page.json` shape
	// (`since`: first-offline, `lastPage`: present only once the page fired).
	if (knownDown !== undefined) {
		writeFileSync(
			join(dir, 'runner-down-page.json'),
			JSON.stringify(
				Object.fromEntries(
					knownDown.map((n) => [
						n,
						{
							since: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
							lastPage: new Date(Date.now() - 60_000).toISOString(),
						},
					])
				)
			)
		);
	}
	const r = spawnSync(process.execPath, [SCRIPT, '--json', ...extraArgv], {
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			FLEET_MANIFEST_DIR: dir,
			HADOKU_STATE_DIR: dir,
		},
	});
	return { ...r, doc: JSON.parse(r.stdout) };
}

void test('no ephemeral candidate at all: one whole-fleet finding, nothing unreadable', () => {
	const r = run({ 'fx-standing': { role: 'claw' } });
	assert.equal(r.status, 1, r.stderr);
	assert.equal(r.doc.ok, false);
	assert.deepEqual(r.doc.unreadable, []);
	assert.equal(r.doc.findings.length, 1);
	assert.equal(r.doc.findings[0].node, null);
	assert.equal(r.doc.findings[0].kind, 'warm-canary-refused');
	assert.match(r.doc.findings[0].reason, /no candidate node exists/);
	assert.ok(r.doc.why, 'a failing GateDoc must carry why');
});

void test('an unreachable ephemeral candidate: unreadable, never a finding', () => {
	const r = run({ 'fx-claw-1': { role: 'claw', ephemeral: true } }, { reachable: false });
	assert.equal(r.status, 1, r.stderr);
	assert.equal(r.doc.ok, false);
	assert.deepEqual(r.doc.findings, []);
	assert.equal(r.doc.unreadable.length, 1);
	assert.equal(r.doc.unreadable[0].node, 'fx-claw-1');
	assert.match(r.doc.unreadable[0].why, /could not reach/);
});

void test('an eligible, reachable candidate holding NO warm listener: one not-warm finding', () => {
	const r = run({ 'fx-claw-1': { role: 'claw', ephemeral: true } }, { reachable: true });
	assert.equal(r.status, 1, r.stderr);
	assert.equal(r.doc.ok, false);
	assert.deepEqual(r.doc.unreadable, []);
	assert.equal(r.doc.findings.length, 1);
	assert.equal(r.doc.findings[0].node, 'fx-claw-1');
	assert.equal(r.doc.findings[0].kind, 'not-warm');
	assert.match(r.doc.findings[0].reason, /eligible.*not holding one/);
	// The pre-existing legacy fields still travel, additively.
	assert.deepEqual(r.doc.eligible, ['fx-claw-1']);
	assert.deepEqual(r.doc.warm, []);
});

void test('a node the dispatcher marked heavy a minute ago is set aside, not paged (2026-11-05)', () => {
	const r = run(
		{
			'fx-claw-1': { role: 'claw', ephemeral: true },
			'fx-claw-4': { role: 'claw', ephemeral: true },
		},
		{ reachable: true, heavyMarks: JSON.stringify({ 'fx-claw-4': Date.now() - 60_000 }) }
	);
	assert.deepEqual(
		r.doc.findings.map((f) => f.node),
		['fx-claw-1'],
		'the unmarked node is still scored'
	);
	assert.deepEqual(
		r.doc.heavyMarked.map((h) => h.node),
		['fx-claw-4']
	);
	assert.equal(r.doc.heavyMarksUnreadable, false);
});

void test('a lapsed mark, or marks that will not parse, set nothing aside', () => {
	const machines = { 'fx-claw-4': { role: 'claw', ephemeral: true } };
	const lapsed = run(machines, {
		reachable: true,
		heavyMarks: JSON.stringify({ 'fx-claw-4': Date.now() - 600_000 }),
	});
	assert.deepEqual(
		lapsed.doc.findings.map((f) => f.node),
		['fx-claw-4']
	);
	const torn = run(machines, { reachable: true, heavyMarks: '{"fx-claw-4": 1' });
	assert.deepEqual(
		torn.doc.findings.map((f) => f.node),
		['fx-claw-4']
	);
	assert.equal(torn.doc.heavyMarksUnreadable, true);
});

void test('warm-yield: a node whose slot yielded to the queue is set aside until it lapses', () => {
	const now = Date.now();
	const entry = (over) =>
		JSON.stringify({
			'fx-claw-4': {
				warmRepo: 'WolffM/hadoku_site',
				job: { repo: 'WolffM/hadoku-cardtable', runId: 1, jobId: 2, queuedSec: 90 },
				spare: 2,
				yieldedAtMs: now - 120_000,
				lastDemandMs: now - 60_000,
				confirmedAtMs: now - 30_000,
				liftedAtMs: null,
				...over,
			},
		});
	const machines = {
		'fx-claw-1': { role: 'claw', ephemeral: true },
		'fx-claw-4': { role: 'claw', ephemeral: true },
	};
	const held = run(machines, { reachable: true, warmYields: entry({}) });
	assert.deepEqual(
		held.doc.findings.map((f) => f.node),
		['fx-claw-1'],
		'the node that did not yield is still scored'
	);
	assert.deepEqual(
		held.doc.yielded.map((y) => y.node),
		['fx-claw-4']
	);
	assert.equal(held.doc.warmYieldsUnreadable, false);
	// The writer stopped confirming it: scored again (the strict direction).
	const stale = run(machines, {
		reachable: true,
		warmYields: entry({ confirmedAtMs: now - 10 * 60_000 }),
	});
	assert.deepEqual(stale.doc.findings.map((f) => f.node).sort(), ['fx-claw-1', 'fx-claw-4']);
	// Lifted long enough ago to have refilled: scored again.
	const lifted = run(machines, {
		reachable: true,
		warmYields: entry({ liftedAtMs: now - 5 * 60_000 }),
	});
	assert.deepEqual(lifted.doc.findings.map((f) => f.node).sort(), ['fx-claw-1', 'fx-claw-4']);
	const torn = run(machines, { reachable: true, warmYields: '{"fx-claw-4": ' });
	assert.equal(torn.doc.warmYieldsUnreadable, true);
	assert.deepEqual(torn.doc.findings.map((f) => f.node).sort(), ['fx-claw-1', 'fx-claw-4']);
});

void test('wave gates1 §A: a node already paged down by runner-health is not a candidate at all', () => {
	// The shared ssh stub answers identically for every node, so fx-claw-1
	// (known down) would read exactly like fx-claw-2 if it were ever probed —
	// the point of this test is that it is NOT: it is excluded from candidacy
	// before any ssh happens, the same way a drained node already is.
	const r = run(
		{
			'fx-claw-1': { role: 'claw', ephemeral: true },
			'fx-claw-2': { role: 'claw', ephemeral: true },
		},
		{ reachable: true, activeRepo: 'WolffM/some-repo', knownDown: ['fx-claw-1'] }
	);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.doc.ok, true);
	assert.deepEqual(r.doc.unreadable, []);
	assert.deepEqual(r.doc.findings, []);
	assert.deepEqual(r.doc.eligible, ['fx-claw-2']);
	assert.equal(r.doc.knownDown.length, 1);
	assert.equal(r.doc.knownDown[0].node, 'fx-claw-1');
	assert.match(r.doc.knownDown[0].pagedBy, /runner-health/);
});

void test('wave gates1 §A: the same unreachable node, NOT known down, still fails (control)', () => {
	const r = run({ 'fx-claw-1': { role: 'claw', ephemeral: true } }, { reachable: false });
	assert.equal(r.status, 1, r.stderr);
	assert.equal(r.doc.ok, false);
	assert.deepEqual(r.doc.knownDown, []);
	assert.equal(r.doc.unreadable.length, 1);
	assert.equal(r.doc.unreadable[0].node, 'fx-claw-1');
});

void test('human output is unaffected by the migration — same prose, same exit code', () => {
	const asJson = run({ 'fx-standing': { role: 'claw' } });
	// Re-run the identical fixture without --json.
	const dir = tempDir('warm-canary-human-');
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	sshStub(bin, { reachable: false });
	writeFileSync(
		join(dir, 'fleet-runner-manifest.json'),
		manifestWith({ 'fx-standing': { role: 'claw' } })
	);
	const human = spawnSync(process.execPath, [SCRIPT], {
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			FLEET_MANIFEST_DIR: dir,
			HADOKU_STATE_DIR: dir,
		},
	});
	assert.equal(human.status, asJson.status, 'exit code must match between the two modes');
	assert.ok(!human.stdout.trim().startsWith('{'), 'human mode must not print JSON');
	assert.match(human.stderr, /✗ warm cache canary:/);
});

void test('warm-holds: a node the warm tick held empty is set aside for its refill window, then scored (fleet-manager#79)', () => {
	const machines = {
		'fx-claw-1': { role: 'claw', ephemeral: true },
		'fx-claw-6': { role: 'claw', ephemeral: true },
	};
	const holds = (agoMs) =>
		JSON.stringify({ 'fx-claw-6': { atMs: Date.now() - agoMs, reason: 'heavy' } });
	// The tick held claw-6 for a heavy job 60 s ago; at :00 the job has ended
	// and the probe sees nothing heavy, but the tick has not refilled yet.
	const fresh = run(machines, { reachable: true, warmHolds: holds(60_000) });
	assert.deepEqual(
		fresh.doc.findings.map((f) => f.node),
		['fx-claw-1'],
		'the node the tick did not hold is still scored'
	);
	assert.deepEqual(
		fresh.doc.heldByTick.map((h) => [h.node, h.reason]),
		[['fx-claw-6', 'heavy']]
	);
	assert.equal(fresh.doc.warmHoldsUnreadable, false);
	// Past the window: the tick should have refilled it by now, so it is scored.
	const stale = run(machines, { reachable: true, warmHolds: holds(10 * 60_000) });
	assert.deepEqual(stale.doc.findings.map((f) => f.node).sort(), ['fx-claw-1', 'fx-claw-6']);
	// Unparseable: says so, and scores every node.
	const torn = run(machines, { reachable: true, warmHolds: '{"fx-claw-6": ' });
	assert.equal(torn.doc.warmHoldsUnreadable, true);
	assert.deepEqual(torn.doc.findings.map((f) => f.node).sort(), ['fx-claw-1', 'fx-claw-6']);
});
