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
import { manifest as manifestFile } from './lib/paths.mjs';
// The queue-health precedent, imported rather than re-derived. READ_ATTEMPTS is
// a measured property of `gh api` from this box (0.13% transient, 2026-09-07),
// not a fact about queues, and a second copy of it is a second thing to tune.
// Still needed here directly for `probeNode`'s own retry loop below —
// `lib/runner-identity-reads.mjs` and `lib/runner-identity-report.mjs` each import their own
// copy for the reads/report they carry.
import { READ_ATTEMPTS } from './lib/queue-health.mjs';
import { createEmitter } from './lib/emit.mjs';
import { buildGateDoc } from './lib/gate-doc.mjs';
import { warmOrphanUnreadable } from './lib/warm-orphan-doc.mjs';
import {
	sleep,
	RETRY_DELAY_MS,
	mintAgeMs,
	readRunners,
	canonical,
	activeWarmUnits,
} from './lib/runner-identity-reads.mjs';
import { printIdentityReport } from './lib/runner-identity-report.mjs';
// The dispatcher's own reap sweep — its grace and its cadence — so an orphan it
// has not REACHED yet is told apart from one it has FAILED to clear by the
// numbers that sweep actually runs on, never by a copy of them.
import { JIT_REAP_GRACE_MS, REAP_INTERVAL_MS } from '../dist/runners/ephemeral-exec.js';
import { WARM_PREFIX } from '../dist/runners/ephemeral.js';
import { nodeOf } from '../dist/runners/census.js';

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
const has = (f) => args.includes(f);
const CONFIRM = has('--confirm');
const JSON_OUT = emitter.json;
// Via `machineArg`, not a private copy. The private copies had the same hole:
// a bare positional was IGNORED, so `... claw-3` scoped to the whole fleet.
const ONLY = machineArg(args);

/**
 * The name prefix that marks a registration as OURS and disposable.
 * Anything minted by the dispatcher must carry it; anything not carrying it is
 * treated as a persistent runner and is never deleted by this tool.
 */
const JIT_PREFIX = 'jit-';

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

const coverage = JSON.parse(readFileSync(COVERAGE, 'utf8'));
const probe = readFileSync(PROBE_SRC, 'utf8');
const nodes = selectMachines(loadManifest(), { only: ONLY }).map(([name]) => name);

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
		unreachable.push({
			machine: m,
			error: r.error,
			expectedDown: defer.deferred,
			why: defer.deferred ? deferralNote(m, defer) : defer.why,
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

// Canonicalise every install's repo BEFORE diffing, so a rename is not mistaken
// for a stolen identity.
for (const list of installs.values()) {
	for (const i of list) i.repo = await canonical(i.repo);
}

// ---- GitHub's belief -----------------------------------------------------
const NOW = Date.now();
const ghosts = [];
const jitOrphans = [];
/** Online JIT orphans older than UNREAPED_AFTER_MS — the sweep is not clearing them. */
const unreaped = [];
/** Minted within GRACE_MS — too young to judge, reported so the skip is visible. */
const young = [];
const noInstall = [];
/** Registered-no-install rows held back because the node is drained ON PURPOSE. */
const expectedDown = [];
const unreadableRepos = [];
/** Warm registrations the snapshot did not back — judged after a second look. */
const warmSuspects = [];

// The registration-side rules need a COMPLETE picture of the fleet: "no node
// holds an install for this repo" and "no node has a live listener" are both
// claims about every node at once. Under --machine the probe saw one box, so
// every install on the others is missing from `installs` and both rules fire on
// the whole fleet. Caught by a mutation test that ran clean fleet-wide and then
// reported a healthy claw-2 runner as install-less under --machine hokon.
const FLEET_WIDE = !ONLY && unreachable.length === 0;
for (const repo of FLEET_WIDE ? repos : []) {
	const listing = await readRunners(repo);
	if (!listing.ok) {
		unreadableRepos.push({ repo, reason: listing.reason });
		continue;
	}
	for (const r of listing.runners) {
		const isJit = r.name.startsWith(JIT_PREFIX);

		// A WARM registration is backed by a transient unit on the node its name
		// carries, never by an install dir (#112, after #61/#103). Falling through
		// to the install check reported every live warm listener the warm cache
		// had rotated in since that node was probed: the nodes are probed one by
		// one BEFORE any listing is read, and the 2026-10-15 13:18Z red was two
		// listeners minted at 13:15:20, mid-sweep.
		if (r.name.startsWith(WARM_PREFIX)) {
			const node = nodeOf(r.name, nodes);
			if (!warmUnits.get(node)?.has(`${r.name}.service`))
				warmSuspects.push({ repo, name: r.name, id: r.id, status: r.status, node });
			continue;
		}
		const local = (installs.get(r.name) ?? []).filter((i) => i.repo === repo);
		const liveHere = local.some((i) => i.alive);

		// A JIT registration is backed by a transient unit, not an install dir.
		const jitLive = isJit && [...jitUnits.values()].some((s) => s.has(`${r.name}.service`));

		if (isJit && !jitLive) {
			const age = mintAgeMs(r.name, NOW);
			if (age < GRACE_MS) {
				young.push({ repo, name: r.name, ageMs: age });
			} else {
				jitOrphans.push({ repo, name: r.name, id: r.id, status: r.status, ageMs: age });
				if (r.status === 'online' && age > UNREAPED_AFTER_MS)
					unreaped.push({ repo, name: r.name, ageMs: age });
			}
			continue;
		}
		if (isJit) continue;

		// A registration exists for this repo, but no node holds an install
		// configured against it. Either the install was removed without
		// deregistering, or its identity was overwritten — the 2026-08-26
		// signature. Report the nodes that DO carry this runner name so the
		// reader can see which box to look at, not the 26 repos it also serves.
		if (!local.length) {
			// A persistent registration is named for the node that holds it, so the
			// drain record can be asked about it by name. Only an OFFLINE one: a
			// drained node reporting `online` with nothing listening is a black hole
			// wearing a drain as a disguise, and it fails here exactly as it would on
			// any other node.
			const defer = r.status === 'online' ? null : deferralFor(r.name, drains);
			if (defer?.deferred) {
				expectedDown.push({
					repo,
					node: r.name,
					status: r.status,
					why: deferralNote(r.name, defer),
				});
				continue;
			}
			const carriers = [...new Set((installs.get(r.name) ?? []).map((i) => i.machine))];
			noInstall.push({ repo, name: r.name, status: r.status, carriers });
			continue;
		}

		if (r.status === 'online' && !liveHere) {
			ghosts.push({ repo, name: r.name, id: r.id, busy: r.busy === true });
		}
	}
}

// ---- warm: a second look ------------------------------------------------
/**
 * A warm registration whose unit the snapshot did not see is either an orphan
 * or a listener that changed while the sweep ran. The warm cache rotates on a
 * 60s tick, so the second case is ordinary, and the snapshot alone cannot tell
 * them apart. So the NAMED node is probed again and the registration re-read:
 *
 *   - unit active now           → minted after the snapshot; live.
 *   - registration gone now     → evicted after the snapshot; nothing to judge.
 *   - still registered, no unit → a WARM ORPHAN, and it FAILS, online or not.
 *
 * It fails offline too, unlike a JIT orphan. A JIT orphan is routine because
 * `reapJitRunners` sweeps every `jit-` name; the warm reap
 * (`reapDeadWarmListener`) only reaches a name the node's marker still holds,
 * and a RESET=1 mint overwrites the marker — #61's leak. Nothing is guaranteed
 * to clear one, so one that survives two looks is a finding, not leakage.
 *
 * A second look that cannot be taken is "I could not look": the suspect stays
 * an orphan, carrying why, rather than being waved through.
 */
const warmOrphans = [];
/** Unbacked in the snapshot, resolved by the second look — printed so a rotation is visible. */
const warmRechecked = [];
const suspectsByNode = new Map();
for (const s of warmSuspects) {
	if (!suspectsByNode.has(s.node)) suspectsByNode.set(s.node, []);
	suspectsByNode.get(s.node).push(s);
}
const relisted = new Map();
for (const [node, suspects] of suspectsByNode) {
	if (!nodes.includes(node)) {
		for (const s of suspects)
			warmOrphans.push({ ...s, why: 'names no manifest node, so no unit can back it' });
		continue;
	}
	const again = await probeNode(node);
	const live = again.ok ? activeWarmUnits(again.out) : null;
	for (const s of suspects) {
		if (!live) {
			warmOrphans.push({ ...s, why: `second look at ${node} failed: ${again.error}` });
			continue;
		}
		if (live.has(`${s.name}.service`)) {
			warmRechecked.push({ ...s, outcome: 'unit active on second look' });
			continue;
		}
		if (!relisted.has(s.repo)) relisted.set(s.repo, await readRunners(s.repo));
		const listing = relisted.get(s.repo);
		if (!listing.ok) {
			warmOrphans.push({
				...s,
				why: `no unit on ${node}; re-reading the registration failed: ${listing.reason}`,
			});
			continue;
		}
		const still = listing.runners.find((x) => x.id === s.id);
		if (!still) {
			warmRechecked.push({ ...s, outcome: 'registration removed since the listing' });
			continue;
		}
		warmOrphans.push({
			...s,
			status: still.status,
			why: `no active unit on ${node} on either look`,
		});
	}
}

// ---- report --------------------------------------------------------------
/**
 * Unreachable nodes split by whether a human took them out on purpose.
 *
 * Only the UNEXPECTED half fails. Both halves are printed: a deferral nobody can
 * see is indistinguishable from a clean fleet, which is the failure the whole
 * `expected-down` mechanism sits one step away from.
 */
const unexpectedlyDark = unreachable.filter((u) => !u.expectedDown);
const expectedDark = unreachable.filter((u) => u.expectedDown);

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
};

/**
 * GateDoc (wave 5j lane B). Built once, here, from the arrays `summary` above
 * already carries — every one of them is the FULL result of a decision this
 * sweep already made, so there is no second pass of logic to keep in sync, in
 * contrast to a gate that exits on the first bad thing it sees (`label-floor`,
 * `boundary-contracts`) and has no single point where every array is final.
 *
 * `unreadable` IS "I could not look": a repo listing or a node probe that
 * never came back, a drain record this run could not parse, and — within
 * `warmOrphans` — the one case where the SECOND look itself failed rather
 * than resolving (`warmOrphanUnreadable`, `lib/warm-orphan-doc.mjs`). `young`,
 * `jitOrphans` (the ones not yet past `UNREAPED_AFTER_MS`), `warmRechecked`,
 * `expectedDown` and `expectedDark` are deliberately in NEITHER array — each
 * is this gate choosing NOT to judge something yet (too young, routine
 * leakage, resolved on a second look, or drained on purpose), the same shape
 * warm-canary's own `drained`/`skippedByRole` and label-floor's
 * `noWorkflows` precedent (that one, unlike this, counts as unreadable — see
 * that file) stay out of its GateDoc too. Everything else is a conclusion
 * reached from data this run actually read.
 */
const gateFindings = [
	...ghosts.map((g) => ({
		node: null,
		kind: 'black-hole',
		reason: `${g.repo} ${g.name}${g.busy ? ' — BUSY, a job is stuck on it' : ''}: GitHub says online, no listener anywhere`,
	})),
	...unreaped.map((u) => ({
		node: null,
		kind: 'unreaped-black-hole',
		reason:
			`${u.repo} ${u.name}: ONLINE JIT orphan past the dispatcher's reap grace, age ` +
			`${u.ageMs === Infinity ? 'unknown (no epoch in name)' : `${Math.round(u.ageMs / 1000)}s`}`,
	})),
	...warmOrphans
		.filter((w) => !warmOrphanUnreadable(w.why))
		.map((w) => ({
			node: w.node ?? null,
			kind: 'warm-orphan',
			reason: `${w.repo} ${w.name} status=${w.status ?? 'unknown'}: ${w.why}`,
		})),
	...noInstall.map((d) => ({
		node: null,
		kind: 'registered-no-install',
		reason:
			`${d.repo} runner "${d.name}" status=${d.status}` +
			(d.carriers.length ? ` (that name lives on: ${d.carriers.join(', ')})` : ''),
	})),
	...unconfigured.map((u) => ({
		node: u.machine,
		kind: 'unconfigured-listener',
		reason: `${u.machine} ${u.dir}: running with no readable .runner`,
	})),
	...clobbered.map((c) => ({
		node: c.machine,
		kind: 'stolen-identity',
		reason: `${c.machine} ${c.dir} now claims "${c.name}" (${c.repo})`,
	})),
];
const gateUnreadable = [
	...(drainUnreadable ? [{ node: null, why: `drain record unreadable: ${drainUnreadable}` }] : []),
	...warmOrphans
		.filter((w) => warmOrphanUnreadable(w.why))
		.map((w) => ({ node: w.node ?? null, why: `${w.repo} ${w.name}: ${w.why}` })),
	...unexpectedlyDark.map((u) => ({ node: u.machine, why: u.error })),
	...unreadableRepos.map((r) => ({ node: null, why: `${r.repo}: ${r.reason}`, repo: r.repo })),
];
// The SAME booleans the exit code below already keys on — computed once, so
// the GateDoc's `ok` and the real exit code can never read differently from
// each other, which `buildGateDoc`'s own array-emptiness default would not
// guarantee if a future term were added to one list and not the other.
const FAILS = Boolean(
	ghosts.length ||
	unreaped.length ||
	warmOrphans.length ||
	noInstall.length ||
	unconfigured.length ||
	clobbered.length ||
	drainUnreadable ||
	unexpectedlyDark.length ||
	unreadableRepos.length
);

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
