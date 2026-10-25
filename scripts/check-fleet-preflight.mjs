#!/usr/bin/env node
/**
 * check-fleet-preflight — the nightly sweep for slow-motion failures: node-key
 * expiry, `HADOKU_SITE_TOKEN` expiry, runner version drift on the standing
 * registrations, pending reboots, LAN addresses no gateway reservation pins,
 * and Debian security updates a claw is not installing. See `lib/preflight.mjs` for why each of these and not some others —
 * every one of them has already bitten this fleet once, except the reboot
 * check, which is the same shape of risk paid for with a probe already in hand.
 *
 * This file is the I/O half only: `lib/preflight.mjs` judges data already
 * fetched and is tested without a tailnet, a token or a fleet.
 *
 * `--json` for the cron; stdout stays parseable and the exit code carries the
 * finding, per scripts/lib/json-contract.mjs.
 *
 * ONLY BLOCKING FINDINGS FAIL THE RUN (#14). `lib/preflight.mjs` classes every
 * finding and explains why the default is blocking; here that split shows up as
 * three arrays in the payload — `findings` (blocking, the ones the cron throws
 * on), `advisory` (printed and reported, never paged) and `deferred` (a node a
 * human took out of service). Nothing is hidden by any of the three.
 *
 * EVERY `gh api` READ IS RETRIED ONCE (#78). `ci:fleet-preflight` paged `@here`
 * at 13:16Z on `could not read the latest actions/runner release: spawnSync gh
 * ETIMEDOUT` — a one-shot timeout on a box where InvokeAI holds ~41 GB during
 * its busiest window. A rerun 1.8s later reported nothing blocking: the box,
 * not the signal, was the problem. `READ_ATTEMPTS` and `describeReadFailure`
 * are imported from `lib/queue-health.mjs` rather than re-derived — that gate
 * measured the transient rate (0.13% of `gh api` calls, 2026-09-07) and one
 * number is the point — exactly as `reconcile-runner-identity.mjs` already
 * does. Retrying is NOT tolerating: a read that fails every attempt is still
 * `could-not-look` and still fails the run, and the finding now carries WHY
 * and `attempt N/M` rather than a bare error string.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { loadManifest, runOn } from './lib/fleet-exec.mjs';
import { READ_ATTEMPTS, describeReadFailure } from './lib/queue-health.mjs';
import {
	nodeKeyFindings,
	tokenExpiryFinding,
	runnerVersionFindings,
	JIT_PAYLOAD_PROBE,
	jitPayloadFindings,
	parseJitPayloadProbe,
	rebootFindings,
	blockingFindings,
	advisoryFindings,
	guestAdvisory,
	lanReservationFindings,
	BLOCKING,
	SECURITY_PROBE,
	parseSecurityProbe,
	pendingSince,
	securityUpdateFinding,
} from './lib/preflight.mjs';
import { stateDir } from './lib/paths.mjs';
import { INTERFACE_PROBE, parseInterfaces, proposeLanRecord } from './lib/node-interfaces.mjs';
import { guestNodeNames } from '../dist/lib/node-role.js';
import { deferralFor, deferralNote, readDrains } from './lib/expected-down.mjs';
import { createEmitter } from './lib/emit.mjs';

const JSON_OUT = process.argv.includes('--json');
const emitter = createEmitter({ json: JSON_OUT });
const log = emitter.log;

/**
 * The only repo with STANDING runner registrations today — this package's own
 * CI, kept resident on claw-4/claw-6 as the dispatcher-outage backstop (plus
 * hokon's own). Every other repo's runners are ephemeral JIT, re-minted with
 * whatever `actions/runner` release is current at mint time, so they cannot
 * drift and scanning them would dilute this signal with entries that are
 * never behind by construction.
 */
const RESIDENT_REPO = 'WolffM/hadoku-fleet-manager';

/**
 * REQUIRED/CLEAN, then the flag file's mtime, then the staged packages.
 *
 * The mtime line is what lets a staged reboot ESCALATE with age instead of
 * being an advisory nobody can ever age out of (#14, `REBOOT_ESCALATE_DAYS`).
 * It is how hokon's flag was dated by hand in the first place — `stat` on
 * `/var/run/reboot-required`, 2026-08-30 06:33 — so this costs nothing new on
 * a probe already paid for. `UNKNOWN` rather than an empty line when `stat`
 * cannot answer, because a missing line would shift the package list up by one
 * and a package name would be parsed as a date.
 */
const REBOOT_PROBE = `
if [ -f /var/run/reboot-required ]; then
	echo REQUIRED
	stat -c %Y /var/run/reboot-required 2>/dev/null || echo UNKNOWN
	cat /var/run/reboot-required.pkgs 2>/dev/null
else
	echo CLEAN
fi
`;

function tailscaleStatus() {
	try {
		const raw = execFileSync('tailscale', ['status', '--json'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 15_000,
		});
		return { ok: true, status: JSON.parse(raw) };
	} catch (err) {
		return { ok: false, error: err.message };
	}
}

/**
 * The ordinary timeout for a `gh api` read whose value is this run's one
 * chance to see something fresh (the token-expiry header, the registered
 * runners). Unchanged from before #78 — these ARE latency-sensitive, so a
 * longer timeout would only make a hung run sit longer before retrying.
 */
const GH_TIMEOUT_MS = 15_000;

/**
 * `actions/runner`'s latest release is a slow-moving fact — days between real
 * changes — so there is no cost to waiting longer for it, unlike the other two
 * reads above. Doubled rather than chosen arbitrarily: the host's busiest
 * window is the failure mode (#78), not the endpoint, so the fix is headroom,
 * not a guess at a "correct" number.
 */
const RELEASE_TIMEOUT_MS = 30_000;

/** Long enough for a blip to pass, short enough to be invisible at the measured 0.13% rate. */
const RETRY_DELAY_MS = 1_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One `gh api` call, as `{ok, out}` or `{ok: false, reason}` — ASYNC
 * `execFile`, deliberately, not `execFileSync`. The four reads this script
 * makes now run concurrently (see the comment in `main()`), and
 * `execFileSync` blocks the entire event loop for as long as the child runs:
 * measured, three `Promise.all`-wrapped `execFileSync` calls of 1s each still
 * took 3s wall-clock, not 1s — wrapping a synchronous call in a Promise does
 * not make it concurrent. `execFile`'s callback does not block, so these
 * genuinely overlap. Translated into `describeReadFailure`'s shape the same
 * way `reconcile-runner-identity.mjs`'s `ghOnce` already does: it is written
 * against `execFileSync`'s error (`status`), and async `execFile` spells the
 * same field `code`.
 */
function ghOnce(args, timeoutMs) {
	return new Promise((resolve) => {
		execFile('gh', args, { encoding: 'utf8', timeout: timeoutMs }, (err, stdout, stderr) => {
			if (err) {
				resolve({
					ok: false,
					reason: describeReadFailure(
						{
							killed: err.killed,
							signal: err.signal,
							status: err.code,
							stderr: stderr ?? '',
							message: err.message,
						},
						timeoutMs
					),
				});
				return;
			}
			resolve({ ok: true, out: stdout });
		});
	});
}

/**
 * Retried per {@link READ_ATTEMPTS} — the same one-shot `gh` timeout that paged
 * on the release read (#78) could just as easily have landed here first; both
 * are a single `gh api` call on the same box in the same window.
 */
async function tokenExpiryHeader(timeoutMs = GH_TIMEOUT_MS) {
	let reason = 'no attempt was made';
	for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
		const r = await ghOnce(['api', '-i', '/user'], timeoutMs);
		if (r.ok) {
			const m = /^github-authentication-token-expiration:\s*(.+)\s*$/im.exec(r.out);
			return { ok: true, header: m?.[1]?.trim() };
		}
		reason = `${r.reason} (attempt ${attempt}/${READ_ATTEMPTS})`;
		if (attempt < READ_ATTEMPTS) await sleep(RETRY_DELAY_MS);
	}
	return { ok: false, error: reason };
}

/**
 * One `gh api` read, retried per {@link READ_ATTEMPTS} rather than treated as a
 * fault on the first timeout (#78). Still "could not look" after every
 * attempt — never softened into a pass; the caller fails the run exactly as it
 * did before, the only change is that it now looks twice and says why.
 */
async function ghApi(args, timeoutMs = GH_TIMEOUT_MS) {
	let reason = 'no attempt was made';
	for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
		const r = await ghOnce(['api', ...args], timeoutMs);
		if (r.ok) return r;
		reason = `${r.reason} (attempt ${attempt}/${READ_ATTEMPTS})`;
		if (attempt < READ_ATTEMPTS) await sleep(RETRY_DELAY_MS);
	}
	return { ok: false, error: reason };
}

/** The node's JIT payload version, for `jitPayloadFinding`. Its own ssh, like the LAN probe. */
async function payloadProbe(node) {
	const res = await runOn(node, JIT_PAYLOAD_PROBE, { timeoutMs: 20_000, connectTimeout: 8 });
	if (!res.ok) return { node, ok: false, error: res.error ?? (res.stderr.trim() || 'unreachable') };
	const parsed = parseJitPayloadProbe(res.stdout);
	if (!parsed)
		return { node, ok: false, error: `unexpected probe output: ${res.out.slice(0, 200)}` };
	return { node, ok: true, ...parsed };
}

async function rebootProbe(node) {
	const res = await runOn(node, REBOOT_PROBE, { timeoutMs: 20_000, connectTimeout: 8 });
	if (!res.ok) return { node, ok: false, error: res.error ?? (res.stderr.trim() || 'unreachable') };
	const lines = res.stdout
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);
	if (lines[0] !== 'REQUIRED' && lines[0] !== 'CLEAN') {
		return { node, ok: false, error: `unexpected probe output: ${res.out.slice(0, 200)}` };
	}
	if (lines[0] === 'CLEAN') return { node, ok: true, rebootRequired: false, packages: [] };
	// Line 2 is the flag's mtime in epoch seconds, or `UNKNOWN`. Anything that is
	// not a bare integer is treated as undated rather than coerced — an
	// unparseable date must not silently become 1970 (which would read as
	// decades overdue) or `now` (which would read as freshly staged, and mute it
	// forever). `rebootFinding` resolves undated STRICT.
	const stagedSec = /^\d+$/.test(lines[1] ?? '') ? Number(lines[1]) : null;
	return {
		node,
		ok: true,
		rebootRequired: true,
		stagedAtMs: stagedSec === null ? null : stagedSec * 1000,
		packages: lines.slice(2),
	};
}

/** Pending security updates and the last security install, for `securityUpdateFinding`. */
async function securityProbe(node) {
	const res = await runOn(node, SECURITY_PROBE, { timeoutMs: 45_000, connectTimeout: 8 });
	if (!res.ok) return { node, ok: false, error: res.error ?? (res.stderr.trim() || 'unreachable') };
	const parsed = parseSecurityProbe(res.stdout);
	if (!parsed)
		return { node, ok: false, error: `unexpected probe output: ${res.out.slice(0, 200)}` };
	if (parsed.error) return { node, ok: false, error: parsed.error };
	return { node, ok: true, ...parsed };
}

/**
 * When each pending security update was first seen, per node — the one piece
 * of history this sweep keeps, because apt records when a package was
 * INSTALLED and never when an update for it APPEARED. In the state dir, never
 * a checkout. Absent is a first run; unparseable is "could not look", because
 * reading it as empty would restart every clock and quietly mute `stuck`.
 */
const PENDING_FILE = () => join(stateDir(), 'security-pending.json');
function readPendingState() {
	if (!existsSync(PENDING_FILE())) return { ok: true, doc: {} };
	try {
		return { ok: true, doc: JSON.parse(readFileSync(PENDING_FILE(), 'utf8')) };
	} catch (err) {
		return { ok: false, error: `${PENDING_FILE()} is unreadable: ${err.message}` };
	}
}
function writePendingState(doc) {
	mkdirSync(dirname(PENDING_FILE()), { recursive: true });
	writeFileSync(`${PENDING_FILE()}.tmp`, `${JSON.stringify(doc, null, 2)}\n`);
	renameSync(`${PENDING_FILE()}.tmp`, PENDING_FILE());
}

/**
 * The node's interfaces, for the LAN-reservation check. A SEPARATE ssh from the
 * reboot probe rather than one combined script: each parser then reads only
 * the output it was written for, and nine extra round-trips cost nothing on a
 * nightly job.
 */
async function lanProbe(node) {
	const res = await runOn(node, INTERFACE_PROBE, { timeoutMs: 20_000, connectTimeout: 8 });
	if (!res.ok) return { node, ok: false, error: res.error ?? (res.stderr.trim() || 'unreachable') };
	const ifaces = parseInterfaces(res.stdout);
	if (!ifaces.length) {
		return { node, ok: false, error: `no interfaces parsed from: ${res.stdout.slice(0, 200)}` };
	}
	return { node, ok: true, ifaces };
}

/**
 * What ssh itself resolves the node to — `ssh -G`, the resolver ssh uses, so
 * wildcards, Match blocks and Include are accounted for. Null when it cannot
 * answer; the finding then skips only the ssh comparison, never the rest.
 */
function sshResolves(node) {
	try {
		return (
			execFileSync('ssh', ['-G', node], { encoding: 'utf8', timeout: 5_000 })
				.split('\n')
				.find((l) => l.startsWith('hostname '))
				?.slice('hostname '.length)
				.trim() ?? null
		);
	} catch {
		return null;
	}
}

async function main() {
	const manifest = loadManifest();
	const fleetNodes = Object.keys(manifest.machines ?? {});
	if (!fleetNodes.length) {
		const msg =
			'check-fleet-preflight: the manifest declares ZERO machines. Cannot preflight nothing.';
		if (JSON_OUT) emitter.emit({ ok: false, error: msg });
		else console.error(msg);
		process.exit(1);
	}

	const findings = [];
	const errors = [];

	// --- node-key expiry ----------------------------------------------------
	const ts = tailscaleStatus();
	if (!ts.ok) {
		errors.push(`could not read \`tailscale status --json\`: ${ts.error}`);
	} else {
		findings.push(...nodeKeyFindings(ts.status, fleetNodes));
	}

	// --- HADOKU_SITE_TOKEN expiry, runner version drift, pending reboots -----
	//
	// RUN CONCURRENTLY, NOT IN SEQUENCE. Each of these four reads is now
	// retried up to READ_ATTEMPTS times (#78), and run one-after-another their
	// WORST CASE adds up: token (31s) + release (61s, the longer
	// RELEASE_TIMEOUT_MS) + registered (31s) + the reboot probes (20s) is 143s
	// against the 120s `execFile` timeout `fleet-preflight-check.ts` wraps this
	// whole script in. Past that wrapper's timeout a clean `could-not-look`
	// JSON finding never gets written at all — the child is killed mid-run and
	// the cron reports "could not run the checker" instead, which is a WORSE
	// failure than the one #78 fixed. `Promise.all` keeps the critical path at
	// the slowest single read (61s) however many of the four are failing at
	// once, and `Promise.all` preserves input order in its results regardless
	// of which settles first, so the rest of this function reads exactly as it
	// did when these were sequential awaits.
	const [tok, latest, registered, probes, lanProbes, payloadProbes, secProbes] = await Promise.all([
		tokenExpiryHeader(),
		ghApi(['repos/actions/runner/releases/latest', '-q', '.tag_name'], RELEASE_TIMEOUT_MS),
		ghApi([`repos/${RESIDENT_REPO}/actions/runners`, '-q', '.runners']),
		Promise.all(fleetNodes.map(rebootProbe)),
		Promise.all(fleetNodes.map(lanProbe)),
		Promise.all(fleetNodes.map(payloadProbe)),
		Promise.all(fleetNodes.map(securityProbe)),
	]);

	if (!tok.ok) {
		errors.push(`could not verify HADOKU_SITE_TOKEN's expiry via \`gh api /user\`: ${tok.error}`);
	} else {
		const f = tokenExpiryFinding(tok.header);
		if (f) findings.push(f);
	}

	// --- runner version drift: standing registrations, and each JIT payload --
	// The listing holds minted runners too; runnerVersionFindings drops them,
	// and the payload they were copied from is judged per node instead (#1).
	if (latest.ok) {
		findings.push(...jitPayloadFindings(payloadProbes, latest.out.trim().replace(/^v/, '')));
	}
	if (!latest.ok) {
		errors.push(`could not read the latest actions/runner release: ${latest.error}`);
	} else if (!registered.ok) {
		errors.push(`could not read ${RESIDENT_REPO}'s registered runners: ${registered.error}`);
	} else {
		const latestVersion = latest.out.trim().replace(/^v/, '');
		let runners;
		try {
			runners = JSON.parse(registered.out);
		} catch (err) {
			errors.push(`could not parse ${RESIDENT_REPO}'s runner list: ${err.message}`);
			runners = null;
		}
		if (runners) {
			findings.push(
				...runnerVersionFindings(
					runners.map((r) => ({ repo: RESIDENT_REPO, name: r.name, version: r.version })),
					latestVersion
				)
			);
		}
	}

	// --- pending reboots ------------------------------------------------------
	// (probed above, concurrently with the gh reads — see the comment there)
	findings.push(...rebootFindings(probes));

	// --- security updates ------------------------------------------------------
	// A guest's finding becomes advisory below like every other node-health one:
	// hokon keeps its own apt config and its updates are the operator's.
	const pendingState = readPendingState();
	if (!pendingState.ok) {
		errors.push(pendingState.error);
	} else {
		const next = { ...pendingState.doc };
		for (const p of secProbes) {
			if (!p.ok) continue;
			next[p.node] = pendingSince(pendingState.doc[p.node], p.pending);
		}
		for (const p of secProbes) {
			const f = securityUpdateFinding(p, next[p.node] ?? {});
			if (f) findings.push(f);
		}
		try {
			writePendingState(next);
		} catch (err) {
			errors.push(`could not record pending security updates: ${err.message}`);
		}
	}

	// --- LAN reservations -----------------------------------------------------
	const resolved = Object.fromEntries(fleetNodes.map((n) => [n, sshResolves(n)]));
	const records = Object.fromEntries(fleetNodes.map((n) => [n, manifest.machines[n]?.lan]));
	const suggestions = Object.fromEntries(
		lanProbes.filter((p) => p.ok).map((p) => [p.node, proposeLanRecord(p.ifaces, resolved[p.node])])
	);
	findings.push(...lanReservationFindings(lanProbes, records, resolved, suggestions));

	// "I COULD NOT LOOK" IS NOT "NOTHING IS WRONG" — an error reading one
	// signal never gets silently absorbed into a clean report on the others.
	// It also fails the whole preflight rather than reporting the signals we
	// DID reach as a clean pass, because a nightly cron that never re-tries
	// mid-run has no other chance to notice the gap before the next run.
	// It is BLOCKING, explicitly and always: a signal that could not be read is
	// the one class of finding that must never be downgraded, because the thing
	// it hides is unknown by definition.
	for (const e of errors) findings.push({ category: 'could-not-look', class: BLOCKING, why: e });

	// A NODE A HUMAN DELIBERATELY TOOK OUT OF SERVICE IS NOT A FINDING.
	//
	// Partitioned here, at the one place every category converges, rather than
	// inside each `*Finding` — those are pure and tested and stay that way, and
	// a node that is powered off produces findings in several categories at once
	// (node-key AND pending-reboot, both simply because nobody could reach it).
	//
	// Deferred findings are still PRINTED. The deferral suppresses the exit code,
	// never the evidence: nothing here is hidden, and lib/expected-down bounds it
	// to DEFER_DAYS so a forgotten drain resurfaces on its own.
	const drains = readDrains();
	const deferrals = new Map();
	const deferred = [];
	const live = [];
	for (const f of findings) {
		if (!f.node) {
			live.push(f);
			continue;
		}
		if (!deferrals.has(f.node)) deferrals.set(f.node, deferralFor(f.node, drains));
		(deferrals.get(f.node).deferred ? deferred : live).push(f);
	}

	// ADVISORY FINDINGS LEAVE `findings` — AND THAT IS THE WHOLE FIX (#14).
	//
	// The exit code alone would have changed nothing: `fleet-preflight-check.ts`
	// throws on `findings.length` and never looks at the exit code at all (that
	// ordering is the --json contract, deliberately). So an advisory left in
	// `findings` would keep failing the job every morning exactly as before.
	// They ride in their own key, the same way `deferred` already does, and the
	// `findings` array narrows to what a person should be woken for.
	//
	// A consumer that wants to SHOW advisories in the digest reads `advisory`;
	// that is a change in mgmt-api, not here, and it is additive — nothing
	// breaks by ignoring the key.
	// A GUEST'S NODE HEALTH DOES NOT FAIL THIS RUN. `machines[<node>].role` is
	// the operator's scoping decision (2026-09-14) and `guestAdvisory` is its one
	// implementation, shared with `fleet doctor` so the two cannot classify the
	// same box differently. Applied AFTER the deferral split, so a drained guest
	// is still reported as deferred rather than as advisory. Nothing is dropped:
	// the finding keeps its `why` and rides in `advisory`.
	const classified = guestAdvisory(live, guestNodeNames(manifest));
	const blocking = blockingFindings(classified);
	const advisory = advisoryFindings(classified);

	log(`Nightly preflight across ${fleetNodes.length} fleet node(s), ${RESIDENT_REPO}'s runners`);
	if (!blocking.length && !advisory.length)
		log(
			'✓ node keys, HADOKU_SITE_TOKEN, runner versions, reboots, LAN reservations and ' +
				'security updates all clean'
		);
	if (!blocking.length && advisory.length)
		log(
			'✓ nothing blocking — node keys, HADOKU_SITE_TOKEN, runner versions and LAN reservations clean'
		);
	for (const f of blocking) log(`  ✗ [${f.category}] ${f.why}`);
	for (const f of advisory) log(`  ! [${f.category}] ${f.why}  (advisory — does not fail the run)`);
	for (const f of deferred)
		log(
			`  · [${f.category}] ${f.why}  (deferred — ${deferralNote(f.node, deferrals.get(f.node))})`
		);

	if (JSON_OUT) {
		emitter.emit({
			ok: blocking.length === 0,
			findings: blocking,
			advisory,
			deferred,
			nodesChecked: fleetNodes.length,
		});
	} else if (blocking.length) {
		console.error('');
		for (const f of blocking) console.error(`✗ [${f.category}] ${f.why}`);
	}

	process.exit(blocking.length ? 1 : 0);
}

main();
