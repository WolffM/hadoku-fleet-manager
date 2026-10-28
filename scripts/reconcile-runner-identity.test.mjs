/**
 * THE TWO "I COULD NOT LOOK" HOLES IN THE IDENTITY GATE.
 *
 * Until 2026-09-14 neither an unreachable node nor an unreadable repo reached
 * this gate's exit code. Both were printed and then dropped — the shape
 * CLAUDE.md names as "'I could not look' must never render as 'nothing is
 * wrong'". The unreachable case was the worse of the two: it ALSO sets
 * FLEET_WIDE false, so one dark box silently took the entire registration half
 * of the sweep with it and the run still exited 0.
 *
 * The gate is a CLI over ssh and `gh`, so it is exercised as one rather than by
 * asserting on its internals: a throwaway manifest directory, `gh` and `ssh`
 * shims first on PATH, and the EXIT CODE read directly. Every shim call is
 * appended to a log file, which is how the retry is counted — `READ_ATTEMPTS`
 * is 2 and "looked twice" is a claim about what was actually spawned, not about
 * what the source says.
 *
 * Retrying is NOT tolerating, and that is the assertion that matters most here:
 * a repo or a node that fails EVERY attempt still fails the gate. The clean
 * fixture is not decoration either — without a case that passes, every
 * assertion below could be satisfied by a gate that fails on all input.
 *
 * NOTHING HERE SPAWNS git. See lib/hook-safe-tests.test.mjs: a test that shells
 * out to git under a hook's GIT_DIR rewrites the repository it is run from.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

import { READ_ATTEMPTS } from './lib/queue-health.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'reconcile-runner-identity.mjs');

const NODE = 'fixture-node';
const OK_REPO = 'WolffM/fixture-alpha';
const BAD_REPO = 'WolffM/fixture-beta';

/**
 * A `gh` that answers an empty runner listing, logs every call, and fails for
 * one path.
 *
 * The failure is a 502 with real stderr rather than a bare non-zero exit,
 * because the thing under test is that the REASON survives into the finding —
 * a rate limit, a timeout and a deleted repo are three different jobs.
 */
const GH_SHIM = `#!/usr/bin/env bash
path="\${2:-}"
printf '%s\\n' "$path" >> "$GH_LOG"
if [ -n "\${GH_FAIL_PATH:-}" ] && [ "$path" = "\${GH_FAIL_PATH}" ]; then
	echo "gh: HTTP 502: Bad gateway (https://api.github.com/$path)" >&2
	exit 1
fi
if [ -n "\${GH_RUNNERS_PATH:-}" ] && [ "$path" = "\${GH_RUNNERS_PATH}" ]; then
	# A later read of the same listing may answer differently — the warm second
	# look re-reads it, and a registration can be gone by then.
	if [ -n "\${GH_RUNNERS_JSON_AGAIN:-}" ] && [ "$(grep -cxF "$path" "$GH_LOG")" -gt 1 ]; then
		printf '%s\n' "$GH_RUNNERS_JSON_AGAIN"
	else
		printf '%s\n' "$GH_RUNNERS_JSON"
	fi
	exit 0
fi
echo '{"total_count":0,"runners":[]}'
`;

/**
 * An `ssh` that answers a clean probe, logs every call, and refuses one node.
 *
 * It drains stdin first: the driver writes the probe script there and closes
 * it, and a shim that exits without reading gives the parent an EPIPE instead
 * of the result under test. argv is fixed by `fleet-exec`'s `sshArgv` —
 * `-o BatchMode=yes -o ConnectTimeout=N <user>@<node> bash -s` — so the node is $5 after its `@`.
 */
const SSH_SHIM = `#!/usr/bin/env bash
cat > /dev/null
node="\${5##*@}"
printf '%s\\n' "$node" >> "$SSH_LOG"
if [ "$node" = "\${SSH_FAIL_NODE:-}" ]; then
	echo "ssh: connect to host $node port 22: No route to host" >&2
	exit 255
fi
# Extra probe lines (WARMUNIT …), and a different set for any later probe of the
# same node — the warm second look probes again.
if [ "$(grep -cxF "$node" "$SSH_LOG")" -gt 1 ]; then
	extra="\${SSH_PROBE_AGAIN-\${SSH_PROBE_EXTRA:-}}"
else
	extra="\${SSH_PROBE_EXTRA:-}"
fi
[ -n "$extra" ] && printf '%s\n' "$extra"
echo "PROBE-END $node 0 0"
`;

/** A throwaway manifest dir, state dir and PATH shim dir, all in one. */
function fixture({
	drain = null,
	machines = { [NODE]: {} },
	coverage = { repos: [OK_REPO, BAD_REPO] },
} = {}) {
	const root = mkdtempSync(join(tmpdir(), 'identity-gate-'));
	writeFileSync(join(root, 'fleet-runner-manifest.json'), JSON.stringify({ machines }));
	writeFileSync(join(root, 'fleet-runner-coverage.json'), JSON.stringify(coverage));
	if (drain) writeFileSync(join(root, 'fleet-drain.json'), JSON.stringify({ nodes: drain }));
	const bin = join(root, 'bin');
	mkdirSync(bin, { recursive: true });
	for (const [name, src] of [
		['gh', GH_SHIM],
		['ssh', SSH_SHIM],
	]) {
		const p = join(bin, name);
		writeFileSync(p, src);
		chmodSync(p, 0o755);
	}
	return { root, bin, ghLog: join(root, 'gh.log'), sshLog: join(root, 'ssh.log') };
}

/** One gate run. Returns the exit code and the combined output — never throws. */
function run(
	fx,
	{ failPath = '', failNode = '', argv = [], runners = null, probe = '', probeAgain = null } = {}
) {
	const env = {
		...process.env,
		PATH: `${fx.bin}:${process.env.PATH}`,
		// A token the host may not supply: never the App's pool, never a real mint (#9).
		GH_TOKEN: 'fixture',
		FLEET_MANIFEST_DIR: fx.root,
		HADOKU_STATE_DIR: fx.root,
		GH_LOG: fx.ghLog,
		SSH_LOG: fx.sshLog,
		GH_FAIL_PATH: failPath,
		SSH_FAIL_NODE: failNode,
		// One repo's listing, when a case needs registrations in it.
		GH_RUNNERS_PATH: runners ? runnersPath(runners.repo) : '',
		GH_RUNNERS_JSON: runners ? JSON.stringify({ runners: runners.list }) : '',
		GH_RUNNERS_JSON_AGAIN: runners?.again ? JSON.stringify({ runners: runners.again }) : '',
		SSH_PROBE_EXTRA: probe,
	};
	if (probeAgain !== null) env.SSH_PROBE_AGAIN = probeAgain;
	try {
		const out = execFileSync('node', [GATE, ...argv], {
			env,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { code: 0, out };
	} catch (e) {
		return { code: e.status ?? -1, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
	}
}

/** Lines in a shim log equal to `want` — i.e. how many times it was spawned for it. */
function attempts(logPath, want) {
	if (!existsSync(logPath)) return 0;
	return readFileSync(logPath, 'utf8')
		.split('\n')
		.filter((l) => l.trim() === want).length;
}

const runnersPath = (repo) => `repos/${repo}/actions/runners`;

/** Fixtures are temp dirs; keep them out of the way once the assertions are done. */
function cleanup(fx) {
	rmSync(fx.root, { recursive: true, force: true });
}

// ── the floor: a fixture that is genuinely clean must pass ──────────────────

test('a reachable node and readable repos exit 0 — without this every case below is vacuous', () => {
	const fx = fixture();
	try {
		const r = run(fx);
		assert.equal(r.code, 0, `expected a clean fleet to pass, got ${r.code}:\n${r.out}`);
		assert.match(r.out, /every registration has a live listener/);
		// One attempt each, because nothing failed: the retry must cost nothing on
		// the success path.
		assert.equal(attempts(fx.ghLog, runnersPath(OK_REPO)), 1);
		assert.equal(attempts(fx.sshLog, NODE), 1);
	} finally {
		cleanup(fx);
	}
});

// ── hole 1: a repo whose runner listing cannot be read ──────────────────────

test('an unreadable repo fails the gate after two attempts, and names the repo AND why', () => {
	const fx = fixture();
	try {
		const r = run(fx, { failPath: runnersPath(BAD_REPO) });
		assert.equal(r.code, 1, `an unreadable repo must fail the gate, got ${r.code}:\n${r.out}`);
		assert.equal(
			attempts(fx.ghLog, runnersPath(BAD_REPO)),
			READ_ATTEMPTS,
			`the listing must be tried ${READ_ATTEMPTS} times before it is called unreadable`
		);
		assert.match(r.out, new RegExp(BAD_REPO), 'the finding must name the repo');
		assert.match(r.out, /502/, 'the finding must carry WHY the read failed, not just that it did');
		assert.match(r.out, /attempt 2\/2/, 'the finding must say the failure survived the retry');
		// The healthy repo is untouched by its neighbour's failure.
		assert.equal(attempts(fx.ghLog, runnersPath(OK_REPO)), 1);
		assert.doesNotMatch(
			r.out,
			/every registration has a live listener/,
			'a run that could not read a repo must not claim the fleet is clean'
		);
	} finally {
		cleanup(fx);
	}
});

test('the unreadable repo reaches --json as a repo AND a reason, not a bare name', () => {
	const fx = fixture();
	try {
		const r = run(fx, { failPath: runnersPath(BAD_REPO), argv: ['--json'] });
		assert.equal(r.code, 1);
		const summary = JSON.parse(r.out.slice(r.out.indexOf('{')));
		assert.equal(summary.unreadableRepos.length, 1);
		assert.equal(summary.unreadableRepos[0].repo, BAD_REPO);
		assert.match(summary.unreadableRepos[0].reason, /502/);
	} finally {
		cleanup(fx);
	}
});

// ── hole 2: a node that did not answer the probe ────────────────────────────

test('an unreachable node fails the gate after two attempts, and names the node AND why', () => {
	const fx = fixture();
	try {
		const r = run(fx, { failNode: NODE });
		assert.equal(r.code, 1, `an unreachable node must fail the gate, got ${r.code}:\n${r.out}`);
		assert.equal(
			attempts(fx.sshLog, NODE),
			READ_ATTEMPTS,
			`the probe must be tried ${READ_ATTEMPTS} times before the node is called unreachable`
		);
		assert.match(r.out, new RegExp(NODE), 'the finding must name the node');
		assert.match(r.out, /No route to host/, "the finding must carry the node's own reason");
		assert.match(r.out, /attempt 2\/2/);
		assert.doesNotMatch(
			r.out,
			/every registration has a live listener/,
			'the registration half was skipped, so no run may claim it passed'
		);
	} finally {
		cleanup(fx);
	}
});

// ── the drain, which this gate honours and must keep honouring ──────────────

test('a node drained for maintenance today is EXPECTED down, listed, and does not fail', () => {
	const fx = fixture({
		drain: { [NODE]: { since: new Date().toISOString(), kind: 'maintenance', reason: 'cooler' } },
	});
	try {
		const r = run(fx, { failNode: NODE });
		assert.equal(r.code, 0, `a drained node must not fail this gate, got ${r.code}:\n${r.out}`);
		assert.match(r.out, /EXPECTED DOWN/, 'a deferral the report does not print is invisible');
		assert.match(r.out, /drained for maintenance/);
		assert.match(r.out, /No route to host/, 'a deferred node still reports what the probe saw');
	} finally {
		cleanup(fx);
	}
});

test('a drain past the deferral window stops deferring — time makes this gate stricter', () => {
	const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
	const fx = fixture({
		drain: { [NODE]: { since: thirtyDaysAgo, kind: 'maintenance', reason: 'cooler' } },
	});
	try {
		const r = run(fx, { failNode: NODE });
		assert.equal(r.code, 1, 'an expired drain must not keep silencing an unreachable node');
		assert.match(r.out, /past the 7-day deferral/);
	} finally {
		cleanup(fx);
	}
});

test('a drain record that cannot be parsed is its own finding, not "nothing is drained"', () => {
	const fx = fixture();
	try {
		writeFileSync(join(fx.root, 'fleet-drain.json'), '{ this is not json');
		const r = run(fx);
		assert.equal(r.code, 1, 'an unreadable drain record must fail even on an otherwise clean run');
		assert.match(r.out, /DRAIN RECORD UNREADABLE/);
	} finally {
		cleanup(fx);
	}
});

// ── #98: a sweep set that went to zero is "I could not look" ────────────────

for (const [label, coverage] of [
	['no `repos` key', {}],
	['an empty `repos` list', { repos: [] }],
	['a `repos` that is not a list', { repos: 'WolffM/fixture-alpha' }],
]) {
	test(`a coverage file with ${label} FAILS before anything is probed`, () => {
		const fx = fixture({ coverage });
		try {
			const r = run(fx);
			assert.equal(r.code, 1, `zero repos to sweep must fail, got ${r.code}:\n${r.out}`);
			assert.match(r.out, /carries no repos/);
			assert.doesNotMatch(r.out, /every registration has a live listener/);
			assert.equal(attempts(fx.sshLog, NODE), 0, 'nothing is probed on a refusal');
		} finally {
			cleanup(fx);
		}
	});
}

test('--machine naming a node the manifest does not declare FAILS, not "nothing wrong"', () => {
	const fx = fixture();
	try {
		const r = run(fx, { argv: ['--machine', 'not-a-node'] });
		assert.equal(r.code, 1, `probing nothing must fail, got ${r.code}:\n${r.out}`);
		assert.match(r.out, /--machine not-a-node is not in the manifest/);
		assert.doesNotMatch(r.out, /nothing wrong with the listeners/);
	} finally {
		cleanup(fx);
	}
});

test('a manifest that declares no machines FAILS — no listener anywhere was seen', () => {
	const fx = fixture({ machines: {} });
	try {
		const r = run(fx);
		assert.equal(r.code, 1, `zero nodes must fail, got ${r.code}:\n${r.out}`);
		assert.match(r.out, /the manifest declares no machines/);
	} finally {
		cleanup(fx);
	}
});

// ── #98: an ONLINE JIT orphan the dispatcher's sweep failed to clear ────────

/** A JIT registration minted `ageSec` ago, per the naming contract. */
const jitRunner = (ageSec, status) => ({
	id: 7,
	name: `jit-${NODE}-fixture-alpha-${Math.floor(Date.now() / 1000) - ageSec}`,
	status,
	busy: false,
});

test('an ONLINE JIT orphan past the reap grace plus two sweeps FAILS as a black hole', () => {
	const fx = fixture();
	try {
		const r = run(fx, { runners: { repo: OK_REPO, list: [jitRunner(3600, 'online')] } });
		assert.equal(r.code, 1, `an unreaped online orphan must fail, got ${r.code}:\n${r.out}`);
		assert.match(r.out, /UNREAPED BLACK HOLES \(1\)/);
	} finally {
		cleanup(fx);
	}
});

test('an OFFLINE JIT orphan, or one the sweep has not reached yet, stays routine', () => {
	for (const runner of [jitRunner(3600, 'offline'), jitRunner(300, 'online')]) {
		const fx = fixture();
		try {
			const r = run(fx, { runners: { repo: OK_REPO, list: [runner] } });
			assert.equal(r.code, 0, `${runner.status} ${runner.name} must not fail:\n${r.out}`);
			assert.match(r.out, /JIT ORPHANS \(1\)/, 'it is still reported');
			assert.doesNotMatch(r.out, /UNREAPED BLACK HOLES/);
		} finally {
			cleanup(fx);
		}
	}
});

// ── #112: a warm listener is backed by a UNIT, not an install dir ───────────

/** The fixture node's warm listener, as the warm cache names it. */
const WARM = { id: 9, name: `warm-${NODE}-fixture-alpha`, status: 'online', busy: false };
const warmUnit = (state = 'active') => `WARMUNIT ${WARM.name}.service ${state}`;

test('a live warm listener is NOT "registered, no install" — its unit backs it', () => {
	const fx = fixture();
	try {
		const r = run(fx, { runners: { repo: OK_REPO, list: [WARM] }, probe: warmUnit() });
		assert.equal(r.code, 0, `a live warm listener must pass, got ${r.code}:\n${r.out}`);
		assert.doesNotMatch(r.out, /REGISTERED, NO INSTALL|WARM ORPHANS/);
		// Backed on the first look, so no second probe is spent on it.
		assert.equal(attempts(fx.sshLog, NODE), 1);
	} finally {
		cleanup(fx);
	}
});

test('a warm listener minted AFTER its node was probed passes on the second look', () => {
	const fx = fixture();
	try {
		const r = run(fx, {
			runners: { repo: OK_REPO, list: [WARM] },
			probe: '',
			probeAgain: warmUnit(),
		});
		assert.equal(r.code, 0, `a mid-sweep rotation must not fail, got ${r.code}:\n${r.out}`);
		assert.match(r.out, /RESOLVED ON A SECOND LOOK \(1\)/, 'the rotation is still reported');
		assert.equal(attempts(fx.sshLog, NODE), 2, 'the named node is probed a second time');
	} finally {
		cleanup(fx);
	}
});

test('a warm registration evicted after the listing was read passes — it is gone', () => {
	const fx = fixture();
	try {
		const r = run(fx, { runners: { repo: OK_REPO, list: [WARM], again: [] } });
		assert.equal(r.code, 0, `an evicted warm listener must not fail, got ${r.code}:\n${r.out}`);
		assert.match(r.out, /registration removed since the listing/);
	} finally {
		cleanup(fx);
	}
});

test('a warm registration with no active unit on either look FAILS, online or offline (#61)', () => {
	for (const status of ['online', 'offline']) {
		for (const probe of ['', warmUnit('failed')]) {
			const fx = fixture();
			try {
				const reg = { ...WARM, status };
				const r = run(fx, { runners: { repo: OK_REPO, list: [reg] }, probe });
				assert.equal(
					r.code,
					1,
					`${status} warm orphan (probe=${probe || 'none'}) must fail:\n${r.out}`
				);
				assert.match(r.out, /WARM ORPHANS \(1\)/);
				assert.match(r.out, new RegExp(`status=${status}`));
				assert.doesNotMatch(r.out, /REGISTERED, NO INSTALL/, 'reported as what it is');
			} finally {
				cleanup(fx);
			}
		}
	}
});

test('a warm registration naming no manifest node FAILS — no unit anywhere can back it', () => {
	const fx = fixture();
	try {
		const stray = { ...WARM, name: 'warm-elsewhere-fixture-alpha' };
		const r = run(fx, { runners: { repo: OK_REPO, list: [stray] } });
		assert.equal(r.code, 1, `an unjudgeable warm registration must fail:\n${r.out}`);
		assert.match(r.out, /names no manifest node/);
	} finally {
		cleanup(fx);
	}
});
