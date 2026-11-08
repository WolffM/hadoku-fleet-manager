#!/usr/bin/env node
/**
 * fleet tool-inventory — a workflow may not invoke a tool the nodes it can
 * land on do not have, unless it provides that tool itself.
 *
 * RENAMED from `check-tool-inventory.mjs` (wave gates2 lane F1a). The missing-
 * tool scan itself (`TOOLS`, `invokes`, `providesTool`, `probeToolPresence`,
 * `scanWorkflows`) moved to `scripts/lib/tool-inventory-scan.mjs`, which
 * `fleet converge-toolchain --refresh` now ALSO calls, so the same finding
 * ("a workflow invokes a tool the node lacks") lands in the nightly toolchain
 * cadence instead of waiting for this separate gate to re-read the fleet.
 *
 * THIS FILE IS KEPT, NOT DELETED, because it is the ONLY writer of
 * `demand-ledger.jsonl` (`--write`, below) — read by `check-label-floor`,
 * `src/runners/node-eligibility.ts` and `src/lib/bootcamp-proof.ts` to decide
 * what the general pool must prove and which labels a job demands. Deleting
 * this subcommand outright would silently stop that ledger from ever being
 * regenerated again. It also carries the capability-retirement comparison
 * (P3.4) and the pinned/hosted demand report (§B), neither of which the
 * toolchain-refresh finding replaces.
 *
 * Workstream C4. The plan's premise was that the fleet's real tool inventory is
 * invisible because `command -v` guards barely exist — three across every
 * workflow in every repo. That count is right and the conclusion drawn from it
 * was too strong: measured 2026-08-27, the workflows that genuinely need a tool
 * the claws lack SELF-INSTALL it (hadoku-watchparty/deploy.yml installs rustup,
 * which brings cargo, and trunk), and the rest either run hosted or target the
 * one node that has the tool. The fleet is currently clean.
 *
 * So this gate is not cleaning up a mess; it is stopping the NEXT one. The
 * failure it prevents is silent and node-dependent: a job that passes on
 * whichever runner happens to have the binary and dies on the others, which
 * reads as flakiness rather than as a missing dependency (P4).
 *
 * P2.2 — THE DEMAND LEDGER (`--write [path]`)
 * ---------------------------------------------
 * Alongside the missing-tool gate above, this scan already walks every job in
 * every covered repo's workflows — `bootcamp-earned-labels-2026-09-02.md` §4
 * needs exactly that same scrape to derive what a repo REQUIRES, and today
 * nothing records it. `--write` emits one JSONL record per (repo, job) —
 * capabilities asked for (derived, never declared, from the same signals
 * bootcamp's design names: a setup-python step implies `python-toolcache`, a
 * playwright step implies `playwright`), the labels the job's `runs-on`
 * resolves to, and the `uses:` actions it invokes. THE UNIT IS THE JOB, not
 * the workflow step or the whole file — two jobs in one workflow can ask for
 * different things (`deploy-workers.yml`'s `detect-changes` runs hosted, its
 * `deploy` runs on the fleet), and the demand ledger has to tell them apart.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadManifest, selectMachines } from './lib/fleet-exec.mjs';
import { manifest as manifestFile, stateDir } from '../dist/lib/fleet-paths.js';
import { tryShipped } from './lib/fleet-source.mjs';
import { hubRepoFull } from '../dist/lib/fleet-config.js';
import { deferralFor, deferralNote, readDrains } from './lib/expected-down.mjs';
import { knownDownNodes, knownDownNote } from './lib/known-down.mjs';
import { TOOLS, probeToolPresence, scanWorkflows } from './lib/tool-inventory-scan.mjs';
import {
	splitJobs,
	deriveCapabilities,
	deriveSetupActions,
	deriveLabels,
	deriveJobName,
	mergeDemandLedger,
	capabilityRetirements,
} from './lib/demand-derive.mjs';
import { CI_DEMAND_CLASS, provenCapabilities } from '../dist/lib/bootcamp-proof.js';

const COVERAGE = manifestFile('fleet-runner-coverage.json');

const WRITE_LEDGER = process.argv.includes('--write');
function writeFlagValue() {
	const i = process.argv.indexOf('--write');
	const next = i >= 0 ? process.argv[i + 1] : undefined;
	return next && !next.startsWith('--') ? next : join(stateDir(), 'demand-ledger.jsonl');
}

/**
 * Every node a CI job can land on, the backstop included: it takes CI when the
 * claws cannot, so the tools a job finds there are the same question.
 */
const manifest = loadManifest();
const selectedNodes = selectMachines(manifest);
const nodes = selectedNodes.map(([name]) => name);
const { present, unreachable } = await probeToolPresence(nodes, TOOLS);

// A node a human powered off is EXPECTED down. It is still PRINTED, and its
// tools are still unread — the deferral suppresses the failure, never the
// evidence, and expires after DEFER_DAYS. See lib/expected-down.mjs.
const _drains = readDrains();
const expectedDown = unreachable.filter((n) => deferralFor(n, _drains).deferred);
// Already paged as down by runner-health's own offline alert (observed, never
// a declaration — see lib/known-down.mjs). Checked only for a node that is
// not already drained, so the two never double-count one machine.
const _knownDown = knownDownNodes();
const knownDown = unreachable.filter((n) => !deferralFor(n, _drains).deferred && _knownDown.has(n));
const trulyUnreachable = unreachable.filter(
	(n) => !deferralFor(n, _drains).deferred && !_knownDown.has(n)
);

// Every node a `hadoku-builder` job can land on.
//
// This was `nodes` minus anything carrying the `pm2-host` LABEL, which was exact
// only while one machine carried that label and stopped being exact the day
// Wave 3d made `pm2-host` an EARNED capability a claw can probe into — a claw
// that earned it would have dropped out of the CI set for a reason that has
// nothing to do with CI.
const clawSet = nodes;

/**
 * §B (wave 3y, corrected 2026-10-05): "proven by the general pool" means
 * EARNED BY A NODE, never DEMANDED BY A JOB. `requiredIdentitySet` answers a
 * different question — what jobs on the general pool ASK for — and reading
 * it as "what the pool proves" would let the floor's own demand stand in as
 * its own evidence: the verifier-reads-its-own-writer trap CLAUDE.md names,
 * just moved from a cgroup reader to a capability one. `provenCapabilities`
 * reads each node's bootcamp facet from the MANIFEST instead — no probe, no
 * ssh, no job text.
 *
 * A node bootcamp has never reached (`provenCapabilities` returns `null`)
 * proves NOTHING — it is counted in `poolUnprobedCount` and reported as a
 * caveat below, never silently read as proof it has everything.
 */
const poolProvenBy = new Map();
let poolUnprobedCount = 0;
for (const [name, node] of selectedNodes) {
	const proven = provenCapabilities(node);
	if (proven === null) {
		poolUnprobedCount++;
		continue;
	}
	for (const c of proven) {
		if (!poolProvenBy.has(c)) poolProvenBy.set(c, new Set());
		poolProvenBy.get(c).add(name);
	}
}

const coverage = JSON.parse(readFileSync(COVERAGE, 'utf8'));
// THE SHIPPED WORKFLOWS, through fleet-source: each repo's default branch,
// fetched by the reader itself — never a sibling working tree under REPOS_DIR,
// and never the hub's deployed tree either (fleet-manager#7).
//
// DEDUPED BY SLUG (wave 3y, 2026-10-05). The hub used to be read twice — once as
// `siteRoot()` and once as `REPOS_DIR/hadoku_site`, two directories naming one
// repo — so every hadoku_site workflow was scanned TWICE in production and a
// `--write` carried a duplicate ledger row per job. One reader, one slug, one
// read.
const repos = [...new Set([hubRepoFull(), ...(coverage.repos ?? [])])];

// THE MISSING-TOOL SCAN (now shared with `fleet converge-toolchain --refresh`;
// see lib/tool-inventory-scan.mjs). Run FIRST and independently of the
// demand-ledger loop below: it needs only `present`, never the per-job
// derivation the ledger does.
const scan = scanWorkflows({ repos, clawSet, present });
const findings = [...scan.findings];
const { examined, examinedJobs, noCheckoutCount: scanNoCheckoutCount } = scan;

// AN EMPTY ROSTER SCANS ONLY THE SITE (#98), and a site with one self-hosted
// workflow is enough to clear the zero-inspected check below. The coverage
// file is generated; a roster of zero is a failed generation, not a fleet.
if (!(coverage.repos ?? []).length) {
	findings.push(
		`${COVERAGE} lists no covered repos — only the site checkout was scanned. Regenerate it ` +
			'with `fleet reconcile --write-coverage`.'
	);
}
/** P2.2: one (repo, job) demand record, collected only when --write is passed. */
const demandLedger = [];
let demandFiles = 0;
/** How many covered repos this run could not even look at (P3.4 item 3). */
let noCheckoutCount = scanNoCheckoutCount;
/** capability -> the repos this run found actually asking for it, on the
 * claw fleet (never a pm2-host — see the `fleetDemand` gate below). Built
 * unconditionally, not just under `--write`, because P3.4's retirement check
 * needs it on every run of the gate, not only when the demand ledger is
 * being written. */
const capabilityRepos = new Map();
/** §B: jobs pinned to one machine (`selfHosted && !fleetForm`) or hosted —
 * demand `requiredIdentitySet` correctly excludes from the floor, but that
 * is real demand recorded nowhere anyone reads until now. One entry per job
 * that invokes at least one tracked capability. */
const pinnedDemand = [];

for (const slug of repos) {
	// A covered repo whose shipped workflows could not be read was not inspected
	// AT ALL — that is "I could not look", never "nothing to invoke here". A repo
	// that READ and ships no workflows genuinely needs no tools; the scan above
	// already counted this once (`noCheckoutCount`), so this loop only needs to
	// SKIP it the same way, never double-count the finding.
	const source = tryShipped(slug);
	if ('unreadable' in source) continue;
	const name = slug.split('/').pop();
	for (const { file, text: raw } of source.workflows()) {
		// STRIP COMMENTS BEFORE MATCHING. A tool name in prose is not an
		// invocation, and this fleet's workflows are heavily commented.
		const text = raw
			.split('\n')
			.filter((l) => !/^\s*#/.test(l) && !/^\s*-?\s*(name|description):/.test(l))
			.join('\n');
		const rel = `${name}/.github/workflows/${file}`;

		// P2.2's job split, and the capability-retirement tracker built on top of
		// it (P3.4), now run on EVERY file — not just under `--write`.
		const jobs = splitJobs(text);
		// A SECOND SPLIT, off text that still has its `name:` lines.
		const namedJobs = new Map(
			splitJobs(
				raw
					.split('\n')
					.filter((l) => !/^\s*#/.test(l))
					.join('\n')
			).map((j) => [j.id, j.text])
		);
		if (WRITE_LEDGER) {
			demandFiles++;
			if (!jobs.length) {
				findings.push(
					`${rel}: the demand ledger found ZERO jobs in it — the 2-space job-` +
						`indent assumption (P2.2) does not hold for this file, so it is ` +
						`invisible to the demand ledger rather than reporting nothing to ask for.`
				);
			}
		}
		const repoName = slug;
		for (const j of jobs) {
			const { runsOn: jobRunsOn, fleetForm, selfHosted, hosted, explicit } = deriveLabels(j.text);
			const capabilities = deriveCapabilities(j.text);
			if ((fleetForm || selfHosted) && !explicit.includes('pm2-host')) {
				for (const c of capabilities) {
					if (!capabilityRepos.has(c)) capabilityRepos.set(c, new Set());
					capabilityRepos.get(c).add(repoName);
				}
			}
			const { jobName, jobNameSource, unjoinable } = deriveJobName(
				j.id,
				namedJobs.get(j.id) ?? j.text
			);
			if ((hosted || (selfHosted && !fleetForm)) && capabilities.length) {
				pinnedDemand.push({
					repo: repoName,
					job: jobName ?? j.id,
					kind: hosted ? 'hosted' : 'pinned',
					labels: explicit,
					capabilities,
				});
			}
			if (!WRITE_LEDGER) continue;
			demandLedger.push({
				class: CI_DEMAND_CLASS,
				repo: repoName,
				job: j.id,
				jobId: j.id,
				jobName,
				jobNameSource,
				...(unjoinable ? { unjoinable } : {}),
				workflow: rel,
				runsOn: jobRunsOn,
				fleetForm,
				selfHosted,
				hosted,
				labels: explicit,
				capabilities,
				setupActions: deriveSetupActions(j.text),
			});
		}
	}
}

for (const u of trulyUnreachable)
	console.error(
		`  ! unreachable, tools unread: ${u} — reported ONCE, not as a node missing every tool`
	);
for (const u of expectedDown)
	console.log(`  · ${deferralNote(u, deferralFor(u, _drains))} — tools unread`);
for (const u of knownDown) console.log(`  · ${knownDownNote(_knownDown.get(u))} — tools unread`);
// ZERO INSPECTED IS A FAILURE, NOT A PASS. This gate reported clean for months
// while matching a literal `self-hosted` that the fleet form never contains; the
// count is what makes the verdict readable as evidence rather than as silence.
if (!examined) {
	findings.push(
		'no self-hosted workflow was inspected at all — the roster, the checkouts or the ' +
			'`runs-on` match is broken. A gate that looked at nothing cannot report nothing wrong.'
	);
}
if (findings.length) {
	console.error(`✗ tool inventory (${findings.length}):`);
	for (const f of findings) console.error(`  ${f}`);
}
if (!findings.length && !trulyUnreachable.length) {
	console.log(
		`✓ ${examined} self-hosted workflow(s) (${examinedJobs} job(s)) inspected across ${clawSet.length} node(s): ` +
			`every tool invoked is present, guarded, or installed by the workflow` +
			(expectedDown.length ? ` (${expectedDown.length} expected down)` : '')
	);
}

if (WRITE_LEDGER) {
	const path = writeFlagValue();
	// PRESERVE, never truncate. Resident demand (`fleet service-inventory
	// --write`) lives in this same file under `class: "resident"` so the claw
	// floor reads ONE ledger; a blind rewrite of this script's own rows deleted
	// measurements taken from another box's kernel. See `mergeDemandLedger`.
	let existing = '';
	try {
		existing = readFileSync(path, 'utf8');
	} catch (err) {
		// ENOENT is the first run; anything else is a file we cannot read, and
		// rewriting one of those would discard rows we never saw.
		if (err.code !== 'ENOENT') throw err;
	}
	const merged = mergeDemandLedger(existing, demandLedger);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, merged.text);
	console.log(
		`\nP2.2 demand ledger: ${merged.written} class:${CI_DEMAND_CLASS} (repo, job) record(s) across ` +
			`${demandFiles} workflow file(s) -> ${path}` +
			`\n  ${merged.preserved} row(s) of another class preserved unchanged` +
			`\n  joinable on jobName: ${demandLedger.filter((r) => r.jobName).length} of ` +
			`${demandLedger.length}; ${demandLedger.filter((r) => r.unjoinable).length} unjoinable ` +
			`(job name is an expression)`
	);
}

// --- capability retirement (P3.4 item 3) ------------------------------------
// A retirement finding says a capability's LAST repo dropped it. It never
// fails the gate — no consumer acts on it automatically — it is a heads-up
// for §P's capability registry to consider dropping the probe. It is computed
// and persisted ONLY on a run that could check out every covered repo: a repo
// this run could not look at must never read as "no longer needs it" — the
// exact "I could not look" ≠ "nothing is wrong" trap the no-checkout finding
// above exists to catch, just applied to a capability's demand instead of a
// node's health. An incomplete run leaves the persisted snapshot untouched so
// the next COMPLETE run still has something real to compare against.
const CAPABILITY_STATE_PATH = join(stateDir(), 'tool-inventory-capabilities.json');
const checkoutsComplete = noCheckoutCount === 0;
let previousCapabilities = {};
/** Set when a state file EXISTS and could not be read — never on a first run. */
let previousStateError = null;
try {
	previousCapabilities = JSON.parse(readFileSync(CAPABILITY_STATE_PATH, 'utf8'));
	if (!previousCapabilities || typeof previousCapabilities !== 'object') {
		throw new Error('not a JSON object');
	}
} catch (err) {
	// ENOENT is a first run and has no history to compare. Anything else is a
	// file that exists and could not be read — and comparing against `{}` would
	// report "no retirements" having compared against nothing.
	previousCapabilities = {};
	if (err.code !== 'ENOENT') previousStateError = String(err.message ?? err);
}
if (previousStateError) {
	console.error(
		`\n  ! could not read previous capability state at ${CAPABILITY_STATE_PATH} ` +
			`(${previousStateError}) — retirement is NOT compared this run; this run's snapshot ` +
			`replaces it as a new baseline.`
	);
}
if (checkoutsComplete) {
	const retirements = capabilityRetirements(previousCapabilities, capabilityRepos);
	if (previousStateError) {
		console.log(
			'\nretirement: not compared — the previous capability state was unreadable (above).'
		);
	} else if (retirements.length) {
		console.log(`\nretirement (${retirements.length}):`);
		for (const r of retirements) console.log(`  ${r}`);
	} else {
		console.log(
			'\nretirement: none this run — every capability last on record still has a repo asking for it.'
		);
	}
	const snapshot = Object.fromEntries(
		[...capabilityRepos].map(([cap, repos]) => [cap, [...repos].sort()])
	);
	try {
		mkdirSync(dirname(CAPABILITY_STATE_PATH), { recursive: true });
		writeFileSync(CAPABILITY_STATE_PATH, JSON.stringify(snapshot, null, 2) + '\n');
	} catch (e) {
		console.error(
			`  ! could not persist capability state to ${CAPABILITY_STATE_PATH}: ${e.message}`
		);
	}
} else {
	console.log(
		`\nretirement: skipped — ${noCheckoutCount} covered repo(s) could not be read this run, ` +
			`so their capability use could not be reconfirmed. Retiring off an incomplete view would be ` +
			`the same "I could not look" ≠ "nothing needs it" mistake, just about a capability instead ` +
			`of a node.`
	);
}

// --- pinned/hosted demand (§B, wave 3y) -------------------------------------
//
// A job pinned to one machine (`selfHosted && !fleetForm`) or hosted entirely
// is correctly excluded from `requiredIdentitySet` — raising the fleet-wide
// floor with a job no claw will ever receive is wrong. But that demand is
// real, and until now it was recorded nowhere anyone reads: the live ledger
// holds pinned or hosted demand for docker, playwright, ffmpeg and
// python-toolcache that no report shows, and cardtable's forge jobs ask for a
// `jdk21` nothing anywhere named (they never call `java` themselves — the
// server they start spawns it from `CARDTABLE_FORGE_JAR`, a `.jar` path).
//
// EVERY capability a pinned/hosted job uses is printed, marked against
// `poolProvenBy` — NEVER filtered down to an "unproven" subset.
//
// OPERATOR-ONLY, ADVISORY: this never adds to `findings` and never affects
// the exit code.
const pinnedLines = [];
for (const p of pinnedDemand) {
	const marked = p.capabilities.map((c) => {
		const earners = [...(poolProvenBy.get(c) ?? [])].sort();
		return earners.length ? `${c} (${earners.join(', ')})` : `${c} (earned by no pool node)`;
	});
	pinnedLines.push(
		`  ${p.repo} / ${p.job} [${p.kind}${p.labels.length ? ': ' + p.labels.join(', ') : ''}]: ` +
			marked.join(', ')
	);
}
if (pinnedLines.length) {
	console.log(`\npinned jobs and what moving them would need (${pinnedLines.length}):`);
	for (const l of pinnedLines) console.log(l);
} else {
	console.log(
		'\npinned jobs and what moving them would need: none — no pinned or hosted job invokes ' +
			'a capability this scan tracks.'
	);
}
// A node bootcamp has never reached proves NOTHING — said explicitly, so the
// earners named above never read as the WHOLE pool having been checked.
if (poolUnprobedCount) {
	console.log(
		`  ! ${poolUnprobedCount} general-pool node(s) have no bootcamp record at all — counted ` +
			`as having proven nothing, never as proof they have it.`
	);
}

process.exit(findings.length || trulyUnreachable.length ? 1 : 0);
