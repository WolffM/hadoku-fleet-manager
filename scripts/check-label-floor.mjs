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
import { readDrains } from './lib/expected-down.mjs';
import { tryShipped } from './lib/fleet-source.mjs';
import { writeFileAtomic } from '../dist/lib/atomic-json.js';
import { hubRepoFull } from '../dist/lib/fleet-config.js';
import { FLOOR_DEMAND_FILE, floorLabels, isFloorDemandLabel } from '../dist/label-floor.js';
import { FLEET_VALUE } from '../dist/ci-runner-fallback.js';
import { BUILDER_LABEL } from '../dist/runners/census.js';
import { RETENTION_DAYS } from '../dist/job-history.js';
import { isProofRunnerName } from '../dist/runners/prove-job.js';
import {
	requiredIdentitySet,
	probeableIds,
	nodeOffer,
	eligibilityLabels,
	provesRequiredSet,
	capability,
} from '../dist/capabilities.js';
import {
	ciRecords,
	emptyRequiredSetReason,
	loadDemandLedger,
	unprovenRequired,
} from './lib/bootcamp-required.mjs';
import { createEmitter } from './lib/emit.mjs';
import { mintsJitRunners } from '../dist/lib/node-role.js';
import { observedDemand, workflowDemand } from './lib/runs-on-demand.mjs';
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
 * NOT under `scripts/lib/json-contract.mjs`: `ci:audit-gates` runs this gate
 * and judges it by a regex over stdout+stderr as PROSE, so nothing parses this
 * payload yet and adding it breaks nothing. The diagnostics stay on STDERR in
 * both modes — stderr is not part of any stdout contract, and audit-gates
 * merges the two, so the prose consumer sees exactly what it sees today.
 */
const emitter = createEmitter();
const JSON_OUT = emitter.json;
const log = emitter.log;

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

function offerersOf(label) {
	return Object.keys(manifest.machines ?? {}).filter((name) => holdings[name].includes(label));
}

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
const ELIGIBILITY = new Set(eligibilityLabels());

/**
 * THE TWO PLACES A DECLARATION IS RIGHT, and nothing else.
 *
 * Capabilities are DERIVED (operator, 2026-09-09) and question 3 above compares
 * the derivation against the declaration. A label the manifest is SUPPOSED to
 * declare therefore has to be exempt from that comparison, or the gate reports
 * the correct state as a disagreement — and it did, on `jit-canary`, the moment
 * `nodeOffer` stopped honouring declarations for anything a probe can settle.
 *
 * The exemption is read from the REGISTRY (`mintOnly`), never listed here: a
 * literal list in a gate is the third copy of a policy this repo has paid for
 * three times. `mintOnly` carries the reasoning; hokon's half of it is the
 * `role: 'guest'` key, not a label property.
 *
 * NARROW ON PURPOSE, IN TWO DIRECTIONS. It exempts the DECLARED-BUT-NOT-DERIVED
 * side only. The reverse — a mint-only label the derivation projects that the
 * manifest does NOT declare — is never exempt: the only way one reaches the
 * offer is through `earned`, and a probe cannot earn what minting proves. That
 * case has its own finding below (`mintOnlyEarned`), because a bootcamp record
 * claiming it is the record lying, not the declaration.
 *
 * `check-capability-schema` still refuses `jit-canary` on a node without
 * `ephemeral: true`, which is the failure a mint-only label actually has, and
 * the floor and unoffered checks above still see it.
 */
function declarationIsRight(label) {
	return capability(label)?.mintOnly === true;
}

/**
 * A label the derivation adds because the node EARNED it — the design, not a
 * disagreement.
 *
 * `cargo-bevy` is the case that exists, and the registry entry says why in its
 * own words: it is "routed by `nodeOffer`, so `machines[].labels` stays
 * untouched and the manifest cannot claim a speed the box has not
 * demonstrated". Four claws earned it on 2026-09-14 and this gate reported four
 * disagreements, because the only exemption on the `added` side was
 * ELIGIBILITY. The end state for every probe-settled label is exactly this:
 * present in `earned`, absent from `labels`.
 *
 * KEYED ON THIS NODE'S OWN `earned`, not on the capability alone. A probe-
 * verified label that appears in the offer WITHOUT the node having earned it
 * came from somewhere else and still fails — the exemption is "the probe put it
 * there", not "labels of this kind are never compared".
 *
 * The `lost` direction is deliberately NOT exempt: a manifest that DECLARES a
 * probe-verified label the record does not earn is the dangerous direction
 * (av1-nvenc on a node whose GPU cannot encode it) and must stay red.
 */
function derivedByEarning(label, earned) {
	if (!earned.has(label)) return false;
	const cap = capability(label);
	return cap?.surface === 'label' && cap.verify === 'probe';
}
const derivationFailures = [];
for (const [name, m] of Object.entries(manifest.machines ?? {})) {
	const rec = m.$capabilities;
	if (!rec || !Array.isArray(rec.earned)) {
		derivationFailures.push(
			`${name} — cannot derive its label offer: ${
				rec ? '`$capabilities` carries no `earned` array' : 'no `$capabilities` record at all'
			}. ` +
				`\`nodeOffer\` fell back to the manifest's declared labels ` +
				`(${(m.labels ?? []).join(', ') || '(none)'}), which is the safe direction and not an ` +
				`answer. Run \`fleet bootcamp --write\` against it.`
		);
		continue;
	}
	const earned = new Set(rec.earned);
	const staleProof = (rec.prereqs ?? []).map((p) => p.id ?? p).filter((id) => !earned.has(id));
	if (staleProof.length) {
		derivationFailures.push(
			`${name} — \`$capabilities.earned\` is [${rec.earned.join(', ')}] but the node PROVED ` +
				`${staleProof.join(', ')}. That record was written by the pre-2026-09-10 producer, which ` +
				`promoted only \`proven ∩ declared\` among probeable LABEL capabilities — so the field the ` +
				`claw floor's eligibility input reads is empty on a node that passed every probe. Re-run ` +
				`\`fleet bootcamp --write\`.`
		);
	}
	// A MINT-ONLY LABEL IN `earned` IS THE RECORD LYING.
	//
	// `jit-canary` is proven by MINTING, so bootcamp has no probe that can put it
	// there — a record that carries it was written by something that is not this
	// bootcamp, or by one that promoted a declaration it read. Either way the
	// field the claw floor ranks on now contains a capability nothing executed,
	// and the fleet's one guarantee that the dispatcher works starts resting on a
	// declaration again. This is the direction the marker EXISTS to catch; the
	// declared-but-not-derived side it merely keeps quiet.
	for (const l of rec.earned) {
		if (!declarationIsRight(l)) continue;
		derivationFailures.push(
			`${name} — \`$capabilities.earned\` carries "${l}", which is MINT-ONLY: no probe can ` +
				`prove it, so bootcamp cannot have earned it. A record that claims it turns the one ` +
				`label that proves the dispatcher works back into a declaration. Re-run ` +
				`\`fleet bootcamp --write\` against it and find out what wrote that record.`
		);
	}
	const declared = m.labels ?? [];
	const derived = holdings[name];
	const lost = declared.filter((l) => !derived.includes(l) && !declarationIsRight(l));
	// A mint-only label (`jit-canary`) is DERIVED from the node's facts by
	// `nodeOffer` since 2026-10-09 — undeclared is the design, not a reader
	// still reading `labels`.
	const added = derived.filter(
		(l) =>
			!declared.includes(l) &&
			!ELIGIBILITY.has(l) &&
			!derivedByEarning(l, earned) &&
			!declarationIsRight(l)
	);
	for (const l of lost) {
		derivationFailures.push(
			`${name} — declares "${l}" and its derived offer does NOT carry it. A mint from the ` +
				`manifest would project a label the node has not proven; the derivation refuses it. ` +
				`bootcamp ${rec.at ?? '(undated)'} earned [${rec.earned.join(', ') || 'nothing'}].`
		);
	}
	for (const l of added) {
		derivationFailures.push(
			`${name} — its derived offer carries "${l}" and the manifest does not declare it, so a ` +
				`mint taken from the declared array alone would be missing it. Either the declaration ` +
				`was removed without this package being deployed, or a reader still reads \`labels\`.`
		);
	}
}

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

/** The bootcamp finding (or the declaration) that explains a node's label. */
function causeFor(node, label) {
	const m = manifest.machines?.[node];
	if (!m) return { kind: 'node-removed', why: `${node} is no longer in the manifest` };
	// `earned` FIRST, because it is the answer `nodeOffer` uses for anything a
	// probe can settle. A label that is both declared and earned got onto the
	// registration because the probe passed, and reporting the declaration as the
	// cause would send an operator to the manifest to explain a transition the
	// manifest did not cause.
	if ((m.$capabilities?.earned ?? []).includes(label)) {
		return { kind: 'earned', why: `earned in bootcamp — the probe for \`${label}\` passed` };
	}
	if ((m.labels ?? []).includes(label)) {
		return { kind: 'declared', why: `declared in the manifest's \`labels\` array` };
	}
	const rec = m.$capabilities;
	if (!rec) {
		return {
			kind: 'no-finding',
			why: 'no bootcamp finding on record — run `fleet bootcamp --write`',
		};
	}
	const blocked = (rec.blocked ?? []).map((b) => b.id ?? b);
	const unprobed = rec.unprobed ?? [];
	const prereqs = (rec.prereqs ?? []).map((p) => p.id ?? p);
	return {
		kind: 'bootcamp',
		at: rec.at ?? null,
		by: rec.by ?? null,
		blocked,
		unprobed,
		prereqs,
		why:
			blocked.length || unprobed.length
				? `bootcamp ${rec.at ?? '(undated)'} — blocked ${blocked.join(', ') || '(none)'}, ` +
					`unprobed ${unprobed.join(', ') || '(none)'}`
				: `bootcamp ${rec.at ?? '(undated)'} — proves ${prereqs.join(', ') || '(nothing required)'}`,
	};
}

const transitions = [];
if (previousHoldings) {
	const nodes = [...new Set([...Object.keys(previousHoldings), ...Object.keys(holdings)])].sort();
	for (const node of nodes) {
		const before = new Set(previousHoldings[node] ?? []);
		const after = new Set(holdings[node] ?? []);
		for (const label of [...after].filter((l) => !before.has(l)).sort()) {
			transitions.push({ node, label, change: 'gained', cause: causeFor(node, label) });
		}
		for (const label of [...before].filter((l) => !after.has(l)).sort()) {
			transitions.push({ node, label, change: 'lost', cause: causeFor(node, label) });
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
 * Labels offered ONLY by nodes that mint — an ephemeral claw or an on-demand
 * guest.
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
		const offerers = offerersOf(l);
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
const nothingOffers = dependencies.filter((l) => offerersOf(l).length === 0);

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

/**
 * Nodes held out of service, read exactly like `fleet drain` — this is a
 * standalone script with no in-process host to inject the path, so it resolves
 * the same two locations `drain-node.mjs` does. A parse failure THROWS: an
 * unreadable drain file must not read as "nothing is drained" and wave a
 * holder through that somebody has a screwdriver in.
 */
function drainedNodeNames() {
	return new Set(Object.keys(readDrains()));
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
			// as a failure naming why, not skipped.
			residentFailures.push(
				`"${repo}" — could not read its runner registrations from GitHub ` +
					`(${String(probe.error ?? '')
						.trim()
						.slice(0, 160)}). Declared holder(s): ${holders.join(', ')}.`
			);
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
			residentFailures.push(
				`"${repo}" — resident holder(s) ${drainedHolders.join(', ')} are DRAINED. ` +
					`The rule is at least two holders and never a drained one: drain a ` +
					`replacement holder in first, then drain this one.`
			);
		}
		if (online.length < 2) {
			residentFailures.push(
				`"${repo}" — only ${online.length} of its declared resident holder(s) ` +
					`(${holders.join(', ')}) are online carrying ${BUILDER_LABEL}. Need at ` +
					`least 2: this is the fleet's ONE backstop repo and a single holder is the ` +
					`single point of failure the 2026-09-07 move off claw-1 exists to remove.`
			);
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

/**
 * THE ONE STDOUT WRITE IN `--json` MODE.
 *
 * Every branch below already prints its diagnosis to STDERR and exits; this
 * adds the machine-readable half beside it without moving a single line of that
 * prose. `verdict` is what the gate concluded, `transitions` and `holdings`
 * ride on EVERY outcome — a demotion is exactly as worth reviewing on a run
 * that failed for some other reason.
 */
function emitJson(verdict, extra = {}) {
	if (!JSON_OUT) return;
	emitter.emit({
		ok: verdict === 'ok',
		verdict,
		dependencies,
		unoffered,
		missing,
		servedByMintOnly: [...servedByMintOnly],
		runtimeWatched: [...runtimeWatched],
		floorDemandPath: FLOOR_DEMAND_PATH,
		floorDemandWriteError,
		persistedStaticError,
		unread,
		noWorkflows,
		unresolvable,
		demandSources,
		historical: historical.map((l) => ({
			label: l,
			observed: demandSources[l].observed,
			lastObserved: observed?.last.get(l) ?? null,
		})),
		observedRows: observed?.rows ?? null,
		observedMalformed: observed?.malformed ?? null,
		observedError,
		transitions,
		holdings,
		holdingsPath: HOLDINGS_PATH,
		holdingsError,
		requiredSet: [...requiredSet].sort(),
		derivationFailures,
		contractVerdicts,
		eligible: eligibleNodes,
		disqualified: disqualifiedNodes,
		unverified: unverifiedNodes,
		held: emitter.held(),
		...extra,
	});
}

// A repo not on disk is a repo whose labels were NOT READ, and a gate that could
// not look must never report success — that is how this one passed on its first
// run having examined a single repository. Reported as a failure, with the
// resolved path, so the cause is visible rather than inferred.
if (unread.length) {
	console.error(`✗ ${unread.length} fleet repo(s) whose shipped workflows could not be read:`);
	for (const name of unread) console.error(`  ${name}: ${unreadWhy.get(name)}`);
	console.error(
		`\n  This gate reads workflow labels from each repo's default branch. Unreadable ones\n` +
			`  mean their labels were not examined, so a pass here would be meaningless.`
	);
	emitJson('unread');
	process.exit(1);
}
// AN EMPTY ROSTER READ ONLY THE SITE, and passed. The coverage file is
// generated; one that lists no repo is a failed generation, not a fleet with
// one repo in it.
if (!coveredRepos.length) {
	console.error(
		`✗ ${COVERAGE} lists no covered repos — this gate would have read only the site checkout\n` +
			`  and called that the fleet's demand. Regenerate it with \`fleet reconcile --write-coverage\`.`
	);
	emitJson('empty-roster');
	process.exit(1);
}
if (noWorkflows.length) {
	console.error(
		`✗ ${noWorkflows.length} covered repo(s) ship no .github/workflows on their default branch:\n` +
			`  ${noWorkflows.join(', ')}\n\n` +
			`  A covered repo is covered because its workflows run on the fleet, so its demand\n` +
			`  was not read.`
	);
	emitJson('no-workflows');
	process.exit(1);
}
if (unresolvable.length) {
	console.error(`✗ ${unresolvable.length} job(s) whose \`runs-on\` resolves to no label:\n`);
	for (const u of unresolvable) console.error(`  unresolvable runs-on in ${u}`);
	console.error(
		`\n  A \`runs-on\` this gate cannot read is demand it did not count. It is a finding, not\n` +
			`  "this job asks for nothing" — a scope that shrinks on a shape the reader does not\n` +
			`  know is how the old reader missed \`jdk21\` and \`cargo-bevy\`. Teach\n` +
			`  scripts/lib/runs-on-demand.mjs the shape, or write the labels as a JSON array literal.`
	);
	emitJson('unresolvable-runs-on');
	process.exit(1);
}
if (observedError) {
	console.error(`✗ observed demand: ${observedError}.`);
	console.error(
		`\n  The labels jobs actually requested are half of this gate's scope; without them only\n` +
			`  the static read of the workflows counts, and a \`runs-on\` resolved at run time is\n` +
			`  invisible. Point HADOKU_STATE_DIR at mgmt-api's state directory.`
	);
	emitJson('observed-unreadable');
	process.exit(1);
}
if (historical.length) {
	log(
		`historical demand only (${historical.length}) — nothing offers it and no shipped workflow asks for it:`
	);
	for (const l of historical) {
		log(
			`  "${l}" — ${demandSources[l].observed} job(s) in ${RETENTION_DAYS}d, last ${observed?.last.get(l) ?? '?'}; ` +
				`ages out of the window`
		);
	}
}
if (unoffered.length) {
	console.error(`\u2717 ${unoffered.length} routing dependency NOTHING in the fleet offers:\n`);
	for (const l of unoffered) {
		console.error(
			`  "${l}" \u2014 a covered repo's workflow asks for it and no machine declares it,\n` +
				`    earned it in bootcamp, or is eligible for it. A job on this label is not\n` +
				`    slow, it is UNPLACEABLE \u2014 it queues until somebody cancels it, which is the\n` +
				`    854 minutes hadoku-games-host sat for 32 seconds of work.`
		);
	}
	console.error(
		`\n  Fix: give a machine the capability (\`fleet bootcamp --write\` once it can prove it),\n` +
			`  or stop the workflow asking for it. This gate deliberately does NOT drop the label\n` +
			`  from its dependency set just because nothing offers it \u2014 that is how a gate gets\n` +
			`  easier to pass the worse the fleet gets.`
	);
	emitJson('unoffered');
	process.exit(1);
}
if (missing.length) {
	console.error(`✗ the runtime label floor will not see ${missing.length} routing dependency:\n`);
	for (const l of missing) {
		const asked = demandSources[l];
		console.error(
			`  "${l}" — requested (${asked.static.length} job(s) in workflows, ${asked.observed} ` +
				`observed in ${RETENTION_DAYS}d) and offered by ${offerersOf(l).join(', ')}, but runner-health\n` +
				`    watches observed demand plus ${FLOOR_DEMAND_PATH}, and this label is in neither, so\n` +
				`    the last runner offering it can go dark with no alert. That is exactly how taskauto\n` +
				`    queued for 6h45m on 2026-08-26.`
		);
	}
	console.error(
		`\n  Fix: the persisted static demand is ${
			floorDemandWriteError
				? `UNWRITABLE (${floorDemandWriteError})`
				: persistedStaticError
					? `unreadable (${persistedStaticError})`
					: 'out of date'
		}. Make ${FLOOR_DEMAND_PATH} writable and re-run.`
	);
	emitJson('missing');
	process.exit(1);
}
if (residentFailures.length) {
	console.error(`✗ resident backstop floor: ${residentFailures.length} problem(s):\n`);
	for (const f of residentFailures) console.error(`  ${f}`);
	console.error(
		`\n  Fix: see "the resident backstop" in @wolffm/fleet-manager's docs/VOCABULARY.md\n` +
			`  for how to move it — edit the two \`residentRepos\` entries, ` +
			`\`fleet reconcile --confirm\`,\n  then verify against the GitHub API, not the manifest.`
	);
	emitJson('resident-backstop', { residentFailures });
	process.exit(1);
}
if (ledgerError) {
	console.error(`✗ could not read the demand ledger: ${ledgerError}`);
	console.error(
		`\n  \`hadoku-builder\`'s required set is derived from ` +
			`${join(stateDir(), 'demand-ledger.jsonl')}, and a ledger this gate cannot fully\n` +
			`  parse must not silently under-count demand and pass. Fix or regenerate it with\n` +
			`  \`fleet tool-inventory --write\`.`
	);
	emitJson('ledger-unreadable', { ledgerError });
	process.exit(1);
}
if (!ledgerRecords) {
	console.error(`✗ no demand ledger at ${join(stateDir(), 'demand-ledger.jsonl')}`);
	console.error(
		`\n  \`hadoku-builder\`'s required set (P1.2/P1.3) is derived from it, and this gate\n` +
			`  cannot check the required-set floor without it. Run \`fleet tool-inventory --write\`\n` +
			`  first.`
	);
	emitJson('ledger-missing');
	process.exit(1);
}
// A LEDGER THAT PARSED AND ASKED FOR NOTHING IS THE THIRD CASE, and it used to
// be the silent one: `unprovenRequired` returns `[]` for an empty set, so the
// gap check below passed having checked nothing. Every node clears a bar of
// zero. Settled in wave 3a — an empty required set is a failure, not a pass —
// and it is now the SAME refusal the fast loop makes (`nodeFailsBootcamp`),
// so the gate and the loop agree about a bar neither can enforce.
const emptyRequired = emptyRequiredSetReason(requiredSet, {
	path: join(stateDir(), 'demand-ledger.jsonl'),
	records: ledgerRecords,
});
if (emptyRequired) {
	console.error(`✗ ${emptyRequired}`);
	emitJson('required-set-empty', { emptyRequired });
	process.exit(1);
}
if (requiredGaps.length) {
	console.error(`✗ ${requiredGaps.length} demanded capability no node proves:\n`);
	for (const id of requiredGaps) {
		console.error(
			knownProbeableIds.has(id)
				? `  "${id}" — the demand ledger says a covered repo's job needs it on the general\n` +
						`    pool, and no node's \`fleet bootcamp --write\` finding proves it. That is\n` +
						`    the shape of the 2026-09-02 claw-5/claw-6 outage: registered, carrying\n` +
						`    hadoku-builder, no Python tool cache at all.`
				: `  "${id}" — the demand ledger asks for it and NOTHING in src/capabilities.ts\n` +
						`    registers it, so no probe can ever prove it. Both python-toolcache/\n` +
						`    playwright/ffmpeg started exactly here before a job died on them.`
		);
	}
	console.error(
		`\n  Fix: run \`fleet bootcamp --write\` on a node that should carry it, or — if it is\n` +
			`  genuinely new — register it in src/capabilities.ts and add it to\n` +
			`  \`toolchain.capabilities\` in fleet-runner-manifest.json.`
	);
	emitJson('required-gap', { requiredGaps });
	process.exit(1);
}
if (derivationFailures.length) {
	console.error(
		`\u2717 the derived label offer and the manifest disagree on ${derivationFailures.length} point(s):\n`
	);
	for (const f of derivationFailures) console.error(`  ${f}`);
	console.error(
		`\n  WHY THIS FAILS THE GATE (issue #19). The manifest's \`labels\` array is the JIT\n` +
			`  mint's label WRITER \u2014 fleet-loop -> ephemeral-tick -> dispatch-pass ->\n` +
			`  mintLabels() \u2014 and it is ALSO read by placement and by floor-probe. Since\n` +
			`  2026-09-10 src/capabilities.ts's \`nodeOffer\` derives that set from\n` +
			`  \`$capabilities.earned\` instead. If the two disagree, one of them is wrong about\n` +
			`  what GitHub will see, and the symptom is jobs queueing silently while this gate\n` +
			`  reports a healthy fleet \u2014 which is exactly what it did on a stripped manifest\n` +
			`  before this check existed.\n\n` +
			`  Fix: run \`fleet bootcamp --write\` against the node(s) named above, then re-run.`
	);
	emitJson('derivation-disagreement', { derivationFailures });
	process.exit(1);
}
log(
	`✓ label floor covers every routing dependency: ${dependencies.join(', ') || '(none)'}` +
		`\n  floor model: each is served by a standing online runner OR an eligible minting node that offers it:` +
		dependencies
			.map((l) => {
				const offerers = offerersOf(l);
				const minting = offerers.filter((n) => mintsJitRunners(manifest.machines?.[n]));
				const standing = offerers.filter((n) => !minting.includes(n));
				return `\n    ${l}: standing ${standing.join(', ') || '(none)'}; minting ${minting.join(', ') || '(none)'}`;
			})
			.join('') +
		(residentHolders.size
			? `\n  (resident backstop: ${[...residentHolders].map(([r, h]) => `${r} on ${h.join('+')}`).join(', ')})`
			: '') +
		(servedByMintOnly.size
			? `\n  served by minting alone, by decision (#120): ${[...servedByMintOnly].sort().join(', ')}`
			: '') +
		`\n  required set (from the demand ledger): ${[...requiredSet].sort().join(', ') || '(none)'}` +
		(eligibleNodes.length
			? `\n  ${BUILDER_LABEL} — which nodes hold it and WHY:\n` +
				eligibleNodes
					.sort((a, b) => a.name.localeCompare(b.name))
					.map((n) => `    ${n.name}: proves ${n.prereqs.join(', ') || '(nothing required)'}`)
					.join('\n')
			: '') +
		(disqualifiedNodes.length
			? `\n  ${BUILDER_LABEL} — disqualified:\n` +
				disqualifiedNodes
					.sort((a, b) => a.name.localeCompare(b.name))
					.map(
						(n) =>
							`    ${n.name}: blocked ${n.blocked.join(', ') || '(none)'}, unprobed ${n.unprobed.join(', ') || '(none)'}`
					)
					.join('\n')
			: '') +
		(unverifiedNodes.length
			? `\n  ${BUILDER_LABEL} — no recorded finding yet (run \`fleet bootcamp --write\`): ` +
				unverifiedNodes.sort().join(', ')
			: '') +
		// THE CONSUMER CONTRACT, evaluated per node on live data. The rule is
		// settled and enforced by the fast loop (see `contractVerdicts`); this is
		// where the verdict is visible on live data before the next tick acts.
		(contractVerdicts.length
			? `\n  consumer contract (a node carries ${BUILDER_LABEL} iff it proves the required set):\n` +
				contractVerdicts.map((v) => `    ${v.name}: ${v.ok ? 'proves it' : v.reason}`).join('\n') +
				`\n    ENFORCED by the fast loop since wave 3c §G — \`nodeFailsBootcamp\` asks this` +
				`\n    same predicate, so a node reported here as not proving it is demoted on the` +
				`\n    next tick. A node with NO recorded finding still fails OPEN, by design, and` +
				`\n    is listed above under "no recorded finding yet".`
			: '')
);
emitJson('ok');
