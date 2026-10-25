/**
 * #78 — ONE `gh api` TIMEOUT PAGED `@here`.
 *
 * `ci:fleet-preflight` paged at 13:16Z on `could not read the latest
 * actions/runner release: spawnSync gh ETIMEDOUT`. A rerun 1.8s later reported
 * nothing blocking: the box (InvokeAI holding ~41 GB in its busiest window)
 * was the problem, not the signal. Every `gh api` read in this gate — the
 * token-expiry header, the latest release, the registered runners — is now
 * retried per `READ_ATTEMPTS` before it is called `could-not-look`, exactly as
 * `reconcile-runner-identity.mjs` already does for its own `gh` reads.
 *
 * Exercised as a CLI over `gh`, `tailscale` and `ssh`, the same way
 * `reconcile-runner-identity.test.mjs` exercises its gate: shims first on
 * PATH, every call logged, the exit code and stdout read directly. A counter
 * file is how a shim can fail N times and then recover — proving the retry
 * both fires AND is not tolerated past `READ_ATTEMPTS`.
 *
 * Retrying is NOT tolerating, and that is the assertion that matters most: a
 * read that fails EVERY attempt still fails the gate, still carries the repo's
 * own reason, and still says `attempt 2/2`.
 *
 * NOTHING HERE SPAWNS git. See lib/hook-safe-tests.test.mjs.
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
const GATE = join(HERE, 'check-fleet-preflight.mjs');

const NODE = 'fixture-node';
const FIXTURE_IP = '192.0.2.50';
const FIXTURE_MAC = '02:00:00:00:00:50';
const RESIDENT_REPO = 'WolffM/hadoku-fleet-manager';

/**
 * A token-expiry header far enough past `tokenExpiryFinding`'s 14-day warn
 * window to read as healthy, anchored to `Date.now()` rather than a pinned
 * ISO date — see `lib/fixture-clock-guard.test.mjs`: an absolute date bakes
 * in "healthy until the calendar catches up", which goes quietly wrong on
 * whatever day it does. 400 days clears the window with the same margin
 * `fixture-clock-guard.test.mjs` itself uses for the "aged INTO view" case.
 */
const FAR_FUTURE_EXPIRY = new Date(Date.now() + 400 * 86_400_000).toISOString();

/**
 * A `gh` that logs every call, answers all three reads cleanly, and can be
 * told to fail one of them (`latest`, `registered` or `user`) a fixed number
 * of times before it recovers — a counter FILE rather than an in-memory one,
 * because each invocation is a fresh process.
 */
const GH_SHIM = `#!/usr/bin/env bash
argv="$*"
printf '%s\\n' "$argv" >> "$GH_LOG"

match=""
case "$argv" in
	*"releases/latest"*) match="latest" ;;
	*"actions/runners"*) match="registered" ;;
	*"-i /user"*) match="user" ;;
esac

if [ -n "$match" ] && [ "$match" = "\${GH_FAIL_WHAT:-}" ]; then
	count_file="$GH_COUNT_DIR/$match"
	n=0
	[ -f "$count_file" ] && n=$(cat "$count_file")
	n=$((n + 1))
	echo "$n" > "$count_file"
	if [ "$n" -le "\${GH_FAIL_TIMES:-999}" ]; then
		echo "gh: ETIMEDOUT waiting for api.github.com" >&2
		exit 1
	fi
fi

case "$match" in
	latest) echo "v2.400.0" ;;
	registered) echo "[]" ;;
	user)
		printf 'HTTP/2.0 200 OK\\r\\n'
		printf 'github-authentication-token-expiration: %s\\r\\n' "$TOKEN_EXPIRY"
		printf '\\r\\n'
		printf '{}\\n'
		;;
	*) echo "{}" ;;
esac
`;

/** Reports the fixture node itself as tailnet-healthy (no real KeyExpiry). */
const TAILSCALE_SHIM = `#!/usr/bin/env bash
printf '{"Self":{"HostName":"%s"},"Peer":{}}' "$TS_HOSTNAME"
`;

/**
 * Answers the four things the gate asks ssh: \`ssh -G\` (where the node
 * resolves), the interface probe (the LAN-reservation check), the JIT payload
 * probe — no payload yet, so nothing stale — the security probe — lists fresh,
 * nothing pending — and the reboot probe — CLEAN, no reboot staged. The interface it reports is the one the
 * fixture manifest records, so a clean fixture is clean on every signal.
 */
const SSH_SHIM = `#!/usr/bin/env bash
if [ "$1" = "-G" ]; then echo "hostname ${FIXTURE_IP}"; exit 0; fi
script=$(cat)
case "$script" in
	*/sys/class/net*)
		printf 'ADDR 2: eth0    inet ${FIXTURE_IP}/24 brd x\\nIF eth0 no ${FIXTURE_MAC}\\n' ;;
	*jit/payload*) echo "PAYLOAD ABSENT" ;;
	*"END security-probe"*) printf 'LISTS %s\nLAST NONE\nEND security-probe\n' "$(date +%s)" ;;
	*) echo CLEAN ;;
esac
`;

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'preflight-gate-'));
	writeFileSync(
		join(root, 'fleet-runner-manifest.json'),
		JSON.stringify({
			machines: {
				[NODE]: { lan: { mac: FIXTURE_MAC, ip: FIXTURE_IP, reservedOn: '2026-10-11' } },
			},
		})
	);
	const bin = join(root, 'bin');
	const counts = join(root, 'counts');
	mkdirSync(bin, { recursive: true });
	mkdirSync(counts, { recursive: true });
	for (const [name, src] of [
		['gh', GH_SHIM],
		['tailscale', TAILSCALE_SHIM],
		['ssh', SSH_SHIM],
	]) {
		const p = join(bin, name);
		writeFileSync(p, src);
		chmodSync(p, 0o755);
	}
	return { root, bin, counts, ghLog: join(root, 'gh.log') };
}

function cleanup(fx) {
	rmSync(fx.root, { recursive: true, force: true });
}

/** One gate run. Returns the exit code and stdout+stderr combined — never throws. */
function run(fx, { failWhat = '', failTimes = '', argv = [] } = {}) {
	const env = {
		...process.env,
		PATH: `${fx.bin}:${process.env.PATH}`,
		FLEET_MANIFEST_DIR: fx.root,
		HADOKU_STATE_DIR: fx.root,
		TS_HOSTNAME: NODE,
		TOKEN_EXPIRY: FAR_FUTURE_EXPIRY,
		GH_LOG: fx.ghLog,
		GH_COUNT_DIR: fx.counts,
		GH_FAIL_WHAT: failWhat,
		GH_FAIL_TIMES: String(failTimes),
	};
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

/** How many logged `gh` calls matched this substring — i.e. how many times it was spawned for it. */
function attempts(logPath, substr) {
	if (!existsSync(logPath)) return 0;
	return readFileSync(logPath, 'utf8')
		.split('\n')
		.filter((l) => l.includes(substr)).length;
}

const LATEST_CALL = 'releases/latest';
const REGISTERED_CALL = `repos/${RESIDENT_REPO}/actions/runners`;
const USER_CALL = '-i /user';

// ── the floor: a genuinely clean fixture must pass, and cost one attempt each ──

test('a clean fleet exits 0, and nothing is retried on the success path', () => {
	const fx = fixture();
	try {
		const r = run(fx);
		assert.equal(r.code, 0, `expected a clean run to pass, got ${r.code}:\n${r.out}`);
		assert.match(r.out, /all clean/);
		assert.equal(
			attempts(fx.ghLog, LATEST_CALL),
			1,
			'the retry must cost nothing when nothing fails'
		);
		assert.equal(attempts(fx.ghLog, REGISTERED_CALL), 1);
		assert.equal(attempts(fx.ghLog, USER_CALL), 1);
	} finally {
		cleanup(fx);
	}
});

test('a node with no gateway reservation on record FAILS the gate, naming what to reserve', () => {
	const fx = fixture();
	try {
		writeFileSync(
			join(fx.root, 'fleet-runner-manifest.json'),
			JSON.stringify({ machines: { [NODE]: {} } })
		);
		const r = run(fx, { argv: ['--json'] });
		assert.equal(r.code, 1, r.out);
		const doc = JSON.parse(r.out.slice(r.out.indexOf('{')));
		const f = doc.findings.find((x) => x.category === 'lan-reservation');
		assert.equal(f?.status, 'unrecorded', r.out);
		assert.match(f.why, new RegExp(`${FIXTURE_MAC} -> ${FIXTURE_IP.replaceAll('.', '\\.')}`));
	} finally {
		cleanup(fx);
	}
});

// ── #78 itself: a one-shot timeout that recovers on the retry must not page ──

test('the release read times out once and recovers: no finding, exit 0', () => {
	const fx = fixture();
	try {
		const r = run(fx, { failWhat: 'latest', failTimes: 1 });
		assert.equal(r.code, 0, `a transient blip that recovered must not fail the run:\n${r.out}`);
		assert.equal(
			attempts(fx.ghLog, LATEST_CALL),
			2,
			'the release read must have been retried exactly once'
		);
		assert.doesNotMatch(
			r.out,
			/could not read the latest actions\/runner release/,
			'a read that recovered must not be reported as a finding'
		);
	} finally {
		cleanup(fx);
	}
});

test('the registered-runners read times out once and recovers: no finding, exit 0', () => {
	const fx = fixture();
	try {
		const r = run(fx, { failWhat: 'registered', failTimes: 1 });
		assert.equal(r.code, 0, `a transient blip that recovered must not fail the run:\n${r.out}`);
		assert.equal(attempts(fx.ghLog, REGISTERED_CALL), 2);
		assert.doesNotMatch(r.out, /could not read .*registered runners/);
	} finally {
		cleanup(fx);
	}
});

test('the token-expiry header read times out once and recovers: no finding, exit 0', () => {
	const fx = fixture();
	try {
		const r = run(fx, { failWhat: 'user', failTimes: 1 });
		assert.equal(r.code, 0, `a transient blip that recovered must not fail the run:\n${r.out}`);
		assert.equal(attempts(fx.ghLog, USER_CALL), 2);
		assert.doesNotMatch(r.out, /could not verify HADOKU_SITE_TOKEN/);
	} finally {
		cleanup(fx);
	}
});

// ── retrying is NOT tolerating: a read that fails every attempt still fails ──

test('a release read that never recovers fails the gate after READ_ATTEMPTS, naming why', () => {
	const fx = fixture();
	try {
		const r = run(fx, { failWhat: 'latest', failTimes: 999 });
		assert.equal(r.code, 1, `a read that never recovers must fail the gate:\n${r.out}`);
		assert.equal(
			attempts(fx.ghLog, LATEST_CALL),
			READ_ATTEMPTS,
			`must be tried exactly ${READ_ATTEMPTS} times before it is called could-not-look`
		);
		assert.match(r.out, /could not read the latest actions\/runner release/);
		assert.match(r.out, /ETIMEDOUT/, 'the finding must carry WHY the read failed');
		assert.match(r.out, /attempt 2\/2/, 'the finding must say the failure survived the retry');
		assert.match(r.out, /could-not-look/);
	} finally {
		cleanup(fx);
	}
});

test('a registered-runners read that never recovers fails the gate after READ_ATTEMPTS', () => {
	const fx = fixture();
	try {
		const r = run(fx, { failWhat: 'registered', failTimes: 999 });
		assert.equal(r.code, 1, `a read that never recovers must fail the gate:\n${r.out}`);
		assert.equal(attempts(fx.ghLog, REGISTERED_CALL), READ_ATTEMPTS);
		assert.match(r.out, new RegExp(`could not read ${RESIDENT_REPO}'s registered runners`));
		assert.match(r.out, /ETIMEDOUT/);
		assert.match(r.out, /attempt 2\/2/);
	} finally {
		cleanup(fx);
	}
});

test('a token-expiry read that never recovers fails the gate after READ_ATTEMPTS', () => {
	const fx = fixture();
	try {
		const r = run(fx, { failWhat: 'user', failTimes: 999 });
		assert.equal(r.code, 1, `a read that never recovers must fail the gate:\n${r.out}`);
		assert.equal(attempts(fx.ghLog, USER_CALL), READ_ATTEMPTS);
		assert.match(r.out, /could not verify HADOKU_SITE_TOKEN's expiry/);
		assert.match(r.out, /ETIMEDOUT/);
		assert.match(r.out, /attempt 2\/2/);
	} finally {
		cleanup(fx);
	}
});

// ── the --json contract: shape must not change, only the finding TEXT may ───

test('--json keeps its exact top-level shape on a clean run', () => {
	const fx = fixture();
	try {
		const r = run(fx, { argv: ['--json'] });
		assert.equal(r.code, 0);
		const doc = JSON.parse(r.out);
		assert.deepEqual(
			Object.keys(doc).sort(),
			['advisory', 'deferred', 'findings', 'nodesChecked', 'ok'].sort(),
			'the --json contract is five keys, exactly — see scripts/lib/json-contract.mjs'
		);
		assert.equal(doc.ok, true);
		assert.deepEqual(doc.findings, []);
	} finally {
		cleanup(fx);
	}
});

test('--json keeps its exact shape on a could-not-look finding — only the finding TEXT grows', () => {
	const fx = fixture();
	try {
		const r = run(fx, { failWhat: 'latest', failTimes: 999, argv: ['--json'] });
		assert.equal(r.code, 1);
		const doc = JSON.parse(r.out);
		assert.deepEqual(
			Object.keys(doc).sort(),
			['advisory', 'deferred', 'findings', 'nodesChecked', 'ok'].sort()
		);
		assert.equal(doc.ok, false);
		assert.equal(doc.findings.length, 1);
		assert.equal(doc.findings[0].category, 'could-not-look');
		assert.match(doc.findings[0].why, /attempt 2\/2/);
		assert.match(doc.findings[0].why, /ETIMEDOUT/);
	} finally {
		cleanup(fx);
	}
});
