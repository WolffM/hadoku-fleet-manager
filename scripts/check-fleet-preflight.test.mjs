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
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { READ_ATTEMPTS } from './lib/read-retry-policy.mjs';

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
 * Answers the five things the gate asks ssh: \`ssh -G\` (where the node
 * resolves), the interface probe (the LAN-reservation check), the JIT payload
 * probe — no payload yet, so nothing stale — the security probe — lists
 * fresh, nothing pending unless \`FORCE_SECURITY_PENDING\` names packages — and
 * the reboot probe — CLEAN unless \`FORCE_REBOOT_STAGED_DAYS\` ages it. The
 * interface it reports is the one the fixture manifest records, so a clean
 * fixture is clean on every signal by default.
 */
const SSH_SHIM = `#!/usr/bin/env bash
if [ "$1" = "-G" ]; then echo "hostname ${FIXTURE_IP}"; exit 0; fi
script=$(cat)
case "$script" in
	*/sys/class/net*)
		printf 'ADDR 2: eth0    inet ${FIXTURE_IP}/24 brd x\\nIF eth0 no ${FIXTURE_MAC}\\n' ;;
	*jit/payload*) echo "PAYLOAD ABSENT" ;;
	*"reboot-required"*)
		if [ -n "\${FORCE_REBOOT_STAGED_DAYS:-}" ]; then
			echo REQUIRED
			echo $(( $(date +%s) - FORCE_REBOOT_STAGED_DAYS * 86400 ))
			echo "linux-image-amd64"
		else
			echo CLEAN
		fi ;;
	*"END security-probe"*)
		if [ -n "\${FORCE_SECURITY_PENDING:-}" ]; then
			printf 'LISTS %s\\nLAST NONE\\n' "$(date +%s)"
			IFS=','; for p in \${FORCE_SECURITY_PENDING}; do printf 'PKG %s\\n' "$p"; done
			printf 'END security-probe\\n'
		else
			printf 'LISTS %s\\nLAST NONE\\nEND security-probe\\n' "$(date +%s)"
		fi ;;
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
function run(
	fx,
	{ failWhat = '', failTimes = '', argv = [], rebootStagedDays = '', securityPending = '' } = {}
) {
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
		FORCE_REBOOT_STAGED_DAYS: String(rebootStagedDays),
		FORCE_SECURITY_PENDING: String(securityPending),
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

// F3 (wave clean-1 lane A) — `writePendingState` moved off a hand-rolled
// write-then-rename onto the shared `writeFileAtomic`. No test named this
// write before: the clean-fleet run above already exercises it (every run
// re-persists `security-pending.json`), but nothing checked its bytes.
test('a clean run persists security-pending.json through the shared atomic writer', () => {
	const fx = fixture();
	try {
		const r = run(fx);
		assert.equal(r.code, 0, r.out);
		const doc = JSON.parse(readFileSync(join(fx.root, 'security-pending.json'), 'utf8'));
		// The fixture's security probe reports nothing pending (lib/preflight.mjs
		// pendingSince over an empty `pending` list), so the node's own entry is
		// an empty object — present, not absent, proving the write ran.
		assert.deepEqual(doc, { [NODE]: {} });
		// No leftover `.tmp` sibling: the atomic write cleaned up after itself.
		assert.deepEqual(
			readdirSync(fx.root).filter((f) => f.startsWith('security-pending.json')),
			['security-pending.json']
		);
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

test('wave gates1 §A: a node already paged down by runner-health is skipped, not a pile of fresh findings', () => {
	const fx = fixture();
	try {
		// Break every ssh probe for the fixture node — the exact "one unreachable
		// node, several separate findings" shape the wave's evidence names (11-12
		// pages for one fact: reboot, payload, security, LAN reservation).
		writeFileSync(join(fx.bin, 'ssh'), '#!/bin/sh\ncat >/dev/null\nexit 1\n');
		chmodSync(join(fx.bin, 'ssh'), 0o755);
		writeFileSync(
			join(fx.root, 'runner-down-page.json'),
			JSON.stringify({
				[NODE]: {
					since: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
					lastPage: new Date(Date.now() - 60_000).toISOString(),
				},
			})
		);
		const r = run(fx, { argv: ['--json'] });
		assert.equal(
			r.code,
			0,
			`the only unreachable node is already paged down by runner-health:\n${r.out}`
		);
		const doc = JSON.parse(r.out);
		assert.equal(doc.ok, true);
		assert.deepEqual(doc.findings, []);
		assert.ok(doc.knownDown.length >= 1, JSON.stringify(doc.knownDown));
		assert.ok(doc.knownDown.every((d) => d.node === NODE));
		assert.match(doc.knownDown[0].pagedBy, /runner-health/);
	} finally {
		cleanup(fx);
	}
});

test('wave gates1 §A: the same unreachable node, NOT known down, still fails on every signal (control)', () => {
	const fx = fixture();
	try {
		writeFileSync(join(fx.bin, 'ssh'), '#!/bin/sh\ncat >/dev/null\nexit 1\n');
		chmodSync(join(fx.bin, 'ssh'), 0o755);
		// No runner-down-page.json at all — the safe-direction empty set.
		const r = run(fx, { argv: ['--json'] });
		assert.equal(r.code, 1);
		const doc = JSON.parse(r.out);
		assert.equal(doc.ok, false);
		assert.deepEqual(doc.knownDown, []);
		assert.ok(
			doc.findings.filter((f) => f.node === NODE).length > 1,
			`expected several separate findings for ${NODE}, one per failed probe: ${JSON.stringify(doc.findings)}`
		);
	} finally {
		cleanup(fx);
	}
});

test('--json keeps its exact top-level shape on a clean run', () => {
	const fx = fixture();
	try {
		const r = run(fx, { argv: ['--json'] });
		assert.equal(r.code, 0);
		const doc = JSON.parse(r.out);
		assert.deepEqual(
			Object.keys(doc).sort(),
			['advisory', 'deferred', 'findings', 'knownDown', 'nodesChecked', 'ok'].sort(),
			'the --json contract is six keys, exactly — see scripts/lib/json-contract.mjs ' +
				'(knownDown added wave gates1 lane A, additive)'
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
			['advisory', 'deferred', 'findings', 'knownDown', 'nodesChecked', 'ok'].sort()
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

// ── wave gates2 lane F1b: pending-reboot/security-updates demoted to notes ──
//
// `reboot-claws` and `fleet apt-security` own acting on both; this gate's job
// for them is now visibility, not a daily page over a maintenance item a
// converger is already working. Demoted at THIS gate's own call site
// (`demoteOwnedElsewhere` in check-fleet-preflight.mjs), not inside
// lib/preflight.mjs's shared classifiers — `fleet doctor` reuses those same
// pure functions for its own policy, unaffected by this gate's demotion.

test('wave gates2 F1b: a staged reboot past REBOOT_ESCALATE_DAYS is a NOTE, not a finding — exit 0', () => {
	const fx = fixture();
	try {
		// 45 days staged: lib/preflight.mjs's OWN rule would make this BLOCKING
		// (past the 30-day escalation) — proving the demotion actually overrides
		// that, rather than merely observing a case that was already advisory.
		const r = run(fx, { argv: ['--json'], rebootStagedDays: 45 });
		assert.equal(r.code, 0, `demoted: must not fail the run:\n${r.out}`);
		const doc = JSON.parse(r.out);
		assert.equal(doc.ok, true);
		assert.equal(
			doc.findings.find((f) => f.category === 'pending-reboot'),
			undefined,
			JSON.stringify(doc.findings)
		);
		const note = doc.advisory.find((f) => f.category === 'pending-reboot');
		assert.ok(note, JSON.stringify(doc.advisory));
		assert.equal(note.status, 'reboot-required');
		assert.equal(note.wasBlocking, true, 'it WAS blocking before this demotion, and says so');
		assert.match(note.why, /45 days/);
	} finally {
		cleanup(fx);
	}
});

test('wave gates2 F1b: pending security updates with none installed are a NOTE, not a finding — exit 0', () => {
	const fx = fixture();
	try {
		// LAST NONE (never installed) would make lib/preflight.mjs's OWN rule
		// 'not-installing', BLOCKING — the demotion must override that too.
		const r = run(fx, { argv: ['--json'], securityPending: 'curl=1,jq=2' });
		assert.equal(r.code, 0, `demoted: must not fail the run:\n${r.out}`);
		const doc = JSON.parse(r.out);
		assert.equal(doc.ok, true);
		assert.equal(
			doc.findings.find((f) => f.category === 'security-updates'),
			undefined,
			JSON.stringify(doc.findings)
		);
		const note = doc.advisory.find((f) => f.category === 'security-updates');
		assert.ok(note, JSON.stringify(doc.advisory));
		assert.equal(note.status, 'not-installing');
		assert.equal(note.wasBlocking, true);
		assert.match(note.why, /curl=1/);
	} finally {
		cleanup(fx);
	}
});

test('wave gates2 F1b: an UNREACHABLE node still FAILS on pending-reboot and security-updates, demoted or not', () => {
	const fx = fixture();
	try {
		writeFileSync(join(fx.bin, 'ssh'), '#!/bin/sh\ncat >/dev/null\nexit 1\n');
		chmodSync(join(fx.bin, 'ssh'), 0o755);
		const r = run(fx, { argv: ['--json'] });
		assert.equal(r.code, 1, r.out);
		const doc = JSON.parse(r.out);
		assert.equal(doc.ok, false);
		const reboot = doc.findings.find((f) => f.category === 'pending-reboot');
		const security = doc.findings.find((f) => f.category === 'security-updates');
		assert.ok(reboot, JSON.stringify(doc.findings));
		assert.ok(security, JSON.stringify(doc.findings));
		assert.equal(reboot.status, 'unreachable');
		assert.equal(security.status, 'unreachable');
		// Never re-classed: "I could not look" is not "nothing is wrong", in a
		// note no less than a finding.
		assert.equal(
			doc.advisory.find(
				(f) => f.category === 'pending-reboot' || f.category === 'security-updates'
			),
			undefined,
			JSON.stringify(doc.advisory)
		);
	} finally {
		cleanup(fx);
	}
});
