import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger, stateDir } from './host.js';
import { getFleetProbeSnapshot } from './fleet-probe-store.js';
// Re-exported so runner-health-runs.ts's own queuedMintView() does not open a
// second direct edge to fleet-probe-store.ts for the same probe this file
// already reads.

import { loadClawNodes, loadEphemeralNodes, loadFleetNodeNames } from './lib/manifest.js';
import { nodeOf, runnerCensus } from './runners/census.js';
import { BACKSTOP_LABEL, BUILDER_LABEL, PM2_HOST_LABEL } from './lib/capability-registry-ids.js';
import {
	FLOOR_DEMAND_FILE,
	floorLabels,
	judgeLabelFloor,
	observedFloorDemand,
	type LabelFloorVerdict,
} from './label-floor.js';
import { isProofRunnerName } from './lib/jit-naming.js';
import { RETENTION_DAYS, jobRecords } from './job-history-store.js';
import { setUnschedulableNodes } from './runners/schedulable.js';
import { deriveClawState } from './runners/claw-state.js';
import { setPm2HostBusy } from './pm2-host-busy-store.js';
// The backstop decision and the hosted fallback are ci-scheduling — observation
// must not import either module directly (rule 5, §3.2). `runner-health-ports.ts`
// is the port the composition root (`index.ts`) and the test rig wire the real
// functions into; see its own header. `runner-health.ts`'s own umbrella reset
// calls the matching `reset*Port` functions straight from that same file — not
// re-exported here, which would just re-open the edge this split closes.
import { runBackstopDecisionPort, runHostedFallbackPort } from './runner-health-ports.js';
import type { GhRunner } from './lib/github-client.js';
import { loadMintView, countLabels } from './runner-health-mint.js';
import type { TickReport } from './runner-health-snapshot.js';
import type { ClawState } from './lib/fleet-vocabulary.js';
// The label floor's two alerting halves (wave shrink-1 lane C): per-label
// (no-demand/mint-unknown/truncated/escalating-page) and per-node (a single
// dead box, degraded but the floor still met). Re-exported below under their
// original path for every existing importer.
import { readRunnerListing } from './runner-health-label-floor-confirm.js';
import {
	runLabelFloorAlerts,
	__resetLabelFloorAlertsForTesting,
} from './runner-health-label-floor-alerts.js';
import {
	runOfflineNodeAlerts,
	__resetOfflineNodeAlertsForTesting,
} from './runner-health-label-floor-nodes.js';

// `runner-health-runs.ts` imports `quietRecorder` straight from this module's
// original path — re-exported live from its new owner (wave shrink-1 lane C).

/**
 * Did the last tick read the fleet as UNMEASURED (no fast-loop probe snapshot
 * yet)? `null` until a tick has run. Set where the census is read, so the
 * re-tick below asks the same fact the backstop acted on.
 */
export let lastTickEphemeralUnknown: boolean | null = null;
/** Test seam: cross-tick memory this module owns, cleared by `__stopRunnerHealthMonitorForTesting`. */
export function __clearLastTickEphemeralUnknownForTesting(): void {
	lastTickEphemeralUnknown = null;
}

// Every demanded `runs-on` label must be SERVED: carried by >=1 standing online
// runner, or offered by an eligible minting node.
//
// THE LABEL FLOOR'S WATCHED SET — every label covered repos DEMAND.
//
// This was `REQUIRED_LABELS`, a list derived from a per-capability `floor`
// boolean, and before that a hand-written literal. Both shapes had the same
// hole: a routing dependency was watched only if somebody remembered to say
// so. `taskauto` and `av1-nvenc` were absent until 2026-08-27, and their
// absence had already cost an outage: github-runner-tenhands.service was the
// ONLY runner offering `taskauto`, it died with its registration deleted on
// 2026-08-26, and `hadoku-tenhands / Task automation` queued 6h45m with no
// floor alert possible. `jdk21` and `cargo-bevy` repeated it on 2026-10-10 in
// the other direction: `floor: false`, because a standing-only floor could not
// watch a label claws serve by minting without paging forever.
//
// Now the set comes from DEMAND (see `label-floor.ts`): observed job labels
// over job history's retention window, unioned with the static workflow
// demand `fleet label-floor` persists. And every watched label is judged by
// one rule — standing online runner, OR an eligible minting node that offers
// it — so a JIT-served label needs no exemption to be watchable.

/**
 * Test seam: a fixed demand instead of job history + the persisted file.
 * `null` restores the real read. Not part of the supported API.
 */
let floorDemandOverride: string[] | null = null;
export function __setFloorDemandForTesting(labels: string[] | null): void {
	floorDemandOverride = labels;
}

/** The last static-demand problem logged, so an unchanged one is said once, not every tick. */
let lastStaticDemandProblem: string | null = null;

/**
 * This tick's watched set, and why its static half is missing when it is.
 *
 * The static half missing is NOT fatal here and must not be silent: the floor
 * still watches everything jobs actually asked for, and `fleet label-floor`
 * — which is what writes the file — goes red on its own when it cannot read
 * the workflows. Logged once per change, and carried on the tick report.
 */
function floorWatchSet(): { labels: string[]; staticProblem: string | null } {
	if (floorDemandOverride) return { labels: floorLabels(floorDemandOverride), staticProblem: null };
	const nodes = loadFleetNodeNames();
	const observed = observedFloorDemand(jobRecords(), {
		sinceIso: new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString(),
		isProof: (runner) => nodes.some((n) => isProofRunnerName(runner, n)),
	});
	const path = join(stateDir(), FLOOR_DEMAND_FILE);
	let staticLabels: string[] = [];
	let staticProblem: string | null = null;
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as { labels?: unknown };
		if (!Array.isArray(parsed.labels)) throw new Error('it carries no `labels` array');
		staticLabels = parsed.labels.filter((l): l is string => typeof l === 'string');
	} catch (err) {
		staticProblem =
			`${path}: ${err instanceof Error ? err.message : String(err)} — the floor watches only ` +
			'labels jobs actually requested in the retention window, so a label only a rarely-run ' +
			'workflow asks for is unwatched until `fleet label-floor` writes it again';
	}
	if (staticProblem !== lastStaticDemandProblem) {
		lastStaticDemandProblem = staticProblem;
		if (staticProblem) logger.warn(`[runner-health] label floor static demand: ${staticProblem}`);
	}
	return { labels: floorLabels([...observed, ...staticLabels]), staticProblem };
}

// Dynamic failover: hokon (the PM2_HOST runner) normally does NOT carry any
// builder label, so normal CI never lands on the prod host. When every claw is
// offline we temporarily add them so GitHub can place queued/rerun jobs on hokon,
// then strip them again the moment a claw returns. Under this model hokon never
// NATIVELY carries a builder label, so a present one is always our temporary
// promotion (self-heals across an mgmt-api restart mid-outage).
//
// BUILDER_LABEL / PM2_HOST_LABEL / BACKSTOP_LABEL are imported from
// ./runners/census.js, which is where the counting that reads them lives.
//
// BACKSTOP_LABEL marks the extra idle runner instances ON hokon, registered
// 2026-08-17. They carry only that label natively, so they sit out of normal CI
// exactly like hokon itself, and the backstop promotes the whole pool at once
// when the garage goes dark. Four instances rather than one because a single
// backstop slot serialises the entire fleet's CI behind one job.

export async function checkLabelFloor(
	token: string,
	fleetRepos: string[],
	data: TickReport
): Promise<{
	runnersChecked: boolean;
	onlineRunnerNames: Set<string> | null;
	selfHostedRunnerNames: Set<string> | null;
	onlineLabels: Record<string, number> | null;
	selfRunners: GhRunner[] | null;
}> {
	const out = {
		runnersChecked: false,
		onlineRunnerNames: null as Set<string> | null,
		selfHostedRunnerNames: null as Set<string> | null,
		onlineLabels: null as Record<string, number> | null,
		selfRunners: null as GhRunner[] | null,
	};
	// --- Check 1: runner label-floor (needs runner-listing privilege) ---
	//
	// `per_page=100`, like every other runner listing in this package. This call
	// was the one exception and took GitHub's DEFAULT PAGE OF 30, which stops
	// being a fleet-wide census the moment JIT registrations outrun the reap.
	// The listing is not ordered by anything this code controls — a live read on
	// 2026-09-14 came back `claw-8, hokon, warm-claw-5, warm-claw-3, jit…,
	// jit…, warm-claw-7`, neither id nor name nor status order — so a 31st
	// registration evicts an arbitrary one, and a standing runner evicted off
	// page one reads EXACTLY like a capability that went offline. That is the
	// loudest alert in this file.
	const runnersResp = await readRunnerListing(token);
	if (runnersResp && Array.isArray(runnersResp.runners)) {
		out.runnersChecked = true;
		const runners = runnersResp.runners;
		// A PARTIAL census cannot answer a per-label question, and answering one
		// anyway is how "I could not look" renders as "nothing is wrong" — or, in
		// this direction, as a capability outage that never happened. GitHub caps
		// `per_page` at 100, so this is reachable on a fleet larger than that
		// rather than hypothetical.
		const truncated =
			typeof runnersResp.total_count === 'number' && runnersResp.total_count > runners.length;
		const online = runners.filter((r) => r.status === 'online');
		const onlineNames = online.map((r) => r.name).join(', ') || '(none)';
		out.onlineRunnerNames = new Set(online.map((r) => r.name));
		out.selfHostedRunnerNames = new Set(runners.map((r) => r.name));
		out.onlineLabels = countLabels(online);
		out.selfRunners = runners;

		// --- Census: how much capacity is there, and is this an outage? ---
		// Pure arithmetic, extracted to ./runners/census.ts so it can be checked
		// against a hand-written listing with no network. Both P2 counting bugs of
		// 2026-08-27/28 lived here and neither was reachable by a test while this
		// was inline in a function that also makes the API calls.
		const fleetNodes = loadFleetNodeNames();
		const has = (r: GhRunner, label: string) => (r.labels ?? []).some((l) => l.name === label);
		const isEligible = (r: GhRunner) =>
			has(r, BUILDER_LABEL) && !has(r, PM2_HOST_LABEL) && !has(r, BACKSTOP_LABEL);

		const c = runnerCensus({
			runners,
			clawNodes: loadClawNodes(),
			ephemeralNodes: loadEphemeralNodes(),
			probe: getFleetProbeSnapshot(),
		});
		const { hokonPool, clawsOnline, clawsRegistered, clawsFree, backstopOnline, pm2Busy } = c;

		data.claws_online = clawsOnline;
		data.claws_registered = clawsRegistered;
		data.backstop_online = backstopOnline;
		data.claws_free = clawsFree;
		// Kept alongside, not instead of. Both halves are real capacity; what the
		// fleet could not previously express is that all of it might need the
		// dispatcher to act before a single job can start.
		data.claws_free_standing = c.clawsFreeStanding;
		data.claws_free_mintable = c.clawsFreeMintable;
		data.claws_mintable_online = c.clawsMintableOnline;
		data.claws_ready = c.clawsReady;
		// The standing half alone. The fleet route re-bases the ephemeral half onto
		// a probe 10 minutes fresher than this tick's, and it can only do that if
		// the two halves arrive separable.
		data.claws_ready_standing = c.clawsReadyStanding;
		data.ephemeral_unknown = c.ephemeralUnknown;
		lastTickEphemeralUnknown = c.ephemeralUnknown === true;

		// WHICH nodes those numbers are made of.
		//
		// `claws_online=1` is not a diagnosis. Reconstructing a 2026-08-29 window
		// from the logs cost an hour and still could not answer whether claw-1 was
		// demoted, offline, or simply not registered for this repo — three states
		// with three different fixes, all rendered as the digit 1. The counts are
		// what the backstop acts on; this is what an operator needs to act on.
		//
		// Registration state is per-REPO. These figures come from SELF_REPO's
		// listing, so a node reading `absent` here is absent from hadoku_site,
		// not necessarily from the fleet — and that distinction is exactly what
		// was unrecoverable from `claws_online=1`.
		const clawState: Record<string, ClawState> = {};
		// Every STANDING node, which is `loadClawNodes()` PLUS the production
		// host. loadClawNodes drops anything the manifest labels `pm2-host`,
		// correctly — it answers "is this a claw" — and using it here left hokon
		// with no state at all, rendering an em dash for the one node the whole
		// backstop is about. `demoted` is the right word for a hokon in standby:
		// it is online and carries no `hadoku-builder`, which is exactly what the
		// backstop being down means.
		const ephemeral = loadEphemeralNodes();
		Object.assign(
			clawState,
			deriveClawState({
				fleetNodes,
				ephemeral,
				runners,
				nodeOf,
				isEligible,
				probeFor: (n) => getFleetProbeSnapshot()?.nodes?.[n],
			})
		);

		// PUBLISH WHO GITHUB CANNOT PLACE WORK ON, for the tier ladder.
		//
		// `offline` (registrations exist, none online) and `absent` (no
		// registration at all) are both unschedulable however healthy the box
		// looks over ssh. claw-4 was the case that made this necessary: reachable,
		// idle, two free slots reported into tier1, and every one of its 26
		// registrations offline — which held tier2 demoted while work queued.
		//
		// `mintable` is NOT included. An ephemeral node has no standing
		// registration by design and is reached through the dispatcher, so reading
		// its empty listing as unschedulable would switch off every JIT node in the
		// fleet. That distinction is the whole reason this is computed here, where
		// the ephemeral set is already known, rather than from a runner listing.
		setUnschedulableNodes(
			Object.entries(clawState)
				.filter(([, st]) => st === 'offline' || st === 'absent')
				.map(([node]) => node)
		);
		data.claw_state = clawState;
		data.pm2_host_busy = pm2Busy;

		// WHICH NODES are serving that rung — the same listing, asked per node.
		//
		// The census answers "is ANY", which is what the report field above means
		// and all the ladder ever needed while hokon alone carried `pm2-host`. The
		// label has been PROBED since 2026-09-15 (#6), so a claw can earn it, and
		// one boolean for two holders reserves the wrong box in both directions: a
		// busy claw would hold an idle hokon off builder duty, and an idle claw
		// would clear a busy one.
		const pm2BusyNodes = new Set(
			runners.filter((r) => has(r, PM2_HOST_LABEL) && r.busy).map((r) => nodeOf(r.name, fleetNodes))
		);

		// Publish the pm2-host rung of the priority ladder for the fast loop.
		// Free here: we already hold the listing.
		setPm2HostBusy(pm2BusyNodes);

		// The LIVE runner facts, for the Fleet panel. Declared capability (what the
		// manifest says a node is for) and current eligibility (what GitHub will
		// actually schedule onto it) are different things, and the panel rendered
		// the former while labelling it the latter — so a promoted hokon could
		// never be seen carrying `hadoku-builder`, which is the single most
		// interesting thing the ladder does.
		data.runner_state = runners.map((r) => ({
			name: r.name,
			status: r.status,
			busy: r.busy,
			labels: (r.labels ?? []).map((l) => l.name),
		}));

		await runBackstopDecisionPort({
			token,
			fleetRepos,
			data,
			clawsOnline,
			clawsRegistered,
			clawsFree,
			ephemeralUnknown: c.ephemeralUnknown,
			pm2BusyNodes,
			fleetNodes,
			backstopPool: hokonPool,
			has,
		});

		await runHostedFallbackPort({
			token,
			ephemeralUnknown: c.ephemeralUnknown,
			clawsOnline,
			backstopOnline,
			data,
		});

		// MEASURED first, for everyone. The snapshot, the panel and the sitrep read
		// `label_online`, and they report what is true NOW — the confirmation below
		// gates the ALERT, which is a judgement about whether to wake someone.
		const watch = floorWatchSet();
		if (watch.staticProblem) data.label_floor_static_problem = watch.staticProblem;
		const labelOnline: Record<string, number> = {};
		for (const label of watch.labels) {
			labelOnline[label] = online.filter((r) =>
				(r.labels ?? []).some((l) => l.name === label)
			).length;
		}

		// ONE RULE FOR EVERY LABEL (label-floor.ts): served by a standing online
		// runner, OR offered by a minting node the dispatcher could mint on now.
		// The probe is the one this tick's census already used, so the two cannot
		// disagree about which claws are up.
		const mint = loadMintView(getFleetProbeSnapshot());
		const verdicts: Record<string, LabelFloorVerdict> = {};
		for (const label of watch.labels) {
			const standing = labelOnline[label] ?? 0;
			verdicts[label] = mint
				? judgeLabelFloor(label, standing, mint.view)
				: standing > 0
					? { state: 'standing', count: standing }
					: // The manifest is unreadable, so the minting arm cannot be asked.
						// Not served (nothing looked), not unserved (no evidence): held.
						{ state: 'unmeasured', nodes: [] };
		}
		data.label_floor = Object.fromEntries(Object.entries(verdicts).map(([l, v]) => [l, v.state]));

		// The demand-shape alerts (no demand at all, the minting arm unreadable,
		// a truncated listing) and the escalating per-label "nothing has served
		// this label" page — split to runner-health-label-floor-alerts.ts (wave
		// shrink-1 lane C), which owns the cross-tick streak it debounces on.
		await runLabelFloorAlerts(token, watch, verdicts, mint, truncated, {
			seen: runners.length,
			total: runnersResp.total_count,
		});

		// --- Individual runner offline (fleet DEGRADED, floor still met) ---
		// Split to runner-health-label-floor-nodes.ts (wave shrink-1 lane C).
		// `clawsOnline === 0` is checked separately from the floor because the
		// backstop PROMOTES hokon to hadoku-builder in that case, which repairs the
		// floor in this same tick — so the floor alone reads healthy during exactly
		// the outage this needs to stay quiet for.
		const floorAlreadyBreached =
			clawsOnline === 0 || Object.values(verdicts).some((v) => v.state === 'unserved');
		runOfflineNodeAlerts(
			runners,
			fleetNodes,
			ephemeral,
			clawState,
			floorAlreadyBreached,
			onlineNames
		);
		data.online = online.length;
		data.offline = runners.length - online.length;
		data.label_online = labelOnline;
	} else {
		logger.warn(
			'[runner-health] /actions/runners unreadable — skipping label-floor check ' +
				'(token may lack runner-listing privilege). Queued-job check still runs.'
		);
	}
	return out;
}

/**
 * Test seam: cross-tick memory this module owns, PLUS a delegating reset for
 * the state the label floor's two alerting halves now own in their own
 * files (wave shrink-1 lane C) — the seam stays the one call site every test
 * rig already uses.
 */
export function __resetLabelFloorForTesting(): void {
	// Cross-tick memory: a leaked value would suppress the next test's warning.
	lastStaticDemandProblem = null;
	__resetLabelFloorAlertsForTesting();
	__resetOfflineNodeAlertsForTesting();
}
