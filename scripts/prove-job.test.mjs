/**
 * `fleet prove-job` THROUGH ITS REAL ENTRY POINT, against a fixture manifest and
 * shims for `gh` and `ssh`. The orchestration is tested in `src/tests/prove-job.test.ts`
 * with the whole world simulated; this proves the parts only a real process has:
 * argument handling, the guest refusal end to end, that an unreadable GitHub is
 * a non-zero exit with parseable JSON on stdout, and that `--out` gets the same
 * document. No network and no node: both shims fail loudly if reached for a write.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'prove-job.mjs');
const CLAW = 'fixture-claw-8.invalid';
const GUEST = 'fixture-guest.invalid';

function fixture({ ghExit = 1 } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'fleet-prove-'));
	const manifestDir = join(root, 'manifests');
	const stateDir = join(root, 'state');
	const bin = join(root, 'bin');
	for (const d of [manifestDir, stateDir, bin]) mkdirSync(d, { recursive: true });
	writeFileSync(
		join(manifestDir, 'fleet-runner-manifest.json'),
		JSON.stringify({
			toolchain: { capabilities: [] },
			machines: {
				[CLAW]: { role: 'claw', ephemeral: true, labels: ['taskauto'], maxConcurrent: 2 },
				[GUEST]: { role: 'guest', labels: ['pm2-host', 'taskauto'] },
			},
		})
	);
	const calls = join(root, 'calls.log');
	// Both shims record that they were called and then FAIL: anything that reaches
	// a node or GitHub for a write in these tests is a bug the exit code will show.
	writeFileSync(
		join(bin, 'gh'),
		`#!/bin/sh\necho "gh $*" >>${JSON.stringify(calls)}\necho 'gh: Not Found (HTTP 404)' >&2\nexit ${ghExit}\n`
	);
	writeFileSync(
		join(bin, 'ssh'),
		`#!/bin/sh\necho "ssh $*" >>${JSON.stringify(calls)}\nexit 255\n`
	);
	chmodSync(join(bin, 'gh'), 0o755);
	chmodSync(join(bin, 'ssh'), 0o755);
	return {
		root,
		stateDir,
		calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []),
		env: {
			...process.env,
			FLEET_MANIFEST_DIR: manifestDir,
			HADOKU_STATE_DIR: stateDir,
			HADOKU_SITE_ROOT: root,
			FLEET_NO_BANNER: '1',
			PATH: `${bin}:${process.env.PATH}`,
		},
	};
}

/** stderr is kept on EVERY exit, a pass included: the guest banner is asserted on one. */
function run(args, env) {
	const r = spawnSync(process.execPath, [SCRIPT, ...args], {
		encoding: 'utf8',
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 60_000,
	});
	return { code: r.status ?? 1, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') };
}

test('a guest is REFUSED end to end: exit non-zero, JSON on stdout, nothing reached', () => {
	const f = fixture();
	try {
		const file = join(f.root, 'proof.json');
		const r = run(['--node', GUEST, '--capability', 'taskauto', '--json', '--out', file], f.env);
		assert.equal(r.code, 1, r.err);
		const doc = JSON.parse(r.out);
		assert.equal(doc.verdict, 'refused');
		assert.equal(doc.ok, false);
		assert.equal(doc.findings[0].rule, 'guest');
		assert.deepEqual(
			JSON.parse(readFileSync(file, 'utf8')),
			doc,
			'--out carries the same document'
		);
		assert.deepEqual(f.calls(), [], 'neither gh nor ssh was touched');
		assert.equal(
			existsSync(join(f.stateDir, 'job-proofs.json')),
			false,
			'a refusal is not recorded'
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('an unreadable GitHub is a finding with its reason and a non-zero exit — never a pass', () => {
	const f = fixture();
	try {
		const r = run(['--node', CLAW, '--capability', 'taskauto', '--json'], f.env);
		assert.equal(r.code, 1);
		const doc = JSON.parse(r.out);
		assert.equal(doc.verdict, 'error');
		assert.equal(doc.findings[0].rule, 'workflow-unreadable');
		assert.match(doc.findings[0].message, /HTTP 404/);
		assert.ok(
			f.calls().every((c) => c.startsWith('gh api')),
			'only reads; no ssh, no write'
		);
		assert.ok(!f.calls().some((c) => /-X/.test(c)));
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a node that does not carry the capability is refused before GitHub is asked anything', () => {
	const f = fixture();
	try {
		writeFileSync(
			join(f.root, 'manifests', 'fleet-runner-manifest.json'),
			JSON.stringify({ machines: { [CLAW]: { role: 'claw', ephemeral: true, labels: [] } } })
		);
		const r = run(['--node', CLAW, '--capability', 'taskauto', '--json'], f.env);
		assert.equal(r.code, 1);
		assert.equal(JSON.parse(r.out).findings[0].rule, 'capability-state');
		assert.deepEqual(f.calls(), []);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('usage errors exit 2 and touch nothing: no --node, a bare positional, an undeclared node, no job', () => {
	const f = fixture();
	try {
		for (const args of [
			['--capability', 'taskauto'],
			[CLAW, '--capability', 'taskauto'],
			['--node', 'nowhere', '--capability', 'taskauto'],
			['--node', CLAW],
			['--node', CLAW, '--capability', 'jitconfig'],
			['--node', CLAW, '--capability', 'taskauto', '--attempts', 'many'],
		]) {
			const r = run(args, f.env);
			assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}${r.err}`);
		}
		assert.deepEqual(f.calls(), []);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('prove-job is a subcommand of the one door, and is deliberately not under the --json contract', async () => {
	const { JSON_CONTRACT } = await import('./lib/json-contract.mjs');
	assert.ok(
		!JSON_CONTRACT.some((c) => c.sub === 'prove-job'),
		'no cron parses it; add it here only with its consumer'
	);
	const cli = readFileSync(join(dirname(SCRIPT), '..', 'src', 'cli.ts'), 'utf8');
	assert.match(cli, /'prove-job':\s*\{\s*script: 'prove-job\.mjs'/);
});

// --- the host-less path: AFTER a successful mint, BEFORE any dispatch ---------
//
// The first real run (0.25.15) died with "host not installed" because the mint's
// `logger.info` reads the in-process host, which only `createFleetManager` installs
// and `src/tests` preload a test host for. Every other test here stops BEFORE the
// mint (refusal, unreadable workflow), so none of them reached the line that threw.
// These two run the real script, in a process with NO host, through a mint that
// SUCCEEDS (shimmed gh + ssh), and fail the dispatch so the run ends right after.

const JIT_CONFIG = Buffer.from(
	JSON.stringify({
		'.runner': Buffer.from(JSON.stringify({ DisableUpdate: 'True', Ephemeral: 'True' })).toString(
			'base64'
		),
	})
).toString('base64');

const WORKFLOW = [
	'name: t',
	'on:',
	'  workflow_dispatch:',
	'jobs:',
	'  backend:',
	'    name: backend pytest',
	'    runs-on: [self-hosted, taskauto]',
	'    steps:',
	'      - run: true',
	'',
].join('\n');

/** Shims for a world where everything works until the dispatch, which answers 500. */
function mintWorld(f, { teardownUnitGone = true } = {}) {
	const calls = join(f.root, 'calls.log');
	const bin = join(f.root, 'bin');
	writeFileSync(join(f.root, 'workflow.yml'), WORKFLOW);
	writeFileSync(
		join(bin, 'gh'),
		`#!/bin/sh
echo "gh $*" >>${JSON.stringify(calls)}
case "$*" in
  *contents/.github/workflows*) cat ${JSON.stringify(join(f.root, 'workflow.yml'))} ;;
  *actions/runners/downloads*) echo '[{"os":"linux","architecture":"x64","download_url":"https://example.invalid/runner.tgz"}]' ;;
  *generate-jitconfig*) cat >/dev/null; echo '{"encoded_jit_config":"${JIT_CONFIG}"}' ;;
  *dispatches*) cat >/dev/null; echo 'gh: Server Error (HTTP 500)' >&2; exit 1 ;;
  *actions/runners*) echo '{"runners":[]}' ;;
  *workflows/test.yml/runs*) echo '{"workflow_runs":[]}' ;;
  *) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
esac
`
	);
	writeFileSync(
		join(bin, 'ssh'),
		`#!/bin/sh
script=$(cat)
echo "ssh $(printf %s "$script" | head -c 80 | tr '\\n' ' ')" >>${JSON.stringify(calls)}
case "$script" in
  *"echo REACHABLE"*) echo REACHABLE ;;
  *jit-provision*) echo SLOT-READY ;;
  *"echo CFG-OK"*) echo CFG-OK ;;
  *"systemctl --user stop"*) echo ${teardownUnitGone ? 'UNIT-GONE' : 'UNIT-ACTIVE'}; echo CFG-GONE; echo LISTENER-GONE ;;
  *) true ;;
esac
`
	);
}

test('with NO host installed, the real script gets through a successful mint (no "host not installed")', () => {
	const f = fixture();
	try {
		mintWorld(f);
		const r = run(['--node', CLAW, '--capability', 'taskauto', '--json', '--no-record'], f.env);
		const doc = JSON.parse(r.out);
		const all = `${r.out}${r.err}`;
		assert.doesNotMatch(all, /host not installed/, all);
		assert.equal(doc.minted.length, 1, 'the mint ran to completion');
		assert.deepEqual(
			doc.findings.map((x) => x.rule),
			['dispatch-failed'],
			'it got as far as the dispatch — which the shim refuses — and no further'
		);
		assert.match(
			r.err,
			/\[ephemeral\] minted jit-/,
			'the library logged to STDERR, via the CLI host'
		);
		assert.doesNotMatch(
			r.out.trim().split('\n')[0],
			/\[ephemeral\]/,
			'stdout stays one JSON document'
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a failure AFTER mint and BEFORE dispatch still tears the proof runner down, VERIFIED', () => {
	const f = fixture();
	try {
		mintWorld(f);
		const r = run(['--node', CLAW, '--capability', 'taskauto', '--json', '--no-record'], f.env);
		const doc = JSON.parse(r.out);
		assert.equal(doc.verdict, 'error');
		assert.equal(doc.teardown.ok, true, JSON.stringify(doc.teardown));
		assert.equal(doc.teardown.runners.length, 1);
		assert.deepEqual(doc.teardown.runners[0], {
			name: doc.minted[0],
			unitStopped: true,
			configGone: true,
			listenerGone: true,
			deregistered: true,
		});
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}

	// And the verification is REAL: a node that still reports the unit active is a failure.
	const g = fixture();
	try {
		mintWorld(g, { teardownUnitGone: false });
		const r = run(['--node', CLAW, '--capability', 'taskauto', '--json', '--no-record'], g.env);
		const doc = JSON.parse(r.out);
		assert.equal(doc.teardown.ok, false);
		assert.ok(
			doc.findings.some((x) => x.rule === 'teardown-failed' && /still active/.test(x.message))
		);
		assert.equal(r.code, 1);
	} finally {
		rmSync(g.root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// wave 4e (#102) — `--input k=v` reaches the real dispatch body, and a
// workload-gated capability's PASS writes `$proof` through the real
// `writeProof`/`readProof` (measured.ts), read back with the built library.
// ---------------------------------------------------------------------------

test('--input k=v (repeatable) reaches the real dispatch body, verbatim', () => {
	const f = fixture();
	try {
		mintWorld(f);
		const dispatchBodyFile = join(f.root, 'dispatch-body.json');
		const bin = join(f.root, 'bin');
		// Same shim `mintWorld` writes, with ONE case changed: the dispatch body
		// is captured to a file instead of discarded, so this test can read back
		// exactly what the real CLI sent.
		writeFileSync(
			join(bin, 'gh'),
			`#!/bin/sh
echo "gh $*" >>${JSON.stringify(join(f.root, 'calls.log'))}
case "$*" in
  *contents/.github/workflows*) cat ${JSON.stringify(join(f.root, 'workflow.yml'))} ;;
  *actions/runners/downloads*) echo '[{"os":"linux","architecture":"x64","download_url":"https://example.invalid/runner.tgz"}]' ;;
  *generate-jitconfig*) cat >/dev/null; echo '{"encoded_jit_config":"${JIT_CONFIG}"}' ;;
  *dispatches*) cat >${JSON.stringify(dispatchBodyFile)}; echo 'gh: Server Error (HTTP 500)' >&2; exit 1 ;;
  *actions/runners*) echo '{"runners":[]}' ;;
  *workflows/test.yml/runs*) echo '{"workflow_runs":[]}' ;;
  *) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
esac
`
		);
		chmodSync(join(bin, 'gh'), 0o755);
		const r = run(
			[
				'--node',
				CLAW,
				'--capability',
				'taskauto',
				'--input',
				'only=e2e',
				'--input',
				'specs=play.spec.ts arrow.spec.ts',
				'--json',
				'--no-record',
			],
			f.env
		);
		const doc = JSON.parse(r.out);
		assert.equal(doc.findings[0].rule, 'dispatch-failed', JSON.stringify(doc.findings));
		assert.deepEqual(JSON.parse(readFileSync(dispatchBodyFile, 'utf8')), {
			ref: 'main',
			inputs: { only: 'e2e', specs: 'play.spec.ts arrow.spec.ts' },
		});
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('--input requires key=value', () => {
	const f = fixture();
	try {
		const r = run(
			['--node', CLAW, '--capability', 'taskauto', '--input', 'no-equals-sign', '--json'],
			f.env
		);
		assert.equal(r.code, 2);
		assert.match(JSON.parse(r.out).error, /key=value/);
		assert.deepEqual(f.calls(), []);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a jdk21-shaped PASS writes $proof, read back through the built measured.ts library', async () => {
	const f = fixture();
	try {
		const { readProof } = await import('../dist/lib/measured.js');
		// RELATIVE TO NOW, never an absolute date: `fixture-clock-guard.test.mjs`
		// flags any literal ISO date a fixture carries, because a reader that
		// treats it as "recent" would age it out on its own. The 300s gap is
		// what this test cares about, not any particular instant.
		const jobStartedAt = new Date(Date.now() - 300_000).toISOString();
		const jobCompletedAt = new Date().toISOString();
		const forgeWorkflow = [
			'name: Forge',
			'on:',
			'  workflow_dispatch:',
			'    inputs:',
			'      only: { required: false, default: "" }',
			'      specs: { required: false, default: "" }',
			'jobs:',
			'  forge-e2e:',
			'    name: forge-e2e',
			'    runs-on: [self-hosted, hadoku-builder, jdk21]',
			'    steps:',
			'      - run: true',
			'',
		].join('\n');
		writeFileSync(join(f.root, 'workflow.yml'), forgeWorkflow);
		const jitConfig = Buffer.from(
			JSON.stringify({
				'.runner': Buffer.from(
					JSON.stringify({ DisableUpdate: 'True', Ephemeral: 'True' })
				).toString('base64'),
			})
		).toString('base64');
		const calls = join(f.root, 'calls.log');
		const bin = join(f.root, 'bin');
		const dispatched = join(f.root, 'dispatched');
		// The real runner name is `jit-<node>-proof-<repo>-j0-r0-<epoch ms at
		// mint time>` — not reproducible from JS ahead of the real run, so the
		// shim reads it back off the MINT call's own body (`generate-jitconfig`'s
		// `name` field) instead of guessing it, the same way a real GitHub would
		// just be told the name and hand it back on every later call.
		const mintedNameFile = join(f.root, 'minted-name');
		writeFileSync(
			join(bin, 'gh'),
			`#!/bin/sh
echo "gh $*" >>${JSON.stringify(calls)}
case "$*" in
  *contents/.github/workflows*) cat ${JSON.stringify(join(f.root, 'workflow.yml'))} ;;
  *actions/runners/downloads*) echo '[{"os":"linux","architecture":"x64","download_url":"https://example.invalid/runner.tgz"}]' ;;
  *generate-jitconfig*)
    body=$(cat)
    name=$(printf '%s' "$body" | sed -n 's/.*"name" *: *"\\([^"]*\\)".*/\\1/p')
    printf '%s' "$name" >${JSON.stringify(mintedNameFile)}
    echo '{"encoded_jit_config":"${jitConfig}"}' ;;
  *dispatches*) cat >/dev/null; touch ${JSON.stringify(dispatched)}; exit 0 ;;
  *git/ref/heads/main*) echo '{"object":{"sha":"ddda60a"}}' ;;
  *git/refs/heads/canary/*) exit 0 ;;
  *git/refs*) cat >/dev/null; echo '{}' ;;
  *-X\\ DELETE*)
    rm -f ${JSON.stringify(mintedNameFile)}
    exit 0 ;;
  *workflows/forge.yml/runs*)
    if [ -f ${JSON.stringify(dispatched)} ]; then
      echo '{"workflow_runs":[{"id":9001,"status":"queued"}]}'
    else
      echo '{"workflow_runs":[]}'
    fi ;;
  *runs/9001/jobs*)
    name=$(cat ${JSON.stringify(mintedNameFile)} 2>/dev/null)
    echo "{\\"jobs\\":[{\\"id\\":7001,\\"name\\":\\"forge-e2e\\",\\"status\\":\\"completed\\",\\"conclusion\\":\\"success\\",\\"runner_name\\":\\"$name\\",\\"started_at\\":\\"${jobStartedAt}\\",\\"completed_at\\":\\"${jobCompletedAt}\\"}]}" ;;
  *runs/9001*) echo '{"id":9001,"status":"completed"}' ;;
  *jobs/7001/logs*) echo 'two friends play one Forge match' ;;
  *actions/runners*)
    name=$(cat ${JSON.stringify(mintedNameFile)} 2>/dev/null)
    if [ -n "$name" ]; then
      echo "{\\"runners\\":[{\\"id\\":1,\\"name\\":\\"$name\\",\\"busy\\":false}]}"
    else
      echo '{"runners":[]}'
    fi ;;
  *) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
esac
`
		);
		writeFileSync(
			join(bin, 'ssh'),
			`#!/bin/sh
script=$(cat)
echo "ssh $(printf %s "$script" | head -c 80 | tr '\\n' ' ')" >>${JSON.stringify(calls)}
case "$script" in
  *"echo REACHABLE"*) echo REACHABLE ;;
  *jit-provision*) echo SLOT-READY ;;
  *"echo CFG-OK"*) echo CFG-OK ;;
  *"systemctl --user stop"*) echo UNIT-GONE; echo CFG-GONE; echo LISTENER-GONE ;;
  *) true ;;
esac
`
		);
		chmodSync(join(bin, 'gh'), 0o755);
		chmodSync(join(bin, 'ssh'), 0o755);
		writeFileSync(
			join(f.root, 'manifests', 'fleet-runner-manifest.json'),
			JSON.stringify({
				toolchain: { capabilities: [] },
				machines: {
					[CLAW]: { role: 'claw', ephemeral: true, labels: ['jdk21'], maxConcurrent: 2 },
				},
			})
		);
		const r = run(
			[
				'--node',
				CLAW,
				'--capability',
				'jdk21',
				'--repo',
				'WolffM/hadoku-cardtable',
				'--workflow',
				'forge.yml',
				'--job',
				'forge-e2e',
				'--evidence',
				'two friends play one Forge match',
				'--json',
			],
			f.env
		);
		const doc = JSON.parse(r.out);
		assert.equal(doc.verdict, 'pass', JSON.stringify(doc.findings));
		assert.equal(r.code, 0, JSON.stringify(doc.findings));
		assert.ok(doc.proofRecord, 'the result carries the $proof record it wrote');
		assert.equal(doc.proofRecord.verdict, 'pass');
		assert.equal(doc.proofRecord.durationSec, 300);
		const stored = readProof(CLAW, 'jdk21', { dir: f.stateDir });
		assert.ok(stored, '$proof must be readable back through the real library');
		assert.equal(stored.verdict, 'pass');
		assert.equal(stored.node, CLAW);
		assert.equal(stored.capability, 'jdk21');
		assert.equal(stored.durationSec, 300);
		assert.equal(stored.evidenceMatched, true);
		assert.match(stored.why, /unbootstrapped: 0\/2/);
		// jdk21 is a scratch-branch canary: never dispatched on main, branch removed.
		assert.match(doc.dispatchRef, /^canary\/fixture-claw-8\.invalid-/);
		const log = readFileSync(calls, 'utf8');
		assert.match(log, /git\/refs/);
		assert.match(log, /-X DELETE \S*git\/refs\/heads\/canary\//);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

// --under-own-drain (2026-10-08): bootcamp --prove drains the node for its
// canary, and prove-job must not then refuse the mint because the node is
// drained, yet the flag must never bypass someone else's drain.
test('--under-own-drain: refused with no drain row, or a drain that is not bootcamp’s, before anything is reached', () => {
	const f = fixture();
	try {
		const none = run(
			['--node', CLAW, '--capability', 'taskauto', '--json', '--under-own-drain'],
			f.env
		);
		assert.equal(none.code, 2);
		assert.match(JSON.parse(none.out).error, /not drained/);
		writeFileSync(
			join(f.stateDir, 'fleet-drain.json'),
			JSON.stringify({ nodes: { [CLAW]: { kind: 'maintenance', reason: 'disk swap' } } })
		);
		const other = run(
			['--node', CLAW, '--capability', 'taskauto', '--json', '--under-own-drain'],
			f.env
		);
		assert.equal(other.code, 2);
		assert.match(JSON.parse(other.out).error, /not bootcamp's canary drain/);
		assert.deepEqual(f.calls(), [], 'neither a node nor GitHub was reached');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('--under-own-drain under bootcamp’s own drain gets past admission (the mint is attempted)', () => {
	const f = fixture();
	try {
		writeFileSync(
			join(f.stateDir, 'fleet-drain.json'),
			JSON.stringify({
				nodes: {
					[CLAW]: { kind: 'training', reason: 'fleet bootcamp --prove: taskauto workload canary' },
				},
			})
		);
		const r = run(
			['--node', CLAW, '--capability', 'taskauto', '--json', '--under-own-drain'],
			f.env
		);
		const doc = JSON.parse(r.out);
		assert.notEqual(doc.findings?.[0]?.rule, 'admission', 'its own drain must not refuse the mint');
		assert.notEqual(doc.findings?.[0]?.rule, 'usage');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// STANDING MODE through the real entry point (2026-10-10): `--include-guests`
// proves a guest's own registration with GitHub API calls only. The ssh shim
// here records and fails; a standing run must never reach it.
// ---------------------------------------------------------------------------

test('--include-guests on a claw is a usage error and touches nothing', () => {
	const f = fixture();
	try {
		const r = run(
			['--node', CLAW, '--capability', 'taskauto', '--include-guests', '--json'],
			f.env
		);
		assert.equal(r.code, 2, r.out + r.err);
		assert.match(JSON.parse(r.out).error, /not a guest/);
		assert.deepEqual(f.calls(), []);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a guest WITH --include-guests is proven on its standing runner: label added and removed, $proof written, no ssh', async () => {
	const f = fixture();
	try {
		const { readProof } = await import('../dist/lib/measured.js');
		const jobStartedAt = new Date(Date.now() - 200_000).toISOString();
		const jobCompletedAt = new Date().toISOString();
		writeFileSync(
			join(f.root, 'manifests', 'fleet-runner-manifest.json'),
			JSON.stringify({
				toolchain: { capabilities: [] },
				machines: { [GUEST]: { role: 'guest', labels: ['pm2-host', 'jdk21'], maxConcurrent: 4 } },
			})
		);
		writeFileSync(
			join(f.root, 'workflow.yml'),
			[
				'name: Forge',
				'on:',
				'  workflow_dispatch:',
				'jobs:',
				'  forge-e2e:',
				'    runs-on: ${{ fromJSON(inputs.runs_on) }}',
				'    steps:',
				'      - run: true',
				'',
			].join('\n')
		);
		const calls = join(f.root, 'calls.log');
		const labelFile = join(f.root, 'proof-label');
		const dispatched = join(f.root, 'dispatched');
		const bin = join(f.root, 'bin');
		writeFileSync(
			join(bin, 'gh'),
			`#!/bin/sh
echo "gh $*" >>${JSON.stringify(calls)}
case "$*" in
  *contents/.github/workflows*) cat ${JSON.stringify(join(f.root, 'workflow.yml'))} ;;
  *"-X POST"*actions/runners/42/labels*)
    sed -n 's/.*"\\(proof-[0-9a-z]*\\)".*/\\1/p' >${JSON.stringify(labelFile)}
    echo '{}' ;;
  *"-X DELETE"*actions/runners/42/labels/proof-*) rm -f ${JSON.stringify(labelFile)}; echo '{}' ;;
  *dispatches*) cat >/dev/null; touch ${JSON.stringify(dispatched)}; exit 0 ;;
  *git/ref/heads/main*) echo '{"object":{"sha":"ddda60a"}}' ;;
  *"-X DELETE"*git/refs/heads/canary/*) exit 0 ;;
  *git/refs*) cat >/dev/null; echo '{}' ;;
  *workflows/forge.yml/runs*)
    if [ -f ${JSON.stringify(dispatched)} ]; then
      echo '{"workflow_runs":[{"id":9001,"status":"queued"}]}'
    else
      echo '{"workflow_runs":[]}'
    fi ;;
  *runs/9001/jobs*)
    echo '{"jobs":[{"id":7001,"name":"forge-e2e (1)","status":"completed","conclusion":"success","runner_name":"${GUEST}","created_at":"${jobStartedAt}","started_at":"${jobStartedAt}","completed_at":"${jobCompletedAt}"}]}' ;;
  *runs/9001*) echo '{"id":9001,"status":"completed"}' ;;
  *jobs/7001/logs*) echo 'two friends play one Forge match' ;;
  *actions/runners*)
    extra=""
    if [ -s ${JSON.stringify(labelFile)} ]; then extra=",{\\"name\\":\\"$(cat ${JSON.stringify(labelFile)})\\"}"; fi
    echo "{\\"runners\\":[{\\"id\\":42,\\"name\\":\\"${GUEST}\\",\\"status\\":\\"online\\",\\"busy\\":true,\\"labels\\":[{\\"name\\":\\"self-hosted\\"}$extra]}]}" ;;
  *) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
esac
`
		);
		chmodSync(join(bin, 'gh'), 0o755);
		const r = run(['--node', GUEST, '--capability', 'jdk21', '--include-guests', '--json'], f.env);
		const doc = JSON.parse(r.out);
		assert.equal(doc.verdict, 'pass', JSON.stringify(doc.findings));
		assert.equal(r.code, 0, JSON.stringify(doc.findings));
		assert.equal(doc.mode, 'standing');
		assert.equal(doc.runnerName, GUEST);
		assert.match(r.err, /PROVING A GUEST: fixture-guest\.invalid/, 'logged loudly');
		const log = f.calls();
		assert.ok(!log.some((c) => c.startsWith('ssh')), `no ssh: ${log.join('\n')}`);
		assert.ok(log.some((c) => /-X POST \S*actions\/runners\/42\/labels/.test(c)));
		assert.ok(log.some((c) => /-X DELETE \S*actions\/runners\/42\/labels\/proof-/.test(c)));
		assert.equal(existsSync(labelFile), false, 'the proof label is gone');
		assert.ok(!log.some((c) => /generate-jitconfig/.test(c)), 'nothing minted');
		assert.equal(doc.proofRecord?.verdict, 'pass');
		const stored = readProof(GUEST, 'jdk21', { dir: f.stateDir });
		assert.equal(stored?.verdict, 'pass');
		assert.equal(stored?.runner, GUEST);
		assert.equal(stored?.durationSec, 200);
		const ledger = JSON.parse(readFileSync(join(f.stateDir, 'job-proofs.json'), 'utf8'));
		assert.equal(ledger[`${GUEST}::jdk21`].lastPass.runnerName, GUEST);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});
