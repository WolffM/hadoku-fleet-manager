#!/usr/bin/env node
/**
 * reconcile-runner-identity — find registrations nothing is listening on.
 *
 * ONE INVARIANT, TWO FAILURES
 * ---------------------------
 * A registration GitHub believes is ONLINE, for which no node has a live
 * listener, is a BLACK HOLE: GitHub will assign it work and nothing will pick
 * that work up, so the job sits until its own timeout and reads as a GitHub
 * outage rather than as our bug. Both failure modes this fleet has actually seen
 * are that same shape:
 *
 *   - A JIT runner reaped before it took a job. The registration survives and
 *     keeps reporting `online` (measured 2026-08-26 — see §12.8 of
 *     docs/planning/fleet-rearchitecture-2026-08-25.md). Under a dispatcher this
 *     happens every time a mint loses the race to a warm runner, so it is a
 *     STEADY-STATE leak, not an edge case.
 *   - A persistent runner whose identity was overwritten. On 2026-08-26 a JIT
 *     probe launched from a configured install clobbered its .runner and
 *     .credentials; the victim kept running on its in-memory session for 23
 *     minutes, then died and could not re-auth. `hadoku-tenhands / Task
 *     automation` queued 55 minutes. Nothing noticed a runner had lost its
 *     identity — the alert that fired was a queue-depth alarm 13 minutes in.
 *
 * WHY THE REAPING IS ASYMMETRIC
 * -----------------------------
 * Only JIT-named registrations are deletable, and only under --confirm. A JIT
 * runner is single-use and disposable by construction, so deleting a dead one
 * costs nothing. A PERSISTENT registration is a node's identity: deleting it
 * forces a reconfigure, and GitHub's `status` field lags reality (a 503 burst on
 * 2026-08-25 flipped a healthy mid-job runner to `offline` for two minutes). So
 * a persistent ghost is REPORTED, loudly, and never auto-deleted — the same
 * asymmetry the rest of this repo's runner tooling uses: registering restores
 * coverage, removing takes it away.
 *
 * A DRAINED NODE'S OFFLINE REGISTRATIONS
 * --------------------------------------
 * A node held out of service keeps its persistent registrations — that is the
 * point of not auto-deleting them. So when claw-8 was drained on 2026-09-09 for
 * a failed cooler and dropped out of the manifest, its 27 registrations became
 * 27 REGISTERED-NO-INSTALL findings and this gate went red and stayed red. A
 * permanently red gate is not a safety property; it is how an operator learns to
 * stop reading gates. `lib/expected-down.mjs` already answers "is this node down
 * ON PURPOSE?" for the reachability gates, and it answers it here too.
 *
 * The deferral is deliberately narrow, and narrower than the reachability one:
 *
 *   1. It is keyed on the LIVE drain record, never on a node name. Lift the
 *      drain and the same registrations fail this gate on the next run.
 *   2. It only ever covers REGISTERED-NO-INSTALL. A black hole (GitHub says
 *      ONLINE, nothing is listening) is the failure this whole file exists for,
 *      and a drained node claiming to be online is a CONTRADICTION, not an
 *      expectation — so `status === 'online'` is never deferred, drained or not.
 *   3. It is listed, not dropped. The report names the node, the reason and the
 *      repos, so a deferral can never be mistaken for a clean fleet.
 *   4. An UNREADABLE drain record fails the gate. Defaulting to "nothing is
 *      drained" would be the strict direction, which is why it is tempting — but
 *      it would silently re-attribute 27 findings to the fleet when the thing
 *      that actually broke was one file. "I could not look" is its own finding.
 *
 * Everything else `expected-down` refuses still applies: an undated drain, a
 * `training` drain, and a drain past DEFER_DAYS all defer nothing.
 *
 * TWO WAYS THIS GATE USED TO SAY "NOTHING IS WRONG" AFTER LOOKING AT NOTHING
 * -------------------------------------------------------------------------
 * Until 2026-09-14 neither `unreachable` nor `unreadableRepos` reached the exit
 * code. Both are "I could not look", and both had the worst available shape: the
 * finding was PRINTED and then discarded.
 *
 *   - An unreachable node also sets FLEET_WIDE false, so the whole
 *     registration half — black holes, registered-no-install — is skipped. One
 *     dead box therefore turned this from "every registration has a live
 *     listener" into "we checked the listeners on the boxes that answered", and
 *     the exit code could not tell the two apart.
 *   - An unreadable repo dropped straight out of the loop. A token that expired
 *     mid-sweep, or one 502, rendered as a repo with no registrations at all —
 *     which is precisely the state this gate exists to distinguish from a clean
 *     one.
 *
 * Both now FAIL, and both carry WHY: a 502, a rate limit and a deleted repo are
 * three different jobs, and so are a powered-off node and a broken ssh key.
 * `READ_ATTEMPTS` and `describeReadFailure` are imported from `lib/queue-health`
 * rather than re-derived — that gate measured the transient rate (0.13% of
 * `gh api` calls, 2026-09-07) and one number is the point. Looking twice is not
 * tolerating: a repo or a node that fails EVERY attempt still fails the gate.
 *
 * The drain is the one exception, and only for the NODE half: a machine a human
 * powered off on purpose is expected down, not a fault, exactly as
 * `check-fleet-toolchain` treats it. It is still listed. An unreadable REPO has
 * no such exception — nothing about a drain makes GitHub unreadable.
 *
 * MIGRATED (wave 5j lane B): `ci:audit-gates` now runs this one with `--json`
 * and judges it by the `GateDoc` below rather than a regex over
 * stdout+stderr — see `src/lib/job-registry.ts`'s `coversSubs` entry
 * (`contract: 'json'`) and `scripts/lib/json-contract.mjs`'s derivation of
 * `JSON_CONTRACT` from it. This sub already had a `--json` mode (wave2 §D.4);
 * what changes here is the SHAPE (a `GateDoc` alongside the pre-existing
 * `summary` fields, additive) and the STDOUT DISCIPLINE (the shared emitter,
 * `lib/emit.mjs`, in place of the hand-rolled `log`/`console.log` pair —
 * `emit.test.mjs` requires every contracted script's stdout to go through it).
 * An unreachable node, an unreadable repo listing, an unreadable drain record
 * or a warm registration's second look that never completed is "I could not
 * look" — `unreadable`; a black hole, an unreaped JIT orphan, a warm orphan
 * both looks actually resolved, a registered-no-install, an unconfigured
 * listener or a stolen identity is a conclusion reached from data this run
 * actually read — `findings`.
 *
 * Usage:
 *   fleet identity            # report
 *   fleet identity --confirm  # + reap JIT orphans
 *   fleet identity --json
 */
import { execFile } from 'node:child_process';
import { checkGhReserve } from './lib/gh-reserve.mjs';
import { useAppPool } from './lib/gh-app.mjs';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, machineArg, runOn, selectMachines } from './lib/fleet-exec.mjs';
import { deferralFor, deferralNote, readDrains } from './lib/expected-down.mjs';
import { knownDownNodes, knownDownNote } from './lib/known-down.mjs';
import { manifest as manifestFile } from '../dist/lib/fleet-paths.js';
// The queue-health precedent, imported rather than re-derived. READ_ATTEMPTS is
// a measured property of `gh api` from this box (0.13% transient, 2026-09-07),
// not a fact about queues, and a second copy of it is a second thing to tune.
// Still needed here directly for `probeNode`'s own retry loop below —
// `lib/runner-identity-reads.mjs` and `lib/runner-identity-report.mjs` each import their own
// copy for the reads/report they carry.
import { READ_ATTEMPTS } from './lib/read-retry-policy.mjs';
import { createEmitter } from './lib/emit.mjs';
import { ARGV_SPECS } from './lib/argv-specs.mjs';
import { parseStrict } from './lib/argv.mjs';
import { buildGateDoc } from './lib/gate-doc.mjs';
import { sleep, RETRY_DELAY_MS, canonical, activeWarmUnits } from './lib/runner-identity-reads.mjs';
import { printIdentityReport } from './lib/runner-identity-report.mjs';
import { diffGithubBelief } from './lib/runner-identity-diff.mjs';
import { recheckWarmSuspects } from './lib/runner-identity-warm-recheck.mjs';
import { buildIdentityGateDoc } from './lib/runner-identity-gatedoc.mjs';
import { classifyInstall, classifyUnit, repoFromUrl } from './lib/runner-unit-audit.mjs';
import {
	createRepoLookup,
	parseRunnerUnitsProbe,
	RUNNER_UNITS_PROBE,
} from './lib/runner-units-probe.mjs';
// The dispatcher's own reap sweep — its grace and its cadence — so an orphan it
// has not REACHED yet is told apart from one it has FAILED to clear by the
// numbers that sweep actually runs on, never by a copy of them.
import { JIT_REAP_GRACE_MS, REAP_INTERVAL_MS } from '../dist/lib/jit-reap-cadence.js';

// STDOUT MUST ARRIVE WHOLE. This script prints a JSON document and then exits,
// and on a pipe `process.exit` throws away whatever the stream still had
// queued — measured on this host, 149,133 bytes in and 146,176 out, which
// `JSON.parse` then rejects mid-string. `createEmitter()` puts fd 1 in
// blocking mode (`keepStdoutWhole()`, called internally) so there is nothing
// left to lose. Issue #33. It is also the ONE place this script writes to
// stdout (wave 5j lane B) — `emit.test.mjs` requires it, and its own exit
// guard is what turns the early `console.error` + `process.exit(1)` refusals
// below into a `--json` document with no further change to them: every one
// of them already runs after `import { createEmitter }` above is evaluated,
// and ES modules evaluate their imports before this file's own top-level code.
const emitter = createEmitter();

const __dirname = dirname(fileURLToPath(import.meta.url));
const COVERAGE = manifestFile('fleet-runner-coverage.json');
const PROBE_SRC = resolve(__dirname, 'runner-identity-probe.sh');

const args = process.argv.slice(2);
// F8 (plan §4.1): strict, from the one spec argv-specs.mjs declares.
const parsed = parseStrict(ARGV_SPECS['reconcile-runner-identity.mjs'], args);
const CONFIRM = parsed.has('--confirm');
const JSON_OUT = emitter.json;
// Via `machineArg`, not a private copy. The private copies had the same hole:
// a bare positional was IGNORED, so `... claw-3` scoped to the whole fleet.
const ONLY = machineArg(args);

/**
 * A registration younger than this is not judged.
 *
 * There IS a real race: the dispatcher mints, then spawns the unit, and a sweep
 * landing between the two sees a registration with no unit — indistinguishable
 * from a leak. Mint -> listener online was measured at 1-8s (§12.8).
 *
 * The runners API returns no creation timestamp, so the age has to come from
 * somewhere we control: the NAME. Hence the contract below. This keeps the sweep
 * stateless, which matters because it must stay correct across the ~5 mgmt-api
 * restarts a day that B9 is about — a grace held in memory would reset on every
 * one of them and reap a fleet's worth of healthy mints.
 */
const GRACE_MS = 120_000;

/**
 * Past this, an ONLINE JIT orphan is a black hole the dispatcher's sweep has
 * FAILED to clear, not one it has yet to reach (#98).
 *
 * The header calls an online JIT orphan a black hole, and it is one: GitHub
 * schedules onto it and nothing answers. But the exit code ignored every JIT
 * orphan as "routine leakage", because the dispatcher's reap sweep deletes them
 * — after JIT_REAP_GRACE_MS, on a REAP_INTERVAL_MS clock. That is true while the
 * sweep runs. When it stops (mgmt-api down, the token's budget spent and calls
 * suppressed, a sweep that throws every tick) the orphans accumulate ONLINE, and
 * a gate that never fails on them gets no harder to pass the longer the reaper
 * is dead — the exact shape AGENTS.md forbids. So an online orphan older than
 * one full grace plus two sweeps fails here; a younger one, or an offline one
 * GitHub will not schedule onto, stays routine and is only reported.
 */
const UNREAPED_AFTER_MS = JIT_REAP_GRACE_MS + 2 * REAP_INTERVAL_MS;

const log = emitter.log;

/**
 * The drain record, and the reason if it could not be read.
 *
 * `readDrains()` THROWS on a file that exists and cannot be parsed or opened; a
 * file that is simply absent means nothing is drained and is not an error. The
 * throw is caught rather than propagated so the rest of the sweep still runs and
 * still reports — but `drainUnreadable` is a finding in its own right and gates
 * on its own, because with no drain record this gate cannot tell a deliberate
 * power-off from a dead node and must not pretend otherwise.
 */
let drains = {};
let drainUnreadable = null;
try {
	drains = readDrains();
} catch (e) {
	drainUnreadable = e instanceof Error ? e.message : String(e);
}

/**
 * Already paged as down by runner-health's own offline alert (observed,
 * never a declaration — see lib/known-down.mjs). A missing or unreadable
 * ledger is an EMPTY set, same safe direction as `drains` above — but unlike
 * the drain record, an unreadable known-down ledger is NOT itself a finding:
 * the safe direction is to skip nothing, which is exactly what an empty set
 * does on its own.
 */
const KNOWN_DOWN = knownDownNodes();

const coverage = JSON.parse(readFileSync(COVERAGE, 'utf8'));
const probe = readFileSync(PROBE_SRC, 'utf8');
const manifest = loadManifest();
const nodes = selectMachines(manifest, { only: ONLY }).map(([name]) => name);

// A SWEEP SET THAT WENT TO ZERO IS "I COULD NOT LOOK" (#98). Both loops below
// iterate a parsed list, and an empty list made each one a clean pass over
// nothing: `coverage.repos ?? []` turned a coverage file that lost its `repos`
// key into "every registration has a live listener" without one listing read,
// and a `--machine` naming no manifest node probed nothing and printed "nothing
// wrong with the listeners on <typo>". The same shape stopped the site repo's
// gate-coverage running two of its rules. Refused before anything is spawned,
// so the refusal is the only thing the run says.
if (!Array.isArray(coverage.repos) || coverage.repos.length === 0) {
	console.error(
		`reconcile-runner-identity: ${COVERAGE} carries no repos ` +
			`(repos=${JSON.stringify(coverage.repos)}), so the registration half would sweep nothing ` +
			'and call it clean. That is "I could not look", not a pass — regenerate it with ' +
			'fleet reconcile --write-coverage.'
	);
	process.exit(1);
}
if (!nodes.length) {
	console.error(
		'reconcile-runner-identity: no nodes to probe' +
			(ONLY
				? ` — --machine ${ONLY} is not in the manifest. Check the spelling.`
				: ' — the manifest declares no machines, so no listener anywhere could be seen.') +
			' Probing nothing is not a pass.'
	);
	process.exit(1);
}

// Under the shared GitHub reserve this sweep is not run, and on the App's pool
// it never touches the user's (#9).
const { pool } = await useAppPool('runner-identity');
const reserve = checkGhReserve('runner-identity', { pool });
if (!reserve.ok) {
	if (JSON_OUT) {
		// `error` is the pre-existing field; the GateDoc half is additive — same
		// rename-nothing approach `check-history-coverage.mjs`'s own `fail()`
		// took in wave 5f lane B. A reserve refusal is "I could not look": this
		// sweep never got as far as reading one node or one repo.
		emitter.emit({
			ok: false,
			error: reserve.reason,
			...buildGateDoc({
				unreadable: [{ node: null, why: reserve.reason }],
				ok: false,
				why: reserve.reason,
			}),
		});
	} else console.error(`reconcile-runner-identity: ${reserve.reason}`);
	process.exit(1);
}

const repos = coverage.repos;

// ---- node truth -------------------------------------------------------
/** agentName -> [{machine, dir, repo, alive}] */
const installs = new Map();
const jitUnits = new Map(); // node -> Set(unit)
const warmUnits = new Map(); // node -> Set(ACTIVE warm unit)
const unreachable = [];
const unconfigured = [];
/** Persistent installs whose identity a JIT probe overwrote — see §12.9. */
const clobbered = [];

/**
 * Probe one node, retried once, with the reason on failure.
 *
 * Retried for the same reason the GitHub reads are: until 2026-09-14 an
 * unreachable node did not reach the exit code, so a transient ssh blip cost
 * nothing. Now that it FAILS the gate, a coin-flip would page — which is the
 * exact trade `READ_ATTEMPTS` was measured for. The retry only ever costs on the
 * failure path.
 *
 * The reason is the node's own stderr where there is any, and the spawn error
 * where there is not — `r.out.trim()` alone rendered a failed spawn as an empty
 * string, which is a `catch {}` wearing a different hat.
 */
async function probeNode(machine) {
	let error = 'no attempt was made';
	for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
		const r = await runOn(machine, probe, { as: 'ci' });
		if (r.out.includes('PROBE-END')) return { ok: true, out: r.out };
		const why =
			r.out.trim().replace(/\s+/g, ' ').slice(0, 160) ||
			r.error ||
			'the probe produced no output and no error';
		error = `${why} (attempt ${attempt}/${READ_ATTEMPTS})`;
		if (attempt < READ_ATTEMPTS) await sleep(RETRY_DELAY_MS);
	}
	return { ok: false, error };
}

log(`Probing ${nodes.length} node(s)...\n`);
for (const m of nodes) {
	const r = await probeNode(m);
	if (!r.ok) {
		// A node a human deliberately powered off is EXPECTED down, not a finding —
		// the same question `check-fleet-toolchain` asks, answered by the same
		// helper. It stays in the report either way, and the deferral expires.
		const defer = deferralFor(m, drains);
		const down = defer.deferred ? null : KNOWN_DOWN.get(m);
		unreachable.push({
			machine: m,
			error: r.error,
			expectedDown: defer.deferred,
			knownDown: down ?? null,
			why: defer.deferred ? deferralNote(m, defer) : down ? knownDownNote(down) : defer.why,
		});
		continue;
	}
	jitUnits.set(m, new Set());
	warmUnits.set(m, activeWarmUnits(r.out));
	for (const line of r.out.split('\n')) {
		const p = line.trim().split(/\s+/);
		if (p[0] === 'RUNNER') {
			const [, dir, repo, name, alive] = p;
			if (name === '?' || repo === '?') {
				// A live listener with no readable config. This is what a stolen or
				// half-removed identity looks like on disk, and it is invisible to
				// every other tool in this repo.
				if (alive === '1') unconfigured.push({ machine: m, dir, repo, name });
				continue;
			}
			const list = installs.get(name) ?? [];
			list.push({ machine: m, dir, repo, alive: alive === '1' });
			installs.set(name, list);
		} else if (p[0] === 'EPHEMERAL-CLOBBER') {
			clobbered.push({ machine: m, dir: p[1], repo: p[2], name: p[3] });
		} else if (p[0] === 'JITUNIT') {
			jitUnits.get(m).add(p[1]);
		}
	}
}

// ---- runner-units: the SAME registration-vs-box question, the other
// direction (wave gates2 lane F1a, item 4: "MERGE ci:runner-units ->
// check:runner-identity"). The loop above starts from GitHub's registrations
// and asks which node is listening; this starts from what is ACTUALLY ON
// each box — install directories AND both supervision schemes' units — and
// resolves each install's repo BACK by numeric id, because GitHub redirects
// a renamed repo silently, with a 200. `scripts/runner-units.mjs` runs the
// identical audit standalone too, for hand-running alone (its own standing
// cron is retired, wave gates2 lane F2); both share the probe text and the
// repo lookup (`lib/runner-units-probe.mjs`), never the classification
// rules, which stay in `lib/runner-unit-audit.mjs` either way.
const runnerUnitsLookup = createRepoLookup();
const runnerUnitsRosterIds = new Set();
const runnerUnitsRosterUnresolved = [];
for (const name of repos) {
	const r = runnerUnitsLookup(name);
	if (r.status === 'found') runnerUnitsRosterIds.add(r.repo.id);
	else
		runnerUnitsRosterUnresolved.push({
			repo: name,
			why: r.status === 'gone' ? 'GitHub answers 404' : r.why,
		});
}
const runnerUnitsFindings = [];
const runnerUnitsNotes = [];
const runnerUnitsLookupFailed = [];
const runnerUnitsUnreachable = [];
let runnerUnitsInstallCount = 0;
let runnerUnitsUnitCount = 0;
const runnerUnitsProbes = await Promise.all(
	nodes.map((m) => runOn(m, RUNNER_UNITS_PROBE, { as: 'ci', timeoutMs: 90_000 }))
);
for (const [i, m] of nodes.entries()) {
	const res = runnerUnitsProbes[i];
	if (!res.ok) {
		// A node whose MAIN identity probe (above) already failed is already
		// counted there — as expected-down, known-down, or `unexpectedlyDark`
		// (the exact shape of "I could not look" this node is). A second
		// finding about the SAME unreachability would not be a second fact,
		// whichever of the three it was. Only a node whose main probe
		// SUCCEEDED but THIS probe transiently failed is new information, and
		// lands in `runnerUnitsUnreachable` below.
		if (unreachable.some((u) => u.machine === m)) continue;
		const defer = deferralFor(m, drains);
		if (defer.deferred) continue;
		if (KNOWN_DOWN.get(m)) continue;
		runnerUnitsUnreachable.push({ node: m, why: res.error ? String(res.error) : 'probe failed' });
		continue;
	}
	const { installs: ruInstalls, units: ruUnits } = parseRunnerUnitsProbe(res.out);
	runnerUnitsInstallCount += ruInstalls.length;
	runnerUnitsUnitCount += ruUnits.length;
	const runningDirs = new Set(
		ruUnits
			.filter((u) => u.active === 'active' && u.sub === 'running' && u.wd)
			.map((u) => u.wd.replace(/\/+$/, '').split('/').pop())
	);
	for (const inst of ruInstalls) {
		const requested = repoFromUrl(inst.url);
		const lookup = requested ? runnerUnitsLookup(requested) : null;
		if (lookup?.status === 'error') {
			runnerUnitsLookupFailed.push({ node: m, dir: inst.dir, repo: requested, why: lookup.why });
			continue;
		}
		const resolved = lookup?.status === 'found' ? lookup.repo : null;
		const entry = manifest.repos?.[resolved?.fullName ?? requested ?? ''];
		const verdict = classifyInstall({
			requested,
			resolved,
			rosterIds: runnerUnitsRosterIds,
			ignored: Boolean(entry?.ignore),
			running: runningDirs.has(inst.dir),
		});
		if (!verdict) continue;
		const rec = {
			node: m,
			dir: inst.dir,
			sizeMb: inst.sizeMb,
			url: inst.url,
			repo: requested,
			resolved: resolved?.fullName ?? null,
			id: resolved?.id ?? null,
			kind: verdict.kind,
			why: verdict.kind === 'ARCHIVED' ? `${verdict.why} (${inst.sizeMb} MB on disk)` : verdict.why,
		};
		if (verdict.note)
			runnerUnitsNotes.push({ ...rec, why: entry?.ignore ? `${rec.why} — ignore: true` : rec.why });
		else runnerUnitsFindings.push(rec);
	}
	const installDirs = new Set(ruInstalls.map((i) => i.dir));
	for (const u of ruUnits) {
		const verdict = classifyUnit({
			unit: u.unit,
			active: u.active,
			sub: u.sub,
			restarts: u.restarts,
			workingDir: u.wd,
			installDirs,
		});
		if (verdict)
			runnerUnitsFindings.push({
				node: m,
				unit: u.unit,
				scope: u.scope,
				restarts: u.restarts,
				...verdict,
			});
	}
}

// Canonicalise every install's repo BEFORE diffing, so a rename is not mistaken
// for a stolen identity.
for (const list of installs.values()) {
	for (const i of list) i.repo = await canonical(i.repo);
}

// ---- GitHub's belief -----------------------------------------------------
// Moved to `lib/runner-identity-diff.mjs` (wave shrink-1 lane D, pure move);
// see that file for the WARM/JIT/persistent-registration rules.
const NOW = Date.now();

// The registration-side rules need a COMPLETE picture of the fleet: "no node
// holds an install for this repo" and "no node has a live listener" are both
// claims about every node at once. Under --machine the probe saw one box, so
// every install on the others is missing from `installs` and both rules fire on
// the whole fleet. Caught by a mutation test that ran clean fleet-wide and then
// reported a healthy claw-2 runner as install-less under --machine hokon.
const FLEET_WIDE = !ONLY && unreachable.length === 0;
const {
	ghosts,
	jitOrphans,
	unreaped,
	young,
	noInstall,
	expectedDown,
	unreadableRepos,
	warmSuspects,
} = await diffGithubBelief({
	repos,
	fleetWide: FLEET_WIDE,
	nodes,
	installs,
	jitUnits,
	warmUnits,
	drains,
	nowMs: NOW,
	graceMs: GRACE_MS,
	unreapedAfterMs: UNREAPED_AFTER_MS,
});

// ---- warm: a second look ------------------------------------------------
// Moved to `lib/runner-identity-warm-recheck.mjs` (wave shrink-1 lane D,
// pure move); see that file for why an unbacked warm registration gets a
// second look rather than being judged off the first snapshot.
const { warmOrphans, warmRechecked } = await recheckWarmSuspects({
	warmSuspects,
	nodes,
	probeNode,
});

// ---- report --------------------------------------------------------------
/**
 * Unreachable nodes split by whether a human took them out on purpose.
 *
 * Only the UNEXPECTED half fails. Both halves are printed: a deferral nobody can
 * see is indistinguishable from a clean fleet, which is the failure the whole
 * `expected-down` mechanism sits one step away from.
 */
const unexpectedlyDark = unreachable.filter((u) => !u.expectedDown && !u.knownDown);
const expectedDark = unreachable.filter((u) => u.expectedDown);
const knownDownDark = unreachable.filter((u) => u.knownDown);

const summary = {
	ghosts,
	jitOrphans,
	unreaped,
	young,
	warmOrphans,
	warmRechecked,
	noInstall,
	expectedDown,
	drainUnreadable,
	unconfigured,
	unreachable,
	unreadableRepos,
	// ADDITIVE (wave gates1 lane A): already paged down by runner-health's own
	// per-node offline alert, not a fresh finding here — see lib/known-down.mjs.
	knownDown: knownDownDark.map((u) => ({ node: u.machine, ...u.knownDown })),
	// ADDITIVE (wave gates2 lane F1a, item 4): the same audit
	// `scripts/runner-units.mjs` runs standalone, folded in here too.
	runnerUnits: {
		findings: runnerUnitsFindings,
		notes: runnerUnitsNotes,
		unreachable: runnerUnitsUnreachable,
		lookupFailed: runnerUnitsLookupFailed,
		rosterUnresolved: runnerUnitsRosterUnresolved,
		installs: runnerUnitsInstallCount,
		units: runnerUnitsUnitCount,
	},
};

// GateDoc (wave 5j lane B) assembly, moved to
// `lib/runner-identity-gatedoc.mjs` (wave shrink-1 lane D, pure move); see
// that file for which arrays land in `findings` vs `unreadable` vs neither.
// The `runnerUnits*` arrays are the item-4 merge, additive to the same call.
const { gateFindings, gateUnreadable, FAILS } = buildIdentityGateDoc({
	ghosts,
	unreaped,
	warmOrphans,
	noInstall,
	unconfigured,
	clobbered,
	drainUnreadable,
	unexpectedlyDark,
	unreadableRepos,
	runnerUnitsFindings,
	runnerUnitsUnreachable,
	runnerUnitsLookupFailed,
	runnerUnitsRosterUnresolved,
});

if (!JSON_OUT) {
	printIdentityReport({
		ghosts,
		jitOrphans,
		unreaped,
		young,
		warmOrphans,
		warmRechecked,
		noInstall,
		expectedDown,
		drainUnreadable,
		clobbered,
		unconfigured,
		unreachable,
		unreadableRepos,
		unexpectedlyDark,
		expectedDark,
		FLEET_WIDE,
		ONLY,
		CONFIRM,
		UNREAPED_AFTER_MS,
		GRACE_MS,
		log,
	});
	for (const u of knownDownDark)
		log(`  · ${knownDownNote(u.knownDown)} — registrations unread\n    probe said: ${u.error}`);

	// runner-units (wave gates2 lane F1a, item 4): the install/unit audit,
	// folded into this same report.
	if (
		runnerUnitsFindings.length ||
		runnerUnitsNotes.length ||
		runnerUnitsUnreachable.length ||
		runnerUnitsLookupFailed.length ||
		runnerUnitsRosterUnresolved.length
	) {
		log(
			`\nrunner-units: ${runnerUnitsInstallCount} install(s), ${runnerUnitsUnitCount} unit(s) ` +
				`across ${nodes.length} node(s)`
		);
		if (runnerUnitsRosterUnresolved.length) {
			log(
				`  ROSTER UNRESOLVED (${runnerUnitsRosterUnresolved.length}): ` +
					runnerUnitsRosterUnresolved.map((r) => `${r.repo} (${r.why})`).join(', ')
			);
		}
		for (const l of runnerUnitsLookupFailed)
			log(`  · unjudged: ${l.node} ${l.dir} ${l.repo}: ${l.why}`);
		for (const u of runnerUnitsUnreachable) log(`  · unreachable: ${u.node}: ${u.why}`);
		for (const f of runnerUnitsFindings)
			log(`  · ${f.kind.padEnd(10)} ${f.node.padEnd(8)} ${f.dir ?? f.unit} — ${f.why}`);
		for (const n of runnerUnitsNotes) log(`  note: ${n.kind} ${n.node} ${n.dir} — ${n.why}`);
	}
}

// ---- reap ----------------------------------------------------------------
if (CONFIRM && jitOrphans.length) {
	log(`\nReaping ${jitOrphans.length} JIT orphan(s)...`);
	for (const o of jitOrphans) {
		const ok = await new Promise((res) =>
			execFile('gh', ['api', '-X', 'DELETE', `repos/${o.repo}/actions/runners/${o.id}`], (e) =>
				res(!e)
			)
		);
		log(`  ${ok ? '✓' : '✗'} ${o.repo}  ${o.name}`);
	}
}

if (JSON_OUT) {
	emitter.emit({
		...summary,
		...buildGateDoc({ findings: gateFindings, unreadable: gateUnreadable, ok: !FAILS }),
	});
}

// A black hole or a drifted identity is a live incident: it silently swallows
// jobs. Exit non-zero so this can gate. A JIT orphan the dispatcher's sweep has
// yet to reach is routine leakage; an ONLINE one it has failed to clear
// (`unreaped`, see UNREAPED_AFTER_MS) is a black hole and fails. A warm orphan
// fails at any status — nothing is guaranteed to reap one (see the second look).
//
// THE LAST THREE ARE ALL "I COULD NOT LOOK", and each is a finding a run with
// zero other findings can still be hiding:
//   - `drainUnreadable`: cannot tell a deliberate power-off from a dead node.
//   - `unexpectedlyDark`: a node's installs went unseen, AND it took the whole
//     registration half down with it via FLEET_WIDE. An UNDRAINED dark box only.
//   - `unreadableRepos`: a listing that failed every attempt reads downstream
//     exactly like a repo with no registrations.
// Each one already survived `READ_ATTEMPTS` looks, so none of these is a blip.
// `FAILS` above is the exact same expression — computed once so the GateDoc's
// `ok` and this exit code can never disagree.
process.exit(FAILS ? 1 : 0);
