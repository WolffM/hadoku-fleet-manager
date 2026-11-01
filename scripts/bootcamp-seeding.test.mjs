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
import { join } from 'node:path';
import process from 'node:process';

import { SEED_DISK_FLOOR_MB } from './lib/capability-seeds.mjs';

import {
	CLAW,
	DOCKER_PRESENT_CASE,
	BACKSTOP_TOOLS_PRESENT_CASE,
	JDK_PRESENT_CASE,
	NO_DATA_ENDPOINT,
	run,
} from './lib/bootcamp-fixtures.mjs';

// ── EARNED CAPABILITIES COME WITH THEIR ARTIFACTS (#102, wave 4c lane E) ─────
//
// bootcamp runs the real `fleet-manager` process, so this is the end-to-end
// proof `capability-seeds.test.mjs`'s pure fakes cannot give: the SAME ssh
// shim already carrying DETECT/INSTALL/PROBE gains three more branches, and a
// NEW `gh` shim on PATH stands in for the controller's own `gh` — resolving
// the seed's repo, pin and script text. Nothing here reaches a real host or a
// real GitHub repo.

const FORGE_REPO = 'WolffM/hadoku-cardtable';
const FORGE_PIN = 'deadbeef00112233445566778899aabbccddeeff';

/**
 * `writableFixture` plus a manifest `$seeds` entry and two extra shims: `ssh`
 * gains branches for the busy check, the disk check and the seed run itself
 * (classified the same way the existing shim classifies DETECT/INSTALL/PROBE —
 * by the shape of the script it is handed); `gh` is new, resolving the
 * repo/pin/script the controller would fetch for real.
 *
 * `busy`/`freeKb` control the two live checks' answers; `seedOutcome` controls
 * what the seed run itself reports: `'hit'` (the default), `'silent'` (exits 0
 * but proves nothing — the "neither HIT nor BUILD" finding), or `'fail'`
 * (non-zero, carrying a reason).
 */
function seedingFixture({
	busy = false,
	freeKb = (SEED_DISK_FLOOR_MB + 1024) * 1024,
	seedOutcome = 'hit',
} = {}) {
	const root = mkdtempSync(join(tmpdir(), 'fleet-bootcamp-seed-'));
	const manifestDir = join(root, 'manifests');
	const stateDir = join(root, 'state');
	const bin = join(root, 'bin');
	for (const d of [manifestDir, stateDir, bin]) mkdirSync(d, { recursive: true });

	const releaseLookupFile = join(root, 'release-lookup.json');
	writeFileSync(
		releaseLookupFile,
		JSON.stringify({ status: 'known', version: '9.9.9', publishedAt: new Date(0).toISOString() })
	);

	const manifestPath = join(manifestDir, 'fleet-runner-manifest.json');
	writeFileSync(
		manifestPath,
		JSON.stringify(
			{
				toolchain: { capabilities: ['ffmpeg'] },
				machines: { [CLAW]: { role: 'claw', labels: [], maxConcurrent: 2, minFreeMb: 1024 } },
				$seeds: {
					jdk21: {
						repo: FORGE_REPO,
						script: 'scripts/forge-bundle.sh',
						argument: { kind: 'submodule-pin', submodule: 'forge', ref: 'default' },
						cache: '~/.cache/cardtable-forge',
					},
				},
			},
			null,
			2
		) + '\n'
	);

	const calls = join(root, 'calls.log');
	const answerFile = join(root, 'probe-answer.txt');

	// THE SHIM DOES NOT EXECUTE THE PIPED SCRIPT — it classifies it by substring
	// and echoes a CANNED answer, exactly like the existing DETECT/INSTALL/PROBE
	// branches. So the canned HIT line embeds the pin as a JS-side LITERAL
	// (`FORGE_PIN`), never a shell `$CARDTABLE_FORGE_PIN` reference: that
	// variable was only ever set inside the piped script's own text, which this
	// shim never runs, so referencing it here would expand to empty and the
	// pin field never found by the proof's regex. Caught by running this fixture
	// once and reading its OWN output back before trusting it.
	const sshShim = join(bin, 'ssh');
	const seedRunBody = (() => {
		if (seedOutcome === 'fail')
			return 'echo "forge-bundle: mvn build failed for forge pin" >&2; exit 1';
		if (seedOutcome === 'silent') return 'exit 0';
		return [
			`echo "forge-bundle: HIT: pin ${FORGE_PIN} already cached at /fixture/cache" >&2`,
			'echo "CARDTABLE_FORGE_JAR=/fixture/cache/forge.jar"',
			'echo "CARDTABLE_FORGE_RES=/fixture/cache/res"',
		].join('\n');
	})();
	writeFileSync(
		sshShim,
		[
			'#!/bin/sh',
			'script="$(cat)"',
			'case "$script" in',
			JDK_PRESENT_CASE,
			DOCKER_PRESENT_CASE,
			BACKSTOP_TOOLS_PRESENT_CASE,
			'  *claude.ai/install.sh*)',
			`    echo INSTALL >>${JSON.stringify(calls)}; exit 0 ;;`,
			'  *"claude --version"*)',
			`    echo DETECT >>${JSON.stringify(calls)}; exit 0 ;;`,
			'  *"pgrep -x Runner.Worker"*)',
			`    echo BUSY-CHECK >>${JSON.stringify(calls)}`,
			busy ? '    echo BUSY; exit 0 ;;' : '    echo IDLE; exit 0 ;;',
			'  *"df -Pk"*)',
			`    echo DISK-CHECK >>${JSON.stringify(calls)}`,
			`    printf '%s\\n' ${freeKb}; exit 0 ;;`,
			'  *CARDTABLE_FORGE_PIN*)',
			`    echo SEED-RUN >>${JSON.stringify(calls)}`,
			`    ${seedRunBody}`,
			'    ;;',
			'  *)',
			`    echo PROBE >>${JSON.stringify(calls)}`,
			`    exec cat ${JSON.stringify(answerFile)} ;;`,
			'esac',
			'',
		].join('\n')
	);
	chmodSync(sshShim, 0o755);

	// THE CONTROLLER'S OWN `gh`, SHIMMED. Three calls, matched on the exact path
	// `resolveSeed` builds: repo info (default branch), the submodule's pinned
	// commit, the script's base64 content. Anything else is a hard failure —
	// nothing here should ask `gh` for a fourth thing.
	const ghShim = join(bin, 'gh');
	const scriptB64 = Buffer.from(
		'#!/usr/bin/env bash\necho fixture-forge-bundle\n',
		'utf8'
	).toString('base64');
	writeFileSync(
		ghShim,
		[
			'#!/bin/sh',
			'path="$2"',
			'case "$path" in',
			`  "repos/${FORGE_REPO}")`,
			'    echo \'{"default_branch":"main"}\'; exit 0 ;;',
			`  "repos/${FORGE_REPO}/contents/forge?ref=main")`,
			`    echo '{"type":"submodule","sha":"${FORGE_PIN}"}'; exit 0 ;;`,
			`  "repos/${FORGE_REPO}/contents/scripts/forge-bundle.sh?ref=main")`,
			`    echo '{"encoding":"base64","content":"${scriptB64}"}'; exit 0 ;;`,
			'  *)',
			'    echo "fixture gh: unexpected call: $*" >&2; exit 1 ;;',
			'esac',
			'',
		].join('\n')
	);
	chmodSync(ghShim, 0o755);

	const env = {
		...process.env,
		FLEET_MANIFEST_DIR: manifestDir,
		HADOKU_STATE_DIR: stateDir,
		HADOKU_SITE_ROOT: root,
		FLEET_DATA_URL: NO_DATA_ENDPOINT,
		PATH: `${bin}:${process.env.PATH}`,
		FLEET_TEST_RELEASE_LOOKUP: releaseLookupFile,
	};

	return {
		root,
		manifestPath,
		env,
		answer: (text) => writeFileSync(answerFile, text),
		calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []),
	};
}

const JDK21_ANSWER = ['CAP ffmpeg ok 7.1.5-0+deb13u1', 'CAP jdk21 ok 21.0.1', 'PROBE-END', ''].join(
	'\n'
);
const NO_JDK21_ANSWER = ['CAP ffmpeg ok 7.1.5-0+deb13u1', 'PROBE-END', ''].join('\n');

test('a node that just earned the seeded capability is seeded, through real ssh/gh shims', () => {
	const f = seedingFixture();
	try {
		f.answer(JDK21_ANSWER);
		const r = run(['--machine', CLAW, '--no-push', '--json'], f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		const doc = JSON.parse(r.out);
		// PROBE comes first: bootcamp probes the node BEFORE it knows what the
		// node earned, and seeding is decided from that fresh `earned` set.
		assert.deepEqual(f.calls(), ['PROBE', 'BUSY-CHECK', 'DISK-CHECK', 'SEED-RUN']);
		const seedRow = doc.seeds[CLAW].find((s) => s.id === 'jdk21');
		assert.equal(seedRow.status, 'seeded');
		assert.equal(seedRow.proof, 'HIT');
		assert.equal(seedRow.pin, FORGE_PIN);
		assert.match(run(['--machine', CLAW, '--no-push'], f.env).out, /seeded:\s+jdk21 — HIT/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a node that did NOT earn the seeded capability costs zero busy/disk/seed calls', () => {
	const f = seedingFixture();
	try {
		f.answer(NO_JDK21_ANSWER);
		const r = run(['--machine', CLAW, '--no-push', '--json'], f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		assert.deepEqual(f.calls(), ['PROBE'], 'no busy check, no disk check, no seed run');
		const doc = JSON.parse(r.out);
		assert.deepEqual(doc.seeds[CLAW], [{ id: 'jdk21', status: 'not-earned' }]);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a busy node is skipped before the disk check or the seed run ever run', () => {
	const f = seedingFixture({ busy: true });
	try {
		f.answer(JDK21_ANSWER);
		const r = run(['--machine', CLAW, '--no-push', '--json'], f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		assert.deepEqual(f.calls(), ['PROBE', 'BUSY-CHECK']);
		const doc = JSON.parse(r.out);
		assert.deepEqual(doc.seeds[CLAW], [{ id: 'jdk21', status: 'busy' }]);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('under the disk floor is refused, counted as a finding, and fails the run', () => {
	const f = seedingFixture({ freeKb: (SEED_DISK_FLOOR_MB - 100) * 1024 });
	try {
		f.answer(JDK21_ANSWER);
		const r = run(['--machine', CLAW, '--no-push', '--json'], f.env);
		assert.equal(r.code, 1, 'a refused seed must fail the run');
		const doc = JSON.parse(r.out);
		assert.equal(doc.ok, false);
		const seedRow = doc.seeds[CLAW].find((s) => s.id === 'jdk21');
		assert.equal(seedRow.status, 'refused');
		assert.match(seedRow.reason, /below the \d+ MiB floor/);
		assert.match(run(['--machine', CLAW, '--no-push'], f.env).out, /SEED FAILED: jdk21/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a seed script that proves nothing (no HIT/BUILD line) is a FAILED finding, not a silent pass', () => {
	const f = seedingFixture({ seedOutcome: 'silent' });
	try {
		f.answer(JDK21_ANSWER);
		const r = run(['--machine', CLAW, '--no-push', '--json'], f.env);
		assert.equal(r.code, 1);
		const seedRow = JSON.parse(r.out).seeds[CLAW].find((s) => s.id === 'jdk21');
		assert.equal(seedRow.status, 'failed');
		assert.match(seedRow.reason, /neither a HIT nor a BUILD/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a seed script that fails (non-zero exit) is a FAILED finding carrying its reason', () => {
	const f = seedingFixture({ seedOutcome: 'fail' });
	try {
		f.answer(JDK21_ANSWER);
		const r = run(['--machine', CLAW, '--no-push', '--json'], f.env);
		assert.equal(r.code, 1);
		const seedRow = JSON.parse(r.out).seeds[CLAW].find((s) => s.id === 'jdk21');
		assert.equal(seedRow.status, 'failed');
		assert.match(seedRow.reason, /mvn build failed/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});
