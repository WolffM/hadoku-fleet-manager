#!/usr/bin/env node
/**
 * floor-probe — P3.2, the forced-placement harness.
 *
 * WHAT THIS IS FOR, IN ONE SENTENCE: the fleet has served the same
 * `(repo, runId, jobName)` on two distinct nodes **0 times in 7,033 jobs**, so
 * "would this have failed somewhere else?" cannot be answered from history that
 * already exists — it has to be MANUFACTURED, and this is the thing that
 * manufactures it.
 *
 * Built to `docs/planning/claw-floor-design-2026-09-07.md` (lane F). Section
 * references below are that document's; the rules themselves live in
 * `lib/floor-probe.mjs` with tests beside them, because a rule that only exists
 * inside a script that talks to GitHub and ssh's to six boxes cannot be
 * exercised.
 *
 * SIX MODES
 * ---------
 *   report      the per-node zone table over the WHOLE retention window, every
 *               node and every repo (or one, with `--repo`). READ-ONLY BY
 *               CONSTRUCTION: it reads job-history and the manifest and makes
 *               no GitHub call, no ssh, no dispatch, no mint and no write. This
 *               is the mode that answers "whose failures are the fleet's", and
 *               it exists because `table` is scoped to one `(repo, job)` — a
 *               question about a NODE cannot be asked one unit at a time when
 *               the busiest node/unit pair has 31 samples in fourteen days.
 *   table       (default) the per-node table for one `(repo, job)`, from
 *               job-history plus this harness's own settled probes. Reads
 *               nothing but disk. This is what a later reader — the panel, a
 *               gate, lane I's `orderCandidates()` — consumes.
 *   candidates  §2's ordered candidate list for that unit: weakest-first, with
 *               margins, exclusions and `floorConfidence`.
 *   window      §7's quiet-window predicate, on its own, so an operator can ask
 *               "may I probe right now" without dispatching anything.
 *   probe       §6's SHADOW path. Mints on ONE named node, dispatches a
 *               workflow, waits, and records what actually served it. Needs
 *               `--confirm`; without it this plans and prints and touches
 *               nothing.
 *   rerun       §5/§6's FORCED RE-RUN path (Control A). Re-dispatches a job that
 *               already failed in the runner or seam zone, with the failing node
 *               EXCLUDED (`--onto`), and records the attempt against it.
 *
 * THE SAFETY PROPERTY THE WHOLE THING EXISTS TO PROTECT (§6): a probe is never
 * a consumer's only attempt. A fleet-origin failure must never be what somebody
 * sees as "my code is broken". Three things enforce it, and none of them is a
 * comment:
 *
 *   1. `shadowSafety()` refuses any workflow that dispatches, redeploys or
 *      publishes — the first workflow anyone would reach for
 *      (hadoku-pygmalion's `redeploy.yml`, which holds the `test` job issue #3
 *      is actually about) ends in a job that takes prod pygmalion down and back
 *      up.
 *   2. `--confirm` is required to make any write at all.
 *   3. Every call goes through the blackout-aware `ghGet`/`ghWrite` in
 *      `runner-health.ts`. A fourth uncoordinated caller is how the fleet spent
 *      19 minutes of every hour unable to poll or mint on 2026-09-05.
 *
 * HOW "FORCED" IS ACTUALLY FORCED, AND HOW IT IS VERIFIED
 * ------------------------------------------------------
 * Under all-JIT nothing can be pinned to a node by asking GitHub. What CAN be
 * done is to have a runner on the chosen node ALREADY LISTENING when the job is
 * created: GitHub hands a queued job to an idle matching runner in about two
 * seconds, well inside the dispatcher's 15s tick, so the probe's runner is
 * usually the only one that ever exists for that job. `modeProbe`'s docblock
 * carries the measurement that forced this ordering — the first version minted
 * AFTER dispatching and collided with mgmt-api on claw-2 inside one second.
 *
 * It is still a RACE and it is not pretended otherwise: hokon holds standing
 * `hadoku-builder` registrations, and the dispatcher may still see the job
 * queued on one tick. So the probe does not trust its own intention — it reads
 * `runner_name` BACK from GitHub and records intended-vs-observed. A probe that
 * landed elsewhere reports MISSED, is not counted as evidence about the intended
 * node, and is still recorded as a real sample of the node that DID serve it,
 * because a probe that silently retargets itself is worse than one that admits
 * it.
 *
 * NOT WIRED TO A CRON, DELIBERATELY. Adding an entry to
 * `scripts/lib/json-contract.mjs` before the mgmt-api file that names it exists
 * opens a red `contract-consumers` window: land the repo that CREATES a consumer
 * before the repo that NAMES it. `--json` costs nothing and is implemented on
 * the same footing as every other `check-*.mjs`; the contract DECLARATION waits
 * for its consumer.
 */
import {
	existsSync,
	readFileSync,
	appendFileSync,
	mkdirSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import process from 'node:process';

import { manifest as manifestFile, manifestDir, stateDir, siteRoot } from './lib/paths.mjs';
import { readDrains } from './lib/expected-down.mjs';
import { tryShipped } from './lib/fleet-source.mjs';
import { createEmitter } from './lib/emit.mjs';
import { stripYamlComments } from './lib/yaml-comments.mjs';
import { runOn } from './lib/fleet-exec.mjs';
// The BUILT copy, for the same reason fleet-exec.mjs imports isLocalNode that
// way: one question, one answer, and no second implementation to drift from.
import { isGuestNode } from '../dist/lib/node-role.js';
import {
	CallBudget,
	PER_NODE_SAMPLES,
	PROBE_CALLS,
	RERUN_CALL_CEILING,
	SHADOW_CALL_BUDGET,
	buildCandidateList,
	callsPerProbe,
	classifyZone,
	dailyCronMinutes,
	flakyVerdicts,
	foreignFlags,
	isCiDemandRow,
	maxProbesPerRun,
	nodeZoneTable,
	parseMode,
	probeGate,
	quietWindow,
	shadowSafety,
	unitTable,
	warrantsForcedRerun,
	ZONE_NAMES,
} from './lib/floor-probe.mjs';
import { installHost } from '../dist/host.js';
import { nodeOf } from '../dist/runners/census.js';
import { PROBE_LEDGER_FILE, RETENTION_DAYS } from '../dist/job-history.js';
import { PROBE_INTENT_DIR, PROBE_INTENT_MAX_MS } from '../dist/runners/dispatch-tick.js';
import { ghGet, ghWrite } from '../dist/lib/github-client.js';
import { ghBlackoutRemainingMs } from '../dist/lib/github-client.js';
import { nodeReservation } from '../dist/node-reservation.js';
import { mintEphemeralRunner, liveJitSlots } from '../dist/runners/ephemeral-exec.js';
import { jitRunnerName } from '../dist/runners/ephemeral.js';
import { nodeOffer, workloadGateContext, workloadGatedCapabilities } from '../dist/capabilities.js';
import { proofFileStatus, readProofsForCapability } from '../dist/lib/measured.js';
import { nodeHome } from '../dist/lib/node-users.js';

/**
 * The library half needs a HOST before any of it runs — `logger`, `stateDir` and
 * the manifest paths are injected, not compiled in, and `ghWrite`/
 * `mintEphemeralRunner` both log. `installHost` rather than
 * `createFleetManager`: the manager is a singleton that also builds the monitors,
 * and a CLI has no business constructing the thing that ticks. Installed at
 * module scope because several library modules resolve paths at import time —
 * the same reason `install-test-host.ts` is a `--import` preload.
 *
 * The four paths are the same four mgmt-api passes (`services/mgmt-api/src/fleet.ts`),
 * resolved through `lib/paths.mjs` so this command and the service name ONE
 * location each rather than two that agree until one moves. `requirePaths` throws
 * on any of them missing, which is the correct failure: every loader behind them
 * turns an absent file into an empty result, and an empty result reads as a
 * healthy fleet of nothing.
 */
installHost({
	logger: {
		// stderr, never stdout. `--json` means this command's stdout is exactly one
		// JSON document, and a library warning printed mid-run would corrupt it for
		// the same parser the rest of the fleet's gates feed.
		info: (m) => process.stderr.write(`${m}\n`),
		warn: (m) => process.stderr.write(`${m}\n`),
		error: (m) => process.stderr.write(`${m}\n`),
	},
	// A CLI does not page anybody. The probe's finding is its exit code and its
	// stdout; posting to Discord from an operator-invoked command would put an
	// alert in front of the only person who already knows it ran.
	alerts: {
		post: () => Promise.resolve({ posted: false, sinkRecorded: false }),
		recordQuietly: () => undefined,
	},
	jobs: { recordJobResult: () => Promise.resolve() },
	githubToken: () => process.env.HADOKU_SITE_TOKEN?.trim() || undefined,
	manifestDir: manifestDir(),
	stateDir: stateDir(),
	storeDoctorPath: join(siteRoot(), 'scripts', 'ci', 'pnpm-store-doctor.sh'),
	cronProfilesPath: join(siteRoot(), 'services', 'cron-worker', 'profiles.json'),
});

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const CONFIRM = argv.includes('--confirm');
const emitter = createEmitter({ json: JSON_OUT });
const log = emitter.log;

const flag = (name, fallback = null) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

/**
 * Every exit that is not a clean pass goes through here — reason included.
 *
 * `detail` is a list of lines printed under the message on the human path and
 * carried in `extra` on the JSON one. A finding that names a thing and nothing
 * else is undiagnosable after the fact: `check-queue-health` named a repo and
 * only a repo until 2026-09-07, and its five findings that day could not be
 * told apart afterwards.
 */
function fail(msg, extra = {}) {
	if (JSON_OUT) emitter.emit({ ok: false, error: msg, ...extra });
	else {
		console.error(`✗ ${msg}`);
		for (const line of extra.detail ?? []) console.error(`    ${line}`);
	}
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Inputs. Every one of these FAILS rather than degrading to empty — "I could
// not look" must never render as "nothing is wrong".
// ---------------------------------------------------------------------------

function readJson(path, what) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch (err) {
		fail(`cannot read ${what} (${path}): ${err.message}`);
	}
}

const historyPath = join(stateDir(), 'job-history.jsonl');
const ledgerPath = join(stateDir(), PROBE_LEDGER_FILE);

function loadHistory() {
	if (!existsSync(historyPath)) {
		fail(`no job-history at ${historyPath} — there is nothing measured to build a table from`);
	}
	const rows = [];
	let bad = 0;
	for (const line of readFileSync(historyPath, 'utf8').split('\n')) {
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line));
		} catch {
			bad++;
		}
	}
	if (!rows.length)
		fail(`job-history at ${historyPath} holds no records — a window of zero is not a pass`);
	return { rows, bad };
}

/** The harness's own ledger. Append-only; job-history reads it and never writes it. */
function loadLedger() {
	if (!existsSync(ledgerPath)) return [];
	const out = [];
	for (const line of readFileSync(ledgerPath, 'utf8').split('\n')) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			// one bad line, not a bad file
		}
	}
	return out;
}

function appendLedger(entry) {
	mkdirSync(dirname(ledgerPath), { recursive: true });
	appendFileSync(ledgerPath, `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`);
}

/**
 * Tell the dispatcher this job is already being served, so it mints no competitor.
 *
 * THE WASTED COMPETITOR, CLOSED. §2.1 measured "roughly one wasted mint per
 * probe": this harness mints a listener and dispatches, mgmt-api sees the same
 * job queued on its next 15 s tick and mints a second runner for it. The cost is
 * absorbed, but it is also what made the sweep's MISSES correlated — all four
 * landed on a node still holding the previous probe's leftover, so two idle
 * matching runners existed and GitHub picked. `readProbeIntents` in
 * `dispatch-tick.ts` is the reader; this is the only writer.
 *
 * DECLARED BEFORE THE MINT, not before the dispatch. Nothing can queue the job
 * until the dispatch, so either would be correct on paper — but the mint is the
 * first irreversible thing, and an intent written after it has a window in which
 * the process can die holding a registration it never declared.
 *
 * RELEASED ON EVERY EXIT, via `process.on('exit')` rather than a `finally`:
 * `fail()` calls `process.exit`, which a `finally` does not run. An intent left
 * behind is a licence to NOT MINT for that unit, and under all-JIT nothing else
 * would mint — so a real job of the same unit would sit queued until the expiry
 * below. The expiry is the backstop for a SIGKILL, not the normal path.
 */
function declareProbeIntent({ repo, job, node, runnerName }) {
	const dir = join(stateDir(), PROBE_INTENT_DIR);
	const path = join(dir, `${runnerName}.json`);
	mkdirSync(dir, { recursive: true });
	// The runner's own TTL, which is the longest this probe can possibly be waiting
	// for the job. PROBE_INTENT_MAX_MS is the reader's ceiling and is deliberately
	// wider, for the two clocks; see that constant.
	const expiresAtMs = Date.now() + PROBE_TTL_SECONDS * 1000;
	if (expiresAtMs - Date.now() > PROBE_INTENT_MAX_MS) {
		// Unreachable while PROBE_TTL_SECONDS is 900 — and asserted in the tests —
		// but a declaration the reader will refuse must not be written silently: the
		// probe would lose the race it thinks it has already won.
		fail(
			`a probe intent of ${PROBE_TTL_SECONDS}s exceeds the dispatcher's ` +
				`${PROBE_INTENT_MAX_MS / 1000}s ceiling — it would be ignored, not honoured`
		);
	}
	writeFileSync(
		path,
		`${JSON.stringify({ repo, job, node, runnerName, expiresAtMs, at: new Date().toISOString() })}\n`
	);
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		try {
			unlinkSync(path);
		} catch {
			// Already gone is the success case — another exit path released it.
		}
	};
	process.on('exit', release);
	return release;
}

const manifest = readJson(manifestFile('fleet-runner-manifest.json'), 'the fleet manifest');
const machines = manifest.machines ?? {};
const NODES = Object.keys(machines);
if (!NODES.length)
	fail('the manifest declares no machines — a healthy fleet of zero is not a pass');

/**
 * This RUN's `WorkloadGateContext` (wave 4e follow-up, #102) — one state-dir
 * read, built once and reused for both `nodeOffer` call sites below (the
 * shadow probe mint and the forced-rerun mint), the same pattern
 * `src/runners/ephemeral-tick.ts`'s `loadWorkloadGateContext` uses. A probe
 * mint is a one-shot CLI invocation, so "once per run" is already "once",
 * unlike the 15s dispatch loop that pattern was written against.
 *
 * `proofFileStatus` is checked FIRST, same reason as every other caller of
 * `workloadGateContext`: an UNREADABLE or MALFORMED `$proof` file must never
 * be read as "no records at all", which would silently RE-GRANT a label a
 * FAIL/STALE mark had just withdrawn. `corrupt: true` forces every workload-
 * gated label withheld fleet-wide instead — the safe failure direction.
 */
const workloadGate = (() => {
	const status = proofFileStatus({ dir: stateDir() });
	if (status.corrupt) {
		console.error(
			`! $proof is ${status.reason} (${status.why}) — withholding every workload-gated label ` +
				`from this probe's mint until it is readable again.`
		);
		return workloadGateContext(NODES, {}, { corrupt: true });
	}
	const proofsByCapability = {};
	for (const id of workloadGatedCapabilities())
		proofsByCapability[id] = readProofsForCapability(id, { dir: stateDir() });
	return workloadGateContext(NODES, proofsByCapability);
})();

/** The mint's labels for one node — `nodeOffer` plus this run's workload gate. */
function mintLabelsFor(node) {
	return nodeOffer(machines[node] ?? {}, {
		eligible: true,
		workloadProofs: workloadGate.byNode[node] ?? {},
		provenCounts: workloadGate.provenCounts,
	});
}

/**
 * The nodes a probe may place on. EPHEMERAL, AND NOT A GUEST.
 *
 * Both halves are enforced, and the second one is not redundant. A probe mints a
 * real runner and pushes a real job onto the node it names, so this list is the
 * blast radius of `--node` and of `--onto` — and `--onto` exists precisely to
 * FORCE a re-run somewhere the job did not choose to go. A guest lends the fleet
 * a standing registration and is otherwise none of the fleet chain's business
 * (operator, 2026-09-14); billing it for a manufactured job is the far end of
 * that.
 *
 * Until now the guest was excluded only because it declares no `ephemeral` key —
 * true today, and one manifest edit from being false, at which point `--onto
 * <the guest>` would have started minting there with nothing to say about it.
 * The rule is the ROLE; `ephemeral` is a capacity fact that happens to agree.
 */
const CLAWS = NODES.filter((n) => machines[n]?.ephemeral === true && !isGuestNode(machines[n]));

/** Named separately so a refusal can say WHICH rule refused — see `notAProbeTarget`. */
const GUESTS = NODES.filter((n) => isGuestNode(machines[n]));

/**
 * Why a node cannot be probed, in the words that fit it.
 *
 * "not an ephemeral node in the manifest" is true of a guest and sends the
 * reader to the wrong fix — they would add `ephemeral: true` to it. A refusal
 * that names the wrong cause is unactionable, which is the point of saying WHY.
 */
const notAProbeTarget = (node) =>
	GUESTS.includes(node)
		? `${node} is a GUEST — the fleet does not place work on one. It lends a standing ` +
			`registration and is otherwise none of the fleet chain's business, so a probe ` +
			`may never be forced onto it. Name a claw: ${CLAWS.join(', ') || '(none)'}`
		: `${node} is not an ephemeral node in the manifest`;

/** Drain state, read from where the DISPATCHER reads it — not a git checkout. */
function drainedNodes() {
	// A parse failure THROWS in drain.ts and every caller fails closed. Same here:
	// answering "nothing is drained" would place a probe on a box somebody is
	// holding a screwdriver over.
	return Object.keys(readDrains());
}

/**
 * The capability set a node has actually PROVEN, per `fleet bootcamp`.
 *
 * §1.1 names `$capabilities.earned` and only that. Measured against the live
 * manifest on 2026-09-08, `earned` is EMPTY on all six claws — bootcamp writes
 * `earned` only for a capability whose surface is a LABEL and which the node
 * also declares, and everything else it proved goes to `prereqs`. Every
 * non-label capability the demand ledger asks for — `python-toolcache` among
 * them, which is exactly what hadoku-pygmalion's `test` job demands and what
 * issue #3 is about — therefore lives in `prereqs` and in no node's `earned`.
 *
 * Reading `earned` alone would exclude every claw for that unit and report a
 * candidate list of zero for a job the fleet demonstrably serves several times
 * a day. That is the "unreadable roster reads as a clean audit" shape, so this
 * reads the UNION and says so. Flagged to the tracker as a disagreement with
 * §1.1 rather than fixed quietly: either the design means "proven", or bootcamp
 * should be promoting prereqs into `earned`, and that is lane P's call.
 */
function provenCapabilities(node) {
	const c = machines[node]?.$capabilities ?? {};
	return new Set([...(c.earned ?? []), ...(c.prereqs ?? []).map((p) => p.id)]);
}

/**
 * What a `(repo, job)` demands, unioned across every CI demand-ledger record.
 *
 * FILTERED ON `class`, and that filter is load-bearing rather than defensive.
 * The ledger holds resident workloads — PM2 services, cron jobs, deployment
 * checkouts — in the SAME file as CI jobs as of Wave 3-prep, by decision, and a
 * resident row shares the `(repo, job)` shape. Unioned in, a PM2 service's
 * capabilities become a CI job's requirements and every claw that cannot satisfy
 * them is excluded with reason `capability` — a candidate list of zero for a job
 * the fleet serves all day, and this time wearing a certainty. `isCiDemandRow`
 * owns the rule because a predicate inside a script that ssh's to six boxes
 * cannot be exercised.
 */
function demandFor(repo, job) {
	const p = join(stateDir(), 'demand-ledger.jsonl');
	if (!existsSync(p)) return null; // could not look — the caller decides
	const caps = new Set();
	let seen = false;
	for (const line of readFileSync(p, 'utf8').split('\n')) {
		if (!line.trim()) continue;
		let r;
		try {
			r = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isCiDemandRow(r, { repo, job })) continue;
		seen = true;
		// A capability once demanded does not un-demand itself between ledger runs.
		for (const c of r.capabilities ?? []) caps.add(c);
	}
	return seen ? caps : null;
}

// ---------------------------------------------------------------------------
// §7 — the quiet window
// ---------------------------------------------------------------------------

/**
 * The 11 staggered daily crons, read from the covered repos' own workflows.
 *
 * DERIVED, NEVER TYPED. "A fixed window is a guess about someone else's
 * schedule, and it goes stale silently" — node-reservation.ts's own argument,
 * and it applies here unchanged: writing `06:03..06:53` into this file would be
 * correct today and wrong the first time WS-E restaggers.
 *
 * A COVERED REPO THAT CANNOT BE READ IS A FAILURE, not zero schedules. If the
 * reader cannot see a repo's workflows it cannot know whether that repo is about
 * to fan out, and probing on that basis is exactly "I could not look" rendering
 * as "nothing is wrong". `quietWindow()` refuses an empty schedule list for the
 * same reason.
 */
function fleetCronSchedules() {
	const coverage = readJson(manifestFile('fleet-runner-coverage.json'), 'the coverage roster');
	const repos = coverage.repos ?? [];
	if (!repos.length) fail('the coverage roster is EMPTY — a fleet of zero repos is not a pass');
	const schedules = [];
	const unreadable = [];
	for (const full of repos) {
		const name = full.split('/').pop();
		// The SHIPPED workflows, through fleet-source: what GitHub will fire is the
		// default branch, never a sibling working tree (fleet-manager#7).
		const source = tryShipped(full);
		if ('unreadable' in source) {
			unreadable.push(`${full}: shipped workflows unreadable (${source.unreadable})`);
			continue;
		}
		for (const { file: f, text } of source.workflows()) {
			const body = stripYamlComments(text);
			for (const m of body.matchAll(/cron:\s*['"]([^'"]+)['"]/g)) {
				const minutes = dailyCronMinutes(m[1]);
				if (minutes !== null) schedules.push({ name: `${name}/${f}`, minutesOfDay: minutes });
			}
		}
	}
	return { schedules, unreadable };
}

/**
 * Is now a quiet window?
 *
 * `nodeReservation`'s LIVE half — `inFlightCronJobs()` — is module state inside
 * the long-lived mgmt-api process and is structurally invisible from a CLI, so
 * out here it always reads zero. That is a genuine "I could not look" and it is
 * named in the output rather than passed off as "not reserved": what this
 * command can see is the DECLARED window, which is 90 minutes wide around every
 * cron-worker profile and therefore strictly wider than the live signal it
 * cannot see. Refusing more often than mgmt-api would is the safe direction.
 */
function checkQuietWindow(now = new Date()) {
	const profilesPath = join(siteRoot(), 'services', 'cron-worker', 'profiles.json');
	if (!existsSync(profilesPath)) {
		return {
			quiet: false,
			why: 'could-not-tell',
			detail: `no cron-worker profiles at ${profilesPath}`,
			reservationSource: 'none',
		};
	}
	const profiles = readJson(profilesPath, "cron-worker's profiles").profiles ?? [];
	// pm2HostBusy is `false` because it is not observable from here either: it is
	// pushed into the library by runner-health's own tick. It reports hokon
	// serving a DEPLOY, which is not the fan-out signal §7 is asking about.
	const reservation = nodeReservation(now, false, profiles);
	const { schedules, unreadable } = fleetCronSchedules();
	// ANY unreadable covered repo closes the window, not just all of them.
	// `quietWindow()` refuses an EMPTY schedule list, which catches the total
	// failure; this catches the partial one, and the partial one is the dangerous
	// shape — 25 readable checkouts and one missing looks exactly like a quiet
	// fleet, and the missing repo is the one that might be fanning out. A
	// PARTIAL scan reported as clean is the same defect as an unreported failure.
	if (unreadable.length) {
		return {
			quiet: false,
			why: 'could-not-tell',
			detail: `${unreadable.length} covered repo(s) could not be read for daily crons`,
			schedulesSeen: schedules.length,
			unreadable,
			reservationSource: 'declared-only (the live cron counter lives inside mgmt-api)',
		};
	}
	const verdict = quietWindow({
		nowMinutesOfDay: now.getUTCHours() * 60 + now.getUTCMinutes(),
		reserved: reservation.reserved,
		reservationReason: reservation.detail,
		schedules,
	});
	return {
		...verdict,
		schedulesSeen: schedules.length,
		unreadable,
		reservationSource: 'declared-only (the live cron counter lives inside mgmt-api)',
	};
}

// ---------------------------------------------------------------------------
// GitHub, metered and blackout-aware
// ---------------------------------------------------------------------------

function githubToken() {
	for (const k of ['HADOKU_SITE_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']) {
		const v = process.env[k]?.trim();
		if (v) return v;
	}
	try {
		// `gh auth token` is the operator's own credential and this command is
		// operator-invoked. The vault broker is hadoku_site's and cannot be reached
		// from here without vendoring it.
		return execFileSync('gh', ['auth', 'token'], {
			encoding: 'utf8',
			timeout: 10_000,
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim();
	} catch {
		return null;
	}
}

/**
 * Every GitHub call this harness makes, metered against §7's 200-call cap and
 * suppressed by the SAME blackout the reap and the label sweep already honour.
 *
 * Suppression returns each function's "could not look" value — `null` for a
 * read, `{ok:false}` for a write. It must NEVER return anything a caller could
 * read as "unchanged": telling the dispatcher its cached queue is current when
 * we simply did not look is the failure CLAUDE.md names by name.
 */
function meteredGh(budget, token) {
	const spent = () => budget.spent;
	const stop = () => probeGate(budget, ghBlackoutRemainingMs());
	return {
		spent,
		async get(path, repo) {
			const why = stop();
			if (why) return { ok: false, why, body: null };
			const body = await ghGet(path, token, repo);
			return { ok: body !== null, why: body === null ? 'GitHub did not answer' : null, body };
		},
		async write(method, path, tok, body, repo) {
			const why = stop();
			if (why) return { ok: false, status: 0, why };
			const res = await ghWrite(method, path, tok, body, repo);
			return { ...res, why: res.ok ? null : `HTTP ${res.status}` };
		},
	};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Refuse to mint into PROBE_SLOT if something is already listening there.
 *
 * The collision this slot reservation exists to prevent has two sources, and
 * reserving a high slot only fixes ONE of them: the dispatcher cannot reach slot
 * 9, but a SECOND copy of this command can, and would provision it with
 * `RESET=1` straight over the first probe's config. Two operators, or one
 * operator and a loop, is not an exotic case — it is how the sweep that measured
 * §2.1 was run.
 *
 * Read from the node's own process tree — the same source `dispatch-pass` uses —
 * rather than from anything this process remembers, because the other probe is
 * in another process and there is nothing here to remember.
 */
async function probeSlotIsFree(node) {
	const slots = await liveJitSlots(node, sh);
	return !slots.has(PROBE_SLOT);
}

/**
 * The slot a probe's runner takes on the node, reserved and deliberately high.
 *
 * `dispatch-pass` takes the LOWEST free slot from the node's own process tree,
 * and `jit-provision.sh` runs `RESET=1` — so two minters that both start
 * counting at zero rewrite each other's config. That is §12.16, and it happened
 * on claw-2 at 18:04 on 2026-09-08 between this harness and mgmt-api. Nine is
 * unreachable by the dispatcher's walk while the largest `maxConcurrent` in the
 * manifest is 3, which makes the collision impossible rather than unlikely.
 */
const PROBE_SLOT = 9;

/**
 * How long a probe's runner may sit listening.
 *
 * Much shorter than the dispatcher's 3600s, because these two hold the slot for
 * opposite reasons: the dispatcher mints for a job that already exists, this
 * mints BEFORE one does. A probe whose dispatch fails silently would otherwise
 * hold a listener on a claw for an hour waiting for work nobody sent. Fifteen
 * minutes comfortably covers a 10-minute `timeout-minutes` job plus its queue.
 */
const PROBE_TTL_SECONDS = 900;

/**
 * Run a command on a node. `null` on failure, which is `ShellLike`'s contract —
 * `mintEphemeralRunner` reads a null as "unreachable" and refuses to mint, and
 * returning an empty string instead would make an unreachable box look like one
 * that answered with nothing.
 */
const sh = async (node, command) => {
	const r = await runOn(node, command, { as: 'ci', timeoutMs: 120_000 });
	return r.ok ? r.stdout : null;
};

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

function parseUnit(spec) {
	if (!spec) return null;
	const i = spec.lastIndexOf('#');
	if (i < 0) return null;
	return { repo: spec.slice(0, i), job: spec.slice(i + 1) };
}

function samplesFor(rows, key) {
	return rows
		.filter((r) => r.repo === key.repo && r.name === key.job)
		.map((r) => ({ ...r, node: nodeOf(r.runner, NODES) }));
}

/** §2's `excluded`: eligibility failures the manifest and the ledger state with certainty. */
function exclusionsFor(key) {
	const drained = new Set(drainedNodes());
	const demanded = demandFor(key.repo, key.job);
	const out = [];
	for (const node of CLAWS) {
		if (drained.has(node)) {
			out.push({ node, reason: 'drained' });
			continue;
		}
		if (demanded === null) continue; // could not look — do NOT invent an exclusion
		const have = provenCapabilities(node);
		const missing = [...demanded].filter((c) => !have.has(c));
		if (missing.length) out.push({ node, reason: 'capability', detail: missing.join(', ') });
	}
	return { excluded: out, demandKnown: demandFor(key.repo, key.job) !== null };
}

function routableJobsByNode(rows) {
	const out = {};
	for (const r of rows) {
		const n = nodeOf(r.runner, NODES);
		out[n] = (out[n] ?? 0) + 1;
	}
	return out;
}

function pickBusiestUnit(rows) {
	const by = new Map();
	for (const r of rows) {
		const k = `${r.repo}#${r.name}`;
		if (!by.has(k)) by.set(k, new Set());
		by.get(k).add(nodeOf(r.runner, NODES));
	}
	let best = null;
	for (const [k, nodes] of by) {
		const claws = [...nodes].filter((n) => CLAWS.includes(n)).length;
		if (!best || claws > best.claws) best = { k, claws };
	}
	return best ? parseUnit(best.k) : null;
}

/**
 * Merge this harness's settled probes into the unit's samples.
 *
 * TWO SOURCES, MERGED — NOT ONE PREFERRED OVER THE OTHER. job-history is the
 * record every other consumer reads, and `ingestRuns` stamps the `probe` tag
 * from the ledger — but only inside the process that HOLDS the window, which is
 * the DEPLOYED mgmt-api. Until this version is published, a probe run lands in
 * job-history untagged.
 *
 * Dropping the ledger row when history already has the job was the first
 * attempt, and it was wrong in a way that got worse over time: the probes showed
 * in the table for a few minutes and then VANISHED, one by one, as the poller
 * caught up and the untagged copy won. `pinned` on claw-2 went 3 → 0 while the
 * probes sat green in the ledger. A table that loses its own evidence as the
 * fleet observes it is exactly the shape `deployed-not-published-2026-09-05.md`
 * warns about.
 *
 * So: history supplies the MEASUREMENT (it re-read every field from GitHub
 * independently), the ledger supplies the PROVENANCE (`probe`, `intendedNode`),
 * and a job present in both gets one row carrying both. Once this version is
 * published the two agree and the merge is a no-op.
 *
 * This is NOT the harness reading back its own writer's artifact. `node`,
 * `conclusion` and `durationSec` in a settled entry were read from GitHub's job
 * listing, not from the probe's intention — the intention is the separate
 * `intendedNode` field, and `forced` is the comparison between them.
 *
 * A MISSED probe is kept, with the node that ACTUALLY served it. It is a real
 * sample of that node, and dropping it would be discarding a measurement for not
 * being the one we asked for.
 */
function mergeProbeProvenance(key, fromHistory) {
	const byJob = new Map();
	const byRun = new Map();
	for (const e of loadLedger()) {
		if (!e.settled || e.repo !== key.repo || e.job !== key.job || !e.node) continue;
		if (typeof e.jobId === 'number') byJob.set(e.jobId, e);
		else byRun.set(e.runId, e);
	}
	let tagged = 0;
	const merged = fromHistory.map((r) => {
		const e = byJob.get(r.jobId) ?? byRun.get(r.runId);
		if (!e) return r;
		byJob.delete(r.jobId);
		byRun.delete(r.runId);
		tagged++;
		return { ...r, probe: e.origin, intendedNode: e.intendedNode ?? null };
	});
	// Whatever the poller has not ingested yet, as its own sample.
	const extra = [...byJob.values(), ...byRun.values()].map((e) => ({
		repo: e.repo,
		runId: e.runId,
		jobId: e.jobId ?? null,
		name: e.job,
		node: e.node,
		durationSec: e.durationSec ?? null,
		conclusion: e.conclusion ?? 'unknown',
		failedStep: e.failedStep ?? undefined,
		probe: e.origin,
		intendedNode: e.intendedNode ?? null,
	}));
	return { samples: [...merged, ...extra], tagged, extra: extra.length };
}

/**
 * The read-only report: every node, every repo, the whole retention window.
 *
 * WHY THIS IS A MODE AND NOT A `--report` FLAG. The wave file asked for
 * `--report`. This command's argv is a MODE plus that mode's flags
 * (`parseMode`, `MODE_FLAGS`, `foreignFlags`), and every one of those three
 * exists because an argument silently read as something else has already cost
 * this file twice — `--unit 'x#y'` parsed as a mode, `--onto claw-6` parsed as
 * a mode, and `bootcamp`'s identical parser turning `--machine=claw-7 --write`
 * into every node including the production host. A flag that changes what the
 * command DOES is a mode wearing a flag's clothes; `--report` would have to be
 * accepted by every mode and then refused by four of them. So: `report`.
 *
 * READ-ONLY IS A STRUCTURAL PROPERTY HERE, not a promise. The function touches
 * `loadHistory` and the manifest and nothing else — no `meteredGh`, no `sh`, no
 * `appendLedger`, no `declareProbeIntent`, no `mintEphemeralRunner`. hokon is
 * therefore reached in exactly the way a GUEST may be reached: its rows are
 * READ out of history like every other node's, and nothing is run against it.
 *
 * ZERO IS A FAILURE. An empty window, a `--repo` that matches nothing, a
 * history that will not parse — each exits 1 and says which, because "I could
 * not look" must never render as "nothing is wrong". A roster node with no
 * records is NOT that case: it is a row, with `jobs: 0` and a `why`.
 */
function modeReport(rows) {
	const days = flag('days') === null ? RETENTION_DAYS : Number(flag('days'));
	if (!Number.isFinite(days) || days <= 0) {
		fail(`--days must be a positive number, got ${JSON.stringify(flag('days'))}`);
	}
	const repoFilter = flag('repo');
	const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;

	const inWindow = rows.filter((r) => Date.parse(r.startedAt ?? '') >= cutoffMs);
	if (!inWindow.length) {
		fail(
			`job history holds ${rows.length} record(s) but NONE in the last ${days} day(s) — ` +
				'nothing was scanned, so nothing can be concluded',
			{ days, historyRecords: rows.length }
		);
	}
	const scoped = repoFilter ? inWindow.filter((r) => r.repo === repoFilter) : inWindow;
	if (repoFilter && !scoped.length) {
		fail(
			`no records for ${repoFilter} in the last ${days} day(s) — a table of zero is not a table`,
			{
				days,
				repo: repoFilter,
				// The repos that ARE there, so a typo is one line away from being obvious
				// rather than indistinguishable from a quiet repo.
				detail: [
					`repos in the window: ${[...new Set(inWindow.map((r) => r.repo))].sort().join(', ')}`,
				],
			}
		);
	}

	const samples = scoped.map((r) => ({ ...r, node: nodeOf(r.runner, NODES) }));
	const t = nodeZoneTable({ samples, roster: NODES });
	const since = new Date(cutoffMs).toISOString();
	// The ROLE, from the manifest, never the name. A guest's failures are read
	// from history like anyone's — it is probing, converging and paging that the
	// guest rule forbids — but a reader comparing boxes has to know which row is
	// not a claw: hokon holds STANDING registrations and GitHub assigns to those
	// directly, so it serves a different population of work than any claw.
	const roles = Object.fromEntries(NODES.map((n) => [n, machines[n]?.role ?? 'unknown']));
	const payload = {
		mode: 'report',
		days,
		since,
		repo: repoFilter ?? null,
		historyRecords: rows.length,
		scanned: scoped.length,
		roles,
		...t,
	};

	if (JSON_OUT) {
		emitter.emit({ ok: true, ...payload });
	} else {
		log(
			`Failures by node — ${repoFilter ?? 'all repos'}, ${days} d since ${since}   ` +
				`(${payload.scanned} of ${rows.length} records)`
		);
		log('');
		log('  node      role    jobs  repos  fails   cxl  runner  seam  content  fleet   r+s    r+s%');
		for (const r of t.rows) {
			const z = r.zones;
			log(
				`  ${r.node.padEnd(9)} ${(roles[r.node] ?? '—').padEnd(6)} ` +
					`${String(r.jobs).padStart(5)} ${String(r.repos).padStart(6)} ` +
					`${String(r.failures).padStart(6)} ${String(r.cancelled).padStart(5)} ` +
					`${String(z.runner).padStart(7)} ${String(z.seam).padStart(5)} ` +
					`${String(z.content).padStart(8)} ${String(z.fleet).padStart(6)} ` +
					`${String(r.runnerSeam).padStart(5)}  ${r.runnerSeamPct === null ? '   —' : `${r.runnerSeamPct.toFixed(2)}%`.padStart(6)}` +
					`${r.why ? `   ${r.why}` : ''}${r.inRoster ? '' : '   (not in the roster)'}`
			);
		}
		log('');
		log(
			`  totals: ${t.totals.jobs} jobs, ${t.totals.failures} failures, ${t.totals.cancelled} cancelled, ` +
				ZONE_NAMES.map((z) => `${z}:${t.totals[z]}`).join(' ')
		);
		if (t.nodesWithNoData.length) {
			log(`  NO RECORDS in the window: ${t.nodesWithNoData.join(', ')} — a row, not an absence.`);
		}
		log('');
		log(
			"  r+s is the FLEET-ORIGIN pair: `runner` (GitHub's own synthetic steps, or no\n" +
				'  step record) plus `seam` (steps the workflow named but did not write).\n' +
				"  `fleet` is separate and is NOT in r+s: those are jobs the fleet's own unit\n" +
				'  TTL stopped (#22) — the fleet ending a job, not a box failing to run one.\n' +
				'  `cxl` is cancelled and is deliberately unclassified: most cancellations are\n' +
				'  `cancel-in-progress` supersedes and the step one lands on is arbitrary.\n' +
				'  A ZONE IS A PRIOR, NOT A VERDICT. And read the denominator: the fleet-wide\n' +
				"  r+s rate is around 0.15%, so at one node's volume a single event moves the\n" +
				'  percentage by more than any real difference between boxes.'
		);
	}
	return 0;
}

function modeTable(rows) {
	const key = parseUnit(flag('unit')) ?? pickBusiestUnit(rows);
	if (!key) fail('no unit to table — pass --unit "<owner>/<repo>#<job name>"');
	const fromHistory = samplesFor(rows, key);
	const { samples, tagged, extra } = mergeProbeProvenance(key, fromHistory);
	if (!samples.length) {
		fail(`no records for ${key.repo}#${key.job} — a table of zero samples is not a table`, { key });
	}
	const t = unitTable({ key, samples, roster: CLAWS });
	t.fromHistory = fromHistory.length;
	t.taggedByLedger = tagged;
	t.fromProbeLedgerOnly = extra;
	const verdicts = flakyVerdicts(loadLedger().filter((e) => e.settled));

	if (JSON_OUT) {
		emitter.emit({ ok: true, mode: 'table', ...t, flaky: verdicts });
	} else {
		log(`Per-node table — ${key.repo}  job "${key.job}"   (n=${t.total})`);
		log(
			`  ${t.fromHistory} from job-history (${t.taggedByLedger} of them tagged by the probe ` +
				`ledger), ${t.fromProbeLedgerOnly} the poller has not ingested yet`
		);
		log('');
		log('  node     samples  organic  shadow   rerun  pinned   p50     p95   fails  cxl  zones');
		for (const r of t.rows) {
			const zones = Object.entries(r.zones)
				.map(([z, n]) => `${z}:${n}`)
				.join(' ');
			log(
				`  ${r.node.padEnd(8)} ${String(r.samples).padStart(7)} ${String(r.organic).padStart(8)} ` +
					`${String(r.shadow).padStart(7)} ${String(r.rerun).padStart(7)} ${String(r.pinned).padStart(7)} ` +
					`${(r.p50Sec === null ? '—' : `${r.p50Sec}s`).padStart(6)} ` +
					`${(r.p95Sec === null ? '—' : `${r.p95Sec}s`).padStart(6)} ` +
					`${String(r.failures).padStart(6)} ${String(r.cancelled).padStart(4)}  ${zones}`
			);
		}
		if (verdicts.length) {
			log('');
			for (const v of verdicts) log(`  FLAKY  ${v.node}  ${v.repo}#${v.job}`);
		}
		log('');
		log(
			'  organic / shadow / rerun are counted apart on purpose: a RERUN sample exists\n' +
				'  BECAUSE something already failed, so its failure rate is conditioned on\n' +
				'  failure and is never a rate. PINNED is the subset of manufactured samples\n' +
				'  that landed on the node they were aimed at — the only column that is\n' +
				'  evidence about THAT node. A row with samples=0 is a node that produced\n' +
				'  nothing, not a node that is fine.'
		);
	}
	return 0;
}

function modeCandidates(rows) {
	const key = parseUnit(flag('unit')) ?? pickBusiestUnit(rows);
	if (!key) fail('no unit — pass --unit "<owner>/<repo>#<job name>"');
	const samples = samplesFor(rows, key);
	const { excluded, demandKnown } = exclusionsFor(key);
	const list = buildCandidateList({
		key,
		samples,
		roster: CLAWS,
		excluded,
		flaky: flakyVerdicts(loadLedger().filter((e) => e.settled)),
		routableJobsByNode: routableJobsByNode(rows),
		timeoutSec: Number(flag('timeout-sec')) || undefined,
	});
	if (JSON_OUT) {
		emitter.emit({ ok: true, mode: 'candidates', ...list, demandKnown });
	} else {
		log(
			`Candidates — ${key.repo}#${key.job}   (${list.floorConfidence}, ${list.measuredRuns} measured runs)`
		);
		log(
			'  weakest capable first: the floor is TRIED first, so the fast nodes stay free for bursts'
		);
		log('');
		for (const [i, c] of list.candidates.entries()) {
			const tags = [
				c.flaky && 'FLAKY',
				c.batchLane && 'batch-lane',
				!c.measured && 'unmeasured',
				c.thinSample && `thin-sample (n<${PER_NODE_SAMPLES})`,
			]
				.filter(Boolean)
				.join(' ');
			log(
				`  ${i + 1}. ${c.node.padEnd(8)} p50=${c.p50Sec ?? '—'}  p95=${c.p95Sec ?? '—'}  ` +
					`margin=${c.margin ?? '—'}  n=${c.sampleCount}  ${tags}`
			);
		}
		for (const e of list.excluded)
			log(`  —  ${e.node.padEnd(8)} excluded: ${e.reason}${e.detail ? ` (${e.detail})` : ''}`);
		log('');
		log(
			'  The roster is the EPHEMERAL nodes. hokon is absent because no placement\n' +
				'  decision here can reach it: it holds standing registrations and GitHub\n' +
				'  assigns to those directly, which is the second of the two assignment paths\n' +
				'  in traffic-model-2026-09-02.md. It still appears in the table, where the\n' +
				'  question is what RAN rather than what could be chosen.'
		);
		const thin = list.candidates.filter((c) => c.thinSample);
		if (thin.length) {
			log('');
			log(
				`  THIN SAMPLE (${thin.map((c) => `${c.node} n=${c.sampleCount}`).join(', ')}): fewer than ` +
					`${PER_NODE_SAMPLES} runs of THIS\n` +
					'  unit on THIS node is not a p50, so it is not ranked and never sorts ahead of\n' +
					'  a node that has ten or more. No 95% interval on a median exists below n=6 at\n' +
					'  all — the number is not wrong, it is unsupported. `table` mode still prints\n' +
					'  it; the sample COUNT is reported here, because three runs is a different\n' +
					'  finding from none.'
			);
		}
		if (!demandKnown) {
			log('');
			log(
				'  NOTE: no demand-ledger record for this unit, so capability exclusions could\n' +
					'  not be computed. That is "I could not look", not "nothing is excluded" —\n' +
					'  run `fleet tool-inventory --write` before trusting the exclusions here.'
			);
		}
	}
	return 0;
}

/**
 * §6's shadow path: one probe, one node.
 *
 * ORDERED SO NOTHING IRREVERSIBLE HAPPENS BEFORE EVERY REFUSAL HAS SPOKEN —
 * safety, then window, then budget, then the runner, then the dispatch.
 *
 * THE RUNNER IS MINTED BEFORE THE JOB EXISTS, and the first version of this did
 * it the other way round. Measured on the fleet, 2026-09-08, dispatching first
 * and then minting for the job id:
 *
 *   18:04:11  this harness minted jit-claw-2-…-r34260822017-1788890650
 *   18:04:13  mgmt-api  minted jit-claw-2-…-r34260822017-1788890649
 *
 * TWO registrations, ONE second apart, on ONE node, for ONE job — and both took
 * slot 0, so the second provision ran `RESET=1` over the first's config. That is
 * §12.16 reproduced by the code written to avoid it. `planTick`'s interlock
 * ("a job already being served is never minted for again") could not help: the
 * dispatcher ticks every 15s and mints within ~3s of seeing a queued job, so a
 * harness that waits for the job id to appear has already lost. The job then ran
 * on claw-1 at 18:05:42, which this probe would have had to report as MISSED.
 *
 * Both halves are fixed here:
 *
 *   - A runner ALREADY LISTENING when the job is created gets it from GitHub in
 *     about two seconds, well inside the dispatcher's 15s tick, so usually no
 *     second mint happens at all.
 *   - PROBE_SLOT is high on purpose. `dispatch-pass` takes the LOWEST free slot,
 *     so a probe sitting at 9 is never the slot it picks while any claw's
 *     `maxConcurrent` is 3. Even when the dispatcher does mint a competitor, it
 *     cannot reset this one's config underneath it.
 *
 * It is still a race and it is still not pretended otherwise: `runner_name` is
 * read BACK from GitHub, and a probe that landed elsewhere reports MISSED and is
 * not counted as evidence about the intended node.
 */
async function modeProbe() {
	const repo = flag('repo');
	const workflow = flag('workflow');
	const jobName = flag('job');
	const node = flag('node');
	const ref = flag('ref', 'main');
	if (!repo || !workflow || !jobName || !node) {
		fail('probe needs --repo <owner/name> --workflow <file.yml> --job <job name> --node <claw-N>');
	}
	if (!CLAWS.includes(node)) fail(notAProbeTarget(node));

	// 1. SAFETY. Read the workflow as SHIPPED, at the default branch — the
	//    bytes a dispatch at that ref will run, never a sibling checkout that may
	//    be behind, dirty or CRLF (fleet-manager#7). A `--ref` this cannot read
	//    is a refusal: the safety verdict would be about some other file.
	if (ref !== 'main') fail(`refusing to dispatch a workflow I cannot inspect at ${ref}`);
	const source = tryShipped(repo);
	if ('unreadable' in source) {
		fail(
			`cannot read ${repo}'s shipped workflows (${source.unreadable}) — refusing to dispatch a workflow I cannot inspect`
		);
	}
	const wfText = source.read(`.github/workflows/${workflow}`);
	if (wfText === null) {
		fail(
			`${repo} ships no .github/workflows/${workflow} — refusing to dispatch a workflow I cannot inspect`
		);
	}
	const safety = shadowSafety(stripYamlComments(wfText));
	if (!safety.ok) fail(`${repo}/${workflow} is not safe to shadow-dispatch: ${safety.reason}`);

	// 2. WINDOW.
	const window = checkQuietWindow();
	if (!window.quiet && !argv.includes('--ignore-window')) {
		fail(`not a quiet window (${window.why}): ${window.detail}`, { window });
	}

	// 3. BUDGET + blackout.
	const budget = new CallBudget(SHADOW_CALL_BUDGET);
	const token = githubToken();
	if (!token) fail('no GitHub token (HADOKU_SITE_TOKEN / GITHUB_TOKEN / `gh auth token`)');
	const gh = meteredGh(budget, token);

	if (!CONFIRM) {
		const plan = {
			repo,
			workflow,
			job: jobName,
			node,
			ref,
			slot: PROBE_SLOT,
			callsBudgeted: callsPerProbe(),
			budget: SHADOW_CALL_BUDGET,
			maxProbesPerRun: maxProbesPerRun(),
			window,
			safety,
		};
		if (JSON_OUT) emitter.emit({ ok: true, mode: 'probe', planned: true, ...plan });
		else {
			log(`PLAN — shadow probe ${repo}/${workflow} job "${jobName}" onto ${node} @ ${ref}`);
			log(`  quiet window: ${window.quiet ? 'yes' : `NO (${window.why}: ${window.detail})`}`);
			log(
				`  budget: ${callsPerProbe()} of ${SHADOW_CALL_BUDGET} calls; ` +
					`${maxProbesPerRun()} probes fit per run`
			);
			log(`  slot ${PROBE_SLOT}, reserved so the dispatcher's lowest-free walk cannot collide`);
			log(
				`  intent: declares ${repo}#${jobName} in ${PROBE_INTENT_DIR}/ for ` +
					`${PROBE_TTL_SECONDS}s, so the dispatcher mints no competitor for it ` +
					`(honoured only by a deployed mgmt-api carrying this version)`
			);
			log('  safe to dispatch: yes');
			log('');
			log('  Nothing was written. Re-run with --confirm to actually dispatch.');
		}
		return 0;
	}

	// 4. MINT FIRST. The ids are not known yet, so the name carries zeros where
	//    the run and job would be: `parseJitName` reads those back as run 0 /
	//    job 0, which no real job collides with, and the trailing epoch — the part
	//    the reaper actually ages on — is real.
	if (!(await probeSlotIsFree(node))) {
		fail(
			`slot ${PROBE_SLOT} on ${node} is already in use — another probe is running there, and ` +
				`provisioning runs RESET=1, so minting anyway would rewrite its config`
		);
	}
	const runnerName = jitRunnerName(node, repo, Date.now(), 0, 0);
	// BEFORE THE MINT — see `declareProbeIntent`. This is what stops mgmt-api
	// minting a second runner for the same job on its next 15s tick.
	const releaseIntent = declareProbeIntent({ repo, job: jobName, node, runnerName });
	const mint = await mintEphemeralRunner(
		{
			node,
			repo,
			runnerName,
			// DERIVED, not the declared array (issue #19, lane K's carve-out in this
			// file). A declaration-read mint becomes unschedulable the moment the
			// eight `hadoku-builder` declarations go, and the `?? ['hadoku-builder']`
			// fallback hid that by guessing the label for a node with none.
			labels: mintLabelsFor(node),
			slotIndex: PROBE_SLOT,
			homeDir: nodeHome(machines[node], 'ci'),
			tarballUrl: null,
			memoryMaxMb: machines[node]?.slice?.unitMaxMb ?? 4096,
			ttlSeconds: PROBE_TTL_SECONDS,
		},
		token,
		{ write: (m, p, t, b, r) => gh.write(m, p, t, b, r) },
		sh
	);
	if (!mint.ok) {
		releaseIntent();
		fail(`could not mint on ${node}: ${mint.reason}`, { node, spent: gh.spent() });
	}

	/**
	 * Remove our runner. Every exit path that does not CONSUME it comes here.
	 *
	 * A registration with nothing listening is §12.8's black hole — GitHub will
	 * schedule onto it and the job hangs. The reaper would eventually take it,
	 * but "eventually" is a 10-minute grace, and a probe that leaves a hole open
	 * for ten minutes has cost a consumer more than it measured.
	 */
	const cleanUp = async () => {
		// THE INTENT GOES FIRST. Once our runner is being torn down the declaration is
		// a licence to not mint for a job nothing is listening for, and under all-JIT
		// the dispatcher is the only thing that would.
		releaseIntent();
		const list = await gh.get('/actions/runners?per_page=100', repo);
		const r = (list.body?.runners ?? []).find((x) => x.name === runnerName);
		if (r) await gh.write('DELETE', `/actions/runners/${r.id}`, token, undefined, repo);
		await sh(
			node,
			`XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user stop ${runnerName} 2>/dev/null || true`
		);
	};

	const started = Date.now();
	// 5. DISPATCH.
	const disp = await gh.write(
		'POST',
		`/actions/workflows/${workflow}/dispatches`,
		token,
		{ ref },
		repo
	);
	if (!disp.ok) {
		await cleanUp();
		fail(`workflow_dispatch failed: ${disp.why}`, { spent: gh.spent() });
	}

	// 6. FIND THE RUN. The POST answers 204 with no body, so the id has to be
	//    looked up. Bounded by PROBE_CALLS.runLookupPolls, and metered.
	let runId = null;
	for (let i = 0; i < PROBE_CALLS.runLookupPolls && runId === null; i++) {
		await sleep(4000);
		const r = await gh.get('/actions/runs?event=workflow_dispatch&per_page=10', repo);
		if (!r.ok) continue;
		const hit = (r.body?.workflow_runs ?? []).find(
			(w) => Date.parse(w.created_at ?? '') >= started - 60_000 && (w.path ?? '').endsWith(workflow)
		);
		if (hit) runId = hit.id;
	}
	if (runId === null) {
		await cleanUp();
		fail('dispatched, but the run never appeared in the listing — could not look further', {
			spent: gh.spent(),
		});
	}

	// 7. DECLARE IT BEFORE IT FINISHES. mgmt-api's poller has to see the ledger
	//    entry by the time it ingests this run, or the sample lands untagged and
	//    the ranking cannot tell a probe from organic traffic.
	appendLedger({ runId, repo, origin: 'shadow', job: jobName, intendedNode: node, runnerName });

	// 8. WATCH. Bounded by PROBE_CALLS.jobPolls.
	let observed = null;
	let conclusion = null;
	let durationSec = null;
	let failedStep = null;
	let jobId = null;
	let servedBy = null;
	for (let i = 0; i < PROBE_CALLS.jobPolls; i++) {
		const r = await gh.get(`/actions/runs/${runId}/jobs`, repo);
		if (r.ok) {
			const j = (r.body?.jobs ?? []).find((x) => x.name === jobName);
			if (j) {
				jobId = j.id ?? jobId;
				if (j.runner_name) {
					servedBy = j.runner_name;
					observed = nodeOf(j.runner_name, NODES);
				}
				if (j.status === 'completed') {
					conclusion = j.conclusion;
					failedStep = (j.steps ?? []).find((s) => s.conclusion === 'failure')?.name ?? null;
					const s = Date.parse(j.started_at ?? '');
					const e = Date.parse(j.completed_at ?? '');
					if (Number.isFinite(s) && Number.isFinite(e)) durationSec = Math.round((e - s) / 1000);
					break;
				}
			}
		}
		await sleep(20_000);
	}
	// CLEAN UP UNLESS OUR RUNNER WAS CONSUMED.
	//
	// `conclusion === null` is not the only case that leaks. A probe that MISSED
	// still completes — the job simply ran somewhere else — and our runner is then
	// sitting there LISTENING, with a 900s TTL, free to pick up an unrelated job
	// in the same repo. Observed at 18:29 on 2026-09-08:
	// `jit-claw-2-hadoku-pygmalion-j0-r0-1788891783` still online and idle six
	// minutes after its probe had reported success on another node.
	//
	// The test is the runner NAME, not the node: the dispatcher's competitor mint
	// can land on the same node, which still makes the probe FORCED (the evidence
	// is about the node) while leaving ours unconsumed.
	if (servedBy !== runnerName) await cleanUp();
	// CONSUMED OR NOT, the job is no longer waiting for a runner, so the
	// declaration has done its job and must stop suppressing mints for this unit.
	releaseIntent();

	// 9. SETTLE. Intended AND observed, always — a probe that silently retargets
	//    itself is worse than one that admits it did.
	const forced = observed === node;
	const outcome = {
		runId,
		jobId,
		repo,
		origin: 'shadow',
		job: jobName,
		intendedNode: node,
		node: observed,
		forced,
		conclusion: conclusion ?? 'unknown',
		durationSec,
		failedStep,
		zone: conclusion && conclusion !== 'success' ? classifyZone({ failedStep }) : null,
		runnerName,
		slot: PROBE_SLOT,
		settled: true,
		spent: gh.spent(),
	};
	appendLedger(outcome);

	if (JSON_OUT) emitter.emit({ ok: conclusion !== null, mode: 'probe', ...outcome });
	else {
		log(`PROBE ${repo}#${jobName} run ${runId}`);
		log(
			`  intended ${node}   observed ${observed ?? '(never reported a runner)'}   ` +
				`${forced ? 'FORCED' : 'MISSED'}`
		);
		log(`  conclusion=${outcome.conclusion}  duration=${durationSec ?? '—'}s`);
		log(`  calls spent: ${gh.spent()} of ${SHADOW_CALL_BUDGET}`);
		if (!forced) {
			log('');
			log(
				'  MISSED is not a failure of the job — GitHub handed it to a runner other\n' +
					'  than the one minted for it, so this sample is NOT evidence about the\n' +
					'  intended node and must not be counted as forced.'
			);
		}
	}
	// A probe that never reached a conclusion is "I could not look", and that is a
	// non-zero exit — the dispatch happened and nothing was learned.
	return conclusion === null ? 1 : 0;
}

/**
 * §5/§6's forced re-run — Control A.
 *
 * Rides the EXISTING budget rather than the 200-call shadow cap: it is a POST
 * plus the listings the failover check already makes, and it fires only on a
 * genuine failure (17 in 1,030 jobs). Metering it would mean declining to
 * investigate a real fleet failure because a synthetic sweep had spent the
 * allowance first.
 *
 * `--onto <node>` IS REQUIRED, AND IT IS THE WHOLE CONTROL. §5.1 does not say
 * "re-run it and see" — it says "re-dispatch the SAME job with the failing node
 * EXCLUDED". A bare `rerun-failed-jobs` cannot do that: GitHub and the
 * dispatcher pick the node, and on 2026-09-08 attempt 2 of the fleet's only
 * retried run went straight back to the same claw. So the exclusion is
 * manufactured the same way the shadow path manufactures placement — a runner
 * is already listening on the chosen node when the re-dispatch lands — and the
 * chosen node is refused if it is the one that failed.
 *
 * `against` on the settled ledger entry is what makes this a POINT under §5.2:
 * a pass on a DIFFERENT node is one piece of evidence against the original.
 * `flakyVerdicts` reads that field and nothing else, so a re-run without an
 * exclusion could never have produced evidence at all.
 */
async function modeRerun(rows) {
	const repo = flag('repo');
	const runId = Number(flag('run'));
	const onto = flag('onto');
	if (!repo || !Number.isFinite(runId)) fail('rerun needs --repo <owner/name> --run <runId>');

	const failed = rows.filter(
		(r) => r.repo === repo && r.runId === runId && r.conclusion !== 'success'
	);
	if (!failed.length) {
		fail(`no failed job recorded for ${repo} run ${runId} — nothing here says the fleet failed`);
	}
	const judged = failed.map((r) => ({ record: r, verdict: warrantsForcedRerun(r) }));
	const worth = judged.filter((j) => j.verdict.ok).map((j) => j.record);
	if (!worth.length) {
		// SAY WHY, per failure. "No probe was spent" and "no probe was warranted"
		// look identical from the outside, and a refusal with no reason is the
		// undiagnosable finding CLAUDE.md names.
		const why = judged.map((j) => `${j.record.name}: ${j.verdict.zone} — ${j.verdict.reason}`);
		fail(`nothing on run ${runId} warrants a forced re-run`, { runId, detail: why });
	}

	const failedOn = [...new Set(worth.map((r) => nodeOf(r.runner, NODES)))];
	const jobName = worth[0].name;
	if (!onto) {
		fail(
			'rerun needs --onto <claw-N>: §5.1 requires the FAILING node excluded, and a bare ' +
				'rerun-failed-jobs cannot exclude anything — attempt 2 of the fleet’s only ' +
				'retried run went straight back to the same claw',
			{ failedOn, candidates: CLAWS.filter((c) => !failedOn.includes(c)) }
		);
	}
	if (!CLAWS.includes(onto)) fail(notAProbeTarget(onto));
	if (failedOn.includes(onto)) {
		fail(`${onto} is where it already failed — that is the node the control EXCLUDES`, {
			failedOn,
		});
	}

	const token = githubToken();
	if (!token) fail('no GitHub token');
	if (!CONFIRM) {
		const plan = {
			repo,
			runId,
			onto,
			failedOn,
			jobs: worth.map((r) => ({
				job: r.name,
				node: nodeOf(r.runner, NODES),
				zone: classifyZone(r),
				failedStep: r.failedStep ?? null,
			})),
		};
		if (JSON_OUT) emitter.emit({ ok: true, mode: 'rerun', planned: true, ...plan });
		else {
			log(`PLAN — forced re-run of ${repo} run ${runId}, onto ${onto}`);
			for (const r of worth) {
				log(
					`  ${r.name}: failed on ${nodeOf(r.runner, NODES)} in the ${classifyZone(r)} zone ` +
						`(${r.failedStep ?? 'no step record'})`
				);
			}
			log('');
			log('  Nothing was written. Re-run with --confirm to actually re-dispatch.');
		}
		return 0;
	}

	// A RUNNER ON `onto`, LISTENING, BEFORE THE RE-DISPATCH LANDS. This is the
	// exclusion: GitHub hands a queued job to an idle matching runner in about two
	// seconds, so the re-run goes where we put it rather than back to the node
	// that failed. Same reasoning, same slot and same verification as the shadow
	// path — see `modeProbe`.
	if (!(await probeSlotIsFree(onto))) {
		fail(
			`slot ${PROBE_SLOT} on ${onto} is already in use — another probe is running there, and ` +
				`provisioning runs RESET=1, so minting anyway would rewrite its config`
		);
	}
	const runnerName = jitRunnerName(onto, repo, Date.now(), 0, 0);
	// SAME DECLARATION AS THE SHADOW PATH, and for the same reason:
	// `rerun-failed-jobs` re-queues the job, the dispatcher sees it queued and mints
	// a competitor that can take the attempt this control exists to place.
	const releaseIntent = declareProbeIntent({ repo, job: jobName, node: onto, runnerName });
	// RERUN_CALL_CEILING, not the shadow cap — see that constant. What this meter
	// buys here is the blackout check and a bound against a spinning watch loop,
	// not an allowance that could refuse to investigate a real failure.
	const gh = meteredGh(new CallBudget(RERUN_CALL_CEILING), token);
	const mint = await mintEphemeralRunner(
		{
			node: onto,
			repo,
			runnerName,
			labels: mintLabelsFor(onto),
			slotIndex: PROBE_SLOT,
			homeDir: nodeHome(machines[onto], 'ci'),
			tarballUrl: null,
			memoryMaxMb: machines[onto]?.slice?.unitMaxMb ?? 4096,
			ttlSeconds: PROBE_TTL_SECONDS,
		},
		token,
		{ write: (m, p, t, b, r) => gh.write(m, p, t, b, r) },
		sh
	);
	if (!mint.ok) {
		releaseIntent();
		fail(`could not mint on ${onto}: ${mint.reason}`);
	}

	const cleanUp = async () => {
		releaseIntent();
		const list = await gh.get('/actions/runners?per_page=100', repo);
		const r = (list.body?.runners ?? []).find((x) => x.name === runnerName);
		if (r) await gh.write('DELETE', `/actions/runners/${r.id}`, token, undefined, repo);
		await sh(
			onto,
			`XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user stop ${runnerName} 2>/dev/null || true`
		);
	};

	// DECLARED BEFORE THE POST. `ingestRuns` lifts its `seenRuns` skip for a run
	// the ledger names as `forced-rerun` and for nothing else — a declaration
	// that arrived after the poller's next tick would be a re-run whose second
	// attempt is never fetched, which is the exact gap this whole mechanism
	// exists to close.
	appendLedger({ runId, repo, origin: 'forced-rerun', job: jobName, intendedNode: onto, failedOn });

	const res = await ghWrite(
		'POST',
		`/actions/runs/${runId}/rerun-failed-jobs`,
		token,
		undefined,
		repo
	);
	if (!res.ok) {
		await cleanUp();
		fail(`rerun-failed-jobs returned ${res.status}`, { runId });
	}

	// WATCH THE NEW ATTEMPT. `rerun-failed-jobs` keeps the run id and increments
	// the attempt, so the same jobs listing answers — with the new attempt's jobs,
	// which is exactly why `ingestRuns` had to lift its skip for this run id.
	let observed = null;
	let conclusion = null;
	let durationSec = null;
	let failedStep = null;
	let jobId = null;
	let servedBy = null;
	for (let i = 0; i < PROBE_CALLS.jobPolls; i++) {
		const r = await gh.get(`/actions/runs/${runId}/jobs`, repo);
		if (r.ok) {
			const j = (r.body?.jobs ?? []).find((x) => x.name === jobName);
			if (j) {
				jobId = j.id ?? jobId;
				if (j.runner_name) {
					servedBy = j.runner_name;
					observed = nodeOf(j.runner_name, NODES);
				}
				if (j.status === 'completed') {
					conclusion = j.conclusion;
					failedStep = (j.steps ?? []).find((s) => s.conclusion === 'failure')?.name ?? null;
					const s = Date.parse(j.started_at ?? '');
					const e = Date.parse(j.completed_at ?? '');
					if (Number.isFinite(s) && Number.isFinite(e)) durationSec = Math.round((e - s) / 1000);
					break;
				}
			}
		}
		await sleep(20_000);
	}
	// Same rule as the shadow path: clean up unless OUR runner was consumed. See
	// the note there — a re-run that landed back on the failing node completes
	// normally and leaves this one listening.
	if (servedBy !== runnerName) await cleanUp();
	releaseIntent();

	const forced = observed === onto;
	const out = {
		runId,
		jobId,
		repo,
		origin: 'forced-rerun',
		job: jobName,
		intendedNode: onto,
		node: observed,
		forced,
		conclusion: conclusion ?? 'unknown',
		durationSec,
		failedStep,
		// §5.2's POINT, and it is recorded ONLY when the re-dispatch actually
		// passed somewhere else. A re-run that landed back on the failing node, or
		// that failed again, is not evidence against anything — it is one more
		// observation, and `flakyVerdicts` treats it as such.
		against: forced && conclusion === 'success' ? failedOn[0] : undefined,
		failedOn,
		runnerName,
		settled: true,
	};
	appendLedger(out);

	if (JSON_OUT) emitter.emit({ ok: conclusion !== null, mode: 'rerun', ...out });
	else {
		log(`RERUN ${repo}#${jobName} run ${runId}`);
		log(`  failed on ${failedOn.join(', ')}   re-dispatched onto ${onto}`);
		log(
			`  observed ${observed ?? '(never reported a runner)'}   ${forced ? 'EXCLUDED' : 'NOT EXCLUDED'}   ` +
				`conclusion=${out.conclusion}`
		);
		if (out.against) {
			log(`  → one point of evidence against ${out.against} for ${repo}#${jobName}`);
			log('    §5.3: two such points with no intervening pass is the flaky verdict. One is not.');
		} else {
			log('  → NOT a point. §5.2 needs a pass on a DIFFERENT node than the one that failed.');
		}
	}
	return conclusion === null ? 1 : 0;
}

// ---------------------------------------------------------------------------

// THE MODE IS THE FIRST ARGUMENT — see `parseMode`, which carries the two
// measured ways the previous `argv.find(...)` misread this command's own argv.
const mode = parseMode(argv);
// A FLAG THAT BELONGS TO ANOTHER MODE IS A REFUSAL, not a default. See
// `foreignFlags`: without this, `--onto claw-6 --repo … --run …` with no mode
// prints a table of an unrelated unit and exits 0.
{
	const foreign = foreignFlags(mode, argv);
	if (foreign.length) {
		fail(`mode "${mode}" does not take ${foreign.map((f) => f.flag).join(', ')}`, {
			mode,
			foreign,
			detail: foreign.map(
				(f) =>
					`${f.flag} belongs to ${f.owners.length ? f.owners.join(' / ') : 'no mode'} — ` +
					`did you mean \`fleet floor-probe ${f.owners[0] ?? '<mode>'} ${f.flag} …\`?`
			),
		});
	}
}
// HISTORY IS LOADED ONLY BY THE MODES THAT READ IT. `loadHistory` fails loudly
// on a missing file, which is right for a table and wrong for `window`: a box
// that has never recorded a job can still answer "may I probe now", and failing
// there would report a scheduling question as a missing-data error.
const needsHistory =
	mode === 'table' || mode === 'candidates' || mode === 'rerun' || mode === 'report';
const { rows } = needsHistory ? loadHistory() : { rows: [] };

let code = 0;
if (mode === 'report') code = modeReport(rows);
else if (mode === 'table') code = modeTable(rows);
else if (mode === 'candidates') code = modeCandidates(rows);
else if (mode === 'window') {
	// A PREDICATE, so the exit code is the answer: 0 for "yes, probe now", 1 for
	// "no", which makes `if fleet floor-probe window; then …` mean what it reads
	// like. "Not quiet" is not a fault, and the JSON says which of the three
	// reasons it is — `reserved`, `cron` or `could-not-tell`, and the third is the
	// one an operator has to act on.
	const w = checkQuietWindow();
	if (JSON_OUT) emitter.emit({ ok: w.quiet, mode: 'window', ...w });
	else {
		log(`quiet window: ${w.quiet ? 'YES' : `NO — ${w.why}: ${w.detail}`}`);
		log(`  daily cron schedules read: ${w.schedulesSeen}`);
		log(`  reservation: ${w.reservationSource}`);
		for (const u of w.unreadable) log(`  could not read: ${u}`);
	}
	code = w.quiet ? 0 : 1;
} else if (mode === 'probe') code = await modeProbe();
else if (mode === 'rerun') code = await modeRerun(loadHistory().rows);
else fail(`unknown mode "${mode}" — one of: report, table, candidates, window, probe, rerun`);

process.exit(code);
