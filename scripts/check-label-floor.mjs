#!/usr/bin/env node
/**
 * check-label-floor — every capability a workflow asks for must be one the
 * fleet alerts about losing.
 *
 * WHY
 * ---
 * `runner-health`'s floor used to watch a fixed list. It carried
 * `hadoku-builder` and `pm2-host`, while workflows across the fleet also request
 * `taskauto` (2 jobs) and `av1-nvenc` (1 job). A label outside that list has NO
 * floor alert, so the last runner offering it can go dark and the only symptom
 * is jobs queueing forever.
 *
 * Since 2026-10-10 the floor watches DEMAND and judges every label by one rule
 * — a standing online runner, or an eligible minting node that offers it
 * (`src/label-floor.ts`). This gate computes that demand and PERSISTS its
 * static half for runner-health to read, so "covered by the floor" is now a
 * question about whether the runtime will SEE a label, not about a list.
 *
 * That is not hypothetical. On 2026-08-26 `github-runner-tenhands.service` — the
 * ONLY runner offering `taskauto` — died with its registration deleted, and
 * `hadoku-tenhands / Task automation` queued for 6h45m. The label floor could
 * not have fired: `taskauto` was not in it. The alert that eventually surfaced
 * the outage was a queue-depth alarm, after the fact.
 *
 * WHAT IT CHECKS
 * --------------
 * The routing dependencies are what covered repos' workflows REQUEST, per job,
 * unioned with what jobs in job history ACTUALLY requested (see "THE DEMAND,
 * FROM TWO SOURCES" below). `self-hosted` is excluded: it is implicit on every
 * self-hosted runner and is not a capability anyone can lose. Hosted images
 * (`ubuntu-*`, `macos-*`, `windows-*`) are excluded: no node earns them.
 *
 * IT USED TO BE `requested ∩ declared`, AND THAT WAS THE BUG. Intersecting with
 * the manifest's `labels` arrays made the gate's SCOPE depend on a declaration,
 * so removing a declaration removed the label from the gate instead of failing
 * it. Under the 2026-09-09 decision that capabilities are DERIVED from workload
 * data and never declared, emptying those arrays would have quietly deleted
 * `hadoku-builder` — the fleet's primary routing label — from its own floor
 * check, and the gate would have gone green having checked less. A gate's scope
 * must come from DEMAND, which nobody can edit away by tidying a manifest.
 *
 * What a declaration still answers is WHO OFFERS a label, and even that is now
 * one of three sources — see `offerersOf`.
 *
 * Reads each repo's SHIPPED workflows through `lib/fleet-source.mjs`, and says so
 * when one is unreadable rather than passing quietly — a repo whose workflows
 * were not read is a repo whose labels were not read, and "I could not look"
 * must never read as "there was nothing to find".
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { manifest as manifestFile, stateDir } from './lib/paths.mjs';
import { tryShipped } from './lib/fleet-source.mjs';
import { writeFileAtomic } from '../dist/lib/atomic-json.js';
import { hubRepoFull } from '../dist/lib/fleet-config.js';
import { FLOOR_DEMAND_FILE, floorLabels, isFloorDemandLabel } from '../dist/label-floor.js';
import { FLEET_VALUE } from '../dist/ci-runner-fallback.js';
import { BUILDER_LABEL } from '../dist/runners/census.js';
import { RETENTION_DAYS } from '../dist/job-history-store.js';
import { isProofRunnerName } from '../dist/runners/prove-job.js';
import { requiredIdentitySet, provesRequiredSet } from '../dist/lib/bootcamp-proof.js';
import { probeableIds } from '../dist/lib/capability-labels.js';
import { nodeOffer } from '../dist/lib/capability-offer.js';
import {
	ciRecords,
	emptyRequiredSetReason,
	loadDemandLedger,
	unprovenRequired,
} from './lib/bootcamp-required.mjs';
import { createEmitter } from './lib/emit.mjs';
import { mintsJitRunners } from '../dist/lib/node-role.js';
import { observedDemand, workflowDemand } from './lib/runs-on-demand.mjs';
import { offerersOf, causeFor, drainedNodeNames } from './lib/label-floor-check.mjs';
import {
	buildJsonDoc,
	computeDerivationFailures,
	checkUnread,
	checkEmptyRoster,
	checkNoWorkflows,
	checkUnresolvable,
	checkObservedError,
	reportHistorical,
	checkUnoffered,
	checkMissing,
	checkResidentFailures,
	checkLedgerError,
	checkLedgerMissing,
	checkEmptyRequired,
	checkRequiredGaps,
	checkDerivationFailures,
	reportSuccess,
} from './lib/label-floor-gate.mjs';
// The resident-floor's one `gh api` read, retried before it is called
// could-not-look (#80) — moved to the shared module (plan §4.1 F2b), which
// also carries `reconcile-fleet-runners.mjs`'s own copy of the same retry.
// `READ_ATTEMPTS`/`describeReadFailure` stay imported HERE (domain layer) and
// are passed INTO the access-layer helper at the call site below, rather
// than it importing them — see `gh-runners.mjs`'s own doc for why (an access
// module importing a domain one is an upward layer violation
// `layer-guard.test.mjs` refuses).
import { READ_ATTEMPTS, describeReadFailure } from './lib/queue-health.mjs';
import { listRunners } from './lib/gh-runners.mjs';

/**
 * `--json` for a reader that wants the transition log as data (wave2 §D.4).
 *
 * MIGRATED (wave 5i lane B): `ci:audit-gates` now runs this one with `--json`
 * and judges it by the `GateDoc` below rather than a regex over
 * stdout+stderr — see `src/lib/job-registry.ts`'s `coversSubs` entry
 * (`contract: 'json'`) and `scripts/lib/json-contract.mjs`'s derivation of
 * `JSON_CONTRACT` from it. The diagnostics stay on STDERR in both modes —
 * stderr is not part of any stdout contract.
 */
const emitter = createEmitter();
const JSON_OUT = emitter.json;
const log = emitter.log;

/**
 * GateDoc halves (wave 5i lane B), built ALONGSIDE every exit branch's
 * existing prose/`extra` fields rather than reconstructed from them later.
 * `unreadable` is "I could not look" — an unread repo's shipped workflows, a
 * repo with no workflows directory at all (this gate's own doc on
 * `noWorkflows` below: "the same 'could not look' as an unreadable repo"), an
 * unreadable demand ledger or observed-demand window, a resident repo's `gh`
 * read that exhausted `READ_ATTEMPTS` — never folded into `findings`. Every
 * other branch is a conclusion this gate actually reached from data it DID
 * read: an empty roster (a failed generation, same shape as tier-fleet's
 * "nothing scanned"), an unresolvable `runs-on` (this file's own comment:
 * "It is a finding, not 'this job asks for nothing'"), a label nothing
 * offers or the floor will not watch, a drained or understaffed resident
 * holder, an empty required set, a demanded capability no node proves, or a
 * manifest/derivation disagreement.
 */
const gateFindings = [];
const gateUnreadable = [];

const MANIFEST = manifestFile('fleet-runner-manifest.json');
const COVERAGE = manifestFile('fleet-runner-coverage.json');

/**
 * Not implicit (`self-hosted`/`Linux`/`X64`, case-insensitive) and not a hosted
 * image. IMPORTED from the module runner-health judges with, so the gate and
 * the runtime floor cannot disagree about what counts as demand.
 */
const isDemandLabel = isFloorDemandLabel;

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));

/**
 * Which nodes hold `hadoku-builder` and WHY (which capabilities proved) —
 * mirrors `nodeFailsBootcamp` in src/fleet-loop.ts exactly: a node with NO
 * recorded finding fails OPEN (unverified, not disqualified — bootcamp has
 * never run against it, which is not the same as having failed), and one
 * with a finding is disqualified only if it names something `blocked` or
 * `unprobed`.
 */
const eligibleNodes = [];
const unverifiedNodes = [];
const disqualifiedNodes = [];
for (const [name, m] of Object.entries(manifest.machines ?? {})) {
	const rec = m.$capabilities;
	if (!rec) {
		unverifiedNodes.push(name);
		continue;
	}
	const blocked = rec.blocked ?? [];
	const unprobed = rec.unprobed ?? [];
	if (blocked.length || unprobed.length) {
		disqualifiedNodes.push({ name, blocked: blocked.map((b) => b.id), unprobed });
	} else {
		eligibleNodes.push({ name, prereqs: (rec.prereqs ?? []).map((p) => p.id) });
	}
}

/**
 * WHO OFFERS A LABEL, once labels are DERIVED rather than DECLARED.
 *
 * `hadoku-builder` is the CONSUMER contract — "any CI-capable claw" — and since
 * 2026-09-09 its WRITER is bootcamp, not this manifest. Seven machines carried a
 * literal `labels: ["hadoku-builder"]` and every one of them was a human typing
 * a fact the probe had already established; the array is being emptied of it.
 *
 * So a declaration is one source of "offers", and it is no longer the only one.
 * A node OFFERS a label if it declares it, if its bootcamp finding EARNED it,
 * or — for the builder label specifically — if its bootcamp finding qualifies
 * it at all, which is exactly the `eligibleNodes` set printed at the bottom of
 * this gate. `unverifiedNodes` deliberately do NOT offer: bootcamp has never
 * run against them, and "no evidence" is not evidence.
 *
 * This is what keeps `servedByMintOnly` HONEST. It reports a routing label
 * every offerer of which mints, and computed off `labels` alone it would have
 * silently lost `hadoku-builder` the moment the declarations were removed — a
 * report emptied by the very cleanup that was supposed to make it honest,
 * which is the shape this repo keeps paying for.
 */
const eligibleNames = new Set(eligibleNodes.map((n) => n.name));

/**
 * Every label every machine offers, node -> sorted labels. The input to the
 * transition log below and to `offerersOf`, which is this answer transposed.
 *
 * `nodeOffer` IS THE ANSWER, not a second derivation beside it (issue #19).
 * This used to be `labels ∪ earned ∪ {builder if eligible}`, which was three
 * sources unioned by hand — and under the 2026-09-10 `earned` semantics
 * (everything the probe executed) that union would have reported `ffmpeg`,
 * `gh`, `python-venv`, `python-toolcache`, `playwright` and `jitconfig` as
 * LABELS every node newly gained, burying the one transition an operator is
 * looking for under ten per node that are not labels at all. `nodeOffer` keeps
 * only label-surface identity capabilities, and it is the same function the
 * mint, the warm listener and the reconciler project.
 */
const holdings = Object.fromEntries(
	Object.entries(manifest.machines ?? {}).map(([name, m]) => [
		name,
		nodeOffer(m, { eligible: eligibleNames.has(name) }).sort(),
	])
);

/**
 * THE DERIVATION AND THE MINT MUST AGREE — issue #19, as a gate.
 *
 * This is the half the issue calls "arguably the more urgent". With
 * `hadoku-builder` stripped from all nine machine entries, `fleet label-floor`
 * exited 0 and printed "label floor covers every routing dependency" on a
 * manifest where nothing declared the fleet's primary routing label — because
 * `holdings` and `offerersOf` re-added it for every eligible node. Demand
 * derivation made the declarations inert TO THE GATE and left them load-bearing
 * to the FLEET, and removed the only signal that would have caught it. That is
 * CLAUDE.md's rule inverted: a gate that gets easier to pass the worse the
 * failure gets.
 *
 * So three questions, each of which FAILS the gate and names the node:
 *
 *  1. CAN THE DERIVATION LOOK AT ALL? No `$capabilities`, or a facet with no
 *     `earned` array, means `nodeOffer` falls back to the declaration — the only
 *     safe direction, since the alternative strips `av1-nvenc` off hokon on an
 *     unreadable record. Safe is not silent: "I could not look" must never
 *     render as "nothing is wrong".
 *  2. HAS THE PRODUCER RUN? `earned` is the proof set as of 2026-09-10; a node
 *     whose `earned` does not contain every `prereqs` id is carrying a record
 *     written under the OLD semantics (`proven ∩ declared` among probeable label
 *     capabilities, which for this fleet meant `[]` on every claw). The
 *     derivation still works — `provenCapabilities` reads the union as a bridge —
 *     but the field the claw floor ranks on is empty, and nothing else would say
 *     so. Clears itself on the next `fleet bootcamp --write`.
 *  3. DOES THE DERIVED OFFER MATCH WHAT A MINT WOULD PROJECT FROM THE MANIFEST?
 *     A label the manifest declares and the derivation does NOT project is the
 *     dangerous direction: `mintLabels()` would put it on a runner that has not
 *     proven it, or — read the other way — the derivation is about to stop
 *     projecting a label the fleet still routes on. The reverse direction is
 *     reported too, EXCEPT for the labels a declaration was never supposed to
 *     carry — see `declarationIsRight` and `derivedByEarning`.
 */
const derivationFailures = computeDerivationFailures(manifest, holdings);

/**
 * EVERY LABEL TRANSITION SINCE THIS GATE LAST RAN — node, label, gained or
 * lost, and the bootcamp finding that caused it.
 *
 * WHY THIS AND NOT AN ENFORCEMENT. The operator's 2026-09-09 decision is that
 * bootcamp demotion is OBSERVED, not forced: the first time a node naturally
 * loses `hadoku-builder` because a probe stopped passing, that has to be
 * REVIEWABLE after the fact rather than silently correct. A derived label with
 * no audit trail is a fleet that reconfigures itself and tells nobody, and the
 * thing an operator needs at 3am is not "why is claw-5 not taking work" but
 * "claw-5 lost hadoku-builder on the 07:00 run because playwright stopped
 * launching". So this NEVER fails the gate. It reports.
 *
 * WHERE THE STATE LIVES. `stateDir()`, beside every other piece of gate state
 * this repo keeps between runs — the precedent is `check-tool-inventory.mjs`'s
 * `tool-inventory-capabilities.json`, which is the same snapshot/diff/persist
 * shape for capability retirement, and `job-history.jsonl` and
 * `fleet-drain.json` live there too. Not the manifest directory: manifests are
 * operator config, and a gate must not write into the file it audits.
 *
 * FIRST RUN IS A BASELINE, NOT A HUNDRED TRANSITIONS. With no previous
 * snapshot every label on every node would read as newly gained, which is
 * noise that trains the reader to skip the block. It records and says so.
 *
 * A SNAPSHOT THAT CANNOT BE READ IS NOT AN EMPTY ONE. An unreadable or corrupt
 * state file is reported as such and treated as a baseline — never silently as
 * "nothing changed", which would hide precisely the transition somebody is
 * looking for.
 */
const HOLDINGS_PATH = join(stateDir(), 'label-floor-holdings.json');

let previousHoldings = null;
let holdingsError = null;
if (existsSync(HOLDINGS_PATH)) {
	try {
		const parsed = JSON.parse(readFileSync(HOLDINGS_PATH, 'utf8'));
		previousHoldings = parsed?.holdings ?? null;
		if (!previousHoldings || typeof previousHoldings !== 'object') {
			throw new Error('no `holdings` object in the state file');
		}
	} catch (err) {
		holdingsError = String(err.message ?? err);
	}
}

const transitions = [];
if (previousHoldings) {
	const nodes = [...new Set([...Object.keys(previousHoldings), ...Object.keys(holdings)])].sort();
	for (const node of nodes) {
		const before = new Set(previousHoldings[node] ?? []);
		const after = new Set(holdings[node] ?? []);
		for (const label of [...after].filter((l) => !before.has(l)).sort()) {
			transitions.push({ node, label, change: 'gained', cause: causeFor(manifest, node, label) });
		}
		for (const label of [...before].filter((l) => !after.has(l)).sort()) {
			transitions.push({ node, label, change: 'lost', cause: causeFor(manifest, node, label) });
		}
	}
}

if (holdingsError) {
	console.error(
		`! label transitions: could not read ${HOLDINGS_PATH} (${holdingsError}) — this run is a ` +
			`new baseline, so a transition since the last run would NOT have been reported.`
	);
} else if (!previousHoldings) {
	log(
		`label transitions: first run — baseline recorded for ${Object.keys(holdings).length} node(s) ` +
			`at ${HOLDINGS_PATH}. Transitions are reported from the next run on.`
	);
} else if (!transitions.length) {
	log('label transitions: none since the last run.');
} else {
	log(`label transitions since the last run (${transitions.length}):`);
	for (const t of transitions) {
		log(`  ${t.node} ${t.change === 'gained' ? '+' : '-'}${t.label} — ${t.cause.why}`);
	}
	log(
		'  Observed, not enforced: bootcamp demotion is reviewable after the fact ' +
			'(wave2 §D.4). None of these fails this gate.'
	);
}

try {
	// Write-then-rename, fsync'd (F3, `lib/atomic-json.ts`).
	writeFileAtomic(
		HOLDINGS_PATH,
		`${JSON.stringify({ at: new Date().toISOString(), holdings }, null, 2)}\n`
	);
} catch (err) {
	// Reported, never swallowed: without the write, the NEXT run compares against
	// a stale snapshot and re-reports transitions it has already shown, or misses
	// one entirely. That is a real gap in the audit trail and it must be visible.
	console.error(`! could not persist label holdings to ${HOLDINGS_PATH}: ${err.message}`);
}

/**
 * THE DEMAND, FROM TWO SOURCES (#98) — what workflows CAN ask for and what jobs
 * DID ask for. Their union is the gate's scope.
 *
 * STATIC: every covered repo's workflows, per JOB, through
 * `lib/runs-on-demand.mjs`. Before 2026-10-10 this was three regexes over the
 * whole file, and two live routing labels (`jdk21`, `cargo-bevy`) were
 * invisible to it — see that module's header. A `runs-on` it cannot resolve is
 * a finding here, never zero labels.
 *
 * OBSERVED: the labels GitHub actually requested over job history's retention
 * window. It covers what no static reader can — a `runs-on` taken from a
 * dispatch input, a repo not yet in the roster — and it is the reader that does
 * not read the writer: the workflow is the writer, the job record is what
 * GitHub did with it.
 */
const coverage = JSON.parse(readFileSync(COVERAGE, 'utf8'));
const coveredRepos = coverage.repos ?? [];
// THE SHIPPED WORKFLOWS, through fleet-source: each repo's default branch,
// fetched by the reader itself. Never a sibling working tree — on 2026-10-24 a
// CRLF, 1627-commits-behind clone of secretProject made this gate report a parse
// failure in a file that was fine on GitHub (fleet-manager#7).
const repos = [...new Set([hubRepoFull(), ...coveredRepos])];

const requested = new Set();
/** label -> where it was asked for: `repo/file:job` (static) and a job count (observed). */
const demandSources = {};
function noteDemand(label, where) {
	if (!isDemandLabel(label)) return;
	requested.add(label);
	demandSources[label] ??= { static: [], observed: 0 };
	if (typeof where === 'number') demandSources[label].observed += where;
	else demandSources[label].static.push(where);
}
const unread = [];
/** name -> why it could not be read; printed beside `unread`, which stays names. */
const unreadWhy = new Map();
const noWorkflows = [];
const unresolvable = [];
for (const slug of repos) {
	const name = slug.split('/').pop();
	const source = tryShipped(slug);
	if ('unreadable' in source) {
		unread.push(name);
		unreadWhy.set(name, source.unreadable);
		continue;
	}
	// A REPO WITH NO WORKFLOWS DIRECTORY CONTRIBUTED NOTHING, silently, and the
	// gate's scope shrank by a whole repo. Every covered repo is covered BECAUSE
	// its workflows run on the fleet, so a missing directory is the same "could
	// not look" as an unreadable repo.
	if (!source.hasWorkflowsDir()) {
		noWorkflows.push(name);
		continue;
	}
	for (const { file: f, text } of source.workflows()) {
		const { jobs, unresolved } = workflowDemand(text, { fleetValue: FLEET_VALUE });
		for (const u of unresolved) unresolvable.push(`${name}/${f}: ${u}`);
		for (const j of jobs) for (const l of j.labels) noteDemand(l, `${name}/${f}:${j.id}`);
	}
}

const HISTORY_PATH = join(stateDir(), 'job-history.jsonl');
const observedSince = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
let observed = null;
let observedError = null;
try {
	const nodes = Object.keys(manifest.machines ?? {});
	observed = observedDemand(readFileSync(HISTORY_PATH, 'utf8'), {
		sinceIso: observedSince,
		isProof: (runner) => nodes.some((n) => isProofRunnerName(runner, n)),
	});
	// A HISTORY WITH NOTHING IN THE WINDOW IS NOT "NOTHING WAS ASKED FOR". The
	// fleet runs hundreds of jobs a day; zero rows means the recorder stopped.
	if (observed.rows === 0) {
		observedError =
			`${HISTORY_PATH} holds no job that started since ${observedSince} — the recorder is not ` +
			`running, so the observed half of the demand is empty, not small`;
	}
} catch (err) {
	observedError =
		err.code === 'ENOENT'
			? `no job history at ${HISTORY_PATH}`
			: `could not read ${HISTORY_PATH}: ${err.message}`;
}
if (observed) for (const [l, n] of observed.labels) noteDemand(l, n);
if (observed?.malformed) {
	console.error(
		`! ${observed.malformed} malformed line(s) in ${HISTORY_PATH} were skipped — an append killed ` +
			`mid-write leaves one; more than that is a corrupt file worth a look.`
	);
}

// A LABEL IS A ROUTING DEPENDENCY BECAUSE SOMETHING ASKS FOR IT. Full stop —
// the fleet's obligations are set by its workflows, not by what the manifest
// happens to admit to. See the header for what the old intersection cost.
//
// A requested label that NOTHING offers used to vanish here, on the grounds
// that it is check:worker-routes' bug rather than this gate's. It no longer
// vanishes: with declarations going away, "nothing offers it" is exactly what
// an accidentally-deleted capability looks like, and silently narrowing the
// dependency set is how this gate would report green on a fleet that can no
// longer serve a label at all. It is reported below as `unoffered`.
const dependencies = [...requested].sort();

/**
 * Labels offered ONLY by nodes that mint — an ephemeral claw or the on-demand
 * backstop.
 *
 * REPORTED, NOT FAILED, since 2026-10-19 (#120). From 2026-09-01 a routing
 * label here failed the gate ("stranded on ephemeral"), on the argument that a
 * label needs an answer that does not wait for the dispatcher, and the answer
 * it pointed at was hokon's ~30 standing runners. The operator retired those:
 * "the runners get brought online the same way the JIT process does. not
 * having standing runners squatting on ram." With every claw JIT, that makes
 * every routing label mint-only by decision, so the rule could only ever fail.
 *
 * What the rule protected is still guarded, by the things that can actually
 * act on it:
 *   - SERVED: the runtime floor watches every demanded label through its
 *     minting arm (`label-floor.ts`), and pages when no eligible minting node
 *     is live. That is the alert the 2026-09-01 state switched off.
 *   - THE DISPATCHER ITSELF: `jit-canary.yml` goes red when minting stops, and
 *     `ci:queue-health` when queues grow.
 *   - FIXING A BROKEN DISPATCHER: the resident floor below keeps this repo's
 *     CI on two standing holders, and hokon keeps hadoku_site's deploy runner
 *     standing (`standingRepos`), so neither the fix nor its deploy waits on
 *     the thing it fixes.
 * The hokon runners never answered for a dead dispatcher anyway: they offered
 * `hadoku-builder` only while runner-health promoted them, and runner-health
 * runs in the same mgmt-api process as the dispatcher.
 */
const servedByMintOnly = new Set(
	dependencies.filter((l) => {
		const offerers = offerersOf(manifest, holdings, l);
		return offerers.length > 0 && offerers.every((n) => mintsJitRunners(manifest.machines?.[n]));
	})
);

/**
 * A routing dependency NOTHING in the fleet offers.
 *
 * Jobs on such a label queue forever — hadoku-games-host sat 854 minutes that
 * way for 32 seconds of work. It is reported here rather than dropped because
 * dropping it is what would let this gate get EASIER to pass the worse the
 * failure gets: the more capabilities the fleet loses, the fewer dependencies
 * it would have had to floor.
 */
const nothingOffers = dependencies.filter((l) => offerersOf(manifest, holdings, l).length === 0);

/**
 * THE STATIC HALF OF THE DEMAND, PERSISTED FOR THE RUNTIME FLOOR.
 *
 * runner-health watches what jobs ACTUALLY requested (it holds job history
 * in-process) unioned with this file, because it cannot read every covered
 * repo's workflows itself. Without the file a label only a rarely-run workflow
 * asks for — `cargo-bevy`, zero observed jobs in the 14 days to 2026-10-10 —
 * would be unwatched, and a job that queues forever never STARTS, so it never
 * reaches job history either.
 *
 * WRITTEN ONLY FROM A COMPLETE READ. A partial static read (a missing
 * checkout, a workflows directory gone, a `runs-on` the reader cannot resolve)
 * would REPLACE a complete file with a shorter one and silently unwatch labels;
 * those cases fail this gate below, and the previous file stays in place.
 */
const FLOOR_DEMAND_PATH = join(stateDir(), FLOOR_DEMAND_FILE);
const staticDemand = Object.entries(demandSources)
	.filter(([, src]) => src.static.length > 0)
	.map(([l]) => l)
	.sort();
const staticComplete =
	coveredRepos.length > 0 && !unread.length && !noWorkflows.length && !unresolvable.length;

/**
 * HISTORICAL DEMAND: a label nothing offers that only past JOBS asked for.
 *
 * The rule above keeps an unoffered label in the dependency set so the gate
 * never gets easier to pass as capabilities disappear. The reverse case is a
 * label nothing ASKS for any more: hadoku-watchparty moved ingest off
 * `watchparty-media` (e87161e6, 2026-10-28) and bootcamp revoked it the same
 * day, and the jobs that ran on it before stayed in the observed window for
 * fourteen days, failing this gate on a dependency no workflow has
 * (fleet-manager#29).
 *
 * Only a COMPLETE static read can say "no workflow asks". Every covered
 * repo's shipped workflows were read and every `runs-on` resolved, so a label
 * with no static job is not a live dependency of any of them. It is reported
 * with when it was last asked for, and it ages out of the window on its own.
 * An incomplete read keeps it failing: then the gate cannot tell. And a job
 * that asks for an unoffered label never starts, so it never reaches job
 * history: a live runtime-resolved ask shows up in ci:queue-health, not here.
 */
const historical = staticComplete
	? nothingOffers.filter((l) => demandSources[l].static.length === 0)
	: [];
const unoffered = nothingOffers.filter((l) => !historical.includes(l));
let floorDemandWriteError = null;
if (staticComplete) {
	try {
		// Write-then-rename, fsync'd (F3, `lib/atomic-json.ts`).
		writeFileAtomic(
			FLOOR_DEMAND_PATH,
			`${JSON.stringify({ at: new Date().toISOString(), labels: staticDemand }, null, 2)}\n`
		);
	} catch (err) {
		// Reported, never swallowed: the runtime floor would keep reading the
		// previous file, or none.
		floorDemandWriteError = String(err.message ?? err);
		console.error(
			`! could not persist the static floor demand to ${FLOOR_DEMAND_PATH}: ${floorDemandWriteError}`
		);
	}
}

/**
 * What the RUNTIME floor will watch, read back exactly as runner-health reads
 * it: observed demand ∪ the persisted static file — the file ON DISK, not the
 * set this run computed, so a write that failed is a write that did not happen.
 */
let persistedStatic = [];
let persistedStaticError = null;
try {
	const parsed = JSON.parse(readFileSync(FLOOR_DEMAND_PATH, 'utf8'));
	if (!Array.isArray(parsed.labels)) throw new Error('it carries no `labels` array');
	persistedStatic = parsed.labels.filter((l) => typeof l === 'string');
} catch (err) {
	persistedStaticError = err.code === 'ENOENT' ? 'no such file' : String(err.message ?? err);
}
const runtimeWatched = new Set(
	floorLabels([...(observed?.labels.keys() ?? []), ...persistedStatic])
);

/**
 * A demanded label the RUNTIME floor will not watch. With one rule for every
 * label this is no longer "outside a list" — it is a label only the static
 * read found, whose persisted copy is missing or out of date, so runner-health
 * cannot see it and the last runner offering it can go dark unannounced.
 */
const missing = dependencies.filter((l) => !runtimeWatched.has(l) && !unoffered.includes(l));

/**
 * RESIDENT FLOOR — the fleet's ONE backstop, and the reason it moved off
 * claw-1 on 2026-09-07 (WS-R, operator decision).
 *
 * `residentRepos` on an ephemeral node is a STANDING registration kept so a
 * repo's own CI can run even when the dispatcher is broken — the guarantee
 * that ended the 2026-09-02 deadlock (jit-name-length-ceiling in this
 * package's memory: `check` and `publish` both queued forever, because
 * minting was broken and nothing could fix it without CI). The rule since
 * 2026-09-07 is AT LEAST TWO HOLDERS, NEVER A DRAINED ONE — one holder is
 * exactly the single point of failure the move away from claw-1 exists to
 * remove.
 *
 * Neither half is provable from the manifest alone: a declared holder can be
 * offline, unlabelled (born that way, awaiting the fast loop's next promote),
 * or drained. So this reads GitHub directly, same as everything else in this
 * gate reads live state rather than a declaration.
 */
const residentHolders = new Map();
for (const [name, m] of Object.entries(manifest.machines ?? {})) {
	for (const repo of m.residentRepos ?? []) {
		if (!residentHolders.has(repo)) residentHolders.set(repo, []);
		residentHolders.get(repo).push(name);
	}
}

const residentFailures = [];
if (residentHolders.size) {
	const drained = drainedNodeNames();
	for (const [repo, holders] of residentHolders) {
		const drainedHolders = holders.filter((n) => drained.has(n));
		const probe = await listRunners(repo, {
			attempts: READ_ATTEMPTS,
			describeFailure: describeReadFailure,
		});
		if (!probe.ok) {
			// "I could not look" must never render as "the floor holds" — see
			// CLAUDE.md. A repo whose registrations could not be read is reported
			// as a failure naming why, not skipped. GateDoc (wave 5i lane B): a
			// `gh` read that exhausted READ_ATTEMPTS is "I could not look",
			// never a finding — same reasoning check-boundary-contracts.mjs's
			// own `bad(..., { unreadable: true })` applies to its exhausted
			// reads.
			const why =
				`could not read its runner registrations from GitHub ` +
				`(${String(probe.error ?? '')
					.trim()
					.slice(0, 160)}). Declared holder(s): ${holders.join(', ')}.`;
			residentFailures.push(`"${repo}" — ${why}`);
			gateUnreadable.push({ node: null, why: `"${repo}" — ${why}` });
			continue;
		}
		const runners = probe.runners;
		const online = holders.filter((node) =>
			runners.some(
				(r) =>
					(r.name === node || r.name.startsWith(`${node}-`)) &&
					r.status === 'online' &&
					(r.labels ?? []).some((l) => l.name === BUILDER_LABEL)
			)
		);
		if (drainedHolders.length) {
			const reason =
				`"${repo}" — resident holder(s) ${drainedHolders.join(', ')} are DRAINED. ` +
				`The rule is at least two holders and never a drained one: drain a ` +
				`replacement holder in first, then drain this one.`;
			residentFailures.push(reason);
			gateFindings.push({ node: null, kind: 'resident-drained', reason });
		}
		if (online.length < 2) {
			const reason =
				`"${repo}" — only ${online.length} of its declared resident holder(s) ` +
				`(${holders.join(', ')}) are online carrying ${BUILDER_LABEL}. Need at ` +
				`least 2: this is the fleet's ONE backstop repo and a single holder is the ` +
				`single point of failure the 2026-09-07 move off claw-1 exists to remove.`;
			residentFailures.push(reason);
			gateFindings.push({ node: null, kind: 'resident-understaffed', reason });
		}
	}
}

/**
 * `hadoku-builder`'s required set, and which nodes hold it and WHY — P1.2/
 * P1.3 (`bootcamp-earned-labels-2026-09-02.md`). The required set is DERIVED
 * from the demand ledger, never declared; a required capability no managed
 * node proves is a gate failure, the same class as `missing` above but for
 * DEMAND rather than for a workflow's literal `runs-on`.
 *
 * A missing ledger is a FAILURE, not a skip — `unread.length` above holds the
 * same line for unreadable repos. This gate already assumes an operational
 * environment (it reads the state dir and GitHub), so requiring the ledger
 * `fleet tool-inventory --write` produces is consistent, not a new floor.
 */
let ledgerRecords;
let ledgerError = null;
try {
	ledgerRecords = loadDemandLedger(join(stateDir(), 'demand-ledger.jsonl'));
} catch (err) {
	ledgerError = String(err.message ?? err);
	ledgerRecords = null;
}
// CI ROWS ONLY, explicitly. The ledger holds resident demand too since
// 2026-09-10 (`service-ledger-2026-09-10.md` §3) and a PM2 service's resource
// row must never be able to raise the bar a CI claw has to clear.
const requiredSet = ledgerRecords ? requiredIdentitySet(ciRecords(ledgerRecords)) : new Set();
const knownProbeableIds = probeableIds();
const requiredGaps = ledgerRecords
	? unprovenRequired(requiredSet, manifest.machines, knownProbeableIds)
	: [];

/**
 * `hadoku-builder`'s CONSUMER CONTRACT, per node, as a REPORT.
 *
 * "A node carries it iff it proves the required set" (operator, 2026-09-07),
 * evaluated through the one predicate `src/fleet-loop.ts` ENFORCES
 * (`provesRequiredSet`) rather than a second copy of the rule. It does NOT fail
 * the gate on its own: `requiredGaps` above already fails when a demanded
 * capability NO node proves, and the per-node view would otherwise redden the
 * fleet for a node that is legitimately unprobed — the fail-open case
 * `nodeFailsBootcamp` keeps deliberately. It is printed so the fast loop's verdict
 * is visible on live data BEFORE the next tick acts on it.
 */
const contractVerdicts = Object.entries(manifest.machines ?? {})
	.map(([name, m]) => ({ name, ...provesRequiredSet(m, requiredSet) }))
	.sort((a, b) => a.name.localeCompare(b.name));

// A LEDGER THAT PARSED AND ASKED FOR NOTHING IS THE THIRD CASE, and it used to
// be the silent one: `unprovenRequired` returns `[]` for an empty set, so the
// gap check below passed having checked nothing. Every node clears a bar of
// zero. Settled in wave 3a — an empty required set is a failure, not a pass —
// and it is now the SAME refusal the fast loop makes (`nodeFailsBootcamp`),
// so the gate and the loop agree about a bar neither can enforce. MOVED UP
// from between `checkLedgerMissing`/`checkEmptyRequired` — it is just a `ctx` field.
const emptyRequired = emptyRequiredSetReason(requiredSet, {
	path: join(stateDir(), 'demand-ledger.jsonl'),
	records: ledgerRecords,
});

// ONE CONTEXT OBJECT, handed into each guard EXPLICITLY — never a reverse import (see gate.mjs).
const ctx = {
	emitter,
	JSON_OUT,
	log,
	gateFindings,
	gateUnreadable,
	COVERAGE,
	manifest,
	holdings,
	eligibleNodes,
	unverifiedNodes,
	disqualifiedNodes,
	HOLDINGS_PATH,
	holdingsError,
	transitions,
	coveredRepos,
	demandSources,
	unread,
	unreadWhy,
	noWorkflows,
	unresolvable,
	observed,
	observedError,
	dependencies,
	servedByMintOnly,
	FLOOR_DEMAND_PATH,
	historical,
	unoffered,
	floorDemandWriteError,
	persistedStaticError,
	runtimeWatched,
	missing,
	residentHolders,
	residentFailures,
	ledgerRecords,
	ledgerError,
	requiredSet,
	knownProbeableIds,
	requiredGaps,
	contractVerdicts,
	emptyRequired,
	derivationFailures,
};

// `--json`'s emit-and-exit: every guard calls `ctx.finish`. The literal
// `if (JSON_OUT) emitter.emit(...)` HERE, not in `buildJsonDoc` (a pure
// builder), is what json-contract.test.mjs's `emitsJson` scans THIS file for.
function finish(verdict, extra) {
	if (JSON_OUT) emitter.emit(buildJsonDoc(ctx, verdict, extra));
	if (verdict !== 'ok') process.exit(1);
}
ctx.finish = finish;

// Each guard: `if (condition) { diagnose; ctx.finish(...); }`, inline once, now in lib/label-floor-gate.mjs.
checkUnread(ctx);
checkEmptyRoster(ctx);
checkNoWorkflows(ctx);
checkUnresolvable(ctx);
checkObservedError(ctx);
reportHistorical(ctx);
checkUnoffered(ctx);
checkMissing(ctx);
checkResidentFailures(ctx);
checkLedgerError(ctx);
checkLedgerMissing(ctx);
checkEmptyRequired(ctx);
checkRequiredGaps(ctx);
checkDerivationFailures(ctx);
reportSuccess(ctx);
