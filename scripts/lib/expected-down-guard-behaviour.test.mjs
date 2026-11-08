/**
 * BEHAVIOURAL FIXTURES — the five gates, run for real against a throwaway
 * manifest and PATH shims, never a live node (CLAUDE.md: fixtures only).
 *
 * Split out of `expected-down-guard.test.mjs` (wave 5s lane B) to bring that
 * file under the 1,000-line test ceiling — a whole-block move, every test
 * body below unchanged from where it lived there. The structural tests in
 * that file prove each gate ASKS the question; these prove it gets the
 * ANSWER right — deferred-and-fresh passes and is still printed, past
 * `DEFER_DAYS` it fails again, `kind: training` never defers, and a drained
 * node that actually answers is not blindly skipped. Same harness shape
 * `reconcile-fleet-runners.test.mjs` and `reconcile-runner-identity.test.mjs`
 * already use for this CLI: a `mkdtemp` manifest dir, `gh`/`ssh` shims first on
 * PATH, stdout captured to a FILE (a pipe loses everything past 8 KB on this
 * host — #33), and the exit code read directly.
 *
 * These tests live here, not beside each gate, because the brief that added
 * them explicitly keeps them out of `reconcile-fleet-runners.test.mjs` — that
 * file already exists and is not on this lane's file list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixtureRemotes } from './fleet-source-fixture.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SCRIPTS_DIR = join(ROOT, 'scripts');

const SCRIPTS = SCRIPTS_DIR;
const NO_GIT_ENV = Object.fromEntries(
	Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
);
const DAYS_AGO = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

/** One shim script written to `dir/name`, executable. */
function shim(dir, name, src) {
	const p = join(dir, name);
	writeFileSync(p, src);
	chmodSync(p, 0o755);
	return p;
}

/** Runs `node <script> ...argv>` against `env`, stdout+stderr to a file. Never throws. */
function runScript(script, argv, env, cwd) {
	const outPath = join(cwd, 'out.txt');
	const fd = openSync(outPath, 'w');
	let code = 0;
	try {
		execFileSync('node', [script, ...argv], { env, stdio: ['ignore', fd, fd] });
	} catch (e) {
		code = e.status ?? -1;
	} finally {
		closeSync(fd);
	}
	return { code, out: readFileSync(outPath, 'utf8') };
}

// ── clean-runner-debris.mjs ────────────────────────────────────────────────

void test('clean-runner-debris: expected-down deferral, expiry, and a reachable drained node', () => {
	const SCRIPT = join(SCRIPTS, 'clean-runner-debris.mjs');
	const NODE = 'fixture-claw';
	const SSH_SHIM = `#!/usr/bin/env bash
cat > /dev/null
node="\${5##*@}"
if [ "$node" = "\${SSH_FAIL_NODE:-}" ]; then
  echo "ssh: connect to host $node port 22: No route to host" >&2
  exit 255
fi
echo "SUMMARY stale_kb=0 update_kb=0 orphan_kb=0 diag_kb=0 tmpfs_kb=0 busy_skipped=0 free_kb=1000000 tmpfs_used_kb=0"
`;

	function fixture({ drain = null } = {}) {
		const root = mkdtempSync(join(tmpdir(), 'guard-clean-'));
		writeFileSync(
			join(root, 'fleet-runner-manifest.json'),
			JSON.stringify({ machines: { [NODE]: {} } })
		);
		if (drain) writeFileSync(join(root, 'fleet-drain.json'), JSON.stringify({ nodes: drain }));
		const bin = join(root, 'bin');
		mkdirSync(bin, { recursive: true });
		shim(bin, 'ssh', SSH_SHIM);
		return root;
	}

	function run(root, { failNode = '' } = {}) {
		return runScript(
			SCRIPT,
			['--machine', NODE],
			{
				...process.env,
				PATH: `${join(root, 'bin')}:${process.env.PATH}`,
				FLEET_MANIFEST_DIR: root,
				HADOKU_STATE_DIR: root,
				SSH_FAIL_NODE: failNode,
			},
			root
		);
	}

	// unreachable, no drain -> fails.
	let root = fixture();
	let r = run(root, { failNode: NODE });
	assert.equal(r.code, 1, `an unreachable node with no drain must fail, got ${r.code}:\n${r.out}`);
	rmSync(root, { recursive: true, force: true });

	// unreachable, fresh maintenance drain -> passes, and is still PRINTED.
	root = fixture({ drain: { [NODE]: { since: DAYS_AGO(0), kind: 'maintenance', reason: 'x' } } });
	r = run(root, { failNode: NODE });
	assert.equal(r.code, 0, `a fresh maintenance drain must defer, got ${r.code}:\n${r.out}`);
	assert.match(r.out, /expected down/, 'deferral removes the page, not the information');
	rmSync(root, { recursive: true, force: true });

	// a drain past DEFER_DAYS stops deferring.
	root = fixture({ drain: { [NODE]: { since: DAYS_AGO(8), kind: 'maintenance' } } });
	r = run(root, { failNode: NODE });
	assert.equal(r.code, 1, `an expired drain must fail again, got ${r.code}:\n${r.out}`);
	rmSync(root, { recursive: true, force: true });

	// a REACHABLE node with a fresh drain gets its real result, not a blind skip —
	// "defer unreachability only".
	root = fixture({ drain: { [NODE]: { since: DAYS_AGO(0), kind: 'maintenance' } } });
	r = run(root, {});
	assert.equal(r.code, 0, `a reachable node must report normally, got ${r.code}:\n${r.out}`);
	assert.doesNotMatch(
		r.out,
		/expected down/,
		'a node that actually answered was not deferred, only a node that could not be reached'
	);
	rmSync(root, { recursive: true, force: true });
});

// ── check-boundary-contracts.mjs ───────────────────────────────────────────

void test('check-boundary-contracts: expected-down deferral, expiry, and training never defers', () => {
	const SCRIPT = join(SCRIPTS, 'check-boundary-contracts.mjs');
	const NODE = 'fixture-claw';
	// Well-formed, NON-empty listings: an empty one is itself a finding (#98), and
	// this case is about the node half alone.
	const GH_SHIM = `#!/usr/bin/env bash
case "$*" in
  *"actions/runs?per_page="*) echo '{"workflow_runs":[{"id":1,"status":"queued","created_at":"x"}]}' ;;
  *"/jobs"*) echo '{"jobs":[{"status":"queued","labels":["self-hosted"]}]}' ;;
  *"actions/runners"*) echo '{"runners":[{"id":1,"name":"standing","status":"online","busy":false,"labels":[{"name":"self-hosted"}]}]}' ;;
  *) echo '{}' ;;
esac
`;
	const SSH_SHIM = `#!/usr/bin/env bash
cat > /dev/null
node="\${5##*@}"
if [ "$node" = "\${SSH_FAIL_NODE:-}" ]; then
  echo "ssh: connect to host $node port 22: No route to host" >&2
  exit 255
fi
echo "300"
`;

	function fixture({ drain = null } = {}) {
		const root = mkdtempSync(join(tmpdir(), 'guard-boundary-'));
		writeFileSync(
			join(root, 'fleet-runner-manifest.json'),
			JSON.stringify({ machines: { [NODE]: {} } })
		);
		if (drain) writeFileSync(join(root, 'fleet-drain.json'), JSON.stringify({ nodes: drain }));
		const bin = join(root, 'bin');
		mkdirSync(bin, { recursive: true });
		shim(bin, 'gh', GH_SHIM);
		shim(bin, 'ssh', SSH_SHIM);
		return root;
	}

	function run(root, { failNode = '' } = {}) {
		return runScript(
			SCRIPT,
			[],
			{
				...process.env,
				PATH: `${join(root, 'bin')}:${process.env.PATH}`,
				FLEET_MANIFEST_DIR: root,
				HADOKU_STATE_DIR: root,
				SSH_FAIL_NODE: failNode,
			},
			root
		);
	}

	let root = fixture();
	let r = run(root, { failNode: NODE });
	assert.equal(r.code, 1, `unreachable with no drain must fail, got ${r.code}:\n${r.out}`);
	rmSync(root, { recursive: true, force: true });

	root = fixture({ drain: { [NODE]: { since: DAYS_AGO(0), kind: 'maintenance', reason: 'x' } } });
	r = run(root, { failNode: NODE });
	assert.equal(r.code, 0, `a fresh maintenance drain must defer, got ${r.code}:\n${r.out}`);
	assert.match(r.out, /expected down/);
	rmSync(root, { recursive: true, force: true });

	root = fixture({ drain: { [NODE]: { since: DAYS_AGO(8), kind: 'maintenance' } } });
	r = run(root, { failNode: NODE });
	assert.equal(r.code, 1, `an expired drain must fail again, got ${r.code}:\n${r.out}`);
	rmSync(root, { recursive: true, force: true });

	root = fixture({ drain: { [NODE]: { since: DAYS_AGO(0), kind: 'training' } } });
	r = run(root, { failNode: NODE });
	assert.equal(r.code, 1, `a 'training' drain must never defer, got ${r.code}:\n${r.out}`);
	rmSync(root, { recursive: true, force: true });
});

// ── tool-inventory.mjs ────────────────────────────────────────────────

void test('tool-inventory: expected-down deferral, expiry, and training never defers', () => {
	const SCRIPT = join(SCRIPTS, 'tool-inventory.mjs');
	const NODE = 'fixture-claw';
	const SSH_SHIM = `#!/usr/bin/env bash
cat > /dev/null
node="\${5##*@}"
if [ "$node" = "\${SSH_FAIL_NODE:-}" ]; then
  echo "ssh: connect to host $node port 22: No route to host" >&2
  exit 255
fi
printf 'pnpm\\tyes\\nnode\\tyes\\n'
`;

	function fixture({ drain = null } = {}) {
		const root = mkdtempSync(join(tmpdir(), 'guard-toolinv-'));
		writeFileSync(
			join(root, 'fleet-runner-manifest.json'),
			JSON.stringify({ machines: { [NODE]: {} } })
		);
		// The site IS the one covered repo (deduped by name against
		// HADOKU_SITE_ROOT): an empty roster is its own tool-inventory finding (#98).
		writeFileSync(
			join(root, 'fleet-runner-coverage.json'),
			JSON.stringify({ repos: ['WolffM/hadoku_site'] })
		);
		if (drain) writeFileSync(join(root, 'fleet-drain.json'), JSON.stringify({ nodes: drain }));
		// The site as a fixture REMOTE (lib/fleet-source-fixture.mjs) with one
		// self-hosted workflow that invokes no tool from TOOLS — so the only thing
		// this fixture can fail on is reachability, never a real tool-drift
		// finding. The gate reads the hub through fleet-source; without the remote
		// it would read the REAL hadoku_site from GitHub.
		const remotes = fixtureRemotes('guard-toolinv-remotes-');
		remotes.push('WolffM/hadoku_site', {
			'.github/workflows/ci.yml':
				'jobs:\n  check:\n    runs-on: ${{ fromJSON(vars.CI_RUNNER) }}\n    steps:\n      - run: echo hi\n',
		});
		const site = join(root, 'site');
		mkdirSync(site, { recursive: true });
		const bin = join(root, 'bin');
		mkdirSync(bin, { recursive: true });
		shim(bin, 'ssh', SSH_SHIM);
		return { root, site, remotes };
	}

	function run({ root, site, remotes }, { failNode = '' } = {}) {
		return runScript(
			SCRIPT,
			[],
			{
				...process.env,
				PATH: `${join(root, 'bin')}:${process.env.PATH}`,
				FLEET_MANIFEST_DIR: root,
				HADOKU_STATE_DIR: root,
				HADOKU_SITE_ROOT: site,
				...remotes.env,
				SSH_FAIL_NODE: failNode,
			},
			root
		);
	}

	let fx = fixture();
	let r = run(fx, { failNode: NODE });
	assert.equal(r.code, 1, `unreachable with no drain must fail, got ${r.code}:\n${r.out}`);
	rmSync(fx.root, { recursive: true, force: true });
	fx.remotes.cleanup();

	fx = fixture({ drain: { [NODE]: { since: DAYS_AGO(0), kind: 'maintenance', reason: 'x' } } });
	r = run(fx, { failNode: NODE });
	assert.equal(r.code, 0, `a fresh maintenance drain must defer, got ${r.code}:\n${r.out}`);
	assert.match(r.out, /expected down/);
	rmSync(fx.root, { recursive: true, force: true });
	fx.remotes.cleanup();

	fx = fixture({ drain: { [NODE]: { since: DAYS_AGO(8), kind: 'maintenance' } } });
	r = run(fx, { failNode: NODE });
	assert.equal(r.code, 1, `an expired drain must fail again, got ${r.code}:\n${r.out}`);
	rmSync(fx.root, { recursive: true, force: true });
	fx.remotes.cleanup();

	fx = fixture({ drain: { [NODE]: { since: DAYS_AGO(0), kind: 'training' } } });
	r = run(fx, { failNode: NODE });
	assert.equal(r.code, 1, `a 'training' drain must never defer, got ${r.code}:\n${r.out}`);
	rmSync(fx.root, { recursive: true, force: true });
	fx.remotes.cleanup();
});

// ── check-warm-canary.mjs ───────────────────────────────────────────────────

/**
 * UNLIKE THE OTHER FOUR GATES: candidacy here mirrors the DISPATCHER's own
 * eligibility rule (`ephemeral-tick.ts`'s `drainedNodes` set, consumed by
 * `ephemeral.ts`), which excludes EVERY node with a row in `fleet-drain.json`
 * — any `kind`, any age, no `DEFER_DAYS` expiry. That is not `deferralFor`'s
 * narrower rule, and it must not be: a `training` drain is reachable, eligible
 * by measured memory, and — correctly, by the dispatcher's own design — holds
 * no listener, so treating it as a normal candidate would make
 * `warmCanaryVerdict`'s per-node check fail it for not holding a listener it
 * was never going to hold. `deferralFor`/`deferralNote` are used here only to
 * PRINT the kind/age, never to decide candidacy.
 */
void test('check-warm-canary: ANY drain row removes candidacy — never sshed, whatever the kind or age', () => {
	const SCRIPT = join(SCRIPTS, 'check-warm-canary.mjs');
	const NODE = 'fixture-claw';
	// Logs every invocation so the test can prove an excluded node was never
	// contacted at all, not merely that its failure was forgiven.
	const SSH_SHIM = `#!/usr/bin/env bash
script="$(cat)"
node="\${5##*@}"
printf '%s\\n' "$node" >> "$SSH_LOG"
if [ "$node" = "\${SSH_FAIL_NODE:-}" ]; then
  echo "ssh: connect to host $node port 22: No route to host" >&2
  exit 255
fi
if echo "$script" | grep -q "Mem:"; then echo "16384"; else echo ""; fi
`;

	function fixture({ drain = null } = {}) {
		const root = mkdtempSync(join(tmpdir(), 'guard-warmcanary-'));
		writeFileSync(
			join(root, 'fleet-runner-manifest.json'),
			JSON.stringify({ machines: { [NODE]: { ephemeral: true } } })
		);
		if (drain) writeFileSync(join(root, 'fleet-drain.json'), JSON.stringify({ nodes: drain }));
		const bin = join(root, 'bin');
		mkdirSync(bin, { recursive: true });
		shim(bin, 'ssh', SSH_SHIM);
		return { root, sshLog: join(root, 'ssh.log') };
	}

	function attempts(logPath, node) {
		if (!existsSync(logPath)) return 0;
		return readFileSync(logPath, 'utf8')
			.split('\n')
			.filter((l) => l === node).length;
	}

	function run(fx, { failNode = '' } = {}) {
		return runScript(
			SCRIPT,
			[],
			{
				...process.env,
				PATH: `${join(fx.root, 'bin')}:${process.env.PATH}`,
				FLEET_MANIFEST_DIR: fx.root,
				HADOKU_STATE_DIR: fx.root,
				SSH_LOG: fx.sshLog,
				SSH_FAIL_NODE: failNode,
			},
			fx.root
		);
	}

	// fresh maintenance drain -> excluded, never sshed, still printed.
	let fx = fixture({ drain: { [NODE]: { since: DAYS_AGO(0), kind: 'maintenance', reason: 'x' } } });
	let r = run(fx, { failNode: NODE });
	assert.equal(attempts(fx.sshLog, NODE), 0, 'a drained node must never be probed');
	assert.match(r.out, /expected down/, 'exclusion removes the page, not the information');
	rmSync(fx.root, { recursive: true, force: true });

	// an OLD drain is still excluded — unlike `deferralFor`'s own rule, this
	// candidacy question has no DEFER_DAYS expiry, because the dispatcher's
	// never has one either. Still printed, with its age visible.
	fx = fixture({ drain: { [NODE]: { since: DAYS_AGO(30), kind: 'maintenance' } } });
	r = run(fx, { failNode: NODE });
	assert.equal(attempts(fx.sshLog, NODE), 0, 'an old drain must still exclude candidacy');
	assert.match(r.out, /expected down/);
	rmSync(fx.root, { recursive: true, force: true });

	// 'training' is excluded too — see the regression test below for WHY this
	// has to be true, not just that it is.
	fx = fixture({ drain: { [NODE]: { since: DAYS_AGO(0), kind: 'training' } } });
	r = run(fx, { failNode: NODE });
	assert.equal(attempts(fx.sshLog, NODE), 0, "a 'training' drain must still exclude candidacy");
	rmSync(fx.root, { recursive: true, force: true });
});

void test('check-warm-canary: a training-drained node must not drag a healthy canary into a false failure', () => {
	// THE REGRESSION. Before this fix, candidacy used `deferralFor`'s narrower
	// rule, so a `training` drain stayed a candidate: reachable, eligible by
	// measured memory, and — correctly, by design — holding no listener. Fed
	// into `warmCanaryVerdict`'s "every eligible node must be warm" check, that
	// produced "1 of 2 eligible node(s) not holding a warm listener:
	// fixture-train" even though `fixture-warm` was genuinely healthy. A new
	// false `@here`, with the wrong reason.
	const SCRIPT = join(SCRIPTS, 'check-warm-canary.mjs');
	const WARM = 'fixture-warm';
	const TRAIN = 'fixture-train';
	const REPO = 'WolffM/fixture-alpha';
	const SSH_SHIM = `#!/usr/bin/env bash
script="$(cat)"
node="\${5##*@}"
printf '%s\\n' "$node" >> "$SSH_LOG"
if echo "$script" | grep -q "Mem:"; then
  echo "16384"
elif echo "$script" | grep -q "warm/repo"; then
  [ "$node" = "\${WARM_NODE:-}" ] && echo "${REPO}" || echo ""
elif echo "$script" | grep -q "is-active"; then
  [ "$node" = "\${WARM_NODE:-}" ] && echo "active" || echo "inactive"
else
  echo ""
fi
`;

	const root = mkdtempSync(join(tmpdir(), 'guard-warmcanary-regress-'));
	writeFileSync(
		join(root, 'fleet-runner-manifest.json'),
		JSON.stringify({ machines: { [WARM]: { ephemeral: true }, [TRAIN]: { ephemeral: true } } })
	);
	writeFileSync(
		join(root, 'fleet-drain.json'),
		JSON.stringify({ nodes: { [TRAIN]: { since: DAYS_AGO(0), kind: 'training' } } })
	);
	const bin = join(root, 'bin');
	mkdirSync(bin, { recursive: true });
	shim(bin, 'ssh', SSH_SHIM);
	const sshLog = join(root, 'ssh.log');

	try {
		const r = runScript(
			SCRIPT,
			['--json'],
			{
				...process.env,
				PATH: `${bin}:${process.env.PATH}`,
				FLEET_MANIFEST_DIR: root,
				HADOKU_STATE_DIR: root,
				SSH_LOG: sshLog,
				WARM_NODE: WARM,
			},
			root
		);
		assert.equal(
			r.code,
			0,
			`a drained training node must not fail an otherwise-healthy canary, got ${r.code}:\n${r.out}`
		);
		const report = JSON.parse(r.out);
		assert.deepEqual(
			report.eligible,
			[WARM],
			'the training node must not even be counted as eligible'
		);
		assert.deepEqual(report.drained, [TRAIN]);
		assert.ok(
			!readFileSync(sshLog, 'utf8').includes(TRAIN),
			'the training node must never be contacted at all'
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── reconcile-fleet-runners.mjs ─────────────────────────────────────────────

void test('reconcile-fleet-runners: an OFFLINE registration defers only for a fresh maintenance drain', () => {
	const SCRIPT = join(SCRIPTS, 'reconcile-fleet-runners.mjs');
	const CLAW = 'fixture-claw';
	const REPO = 'WolffM/fixture-alpha';
	const GH_SHIM = `#!/usr/bin/env bash
case "$*" in
  "repo list"*)
    echo '[{"nameWithOwner":"${REPO}","isFork":false,"isArchived":false,"pushedAt":"'"$GH_PUSHED_AT"'"}]' ;;
  *"actions/runners"*) cat "$GH_RUNNERS" ;;
  *"releases/latest"*) echo 'v2.337.0' ;;
  *"/contents/.github/workflows") echo '[{"name":"ci.yml","path":".github/workflows/ci.yml"}]' ;;
  *"/contents/.github/workflows/"*)
    printf '{"content":"%s"}\\n' "$(printf 'jobs:\\n  check:\\n    runs-on: \${{ fromJSON(vars.CI_RUNNER) }}\\n' | base64 -w0)" ;;
  *"trees/HEAD"*) echo '{"tree":[]}' ;;
  *) echo '{}' ;;
esac
`;
	const SSH_SHIM = `#!/usr/bin/env bash
cat > /dev/null
echo "PROBE-END \${5##*@} 0 0"
`;

	function fixture({ drain = null } = {}) {
		const root = mkdtempSync(join(tmpdir(), 'guard-reconcile-'));
		writeFileSync(
			join(root, 'fleet-runner-manifest.json'),
			JSON.stringify({ machines: { [CLAW]: { labels: ['hadoku-builder'], maxConcurrent: 2 } } })
		);
		writeFileSync(join(root, 'fleet-runner-coverage.json'), JSON.stringify({ repos: [REPO] }));
		if (drain) writeFileSync(join(root, 'fleet-drain.json'), JSON.stringify({ nodes: drain }));
		const bin = join(root, 'bin');
		mkdirSync(bin, { recursive: true });
		shim(bin, 'gh', GH_SHIM);
		shim(bin, 'ssh', SSH_SHIM);
		return { root, runners: join(root, 'runners.json') };
	}

	const oneRunner = (status) => [
		{ id: 1, name: CLAW, status, busy: false, labels: [{ name: 'hadoku-builder' }] },
	];

	function run(fx, runners, argv = []) {
		writeFileSync(fx.runners, JSON.stringify({ total_count: runners.length, runners }));
		return runScript(
			SCRIPT,
			argv,
			{
				...NO_GIT_ENV,
				PATH: `${join(fx.root, 'bin')}:${process.env.PATH}`,
				// A token the host may not supply: never the App's pool, never a real mint (#9).
				GH_TOKEN: 'fixture',
				FLEET_MANIFEST_DIR: fx.root,
				HADOKU_STATE_DIR: fx.root,
				GH_RUNNERS: fx.runners,
				GH_PUSHED_AT: new Date().toISOString(),
			},
			fx.root
		);
	}

	// baseline: a claw's offline registration fails with no drain on record.
	let fx = fixture();
	let r = run(fx, oneRunner('offline'));
	assert.equal(r.code, 1, `an offline claw with no drain must fail, got ${r.code}:\n${r.out}`);
	rmSync(fx.root, { recursive: true, force: true });

	// a fresh maintenance drain defers it, and it is still PRINTED.
	fx = fixture({ drain: { [CLAW]: { since: DAYS_AGO(0), kind: 'maintenance', reason: 'x' } } });
	r = run(fx, oneRunner('offline'));
	assert.equal(r.code, 0, `a fresh maintenance drain must defer, got ${r.code}:\n${r.out}`);
	assert.match(r.out, /OFFLINE, EXPECTED DOWN \(1\)/);
	assert.match(r.out, /expected down: fixture-claw/);
	rmSync(fx.root, { recursive: true, force: true });

	// past DEFER_DAYS the offline row fails again.
	fx = fixture({ drain: { [CLAW]: { since: DAYS_AGO(8), kind: 'maintenance' } } });
	r = run(fx, oneRunner('offline'));
	assert.equal(r.code, 1, `an expired drain must fail again, got ${r.code}:\n${r.out}`);
	rmSync(fx.root, { recursive: true, force: true });

	// 'training' is meant to be RUNNING and must never defer.
	fx = fixture({ drain: { [CLAW]: { since: DAYS_AGO(0), kind: 'training' } } });
	r = run(fx, oneRunner('offline'));
	assert.equal(r.code, 1, `a 'training' drain must never defer, got ${r.code}:\n${r.out}`);
	rmSync(fx.root, { recursive: true, force: true });

	// THE PRECISION RULE: a registration that answers ONLINE is never deferred,
	// drained or not — it is not even in the `offline` array to begin with.
	fx = fixture({ drain: { [CLAW]: { since: DAYS_AGO(0), kind: 'maintenance' } } });
	r = run(fx, oneRunner('online'), ['--json']);
	assert.equal(r.code, 0);
	const report = JSON.parse(r.out);
	assert.equal(
		report.offline.length,
		0,
		'a drained node that answers ONLINE is not deferred — it never reaches the offline array'
	);
	rmSync(fx.root, { recursive: true, force: true });
});

// ── runner-units.mjs (#74) ────────────────────────────────────────────

void test('runner-units: expected-down deferral, expiry, and a reachable drained node', () => {
	const SCRIPT = join(SCRIPTS, 'runner-units.mjs');
	const NODE = 'fixture-claw';
	const SSH_SHIM = `#!/usr/bin/env bash
cat > /dev/null
node="\${5##*@}"
if [ "$node" = "\${SSH_FAIL_NODE:-}" ]; then
  echo "ssh: connect to host $node port 22: No route to host" >&2
  exit 255
fi
printf ''
`;

	function fixture({ drain = null } = {}) {
		const root = mkdtempSync(join(tmpdir(), 'guard-runnerunits-'));
		writeFileSync(
			join(root, 'fleet-runner-manifest.json'),
			JSON.stringify({ machines: { [NODE]: {} } })
		);
		// Empty roster: no install this fixture emits, so `resolveRepo` (a `gh`
		// call) is never reached — the thing under test here is reachability,
		// not roster resolution.
		writeFileSync(join(root, 'fleet-runner-coverage.json'), JSON.stringify({ repos: [] }));
		if (drain) writeFileSync(join(root, 'fleet-drain.json'), JSON.stringify({ nodes: drain }));
		const bin = join(root, 'bin');
		mkdirSync(bin, { recursive: true });
		shim(bin, 'ssh', SSH_SHIM);
		return root;
	}

	function run(root, { failNode = '' } = {}) {
		return runScript(
			SCRIPT,
			['--machine', NODE],
			{
				...process.env,
				PATH: `${join(root, 'bin')}:${process.env.PATH}`,
				FLEET_MANIFEST_DIR: root,
				HADOKU_STATE_DIR: root,
				SSH_FAIL_NODE: failNode,
			},
			root
		);
	}

	// unreachable, no drain -> fails.
	let root = fixture();
	let r = run(root, { failNode: NODE });
	assert.equal(r.code, 1, `an unreachable node with no drain must fail, got ${r.code}:\n${r.out}`);
	rmSync(root, { recursive: true, force: true });

	// unreachable, fresh maintenance drain -> passes, and is still PRINTED.
	root = fixture({ drain: { [NODE]: { since: DAYS_AGO(0), kind: 'maintenance', reason: 'x' } } });
	r = run(root, { failNode: NODE });
	assert.equal(r.code, 0, `a fresh maintenance drain must defer, got ${r.code}:\n${r.out}`);
	assert.match(r.out, /expected down/, 'deferral removes the page, not the information');
	rmSync(root, { recursive: true, force: true });

	// a drain past DEFER_DAYS stops deferring.
	root = fixture({ drain: { [NODE]: { since: DAYS_AGO(8), kind: 'maintenance' } } });
	r = run(root, { failNode: NODE });
	assert.equal(r.code, 1, `an expired drain must fail again, got ${r.code}:\n${r.out}`);
	rmSync(root, { recursive: true, force: true });

	// a REACHABLE node with a fresh drain gets its real result, not a blind
	// skip — "defer unreachability only".
	root = fixture({ drain: { [NODE]: { since: DAYS_AGO(0), kind: 'maintenance' } } });
	r = run(root, {});
	assert.equal(r.code, 0, `a reachable node must report normally, got ${r.code}:\n${r.out}`);
	assert.doesNotMatch(
		r.out,
		/expected down/,
		'a node that actually answered was not deferred, only a node that could not be reached'
	);
	rmSync(root, { recursive: true, force: true });

	// 'training' is meant to be RUNNING and must never defer.
	root = fixture({ drain: { [NODE]: { since: DAYS_AGO(0), kind: 'training' } } });
	r = run(root, { failNode: NODE });
	assert.equal(r.code, 1, `a 'training' drain must never defer, got ${r.code}:\n${r.out}`);
	rmSync(root, { recursive: true, force: true });
});

// ── collect-job-metrics.mjs (#74) ───────────────────────────────────────────

void test('collect-job-metrics: expected-down deferral, expiry, and a read-error is never deferred', () => {
	const SCRIPT = join(SCRIPTS, 'collect-job-metrics.mjs');
	const NODE = 'fixture-claw';
	const READ_END = '#job-metrics-read-end';
	const SSH_SHIM = `#!/usr/bin/env bash
cat > /dev/null
node="\${5##*@}"
if [ "$node" = "\${SSH_FAIL_NODE:-}" ]; then
  echo "ssh: connect to host $node port 22: No route to host" >&2
  exit 255
fi
if [ "$node" = "\${READ_ERROR_NODE:-}" ]; then
  echo "garbage, no sentinel line"
  exit 0
fi
echo "${READ_END} kept=0 older=0 files=0"
`;

	function fixture({ drain = null } = {}) {
		const root = mkdtempSync(join(tmpdir(), 'guard-jobmetrics-'));
		writeFileSync(
			join(root, 'fleet-runner-manifest.json'),
			JSON.stringify({ machines: { [NODE]: {} } })
		);
		if (drain) writeFileSync(join(root, 'fleet-drain.json'), JSON.stringify({ nodes: drain }));
		const bin = join(root, 'bin');
		mkdirSync(bin, { recursive: true });
		shim(bin, 'ssh', SSH_SHIM);
		return root;
	}

	function run(root, { failNode = '', readErrorNode = '' } = {}) {
		return runScript(
			SCRIPT,
			['--machine', NODE],
			{
				...process.env,
				PATH: `${join(root, 'bin')}:${process.env.PATH}`,
				FLEET_MANIFEST_DIR: root,
				HADOKU_STATE_DIR: root,
				// No job-history.jsonl under this HOME, so every row (there are
				// none here anyway) stays unjoined rather than reading the
				// operator's real history file.
				HOME: root,
				SSH_FAIL_NODE: failNode,
				READ_ERROR_NODE: readErrorNode,
			},
			root
		);
	}

	// unreachable, no drain -> fails.
	let root = fixture();
	let r = run(root, { failNode: NODE });
	assert.equal(r.code, 1, `an unreachable node with no drain must fail, got ${r.code}:\n${r.out}`);
	rmSync(root, { recursive: true, force: true });

	// unreachable, fresh maintenance drain -> passes, and is still PRINTED.
	root = fixture({ drain: { [NODE]: { since: DAYS_AGO(0), kind: 'maintenance', reason: 'x' } } });
	r = run(root, { failNode: NODE });
	assert.equal(r.code, 0, `a fresh maintenance drain must defer, got ${r.code}:\n${r.out}`);
	assert.match(r.out, /expected down/, 'deferral removes the page, not the information');
	rmSync(root, { recursive: true, force: true });

	// a drain past DEFER_DAYS stops deferring.
	root = fixture({ drain: { [NODE]: { since: DAYS_AGO(8), kind: 'maintenance' } } });
	r = run(root, { failNode: NODE });
	assert.equal(r.code, 1, `an expired drain must fail again, got ${r.code}:\n${r.out}`);
	rmSync(root, { recursive: true, force: true });

	// a REACHABLE node with a fresh drain gets its real result, not a blind skip.
	root = fixture({ drain: { [NODE]: { since: DAYS_AGO(0), kind: 'maintenance' } } });
	r = run(root, {});
	assert.equal(r.code, 0, `a reachable node must report normally, got ${r.code}:\n${r.out}`);
	assert.doesNotMatch(
		r.out,
		/expected down/,
		'a node that actually answered was not deferred, only a node that could not be reached'
	);
	rmSync(root, { recursive: true, force: true });

	// 'training' is meant to be RUNNING and must never defer.
	root = fixture({ drain: { [NODE]: { since: DAYS_AGO(0), kind: 'training' } } });
	r = run(root, { failNode: NODE });
	assert.equal(r.code, 1, `a 'training' drain must never defer, got ${r.code}:\n${r.out}`);
	rmSync(root, { recursive: true, force: true });

	// THE NARROWING RULE: a `read-error` (the node answered; the bytes did not
	// come back whole) is never deferred, drained or not — only `unreachable`
	// (ssh itself failing) is. A maintenance drain never explains broken bytes.
	root = fixture({ drain: { [NODE]: { since: DAYS_AGO(0), kind: 'maintenance', reason: 'x' } } });
	r = run(root, { readErrorNode: NODE });
	assert.equal(
		r.code,
		1,
		`a read-error on a drained node must still fail, got ${r.code}:\n${r.out}`
	);
	assert.doesNotMatch(
		r.out,
		/expected down/,
		'a read-error is not the reachability question deferralFor answers'
	);
	rmSync(root, { recursive: true, force: true });
});
