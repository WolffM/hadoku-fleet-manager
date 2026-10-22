/**
 * The fleet census — "how much capacity is there, right now, and is this an
 * outage?" — as pure arithmetic over a runner listing.
 *
 * This lived inline in `checkLabelFloor`, wrapped in the same function as the
 * GitHub calls that fetch the listing and the writes that act on the answer.
 * Both P2 bugs of 2026-08-27/28 were in exactly these ~15 lines of counting,
 * and neither was reachable by a test without stubbing the whole HTTP surface:
 *
 *   - `clawsOnline` counted runners carrying BUILDER_LABEL. That label is
 *     ELIGIBILITY, rewritten by the fast loop every few minutes, so a claw
 *     that was up, healthy and merely DEMOTED vanished from the count. The
 *     fleet routinely reported `clawsOnline = 1` with three claws reachable.
 *   - Ephemeral nodes hold zero standing registrations, so a listing-derived
 *     count cannot see them at all. After claw-3 went pure JIT the fleet read
 *     2 claws online with three healthy nodes.
 *
 * Separated so the counting can be checked against a hand-written listing with
 * no network at all. The actuation that reads these numbers stays in
 * runner-health.ts; this module decides nothing and writes nothing.
 */

/**
 * The three labels this module counts by.
 *
 * RE-EXPORTED, not declared. They are registry entries now — `capabilities.ts`
 * carries the identity/eligibility distinction this file's docstring calls
 * load-bearing, plus the description, the verification route and the floor
 * policy for each. The names stay exported from here because five modules import
 * them from `./census.js` and the point of a registry is to stop the vocabulary
 * being copied, not to make every consumer re-import it.
 */
export { BUILDER_LABEL, PM2_HOST_LABEL, BACKSTOP_LABEL } from '../capabilities.js';
import { BUILDER_LABEL, PM2_HOST_LABEL, BACKSTOP_LABEL } from '../capabilities.js';

export interface CensusRunner {
	name: string;
	status: string;
	busy: boolean;
	labels?: { name: string }[];
}

export interface NodeProbeLike {
	reachable?: boolean;
	sick?: boolean;
	/** Slots still available on this node: capacity minus running workers. */
	free?: number;
}

/**
 * Generic over the runner type so the caller gets back the SAME objects it put
 * in, `id` and all — the actuation loop in runner-health needs `r.id` to POST a
 * label, and a census that narrowed its output to the fields it reads would
 * force a cast at every use.
 */
export interface CensusInput<R extends CensusRunner = CensusRunner> {
	/** Every registration GitHub reports for this repo, online or not. */
	runners: R[];
	/** Nodes the manifest declares as claws (non-pm2-host builders). */
	clawNodes: Set<string>;
	/** Nodes that mint a runner per job and hold no standing registrations. */
	ephemeralNodes: Set<string>;
	/** The fast loop's last reachability probe, or null if it has not run. */
	probe: { nodes?: Record<string, NodeProbeLike> } | null;
}

export interface Census<R extends CensusRunner = CensusRunner> {
	online: R[];
	/** The production host's runner plus its idle backstop instances. */
	hokonPool: R[];
	clawsOnline: number;
	clawsRegistered: number;
	/** Online, eligible, and NOT busy — i.e. can take the next job. */
	clawsFree: number;
	/**
	 * Of `clawsFree`, the part a job can land on WITHOUT the dispatcher acting.
	 *
	 * THE DISTINCTION THE 2026-09-01 OUTAGE WAS MADE OF. A standing free runner
	 * is capacity GitHub can assign to this second. A mintable slot is a promise
	 * that a dispatcher will create one — and nothing in the census verifies the
	 * promiser is alive.
	 *
	 * Both are real capacity and both belong in `clawsFree`; what was missing is
	 * the ability to tell them apart. With three of four nodes ephemeral the
	 * fleet reported healthy with free slots while ZERO online runners carried
	 * hadoku-builder, the backstop stayed suppressed, and jobs queued 11-19
	 * minutes. `clawsFree` alone cannot express that state. These two can.
	 */
	clawsFreeStanding: number;
	/**
	 * MACHINES ready to take a job right now — standing nodes that are online,
	 * eligible and idle, plus ephemeral nodes that are reachable with room to
	 * mint.
	 *
	 * Distinct from every other count here, and the one an operator actually
	 * asks for. `clawsOnline` counts boxes that are UP (a saturated fleet is
	 * still fully online); `clawsFree` counts SLOTS, which on an all-JIT fleet
	 * reads as a number larger than the fleet and invites "why is it 10 when I
	 * have 6 machines".
	 */
	clawsReady: number;
	/**
	 * The STANDING half of `clawsReady` on its own.
	 *
	 * Separable because the fleet route re-bases the ephemeral half onto a probe
	 * ten minutes fresher than this tick's, and a sum cannot be re-based.
	 */
	clawsReadyStanding: number;
	/** Of `clawsFree`, the part that requires the dispatcher to mint first. */
	clawsFreeMintable: number;
	/**
	 * How many ephemeral NODES are reachable and not sick — capacity that exists
	 * even when every slot on it is currently busy.
	 *
	 * Separate from `clawsFreeMintable` because the two answer different
	 * questions, and the label floor asks this one. "No online runner carries
	 * hadoku-builder" is an OUTAGE only when nothing can produce one; under
	 * all-JIT the standing count is zero by design and stays zero forever, so a
	 * floor keyed on it pages continuously while the fleet mints 9 of 9 queued
	 * jobs. Keyed on free SLOTS it would instead page every time the fleet was
	 * merely full, which is a queue, not an outage.
	 */
	clawsMintableOnline: number;
	/**
	 * The fleet declares ephemeral nodes and NO probe snapshot exists, so their
	 * capacity was never measured. Distinct from measuring it as zero.
	 *
	 * Every count above is then a floor, not a reading, and a caller that treats
	 * them as readings declares an outage for a healthy fleet — which is what
	 * happened on each of 2026-09-02's deploys.
	 */
	ephemeralUnknown: boolean;
	backstopOnline: number;
	/** Is the production host serving a rung that outranks CI? */
	pm2Busy: boolean;
}

/** A GitHub-hosted runner reports a unique name per job; they are one pool. */
export const HOSTED_NODE = 'github-hosted';
const HOSTED_NAME = /^GitHub Actions \d+$/;

/** A just-in-time runner is named `jit-<node>-<repo>-r<runId>-<epoch>`. */
const JIT_PREFIX = 'jit-';

/** A warm-cache-of-one listener is named `warm-<node>-<repo-slug>` — see
 * `WARM_PREFIX` in ephemeral.ts. Duplicated here rather than imported, same
 * as JIT_PREFIX above: this file's whole reason to exist is counting from a
 * runner listing with no dependency on the code that mints anything. */
const WARM_PREFIX = 'warm-';

/**
 * Which NODE owns a runner, by longest declared-name prefix.
 *
 * There were five implementations of this question and two of them disagreed.
 * This one is the rule the other three already used, plus the two naming forms
 * none of them handled — and both of those were live defects:
 *
 *   - a JIT runner is named per JOB, so grouping by raw runner name gave the
 *     fleet panel a new row for every job claw-3 served. Measured 2026-08-29:
 *     70 node rows for a four-node fleet.
 *   - a GitHub-hosted runner likewise reports `GitHub Actions <n>` per job. 58
 *     of those 70 rows were one hosted job each.
 *
 * The version this replaces stripped a trailing `-b`, a convention retired on
 * 2026-08-24 along with the claw-N-b / hokon-b pools. It therefore folded
 * nothing that exists today and left `hokon-tenhands` as its own node, which
 * is how the offline ledger could report it dead separately from hokon.
 *
 * A warm listener strips the SAME way a JIT one does, added 2026-09-07 (P4.1)
 * for the same reason: without it, a `warm-claw-1-hadoku_site` registration
 * would attribute to nothing, and job-history's `lastServedRepoByNode` — which
 * resolves through this function precisely so a warm-served job counts toward
 * its node exactly like a JIT-served one — would never see it.
 *
 * Longest prefix wins so a future `claw-1x` cannot be captured by `claw-1`. An
 * unrecognised name is returned unchanged rather than guessed at — an unknown
 * runner should look unknown, not be silently attributed to a node.
 */
export function nodeOf(runnerName: string, nodes: readonly string[] = []): string {
	if (HOSTED_NAME.test(runnerName)) return HOSTED_NODE;
	const prefix = runnerName.startsWith(JIT_PREFIX)
		? JIT_PREFIX
		: runnerName.startsWith(WARM_PREFIX)
			? WARM_PREFIX
			: '';
	const bare = prefix ? runnerName.slice(prefix.length) : runnerName;
	if (nodes.includes(bare)) return bare;
	const owner = nodes
		.filter((m) => bare.startsWith(`${m}-`))
		.sort((a, b) => b.length - a.length)[0];
	if (owner) return owner;
	// A hand-named runner with its own prefix — `w3p-claw-8-tenhands-taskauto-proof`,
	// a wave-3p proof — names its node as a whole dash-delimited segment. Folded
	// rather than left as a phantom machine row; the delimiters on both sides keep
	// `claw-1` from capturing `claw-10`.
	const inner = nodes
		.filter((m) => bare.includes(`-${m}-`) || bare.endsWith(`-${m}`))
		.sort((a, b) => b.length - a.length)[0];
	return inner ?? bare;
}

const has = (r: CensusRunner, label: string): boolean =>
	(r.labels ?? []).some((l) => l.name === label);

/**
 * Eligibility, by label — "will GitHub put a CI job here right now".
 *
 * Kept distinct from `isClaw` below, which asks IDENTITY. They read similarly
 * and mean opposite things, and collapsing them is precisely the P2 bug: a
 * demoted-but-healthy claw is eligible=false, identity=claw, and counting it as
 * absent turns a routine demotion into a declared outage.
 */
const isEligibleBuilder = (r: CensusRunner): boolean =>
	has(r, BUILDER_LABEL) && !has(r, PM2_HOST_LABEL) && !has(r, BACKSTOP_LABEL);

/**
 * What the EPHEMERAL half of the fleet can serve, from a probe alone.
 *
 * Split out because it has two readers at two different freshnesses, and the
 * slower one was being rendered.
 *
 * `runnerCensus` calls it on the 10-minute health tick, because that is when the
 * backstop decides. `buildFleetReport` calls it on every HTTP request with the
 * 60-second probe, because that is when the operator LOOKS — and under all-JIT
 * every claw's capacity comes from this function, so serving the tick-time copy
 * meant the panel reported a dead fleet for up to ten minutes after each deploy.
 * Measured 2026-09-02 15:34: six reachable claws with nine free mint slots
 * rendering as "0 standing · 0 mintable", in red, while eight jobs queued.
 *
 * `null` is UNMEASURED — the fleet declares ephemeral nodes and no snapshot
 * exists yet. Distinct from `{online: 0, free: 0}`, which is a reading. The
 * whole 2026-09-02 deploy-alarm episode was those two collapsed together, and
 * the panel needs the same distinction the backstop got.
 *
 * A node present in the set but ABSENT from a snapshot that exists is counted
 * down, not unmeasured: guessing upward there is how a real outage stays
 * invisible.
 */
export function mintableCapacity(
	ephemeralNodes: ReadonlySet<string>,
	probe: { nodes?: Record<string, NodeProbeLike> } | null | undefined
): { online: number; free: number; ready: number } | null {
	if (probe == null) return ephemeralNodes.size > 0 ? null : { online: 0, free: 0, ready: 0 };
	const up = [...ephemeralNodes]
		.map((m) => probe.nodes?.[m])
		.filter((p) => Boolean(p?.reachable) && !p?.sick);
	return {
		online: up.length,
		free: up.reduce((n, p) => n + (p?.free ?? 0), 0),
		// MACHINES that could take a job this second, as distinct from the SLOTS
		// above. `online` counts nodes that are up; this counts nodes that are up
		// AND have room, which is the number an operator means by "what is ready".
		ready: up.filter((p) => (p?.free ?? 0) > 0).length,
	};
}

export function runnerCensus<R extends CensusRunner>(i: CensusInput<R>): Census<R> {
	const online = i.runners.filter((r) => r.status === 'online');

	// Promoted together, demoted together — one slot would serialise every
	// repo's CI behind a single job during exactly the outage it exists for.
	const hokonPool = i.runners.filter((r) => has(r, PM2_HOST_LABEL) || has(r, BACKSTOP_LABEL));

	// IDENTITY, not eligibility. A claw is a node the manifest names as one.
	// Excluding BACKSTOP_LABEL in the fallback is load-bearing: once promoted
	// those carry BUILDER_LABEL, and counting them as claws would make the very
	// next tick read "claws are back" and demote the pool it just promoted.
	const isClaw = (r: CensusRunner): boolean =>
		i.clawNodes.size > 0
			? i.clawNodes.has(nodeOf(r.name, [...i.clawNodes]))
			: // Unreadable manifest: fall back to the label reading rather than
				// declaring every node a non-claw, which would read as a total
				// outage.
				isEligibleBuilder(r);

	// A node whose probe is MISSING counts as down. This figure exists to
	// detect an outage, and guessing upward here is how a real outage stays
	// invisible.
	//
	// But an ABSENT SNAPSHOT is a different fact from a node that failed its
	// probe, and collapsing the two is how every mgmt-api restart manufactured a
	// total outage on 2026-09-02. `lastFleetProbe` is null until the fast loop's
	// first pass (~60s after boot), and under all-JIT EVERY claw's capacity comes
	// from it — nothing standing is left to see. runner-health's first tick landed
	// 20s after a deploy, read claws_online=0 against 0 registered, declared an
	// outage and promoted the production host. It reverted a minute later, so each
	// deploy cost a 🔻 and a 🔺 for a fleet that was entirely healthy.
	//
	// "I could not look" must not render as "the garage is dark" any more than it
	// may render as "nothing is wrong" — same rule, other direction. The count
	// below stays honest (unmeasured capacity is not counted); `ephemeralUnknown`
	// is what lets a caller tell the two apart instead of acting on the zero.
	// Declared ephemeral nodes exist, and the snapshot that would describe them
	// has not been taken. Not "they are down" — not measured at all.
	// ONE definition, shared with the fleet route — see mintableCapacity.
	const mint = mintableCapacity(i.ephemeralNodes, i.probe);
	const ephemeralUnknown = mint === null;
	const mintableOnline = mint?.online ?? 0;

	// ...and the SLOTS those nodes can serve, which is a different number.
	//
	// clawsFree asks "can a job start right now". An ephemeral node holds no
	// standing registration, so counting free runner instances finds nothing on
	// it however much room it has — claw-3 reports free:1 today and contributed
	// 0. isAtCapacity is `healthy && clawsFree === 0`, and that gates a
	// SATURATION promote of the production host, so as more of the fleet goes
	// JIT this trends to zero and reaches for hokon over an idle fleet.
	//
	// This is the third instance of the counting bug census.ts was extracted to
	// prevent: mintable capacity was added to clawsOnline and clawsRegistered
	// when ephemeral nodes landed, and clawsFree was missed.
	const mintableFree = mint?.free ?? 0;

	// Capacity that can answer WITHOUT the dispatcher. Reported separately
	// because "the fleet has room" and "a job can start right now" are the same
	// number only while something standing carries the label.
	const standingFree = online.filter((r) => isEligibleBuilder(r) && !r.busy).length;
	// The same set folded to MACHINES. `standingFree` counts runner INSTANCES, so
	// a node hosting three idle registrations contributes three — right for "how
	// many jobs can start", wrong for "how many boxes are ready", and the panel
	// asks the second question.
	const standingReady = new Set(
		online
			.filter((r) => isEligibleBuilder(r) && !r.busy)
			.map((r) => nodeOf(r.name, [...i.clawNodes]))
			.filter((m) => i.clawNodes.has(m))
	).size;

	return {
		online,
		hokonPool,
		clawsOnline: online.filter(isClaw).length + mintableOnline,
		clawsRegistered: i.runners.filter(isClaw).length + mintableOnline,
		// A claw that is ONLINE BUT BUSY cannot take the next job — it queues. An
		// all-green fleet with every claw mid-build is, from a queued job's point
		// of view, indistinguishable from an outage.
		clawsFree: standingFree + mintableFree,
		clawsFreeStanding: standingFree,
		clawsReady: standingReady + (mint?.ready ?? 0),
		clawsReadyStanding: standingReady,
		clawsFreeMintable: mintableFree,
		// NODES that can mint, as distinct from the SLOTS they have free right
		// now. The label floor needs this one: a fleet whose claws are all
		// momentarily busy is not an outage, it is a queue that drains. Asking
		// `clawsFreeMintable > 0` there would page every time the fleet filled up.
		clawsMintableOnline: mintableOnline,
		ephemeralUnknown,
		backstopOnline: hokonPool.filter((r) => r.status === 'online').length,
		// `pm2-host` work is the five infra workflows, and they only ever run on
		// hokon — so a busy runner carrying that label is hokon serving a rung
		// that outranks CI, and hokon's tier must not add builder load on top.
		pm2Busy: i.runners.some((r) => has(r, PM2_HOST_LABEL) && r.busy),
	};
}
