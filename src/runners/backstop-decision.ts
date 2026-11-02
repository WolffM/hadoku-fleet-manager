import { logger, postDiscord as postDiscordSink } from '../host.js';
import { type GhRunner } from '../lib/github-client.js';
import { withGhCaller } from '../gh-budget.js';
import { nodeOf } from './census.js';
import { BUILDER_LABEL } from '../lib/capability-registry-ids.js';
import { clawsAreHealthy, decideBackstop, hostMayTakeSaturation } from './backstop.js';
import {
	isBackstopNode,
	mintsOnDemand,
	type MintBearingNode,
	type RoleBearingNode,
} from '../lib/node-role.js';
import { backstopHold, setBackstopHold } from './backstop-hold.js';
import { describeForce, isForced, readForce, type ForceState } from './backstop-force.js';
import { nodeIsSick } from '../lib/sick-node.js';
import { isDraining, readDrain } from './drain.js';
import { nodeReservation } from '../node-reservation.js';
import { backstopMachinesReader } from './backstop-machines.js';
import { subCadenceDue, markSubCadence, __resetSubCadenceKeyForTesting } from '../lib/every.js';
import { selfHostname } from '../lib/runner-health-shared.js';
import type { TickReport } from '../runner-health-snapshot.js';

import { readHostLoad } from './backstop-host-load.js';

import { syncBackstopAcrossFleet } from './backstop-fanout.js';

import { probeQueuePressure, QUEUE_ZOMBIE_SECONDS } from './backstop-queue-probe.js';

import {
	getBackstopFleetState,
	setBackstopFleetState,
	getBackstopAlerted,
	setBackstopAlerted,
	getBackstopCalmTicks,
	setBackstopCalmTicks,
	getBackstopLastReason,
	setBackstopLastReason,
	getQueueZombiesLogged,
	setQueueZombiesLogged,
	getReservationOverride,
	__resetBackstopDecisionStateForTesting,
} from './backstop-decision-state.js';

import {
	checkCapacityInvariant,
	__resetCapacityInvariantForTesting,
} from './backstop-decision-capacity.js';

import { logBackstopEligibility } from './backstop-decision-report.js';
import { applyBackstopLabels } from './backstop-decision-labels.js';

/**
 * When the fan-out last READ the fleet's registrations, rather than trusting
 * `getBackstopFleetState()`.
 *
 * THE BELIEF IS THE BUG THIS BOUNDS. The fan-out ran only on a change of that
 * boolean, so it only ever looked when IT had changed its own mind — and a
 * label written by anything else was invisible to it for as long as its mind
 * stayed made up. Measured 2026-09-10 → 09-19: the retired tier ladder's
 * 13:00 prewarm put `hadoku-builder` on hokon across the fleet, the ID-based
 * loop below stripped it from the hub repo within five minutes each day
 * (`BACKSTOP demote: N claw(s) online`, 09-17/18/19), and the other 26 repos
 * kept it for DAYS — 165 of the 169 non-prewarm builder jobs hokon served in
 * that window ran on repos the fan-out never looked at. The only lines in any
 * retained log that cleared them (`BACKSTOP fleet demote: 26/27 runner(s)`,
 * 09-18T19:29Z, 09-18T21:47Z, 09-19T20:51Z) are restarts, which set the belief
 * to `null` and forced a converge by accident.
 *
 * The ladder is gone and nothing else writes this label on a backstop today (the
 * fast loop skips backstops — `fleet-loop.ts`, `if (backstopNodes.has(node))
 * continue`). That makes the sweep below a guard against a writer that does
 * not currently exist, which is exactly what it should be: the reader for this
 * facet now reads the REGISTRATIONS, not its own record of what it wrote, so a
 * divergence from any source is bounded by this interval instead of being
 * permanent.
 *
 * ARITHMETIC, because a cadence is a budget. One GET per fleet repo, 27 repos,
 * at most once an hour = 27 calls/hr against 5,000 — and only in the
 * backstop-DOWN state, since while it is up the existing re-assert already
 * converges every tick. It is deliberately much slower than the 10-minute tick
 * for that reason: the fault it catches is rare and its cost is measured in
 * hours of exposure, not seconds of latency.
 *
 * NOT `subCadence` (`lib/every.ts`, wave5m lane C): that primitive marks the
 * moment it answers due, and this gate must not — "only claim the state once
 * nothing failed, so a partial fan-out is retried next tick instead of being
 * recorded as done" (below). `subCadenceDue`/`markSubCadence` are the same
 * clock with the mark pulled out to this file's own success branch, which is
 * exactly the split this gate needs.
 */
const CONVERGE_CADENCE_NAME = 'backstop-decision:converge';

/** @see CONVERGE_CADENCE_NAME — how stale the fan-out's reading may get. */
export const BACKSTOP_CONVERGE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Cross-tick memory this file reads/writes lives beside the functions that
 * own it — `backstop-decision-state.ts` (getBackstopFleetState etc.) and
 * `backstop-decision-capacity.ts` (the ledger invariant); see each module's
 * own doc.
 *
 * Check 1 — the label floor: is every DEMANDED routing label SERVED — carried
 * by a standing online runner, or offered by a minting node the dispatcher
 * could mint on now? One rule for every label; see `label-floor.ts`.
 *
 * EXCEPT `hadoku-builder` (retired 2026-09-08, decision C0b): it is still
 * MEASURED and JUDGED here but never alerted on. `check-queue-health` owns
 * that page now. See `claw-floor-design-2026-09-07.md` §10 and the comment
 * inside the loop below.
 *
 * Extracted from tick() on 2026-08-28. tick() was 830 lines holding three
 * unrelated checks plus its own reporting, which is why the only way to test any
 * part of it was to drive the whole thing — 82 of this suite's tests do exactly
 * that, and they are what verifies this extraction changed nothing.
 *
 * `data` is the shared report payload and is mutated by reference. The three
 * returned facts are the ENTIRE remaining data flow across the seam; everything
 * else in here is local, which is what made the split safe to do mechanically.
 */

export async function runBackstopDecision(args: {
	token: string;
	fleetRepos: string[];
	data: TickReport;
	clawsOnline: number;
	clawsRegistered: number;
	clawsFree: number;
	ephemeralUnknown: boolean;
	pm2BusyNodes: Set<string>;
	fleetNodes: string[];
	backstopPool: GhRunner[];
	has: (r: GhRunner, label: string) => boolean;
}): Promise<void> {
	const {
		token,
		fleetRepos,
		data,
		clawsOnline,
		clawsRegistered,
		clawsFree,
		ephemeralUnknown,
		pm2BusyNodes,
		fleetNodes,
		backstopPool,
		has,
	} = args;
	// Two independent reasons to want the backstop up, kept distinct because they
	// warrant different noise: an OUTAGE is an incident the operator should see,
	// SATURATION is ordinary load and pages nobody.
	//
	// WHAT DECIDES WHETHER TO PROBE IS WHAT THE ANSWER CAN CHANGE, AND
	// `atCapacity` IS NOT THAT.
	//
	// This gate read `isAtCapacity(...)` until 2026-09-24, so off-capacity the
	// queue was handed to `decideBackstop` as the literal 0 and `saturated`
	// could not be true there — the caller answering the function's question
	// for it, and silently undoing the fix the function took on 2026-09-01.
	// That fix removed `atCapacity` as a precondition BECAUSE census.ts folds
	// mintable slots into `clawsFree`: once enough of the fleet is JIT the
	// count never reaches zero, so the one state this caller was willing to
	// pay for never arrives. On 2026-09-01, three of four nodes ephemeral, 13
	// jobs sat 11-19 minutes across nine repos while `clawsFree` never hit
	// zero and this line passed 0 (#63).
	//
	// Two states still skip the probe, and NEITHER of them is "a claw was
	// free":
	//   - an OUTAGE. There is nothing to queue BEHIND a fleet with nowhere to
	//     run, `decideBackstop` promotes on the outage alone, and waiting to
	//     observe a queue would add the threshold to every job's latency
	//     during the incident. Skipping here BUYS latency; it does not save a
	//     call that mattered.
	//   - UNMEASURED counts. `decideBackstop` returns on `ephemeralUnknown`
	//     before it ever reads `queuePressureSec`, holding the previous
	//     answer, so a probe there is one listing per repo spent on an input
	//     nothing consumes — and runner-health's first tick after every
	//     mgmt-api restart lands in that window.
	//
	// BUDGET, sized as if every listing were charged: `probeQueuePressure`
	// goes through `ghGet`, which revalidates with an ETag, so an unchanged
	// queue is free — but a moving one is not, and the ceiling is what a
	// cadence answers to. One listing per repo, breaking at the first run
	// over the threshold, on runner-health's own 10-minute tick —
	// 26 covered repos x 6 ticks/hr = 156 calls/hr against 5,000/hr, 3.1%,
	// and that is the WORST case: a fleet actually backed up breaks early and
	// costs LESS. No timer changed here, so nothing else hanging off this
	// tick moved with it. Asserted in runner-health.test.ts.
	//
	// AND A DAYS-OLD QUEUED RUN IS NOT PRESSURE, which is what made the
	// unconditional probe a regression rather than a fix. See
	// `QUEUE_ZOMBIE_SECONDS`: from 2026-09-25 this line returned ~3.5 MILLION
	// seconds every tick off two runs that have been `queued` and
	// uncancellable since 2026-08-17/19, so `saturation` was permanently true
	// and hokon carried `hadoku-builder` continuously. The probe is right to be
	// unconditional; it was reading the wrong population.
	const fleetIsUp = clawsAreHealthy(clawsOnline, clawsRegistered);
	const queue =
		fleetIsUp && !ephemeralUnknown
			? await probeQueuePressure(token, fleetRepos, Date.now())
			: { pressureSec: 0, zombies: 0, oldestZombieSec: 0 };
	const queuePressureSec = queue.pressureSec;

	// SAY WHAT WAS REFUSED, ONCE PER CHANGE. A zombie stays a zombie — that is
	// what makes it one — so a line every tick is six an hour forever and the
	// fleet's own logs become the thing nobody reads (`dispatch-tick.ts` learned
	// this about the same two runs). But silence here is the failure this whole
	// file is about: the operator had no way to know the saturation trigger was
	// reading a 40-day-old run, and the only number printed was the inflated
	// one. Logged when the count MOVES, and carried on the snapshot every tick.
	if (queue.zombies !== getQueueZombiesLogged()) {
		setQueueZombiesLogged(queue.zombies);
		if (queue.zombies > 0) {
			logger.warn(
				`[runner-health] queue probe ignored ${queue.zombies} run(s) queued longer than ` +
					`${Math.round(QUEUE_ZOMBIE_SECONDS / 3600)}h (oldest ` +
					`${Math.round(queue.oldestZombieSec / 86400)}d) — a run that old is STUCK, not ` +
					'starved, and the backstop cannot serve it. Saturation is decided on the ' +
					`remainder: ${queuePressureSec}s`
			);
		} else {
			logger.info('[runner-health] queue probe: no zombie runs left to ignore');
		}
	}

	// The reservation ladder — pm2-host > builder > taskauto. hokon's nightly
	// crons are Temporal work GitHub cannot see, so no label or queue signal
	// reveals them; only this does. It gates the BACKSTOP, which is the only
	// writer of `hadoku-builder` on the pool.
	//
	// PER NODE on the pm2-host rung, fleet-wide on the cron ones. The pool is
	// held off builder work by `pm2-host` only when EVERY node in it is serving
	// that rung — one free holder means the backstop still has somewhere to go,
	// and the busy holder is skipped individually in the loop below. The cron
	// rungs have no node to key on (one mgmt-api, one profiles.json), so they
	// reserve the whole pool exactly as before.
	//
	// `poolNodes` is every NODE the pool sits on in listing order — the prod
	// host carries several registrations, so it repeats, and `backstopNodes` is
	// that folded to machines.
	const poolNodes = backstopPool.map((r) => nodeOf(r.name, fleetNodes));
	// THE MANIFEST'S BACKSTOPS AS WELL AS THE POOL'S NODES (#120). The pool is
	// read off registrations, and an on-demand backstop's whole point is to keep
	// none — so a node that retired its standing runners would otherwise
	// vanish from the backstop the moment it stopped squatting on memory.
	const machines = backstopMachinesReader();
	const backstopNodes = [
		...new Set([
			...poolNodes,
			...Object.entries(machines ?? {})
				.filter(([, m]) => isBackstopNode(m as RoleBearingNode))
				.map(([n]) => n),
		]),
	];
	// Promoted by the HOLD alone: the dispatcher mints for it, so nothing here
	// may write `hadoku-builder` onto one of its registrations — the one it
	// keeps (`standingRepos`) is a deploy runner, and labelling it would put
	// builder work on a listener outside the mint path and its slice.
	const onDemand = (node: string): boolean =>
		mintsOnDemand(machines?.[node] as MintBearingNode | undefined);
	// "I could not look" writes no label. Without the manifest a deploy runner
	// and a backstop registration look identical — both carry `pm2-host` — so a
	// promotion here would label whichever the pool happens to hold.
	const labelsMayPromote = (node: string): boolean => machines !== null && !onDemand(node);
	if (machines === null) {
		logger.warn(
			'[runner-health] BACKSTOP could not read the manifest — writing no builder label this ' +
				'tick (a deploy runner is indistinguishable from a backstop registration without it)'
		);
	}
	const poolPm2Busy = backstopNodes.length > 0 && backstopNodes.every((n) => pm2BusyNodes.has(n));
	const reservation = (getReservationOverride() ?? ((busy) => nodeReservation(new Date(), busy)))(
		poolPm2Busy
	);

	const backstopInput = {
		clawsOnline,
		clawsRegistered,
		clawsFree,
		queuePressureSec,
		reserved: reservation.reserved,
		// Do not act on capacity that was never measured. Null probe =>
		// every claw count is a floor, not a reading.
		ephemeralUnknown: ephemeralUnknown,
	};
	const decision = decideBackstop(backstopInput, {
		calmTicks: getBackstopCalmTicks(),
		lastReason: getBackstopLastReason(),
		promoted: getBackstopFleetState(),
	});
	setBackstopCalmTicks(decision.next.calmTicks);
	setBackstopLastReason(decision.next.lastReason);

	const outage = decision.outage;
	const backstopWanted = decision.wanted;
	const backstopReason = decision.reason;
	data.queue_pressure_sec = queuePressureSec;
	data.queue_zombies_ignored = queue.zombies;
	data.at_capacity = decision.atCapacity;
	data.reserved_reason = reservation.reserved ? reservation.reason : null;
	data.backstop_reason = backstopReason;
	data.backstop_calm_ticks = getBackstopCalmTicks();

	// Tell the fast loop before touching a single label. The two are
	// phase-locked ~8s apart and the ladder does not know tier4 exists as far
	// as the backstop is concerned; without this it strips the label this loop
	// is about to write. Set on BOTH branches — a stale hold would pin hokon
	// eligible forever once the backstop stood down.
	//
	// PER NODE, and the hold and the write must use ONE predicate: a node the
	// pm2-host rung excludes is one the loop below is about to DEMOTE, and
	// holding it would tell the fast loop to preserve the label we are
	// removing. An OUTAGE overrules the rung for the reason `decideBackstop`
	// gives — a fleet with nowhere to run is worth interrupting for.
	//
	// A QUARANTINED OR DRAINED NODE IS NEVER PROMOTED, outage included. The
	// backstop is the ONLY writer of this label on the backstop node (the ladder skipped
	// backstops), so until 2026-09-21 the fleet loop's quarantine of hokon was a
	// log line and nothing else: on saturation this would have handed CI to a
	// node whose store the guard had flagged. hokon is a reserve, brought in
	// when work needs it — which is exactly when it must be sound. The loop
	// keeps repairing it, so a sick reserve returns on its own. An outage with
	// the reserve also sick is the "no self-hosted capacity" case, which
	// CI_RUNNER's hosted flip already answers.
	const drain = readDrain();
	const unsafeNode = (node: string): boolean => nodeIsSick(node) || isDraining(node, drain);
	// IDLE (2026-10-09): saturation promotes the backstop host only while it
	// is quiet — see `isHostIdle`. Read locally (the backstop host is the
	// controller); a node this process cannot read is not idle.
	//
	// THE RED LIGHT IS THE DRAIN (operator, 2026-10-19: "a traffic signal that
	// just makes it so jobs dont go to hokon if we have it blocked"). It was a
	// manifest mode, `backstop: "outage-only"`, from 2026-10-09 — and hokon's
	// live entry never carried the key, so the block the operator asked for
	// was not in force for ten days. `fleet drain hokon` is the one switch:
	// `unsafeNode` refuses a drained node on an outage too, and the dispatcher
	// reads the same drain file for every mint.
	//
	// THE GREEN LIGHT IS THE FORCE (2026-10-21, `backstop-force.ts`). An
	// operator holding a node eligible beats the saturation decision and the
	// idle gate — that is what the switch is for — but NOT the drain or the
	// quarantine (red beats green) and NOT the pm2-host rung (a deploy on the
	// box finishes first, as the ladder orders). Read every tick like the
	// drain, so a force set between ticks takes effect on the next one and an
	// expired one lapses on its own. An unreadable file is NO force, said
	// aloud: a corrupt switch must neither route work nor vanish silently.
	let force: ForceState = {};
	try {
		force = readForce();
	} catch (err) {
		logger.warn(
			'[runner-health] BACKSTOP force file unreadable — treating no node as forced: ' +
				(err instanceof Error ? err.message : String(err))
		);
	}
	const forceNowMs = Date.now();
	const forcedOn = (node: string): boolean => isForced(node, force, forceNowMs);
	//
	// THE BACKLOG ESCALATION (2026-10-21, `hostMayTakeSaturation`): past
	// BACKLOG_QUEUE_SECONDS the load clause is waived — the same 300 s at
	// which ci:queue-health declares the fleet not serving work. Memory is
	// still required. One verdict with its reason, reused by REACHED NOBODY.
	const saturationHost = (node: string) =>
		hostMayTakeSaturation(readHostLoad(node), queuePressureSec);
	const wantedOnNode = (node: string): boolean =>
		((forcedOn(node) && !pm2BusyNodes.has(node)) ||
			(backstopWanted && (outage || (!pm2BusyNodes.has(node) && saturationHost(node).ok)))) &&
		!unsafeNode(node);
	const refused = backstopWanted ? backstopNodes.filter(unsafeNode) : [];
	if (refused.length) {
		logger.warn(
			`[runner-health] BACKSTOP wanted (${backstopReason}) but ${refused.join(', ')} ` +
				'is quarantined or drained — not promoting it'
		);
	}
	const heldNodes = backstopNodes.filter(wantedOnNode);
	// The hold's EDGES, for the nodes promoted by it alone. A relabelled node
	// announces itself through its label writes below; an on-demand one has
	// none, so without this its promotion — the 🔻 on an outage included —
	// would happen silently.
	const wasHeld = new Set(backstopHold());
	setBackstopHold(heldNodes);

	// A FORCE SAYS SO EVERY TICK IT IS IN EFFECT, held or refused. Six lines
	// an hour while an operator has the switch on is the cheapest possible
	// answer to "is it doing anything", and a refused force names the one
	// thing that outranks it — the same per-node spelling REACHED NOBODY uses.
	for (const node of backstopNodes.filter(forcedOn)) {
		const why = describeForce(node, force[node], forceNowMs);
		if (heldNodes.includes(node)) {
			logger.info(`[runner-health] BACKSTOP FORCED — ${why}`);
		} else {
			const blocker = nodeIsSick(node)
				? 'quarantined'
				: isDraining(node, drain)
					? 'drained (the red light beats the green one)'
					: pm2BusyNodes.has(node)
						? 'serving pm2-host (the deploy finishes first)'
						: 'unknown';
			logger.warn(`[runner-health] BACKSTOP FORCED but REFUSED (${blocker}) — ${why}`);
		}
	}

	// THE CAPACITY INVARIANT, PAGED (2026-10-21) — see `backstop-decision-
	// capacity.ts`'s own doc for the full reasoning (the 2026-10-07 bug this
	// guards against, and why a ledger older than two ticks pages elsewhere).
	await checkCapacityInvariant();

	// WHY THE PRODUCTION HOST IS REACHABLE, ON THE TICK IT IS REACHABLE — see
	// `backstop-decision-report.ts`'s own doc. `why` is reused in the demote
	// line further down, in the same tick.
	const why = logBackstopEligibility({
		backstopInput,
		decision,
		backstopWanted,
		heldNodes,
		outage,
		saturationHost,
		queuePressureSec,
		backstopNodes,
		drain,
		pm2BusyNodes,
	});

	// See `backstop-decision-labels.ts`'s own doc for the "could not look is
	// not an order" reasoning and the mint-hold edges folded in here.
	const { promoted, demoted } = await applyBackstopLabels({
		unmeasured: decision.unmeasured,
		backstopPool,
		fleetNodes,
		wantedOnNode,
		labelsMayPromote,
		has,
		token,
		heldNodes,
		onDemand,
		wasHeld,
	});

	// Fan the same decision out to the rest of the fleet. Edge-triggered, plus a
	// re-assert while up; see syncBackstopAcrossFleet for why this cannot be
	// derived from this repo's listing.
	//
	// The re-assert is only for a node the label PROMOTES. An on-demand backstop
	// is promoted by the hold above, and its sweep is demote-only — running it
	// every tick of a promotion would read the whole fleet's listings to change
	// nothing.
	const relabels = backstopNodes.some(labelsMayPromote);
	// The third condition is the VERIFY sweep — see `CONVERGE_CADENCE_NAME`.
	// The first two ask "did I change my mind?"; only this one asks "is the
	// fleet actually in the state I believe it is?", which is the question
	// the 165 jobs on 26 unlooked-at repos needed somebody to ask.
	const convergeDue = subCadenceDue(CONVERGE_CADENCE_NAME, BACKSTOP_CONVERGE_INTERVAL_MS);
	if (
		!decision.unmeasured &&
		(getBackstopFleetState() !== backstopWanted || (backstopWanted && relabels) || convergeDue)
	) {
		try {
			const fleet = await withGhCaller('backstop', () =>
				syncBackstopAcrossFleet(backstopWanted, token, fleetRepos, (name) => {
					const node = nodeOf(name, fleetNodes);
					return unsafeNode(node) || !labelsMayPromote(node);
				})
			);
			// Only claim the state once nothing failed, so a partial fan-out is
			// retried next tick instead of being recorded as done. Same rule for
			// the verify clock: a sweep that could not read every repo has not
			// verified anything, and must not buy itself another hour of silence.
			if (!fleet.failed.length) {
				setBackstopFleetState(backstopWanted);
				markSubCadence(CONVERGE_CADENCE_NAME);
			}
			if (convergeDue && fleet.changed.length && getBackstopFleetState() === backstopWanted) {
				// A divergence the belief could not have shown. Warn, not info:
				// somebody other than this function wrote the one label it owns.
				logger.warn(
					`[runner-health] BACKSTOP verify sweep found ${fleet.changed.length} ` +
						`registration(s) out of step with reason=${backstopReason} — ` +
						`${fleet.changed.join(', ')}. This label has one writer; something else moved it.`
				);
			}
			if (fleet.changed.length) {
				logger.info(
					`[runner-health] BACKSTOP fleet ${backstopWanted ? 'promote' : 'demote'}: ` +
						`${fleet.changed.length} runner(s) — ${fleet.changed.join(', ')}`
				);
			}
			if (fleet.failed.length) {
				logger.warn(
					`[runner-health] BACKSTOP fleet ${backstopWanted ? 'promote' : 'demote'} FAILED on ` +
						`${fleet.failed.length}: ${fleet.failed.join(', ')} — those repos queue until this succeeds`
				);
			}
		} catch (err) {
			// Fail-soft like every other write in this tick: a broken fan-out must
			// not take down the monitor reporting the outage.
			logger.warn(
				`[runner-health] BACKSTOP fleet sync failed: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	if (promoted.length) {
		logger.info(
			`[runner-health] BACKSTOP promote (${backstopReason}): ` +
				`${clawsOnline}/${clawsRegistered} claw instances online, ${clawsFree} free ` +
				`→ ${promoted.join(', ')} now offer '${BUILDER_LABEL}'`
		);
		// Saturation is deliberately silent. Every claw being busy is a normal
		// weekday, and paging for it would train the operator to skim past the
		// 🔻 that means the garage is actually dark.
		if (outage) {
			await postDiscordSink(
				`🔻 **runners** on \`${selfHostname()}\`: only ${clawsOnline}/${clawsRegistered} claw instances ` +
					'online — promoted ' +
					`${promoted.map((n) => `\`${n}\``).join(', ')} so jobs still have somewhere to run. ` +
					'Degraded backstop on the prod host; reverts automatically when a claw returns.',
				'runner-health'
			);
			setBackstopAlerted(true);
		}
	}
	if (demoted.length) {
		logger.info(
			`[runner-health] BACKSTOP demote: ${clawsOnline} claw(s) online → released ` +
				`${demoted.join(', ')} — no longer offered '${BUILDER_LABEL}': ${why}`
		);
		// Mirror of the promote arm: only announce the recovery the operator was
		// told about. A demote after mere saturation never had a 🔻 to close.
		if (getBackstopAlerted()) {
			await postDiscordSink(
				`🔺 **runners** on \`${selfHostname()}\`: a claw is back online — released the backstop on ` +
					`${demoted.map((n) => `\`${n}\``).join(', ')}.`,
				'runner-health'
			);
			setBackstopAlerted(false);
		}
	}
}

/** Test seam: cross-tick memory this module owns. */
export function __resetBackstopDecisionForTesting(): void {
	// Same leak class as `hostedRepos` below: a promoted backstop would otherwise
	// carry into the next test, which would then see no fan-out because the state
	// already matched, and pass while measuring nothing. Delegated to the two
	// modules that actually own this cross-tick memory.
	__resetBackstopDecisionStateForTesting();
	__resetCapacityInvariantForTesting();
	// Cross-tick memory — see the comment below. A leaked timestamp would make
	// the verify sweep "not due" for an hour of test time and pass while
	// measuring nothing.
	__resetSubCadenceKeyForTesting(CONVERGE_CADENCE_NAME);
}
