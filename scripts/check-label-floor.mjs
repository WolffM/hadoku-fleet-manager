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
import { readFileSync } from 'node:fs';
import { manifest as manifestFile } from '../dist/lib/fleet-paths.js';
import { loadManifest } from './lib/fleet-exec.mjs';
import { isFloorDemandLabel } from '../dist/label-floor.js';
import { createEmitter } from './lib/emit.mjs';
import { eligibilityOf, holdingsOf } from './lib/label-floor-holdings.mjs';
import { trackLabelTransitions } from './lib/label-floor-transitions.mjs';
import { collectDemand } from './lib/label-floor-demand.mjs';
import { persistAndWatchDemand } from './lib/label-floor-persist.mjs';
import { checkResidentFloor } from './lib/label-floor-resident.mjs';
import { requiredSetAndVerdicts } from './lib/label-floor-required.mjs';
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

const COVERAGE = manifestFile('fleet-runner-coverage.json');

/**
 * Not implicit (`self-hosted`/`Linux`/`X64`, case-insensitive) and not a hosted
 * image. IMPORTED from the module runner-health judges with, so the gate and
 * the runtime floor cannot disagree about what counts as demand.
 */
const isDemandLabel = isFloorDemandLabel;

const manifest = loadManifest();

/**
 * Which nodes hold `hadoku-builder` and WHY, and WHO OFFERS A LABEL once
 * labels are DERIVED rather than DECLARED — moved to
 * `lib/label-floor-holdings.mjs` (wave shrink-1 lane D, pure move); see that
 * file for the doc comment on `nodeFailsBootcamp` parity, `servedByMintOnly`
 * honesty and why `nodeOffer` is the one answer rather than a second
 * derivation (issue #19).
 */
const { eligibleNodes, unverifiedNodes, disqualifiedNodes } = eligibilityOf(manifest);
const holdings = holdingsOf(manifest, eligibleNodes);

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
 * EVERY LABEL TRANSITION SINCE THIS GATE LAST RAN, moved to
 * `lib/label-floor-transitions.mjs` (wave shrink-1 lane D, pure move) — see
 * that file for why this never fails the gate, where the state lives, and
 * why a baseline run and an unreadable snapshot are reported differently.
 */
const {
	transitions,
	holdingsError,
	holdingsPath: HOLDINGS_PATH,
} = trackLabelTransitions(manifest, holdings, log);

/**
 * THE DEMAND, FROM TWO SOURCES (#98) — what workflows CAN ask for (static,
 * through shipped workflows) and what jobs DID ask for (observed, through
 * job history) — and the mint-only/unoffered splits derived from their
 * union. Moved to `lib/label-floor-demand.mjs` (wave shrink-1 lane D, pure
 * move); see that file for the full rationale.
 */
const coverage = JSON.parse(readFileSync(COVERAGE, 'utf8'));
const coveredRepos = coverage.repos ?? [];
const {
	demandSources,
	unread,
	unreadWhy,
	noWorkflows,
	unresolvable,
	observed,
	observedError,
	dependencies,
	servedByMintOnly,
	nothingOffers,
} = collectDemand(manifest, holdings, coveredRepos, isDemandLabel);

/**
 * THE STATIC HALF, PERSISTED FOR THE RUNTIME FLOOR, plus the read-back that
 * computes what the runtime floor actually watches and the historical/
 * unoffered split. Moved to `lib/label-floor-persist.mjs` (wave shrink-1
 * lane D, pure move); see that file for why the write happens only from a
 * COMPLETE static read.
 */
const {
	FLOOR_DEMAND_PATH,
	historical,
	unoffered,
	floorDemandWriteError,
	persistedStaticError,
	runtimeWatched,
	missing,
} = persistAndWatchDemand({
	demandSources,
	nothingOffers,
	coveredRepos,
	unread,
	noWorkflows,
	unresolvable,
	observed,
	dependencies,
});

/**
 * RESIDENT FLOOR — the fleet's ONE backstop, moved to
 * `lib/label-floor-resident.mjs` (wave shrink-1 lane D, pure move). See that
 * file for why it reads GitHub directly rather than trusting the manifest,
 * and the "at least two holders, never a drained one" rule (WS-R,
 * 2026-09-07).
 */
const { residentHolders, residentFailures } = await checkResidentFloor(
	manifest,
	gateFindings,
	gateUnreadable
);

/**
 * `hadoku-builder`'s required set (derived from the demand ledger, never
 * declared), its per-node contract verdicts, and the empty-required-set
 * failure. Moved to `lib/label-floor-required.mjs` (wave shrink-1 lane D,
 * pure move); see that file for P1.2/P1.3 and why an empty required set
 * fails the gate rather than passing having checked nothing.
 */
const {
	ledgerRecords,
	ledgerError,
	requiredSet,
	knownProbeableIds,
	requiredGaps,
	contractVerdicts,
	emptyRequired,
} = requiredSetAndVerdicts(manifest);

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
