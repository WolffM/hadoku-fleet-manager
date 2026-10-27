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
 * Usage:
 *   fleet identity            # report
 *   fleet identity --confirm  # + reap JIT orphans
 *   fleet identity --json
 */
import { execFile } from 'node:child_process';
import { checkGhReserve } from './lib/gh-reserve.mjs';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, machineArg, runOn, selectMachines } from './lib/fleet-exec.mjs';
import { deferralFor, deferralNote, readDrains } from './lib/expected-down.mjs';
import { manifest as manifestFile } from './lib/paths.mjs';
// The queue-health precedent, imported rather than re-derived. READ_ATTEMPTS is
// a measured property of `gh api` from this box (0.13% transient, 2026-09-07),
// not a fact about queues, and a second copy of it is a second thing to tune.
import { READ_ATTEMPTS, describeReadFailure } from './lib/queue-health.mjs';
import { keepStdoutWhole } from './lib/emit.mjs';
// The dispatcher's own reap sweep — its grace and its cadence — so an orphan it
// has not REACHED yet is told apart from one it has FAILED to clear by the
// numbers that sweep actually runs on, never by a copy of them.
import { JIT_REAP_GRACE_MS, REAP_INTERVAL_MS } from '../dist/runners/ephemeral-exec.js';
import { WARM_PREFIX } from '../dist/runners/ephemeral.js';
import { nodeOf } from '../dist/runners/census.js';

// STDOUT MUST ARRIVE WHOLE. This script prints a JSON document and then exits,
// and on a pipe `process.exit` throws away whatever the stream still had
// queued — measured on this host, 149,133 bytes in and 146,176 out, which
// `JSON.parse` then rejects mid-string. `keepStdoutWhole` puts fd 1 in
// blocking mode so there is nothing left to lose. Issue #33; the shared
// emitter calls the same function for the scripts that use it.
keepStdoutWhole();

const __dirname = dirname(fileURLToPath(import.meta.url));
const COVERAGE = manifestFile('fleet-runner-coverage.json');
const PROBE_SRC = resolve(__dirname, 'runner-identity-probe.sh');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const CONFIRM = has('--confirm');
const JSON_OUT = has('--json');
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

/**
 * REQUIRED NAMING CONTRACT for anything the dispatcher mints:
 *
 *     jit-<node>-<repo-slug>-<epochSeconds>
 *
 * The trailing epoch is load-bearing, not decoration — it is the only mint-time
 * fact the GitHub API will give back to us. A JIT runner named without it is
 * treated as ageless and therefore immediately reapable.
 */
function mintAgeMs(name, now) {
	const m = /-(\d{10,})$/.exec(name);
	if (!m) return Infinity;
	return now - Number(m[1]) * 1000;
}

const log = (...a) => {
	if (!JSON_OUT) console.log(...a);
};

/**
 * A read that never finishes is a read that never reports. 20s matches
 * `check-queue-health`, and it is what makes `describeReadFailure`'s timeout
 * branch reachable rather than decorative.
 */
const READ_TIMEOUT_MS = 20_000;
/** Long enough for a blip to pass, short enough to be invisible at a 0.13% rate. */
const RETRY_DELAY_MS = 1_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One `gh api` call, as `{ok, data}` or `{ok: false, reason}`.
 *
 * This was `catch { res(null) }` — the shape CLAUDE.md names explicitly, where
 * the reason is discarded and the finding becomes unactionable. `describeReadFailure`
 * is written against `execFileSync`'s error shape, which spells the exit code
 * `status`; async `execFile` spells it `code`. Translated here rather than
 * re-implemented, because the interesting part — timeout vs exit vs stderr — is
 * the same question in both.
 */
function ghOnce(path) {
	return new Promise((res) => {
		execFile(
			'gh',
			['api', path],
			{ maxBuffer: 8 << 20, timeout: READ_TIMEOUT_MS },
			(err, stdout, stderr) => {
				if (err)
					return res({
						ok: false,
						reason: describeReadFailure(
							{
								killed: err.killed,
								signal: err.signal,
								status: err.code,
								stderr: stderr ?? '',
								message: err.message,
							},
							READ_TIMEOUT_MS
						),
					});
				try {
					res({ ok: true, data: JSON.parse(stdout) });
				} catch (e) {
					res({ ok: false, reason: `gh returned unparseable JSON: ${String(e.message)}` });
				}
			}
		);
	});
}

/** Data or null, for callers that treat a failed read as "no answer". */
async function gh(path) {
	const r = await ghOnce(path);
	return r.ok ? r.data : null;
}

/**
 * The runner listing for one repo, retried once, with the reason on failure.
 *
 * `{ok: false}` is COULD NOT LOOK and is never a pass — a repo whose listing
 * cannot be read is indistinguishable from a repo with no registrations, and
 * this whole file is about telling those apart.
 */
async function readRunners(repo) {
	let reason = 'no attempt was made';
	for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
		const r = await ghOnce(`repos/${repo}/actions/runners`);
		if (r.ok && Array.isArray(r.data?.runners)) return { ok: true, runners: r.data.runners };
		// The LAST reason wins: it is the one that stood after the blip had a
		// moment to pass, which is the more informative of the two.
		reason = `${r.ok ? 'gh answered with no `runners` array — not a runner listing' : r.reason} (attempt ${attempt}/${READ_ATTEMPTS})`;
		if (attempt < READ_ATTEMPTS) await sleep(RETRY_DELAY_MS);
	}
	return { ok: false, reason };
}

/**
 * Resolve a repo slug to its CANONICAL full_name, following renames.
 *
 * A runner's .runner file records the URL it was configured with and is never
 * rewritten when the repo is renamed, so the fleet is full of stale names:
 * `WolffM/tenhands` is now `WolffM/hadoku-tenhands`, `WolffM/OSS-Issue-Aggregator`
 * is now `WolffM/hadoku-aggregator`. Comparing a coverage roster (canonical)
 * against .runner (historical) without this reports every renamed repo on every
 * node as an identity mismatch — the first run of this tool produced ten such
 * findings and zero real ones.
 *
 * GitHub redirects the API for a renamed repo, so one call per DISTINCT stale
 * name resolves it. Cached, because the same stale name appears on every node.
 */
const canonCache = new Map();
async function canonical(slug) {
	if (!slug || slug === '?') return slug;
	if (canonCache.has(slug)) return canonCache.get(slug);
	const data = await gh(`repos/${slug}`);
	const full = data?.full_name ?? slug;
	canonCache.set(slug, full);
	return full;
}

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

// Under the shared GitHub reserve this sweep is not run (#9).
const reserve = checkGhReserve('runner-identity');
if (!reserve.ok) {
	if (JSON_OUT) console.log(JSON.stringify({ ok: false, error: reserve.reason }, null, 2));
	else console.error(`reconcile-runner-identity: ${reserve.reason}`);
	process.exit(1);
}

/**
 * A GUEST IS DELIBERATELY IN SCOPE HERE — `includeGuests` below, on purpose.
 *
 * A guest lends the fleet a registration and is otherwise none of the fleet
 * chain's business (operator, 2026-09-14). THE REGISTRATION IS THIS FILE'S WHOLE
 * SUBJECT: does every registration GitHub lists have a live install behind it,
 * and does every install have a registration. The guest is the fleet's backstop
 * and holds the standing registration for essentially the whole roster, so its
 * side of that question is most of the question.
 *
 * SKIPPING IT WOULD MANUFACTURE FINDINGS, not avoid work. `FLEET_WIDE` below
 * turns the registration-side rules on only when the probe saw the WHOLE fleet,
 * because "no node holds an install for this repo" is a claim about every node at
 * once. A guest that was reached but not probed would leave its installs out of
 * `installs`, and every one of its registrations would be reported
 * registered-no-install — a mutation test already caught that exact shape under
 * `--machine`. The probe reads unit and directory listings; it installs nothing,
 * removes nothing and asks for no sudo.
 */
const INCLUDE_GUESTS = true;
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
/** The warm units a probe saw ACTIVE. A loaded-but-dead unit backs nothing. */
function activeWarmUnits(out) {
	const live = new Set();
	for (const line of out.split('\n')) {
		const p = line.trim().split(/\s+/);
		if (p[0] === 'WARMUNIT' && p[2] === 'active') live.add(p[1]);
	}
	return live;
}

async function probeNode(machine) {
	let error = 'no attempt was made';
	for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
		const r = await runOn(machine, probe, { as: 'ci', includeGuests: INCLUDE_GUESTS });
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

if (!JSON_OUT) {
	if (ghosts.length) {
		log(`BLACK HOLES (${ghosts.length}) — GitHub says online, NO listener anywhere:`);
		for (const g of ghosts)
			log(`  ${g.repo}  ${g.name}${g.busy ? '  BUSY — a job is stuck on it' : ''}`);
		log('  These are never auto-deleted: a persistent registration is a node identity,');
		log("  and GitHub's status field lags. Investigate before removing.\n");
	}
	if (jitOrphans.length) {
		log(`JIT ORPHANS (${jitOrphans.length}) — ephemeral registration, no live unit:`);
		for (const o of jitOrphans)
			log(
				`  ${o.repo}  ${o.name}  status=${o.status}  age=${o.ageMs === Infinity ? 'unknown (no epoch in name)' : Math.round(o.ageMs / 1000) + 's'}`
			);
		log(CONFIRM ? '' : '  (pass --confirm to reap these)\n');
	}
	if (unreaped.length) {
		log(
			`UNREAPED BLACK HOLES (${unreaped.length}) — ONLINE JIT orphans older than ` +
				`${Math.round(UNREAPED_AFTER_MS / 60_000)}m, past the dispatcher's reap grace plus two sweeps:`
		);
		for (const u of unreaped)
			log(
				`  ${u.repo}  ${u.name}  age=${u.ageMs === Infinity ? 'unknown (no epoch in name)' : Math.round(u.ageMs / 1000) + 's'}`
			);
		log('  This FAILS. GitHub schedules onto an online registration and nothing answers;');
		log("  the dispatcher's sweep should have deleted these and has not. Check that it is");
		log('  running (mgmt-api up, token budget not spent) — --confirm reaps them here.\n');
	}
	if (young.length) {
		// Named so a skipped reap is never silent — an orphan that is always
		// "too young" is a dispatcher that is minting and failing to spawn.
		log(`TOO YOUNG TO JUDGE (${young.length}) — inside the ${GRACE_MS / 1000}s mint grace:`);
		for (const y of young) log(`  ${y.repo}  ${y.name}  age=${Math.round(y.ageMs / 1000)}s`);
		log('');
	}
	if (warmOrphans.length) {
		log(`WARM ORPHANS (${warmOrphans.length}) — warm registration, no live unit on its node:`);
		for (const w of warmOrphans) log(`  ${w.repo}  ${w.name}  status=${w.status} — ${w.why}`);
		log("  This FAILS. The warm reap only reaches a name its node's marker still holds, so");
		log('  nothing is guaranteed to clear these (#61). Delete the registration by id.\n');
	}
	if (warmRechecked.length) {
		log(`WARM, RESOLVED ON A SECOND LOOK (${warmRechecked.length}) — the cache rotated mid-sweep:`);
		for (const w of warmRechecked) log(`  ${w.repo}  ${w.name} — ${w.outcome}`);
		log('');
	}
	if (noInstall.length) {
		log(`REGISTERED, NO INSTALL (${noInstall.length}) — no node is configured for this repo:`);
		for (const d of noInstall)
			log(
				`  ${d.repo}  runner "${d.name}" status=${d.status}` +
					(d.carriers.length ? `  (that name lives on: ${d.carriers.join(', ')})` : '')
			);
		log('');
	}
	if (expectedDown.length) {
		// LISTED, never dropped. A deferral the report does not print is
		// indistinguishable from a clean fleet, which is the failure this whole
		// mechanism is one step away from.
		const byNode = new Map();
		for (const e of expectedDown) {
			if (!byNode.has(e.node)) byNode.set(e.node, []);
			byNode.get(e.node).push(e);
		}
		log(
			`EXPECTED DOWN (${expectedDown.length}) — registered, no install, DEFERRED because the node is drained:`
		);
		for (const [node, rows] of byNode) {
			log(`  ${rows[0].why}`);
			log(`    ${rows.length} offline registration(s) still held by ${node}:`);
			for (const r of rows) log(`      ${r.repo}`);
		}
		log('  Lift the drain, or let it expire, and every line above fails this gate again.\n');
	}
	if (drainUnreadable) {
		log(`! DRAIN RECORD UNREADABLE — ${drainUnreadable}`);
		log('  NOTHING was deferred on this run. A gate that cannot read the drain record');
		log('  cannot tell a deliberate power-off from a dead node, so any registration');
		log('  finding above may be either. Fix the file and re-run before acting on them.\n');
	}
	if (clobbered.length) {
		log(`STOLEN IDENTITIES (${clobbered.length}) — a JIT probe overwrote a persistent install:`);
		for (const c of clobbered) log(`  ${c.machine}  ${c.dir}  now claims "${c.name}" (${c.repo})`);
		log('  Repair: ./config.sh remove --local, then re-register with --replace.\n');
	}
	if (unconfigured.length) {
		log(`UNCONFIGURED LISTENERS (${unconfigured.length}) — running with no readable .runner:`);
		for (const u of unconfigured) log(`  ${u.machine}  ${u.dir}`);
		log('');
	}
	if (!FLEET_WIDE) {
		log(
			ONLY
				? `Scoped to ${ONLY}: registration-side checks (black holes, registered-no-install) SKIPPED —\n  they need every node's installs to be meaningful.\n`
				: `${unreachable.length} node(s) unreachable: registration-side checks SKIPPED —\n  a partial fleet view turns every unseen install into a false finding.\n`
		);
	}
	if (unexpectedlyDark.length) {
		log(
			`COULD NOT LOOK — ${unexpectedlyDark.length} node(s) unreachable, after ${READ_ATTEMPTS} attempts:`
		);
		for (const u of unexpectedlyDark) log(`  ${u.machine}: ${u.error}  [${u.why}]`);
		log("  This FAILS. A node that did not answer has installs nobody saw, and this gate's");
		log('  registration half is skipped while one is dark — so a pass here would be a');
		log("  statement about the boxes that answered, wearing the fleet's name.\n");
	}
	if (expectedDark.length) {
		log(
			`EXPECTED DOWN (${expectedDark.length}) — unreachable, DEFERRED because the node is drained:`
		);
		for (const u of expectedDark) log(`  ${u.why}\n    probe said: ${u.error}`);
		log('  Lift the drain, or let it expire, and every line above fails this gate again.\n');
	}
	if (unreadableRepos.length) {
		log(
			`COULD NOT LOOK — ${unreadableRepos.length} repo(s) whose runner listing failed every one of ${READ_ATTEMPTS} attempts:`
		);
		for (const r of unreadableRepos) log(`  ${r.repo} — ${r.reason}`);
		log('  This FAILS. An unread listing and a repo with no registrations are the same');
		log('  bytes to everything downstream, and telling those apart is what this gate is.\n');
	}
	if (
		!ghosts.length &&
		!jitOrphans.length &&
		!unreaped.length &&
		!warmOrphans.length &&
		!noInstall.length &&
		!unconfigured.length &&
		!clobbered.length &&
		!drainUnreadable &&
		!unreachable.length &&
		!unreadableRepos.length
	)
		// THE ✓ IS A CLAIM ABOUT THE FLEET, so it may only be made when the fleet
		// was seen. Under `--machine` the registration half never ran, and the old
		// line said "every registration has a live listener" anyway — a sentence
		// about 27 repos printed by a run that read none of them.
		log(
			(FLEET_WIDE
				? '✓ every registration has a live listener, and every listener knows who it is.'
				: `✓ nothing wrong with the listeners on ${ONLY} — but the registration half was SKIPPED, so this says nothing about the fleet.`) +
				(expectedDown.length ? ` (${expectedDown.length} deferred — listed above)` : '')
		);
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

if (JSON_OUT) console.log(JSON.stringify(summary, null, 2));

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
process.exit(
	ghosts.length ||
		unreaped.length ||
		warmOrphans.length ||
		noInstall.length ||
		unconfigured.length ||
		clobbered.length ||
		drainUnreadable ||
		unexpectedlyDark.length ||
		unreadableRepos.length
		? 1
		: 0
);
