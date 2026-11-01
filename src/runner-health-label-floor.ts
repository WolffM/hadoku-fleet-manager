import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger, stateDir, recordAlertQuietly } from './host.js';
import { getFleetProbeSnapshot } from './fleet-probe-store.js';
// Re-exported so runner-health-runs.ts's own queuedMintView() does not open a
// second direct edge to fleet-probe-store.ts for the same probe this file
// already reads.
export { getFleetProbeSnapshot };
import { loadClawNodes, loadEphemeralNodes, loadFleetNodeNames } from './lib/manifest.js';
import {
	BACKSTOP_LABEL,
	BUILDER_LABEL,
	PM2_HOST_LABEL,
	nodeOf,
	runnerCensus,
} from './runners/census.js';
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
import {
	runBackstopDecision,
	__resetBackstopDecisionForTesting,
} from './runners/backstop-decision.js';
import { runHostedFallback, __resetHostedFallbackForTesting } from './runners/hosted-fallback.js';
// Re-exported so runner-health.ts's own reset does not open a second direct
// edge to either module for a function this file already imports.
export { __resetBackstopDecisionForTesting, __resetHostedFallbackForTesting };
import { alertOnce, clearAlert, pagedAlerts } from './lib/alert-ledger.js';
import { TICK_INTERVAL_MS, OFFLINE_TICKS_BEFORE_ALERT } from './lib/runner-health-shared.js';
import { selfHostname } from './lib/runner-health-shared.js';
import { ghGet, SELF_REPO, type GhRunner } from './lib/github-client.js';
import { loadMintView, countLabels } from './runner-health-mint.js';
import type { TickReport } from './runner-health-snapshot.js';
import type { ClawState } from './lib/fleet-vocabulary.js';

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

/**
 * NODE name → consecutive ticks seen OFFLINE. Keyed by node, not runner,
 * so one dead box is one message rather than one per registration.
 *
 * The `claw-N-b` second instances this was written for were retired on
 * 2026-08-24, but the grouping is not vestigial: `hokon-tenhands` is a live
 * second registration on hokon (443 job records), and a JIT runner is named per
 * job. `nodeOf` folds both.
 */
const offlineTicks = new Map<string, number>();

/**
 * Watched label → consecutive ticks it was judged UNSERVED (no standing online
 * runner, no eligible minting offerer).
 *
 * The label floor used to page on the FIRST tick at zero, which made it fire on
 * every transient disconnect. On 2026-08-20 all four hokon runners dropped
 * their broker long-poll for ~10s (`SocketException (125): Operation canceled`,
 * then `Back off 9.591 seconds`), and `pm2-host` paged "will queue forever"
 * while nothing was wrong — no process had restarted, and the PM2 deploy 36
 * minutes earlier had run fine. That runner log holds 115 such backoffs in two
 * days, so this was not a one-off.
 *
 * `alertOnce` could not absorb it: that is a re-alert RATE LIMIT, and
 * `clearAlert` deliberately re-arms so the next occurrence fires immediately —
 * correct for a condition that stays broken, wrong for one that flaps.
 *
 * So the floor now debounces on OFFLINE_TICKS_BEFORE_ALERT, exactly as the
 * per-node check below already does, and for the reason that constant
 * already documents: a blip clears well inside it, a real outage does not.
 * Only the ALERT waits — `labelOnline` and the sitrep still report zero the
 * moment it is true, because that is a fact about now and this is a judgement
 * about whether it is worth waking someone.
 */
const labelZeroTicks = new Map<string, number>();

/** NODE name → how many times its outage has been re-announced. */
const offlineRepeats = new Map<string, number>();

/**
 * Escalating re-alert schedule for a sustained outage, mirroring heartbeat.ts
 * and worker-health-alerts. A dead node needs hands and may wait days; a
 * fixed hourly ping for a condition the operator already knows about is the
 * noise that teaches people to mute the channel.
 */
const OFFLINE_REPEAT_BACKOFF_MS = [
	1 * 60 * 60 * 1000,
	4 * 60 * 60 * 1000,
	12 * 60 * 60 * 1000,
	24 * 60 * 60 * 1000,
];

/**
 * A floor zero is READ TWICE, seconds apart, before the tick counts as a breach.
 *
 * The tick debounce above absorbs a blip that clears within ten minutes. It does
 * NOT absorb the failure mode it was written for when that failure lasts hours:
 * on 2026-09-12 GitHub's broker answered hokon's message long-poll with
 * `InternalServerError` repeatedly between 19:21Z and 22:45Z, and through that
 * window `/actions/runners` reported hokon — and every warm claw — `offline`
 * on some reads and `online` on others, ten minutes apart. Eighteen 🚨 went out
 * over eleven hours claiming `pm2-host`, `taskauto` and `av1-nvenc` had no
 * online runner and that jobs "will queue" (#24).
 *
 * They had not. GitHub scheduled and completed a `redeploy` job ON hokon at
 * 06:12:32-06:12:50Z, and the 06:13:49Z tick then read `pm2-host=0
 * hokon:offline` seventy-seven seconds later. The listing was faithful to what
 * the API returned; the API's `status` was momentarily wrong. Two consecutive
 * TICKS can both land in such a window — and did, twelve times in a row —
 * because the degradation outlives the debounce. Two READS seconds apart do
 * not, because the listener re-polls in between.
 *
 * Retrying is NOT tolerating (see `check-queue-health`'s READ_ATTEMPTS): a zero
 * both reads agree on still advances the streak and still pages. Only an
 * UNCONFIRMED zero is held — and held, not cleared, so a sustained outage that
 * flaps keeps its streak instead of being reset by the flapping.
 */
const FLOOR_CONFIRM_DELAY_MS = 5000;

/** Test seam for {@link FLOOR_CONFIRM_DELAY_MS}. Not part of the supported API. */
let floorConfirmDelayMs: number = FLOOR_CONFIRM_DELAY_MS;
export function __setFloorConfirmDelayForTesting(ms: number | null): void {
	floorConfirmDelayMs = ms ?? FLOOR_CONFIRM_DELAY_MS;
}

/**
 * Indirection purely so tests can SEE the ledger-only path.
 *
 * A quiet record makes no fetch, so the stubbed-fetch harness these tests use
 * cannot observe it — and a test that only asserted "nothing was posted to
 * Discord" would keep passing if the condition stopped being DETECTED at all,
 * which is the failure that matters. This lets them assert the record instead
 * of its absence.
 */
export let quietRecorder: (content: string, source: string) => void = recordAlertQuietly;

/** Test-only seam. */
export function __setQuietRecorderForTesting(
	fn: ((content: string, source: string) => void) | null
): void {
	quietRecorder = fn ?? recordAlertQuietly;
}

/**
 * SELF_REPO's self-hosted runner listing, asked for a page big enough to BE a
 * census. `null` is "I could not look" and every caller treats it that way.
 *
 * One door for this read so the floor check and the read that CONFIRMS a floor
 * breach cannot drift apart — a confirmation taken through a differently-shaped
 * request is not a confirmation of anything.
 */
async function readRunnerListing(
	token: string
): Promise<{ runners?: GhRunner[]; total_count?: number } | null> {
	return ghGet<{ runners?: GhRunner[]; total_count?: number }>(
		'/actions/runners?per_page=100',
		token
	);
}

/** What a second look at the listing found, or `null` for "I could not look". */
interface FloorConfirmation {
	/** Online-runner label census from the CONFIRMING read. */
	labels: Record<string, number>;
	/** Online runner names from the confirming read, for the message. */
	names: string;
	/** Registrations the confirming read saw, online or not. */
	registrations: number;
}

/**
 * Look a second time before saying a routing label has no online runner.
 *
 * Seconds apart, not ticks: see FLOOR_CONFIRM_DELAY_MS for the 2026-09-12
 * measurement that distinguishes the two. Costs one GitHub call, and only on a
 * tick that is about to page.
 *
 * `null` for anything it could not READ — an unreadable listing, a suppressed
 * budget, or a listing that came back TRUNCATED. A partial census cannot
 * confirm a zero any more than it can produce one.
 */
async function confirmFloorZero(token: string): Promise<FloorConfirmation | null> {
	if (floorConfirmDelayMs > 0) {
		await new Promise((resolve) => setTimeout(resolve, floorConfirmDelayMs));
	}
	const resp = await readRunnerListing(token);
	if (!resp || !Array.isArray(resp.runners)) return null;
	if (typeof resp.total_count === 'number' && resp.total_count > resp.runners.length) return null;
	const online = resp.runners.filter((r) => r.status === 'online');
	return {
		labels: countLabels(online),
		names: online.map((r) => r.name).join(', ') || '(none)',
		registrations: resp.runners.length,
	};
}

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

		await runBackstopDecision({
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

		await runHostedFallback({
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

		// A DEMAND WITH NOTHING IN IT IS NOT A FLEET WITH NOTHING TO SERVE. The
		// fleet runs hundreds of jobs a day; an empty watched set means job history
		// stopped recording AND the persisted static demand is gone, and a floor
		// that watches nothing passes everything. Paged on its own key.
		if (!watch.labels.some((l) => l !== BUILDER_LABEL)) {
			await alertOnce(
				'label-floor:no-demand',
				`🚨 **runners** on \`${selfHostname()}\`: the label floor has NOTHING to watch — no ` +
					'job in the retention window requested a routing label, and the static demand ' +
					`could not be read (${watch.staticProblem ?? 'it was empty'}). A floor over an ` +
					'empty set passes every outage. Check that job history is recording and run ' +
					'`fleet label-floor`.'
			);
		} else {
			clearAlert('label-floor:no-demand');
		}

		// The minting arm could not be asked at all. Loud on its own key, like a
		// truncated listing, and every label that needed it is HELD below.
		const needsMint = watch.labels.filter(
			(l) => l !== BUILDER_LABEL && verdicts[l].state === 'unmeasured'
		);
		if (!mint && needsMint.length) {
			await alertOnce(
				'label-floor:mint-unknown',
				`🚨 **runners** on \`${selfHostname()}\`: the fleet manifest is unreadable, so the label ` +
					`floor cannot ask which minting nodes offer ${needsMint.map((l) => `\`${l}\``).join(', ')} ` +
					'— no standing runner carries them online. Not judged this tick; fix the manifest.'
			);
		} else {
			clearAlert('label-floor:mint-unknown');
		}

		// A zero is not paged on one look. `confirmFloorZero` is called at most
		// once per tick, and only when a label this check can page for is judged
		// UNSERVED in the first read — so the happy path costs nothing, and a label
		// the claws are minting fine never costs a second listing.
		const pageable = watch.labels.filter((l) => l !== BUILDER_LABEL);
		const suspected = pageable.filter((l) => verdicts[l].state === 'unserved');
		const confirmation =
			suspected.length && !truncated
				? await confirmFloorZero(token)
				: (null as FloorConfirmation | null);
		if (truncated) {
			// LOUD, and about the right thing. A truncated listing is not a
			// capability outage and must not be rendered as one — but it is also not
			// a clean bill of health, so it pages on its own key and the per-label
			// streaks below are HELD rather than advanced or cleared.
			await alertOnce(
				'label-floor:truncated',
				`🚨 **runners** on \`${selfHostname()}\`: the runner listing for \`${SELF_REPO}\` came back ` +
					`PARTIAL — ${runners.length} of ${runnersResp.total_count} registrations. The label floor ` +
					'cannot be judged from part of a census, so it is not being judged this tick. ' +
					"`per_page` is already at GitHub's maximum of 100; this needs a page-until-empty loop."
			);
		} else {
			clearAlert('label-floor:truncated');
		}

		// A label that LEFT the watched set (its demand aged out) takes its streak
		// and its alert with it — otherwise an alert for a label nothing asks for
		// any more stays armed, and the next unrelated blip re-pages it.
		for (const label of [...labelZeroTicks.keys()]) {
			if (watch.labels.includes(label)) continue;
			labelZeroTicks.delete(label);
			clearAlert(`label-floor:${label}`);
		}

		for (const label of watch.labels) {
			const verdict = verdicts[label];
			const key = `label-floor:${label}`;
			// RETIRED 2026-09-08 (decision C0b, see `claw-floor-design-2026-09-07.md`
			// §10). `hadoku-builder` is the fleet's one ELIGIBILITY label: the fast
			// loop writes it, every claw mints it, and "can CI run right now" is
			// owned by `check-queue-health`, measured by queue age. An all-claws-down
			// outage — the only state in which nothing could serve it — already pages
			// through the backstop's 🔻, which promotes hokon onto it in this same
			// tick. Still MEASURED and JUDGED (the snapshot and the per-node
			// suppression below read the verdict), just never alerted on here.
			if (label === BUILDER_LABEL) {
				labelZeroTicks.delete(label);
				clearAlert(key);
				continue;
			}
			if (verdict.state === 'standing' || verdict.state === 'minting') {
				labelZeroTicks.delete(label);
				clearAlert(key);
				continue;
			}
			if (verdict.state === 'unmeasured') {
				// THE FAST LOOP HAS NOT PROBED YET — ~60s after every mgmt-api restart,
				// and runner-health's first tick lands inside it. Nothing stands, and
				// the minting nodes that offer this have not been looked at. HOLD:
				// clearing would be "I could not look" rendering as "nothing is wrong";
				// advancing would page a healthy fleet on every deploy (census.ts,
				// 2026-09-02).
				logger.warn(
					`[runner-health] label floor \`${label}\`: no standing runner online, and the minting ` +
						`node(s) offering it (${verdict.nodes.join(', ') || 'unknown — manifest unreadable'}) ` +
						'have not been probed yet — holding the streak, not paging.'
				);
				continue;
			}
			// UNSERVED on the first read. A partial census produced the standing
			// zero — it is not evidence.
			if (truncated) continue;
			// Could not look a second time: a suppressed budget, an unreadable
			// listing, or one that came back truncated. HOLD the streak. Clearing
			// it would be "I could not look" rendering as "nothing is wrong";
			// advancing it would page on a single look, which is the thing this
			// confirmation exists to stop.
			if (!confirmation) {
				logger.warn(
					`[runner-health] label floor \`${label}\` read UNSERVED but the confirming listing was ` +
						'unreadable — holding the streak, not paging. Check the token and the rate-limit ' +
						'budget: an unconfirmed zero is neither a breach nor a pass.'
				);
				continue;
			}
			const second = confirmation.labels[label] ?? 0;
			// The two reads DISAGREED. That is the 2026-09-12 shape (#24): GitHub's
			// `status` said offline on one read and online seconds later, while it
			// was scheduling jobs onto the very runner in question. Held, not
			// cleared — a sustained outage that flaps keeps its streak instead of
			// being reset by the flapping, so it still pages on the next tick both
			// reads agree on.
			if (second > 0) {
				logger.warn(
					`[runner-health] label floor \`${label}\`: first read said 0 online, the confirming ` +
						`read ${Math.round(floorConfirmDelayMs / 1000)}s later said ${second} ` +
						`(online: ${confirmation.names}). Two answers is not evidence — holding.`
				);
				continue;
			}
			const seen = (labelZeroTicks.get(label) ?? 0) + 1;
			labelZeroTicks.set(label, seen);
			if (seen >= OFFLINE_TICKS_BEFORE_ALERT) {
				const mins = Math.round((seen * TICK_INTERVAL_MS) / 60000);
				await alertOnce(
					key,
					`🚨 **runners** on \`${selfHostname()}\`: nothing has served label \`${label}\` for ` +
						`${mins} min — ${verdict.why}${mint?.drainProblem ? ` (${mint.drainProblem})` : ''}. ` +
						`Jobs using \`runs-on: [self-hosted, ${label}]\` will queue. Two reads ` +
						`${Math.round(floorConfirmDelayMs / 1000)}s apart agreed: \`${SELF_REPO}\` lists ` +
						`${confirmation.registrations} registration(s), none of them carrying it online. ` +
						`Online runners: ${confirmation.names}`
				);
			}
		}

		// --- Individual runner offline (fleet DEGRADED, floor still met) ---
		// The label-floor check above only fires at ZERO online. With claw-1 and
		// claw-2 up, claw-3 sat dead for a full day and nothing ever said so —
		// found by hand on 2026-08-15, Tailscale reporting "last seen 1d ago".
		// The first node to die is the one worth hearing about; by the time the
		// floor breaks, CI is already stopped.
		//
		// Suppressed to hourly by alertOnce while it stays down, cleared the moment
		// it returns, and skipped entirely during a FULL outage — that pages twice
		// already (backstop promote + label floor), and a third message per dead
		// node for one root cause is noise the operator learns to skip.
		//
		// `clawsOnline === 0` is checked separately from the floor because the
		// backstop PROMOTES hokon to hadoku-builder in that case, which repairs the
		// floor in this same tick — so the floor alone reads healthy during exactly
		// the outage this needs to stay quiet for.
		const floorAlreadyBreached =
			clawsOnline === 0 || Object.values(verdicts).some((v) => v.state === 'unserved');

		// Group by NODE first: one dead claw hosts two runner instances, and
		// announcing each separately doubles every message for a single fault.
		// `fleetNodes`, loaded once above, is what lets `hokon-tenhands` fold
		// onto `hokon` and a JIT runner onto the node that minted it. Without
		// it every instance name is its own "node" and one dead box reports
		// twice.
		//
		// AN EPHEMERAL NODE IS JUDGED BY ITS PROBE, NOT THIS LISTING. Its only
		// registrations here are JIT runners, and a JIT runner reads `offline`
		// between its mint and its listener connecting and again after its job,
		// until GitHub drops it. A tick that caught claw-8 in that gap counted as
		// a tick down, and a later one did the same, so `claw-8 OFFLINE for 20
		// min` was written on 2026-10-22 03:16Z while it ran a job every few
		// minutes. claw-9 on 2026-10-16 17:30Z was the same shape. And a dead
		// ephemeral node has no registrations at all, so this listing could
		// only ever accuse a live one. `deriveClawState` already draws this line
		// from the fast loop's probe; `unreachable` there is what down means.
		// An unprobed node (no state yet) holds its count, neither direction.
		const byNode = new Map<string, { names: string[]; allOffline: boolean }>();
		for (const r of runners) {
			const m = nodeOf(r.name, fleetNodes);
			if (ephemeral.has(m)) continue;
			const e = byNode.get(m) ?? { names: [], allOffline: true };
			e.names.push(r.name);
			if (r.status === 'online') e.allOffline = false;
			byNode.set(m, e);
		}
		for (const m of ephemeral) {
			const st = clawState[m];
			if (st === undefined) continue;
			byNode.set(m, { names: [], allOffline: st === 'unreachable' });
		}
		// CONSECUTIVE ticks, or it is not "for 20 min". A node that is in no
		// listing this tick was not seen down, so its count starts over — the
		// count is what the message multiplies into a duration.
		for (const m of offlineTicks.keys()) {
			if (byNode.has(m) || (ephemeral.has(m) && clawState[m] === undefined)) continue;
			offlineTicks.delete(m);
			offlineRepeats.delete(m);
			clearAlert(`runner-offline:${m}`);
		}

		for (const [node, e] of byNode) {
			const key = `runner-offline:${node}`;
			// A node only counts as down when EVERY instance on it is offline —
			// one instance dying while its twin serves is a runner fault, not a
			// dead box, and the label floor already covers the capacity question.
			if (!e.allOffline) {
				offlineTicks.delete(node);
				offlineRepeats.delete(node);
				clearAlert(key);
				continue;
			}
			const seen = (offlineTicks.get(node) ?? 0) + 1;
			offlineTicks.set(node, seen);
			if (floorAlreadyBreached || seen < OFFLINE_TICKS_BEFORE_ALERT) continue;

			const repeats = offlineRepeats.get(node) ?? 0;
			const wait =
				OFFLINE_REPEAT_BACKOFF_MS[Math.min(repeats, OFFLINE_REPEAT_BACKOFF_MS.length - 1)];
			const last = pagedAlerts[key] ? Date.parse(pagedAlerts[key]) : 0;
			if (repeats > 0 && Date.now() - last < wait) continue;

			const mins = Math.round((seen * TICK_INTERVAL_MS) / 60000);
			const downFor = mins >= 120 ? `${Math.round(mins / 60)}h` : `${mins} min`;
			const instances = e.names.length > 1 ? ` (${e.names.join(', ')})` : '';
			// Bypasses alertOnce deliberately: that helper is a fixed hourly window,
			// and this condition needs the escalating ladder instead.
			pagedAlerts[key] = new Date().toISOString();
			offlineRepeats.set(node, repeats + 1);
			// LEDGER ONLY. Read the message: capacity is fine and nothing is
			// queuing, so there is no action that has to happen now — the box needs
			// hands on it eventually, which is a morning-read item, not a ping. It
			// was 24 of the 114 runner-health alerts in the fifteen days to
			// 2026-08-28, all of them announcing that nothing was wrong. The
			// escalating ladder above is kept: it still paces the ledger rows, so a
			// box down for a week does not write one every ten minutes.
			//
			// The floor breach and the all-claws-down backstop still PING — this is
			// only the case where redundancy did its job.
			quietRecorder(
				`⚠️ **runners** on \`${selfHostname()}\`: \`${node}\`${instances} OFFLINE for ${downFor}. ` +
					`CI has capacity (online: ${onlineNames}) and nothing is queuing — the box needs power/network.`,
				'runner-health'
			);
		}
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

/** Test seam: cross-tick memory this module owns. */
export function __resetLabelFloorForTesting(): void {
	labelZeroTicks.clear();
	// Cross-tick memory: a leaked value would suppress the next test's warning.
	lastStaticDemandProblem = null;
	offlineTicks.clear();
	offlineRepeats.clear();
	quietRecorder = recordAlertQuietly;
}
