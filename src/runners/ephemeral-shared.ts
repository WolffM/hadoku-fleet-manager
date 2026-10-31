import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { JOB_RESERVE_DEFAULT_MB, jitRoot } from './ephemeral.js';
import { nodeShell } from '../node-shell.js';
import { logger, manifest, stateDir } from '../host.js';
import { isGuestNode } from '../lib/node-role.js';
import {
	nodeOffer,
	revokedFor,
	workloadGateContext,
	workloadGatedCapabilities,
	type WorkloadGateContext,
} from '../capabilities.js';
import { readRevocations, REVOCATIONS_FILE, revokedSets } from '../capability-revocations.js';
import { proofFileStatus, readProofsForCapability, type ProofRecord } from '../lib/measured.js';
import type { UserBearingNode } from '../lib/node-users.js';

/** The half of the fast loop's probe this needs. Declared locally, not imported,
 *  so the dependency stays one-directional. */
export interface ProbeLike {
	reachable: boolean;
	busyRepos: ReadonlyMap<string, number> | null;
	/**
	 * Runner.Worker processes running on this node right now — `ProbeResult.workers`
	 * (`fleet-loop.ts`), structurally the same field `NodeProbe` already carries, so
	 * the real caller needs no change to satisfy this (#102.1).
	 *
	 * Optional, and absent falls back to the PRE-#102 approximation (distinct
	 * busy REPOS, from `busyRepos`) rather than 0 — a caller that has not been
	 * touched for this wave (every test fixture written before it) still gets a
	 * real, if coarser, number instead of a node that silently reads idle.
	 */
	workers?: number;
}

export interface EphemeralTickInput {
	fleetProbe: ReadonlyMap<string, ProbeLike>;
	/** Nodes the manifest marks `ephemeral: true`. */
	ephemeral: ReadonlySet<string>;
	nodes: Record<
		string,
		{
			labels?: string[];
			maxConcurrent?: number;
			minFreeMb?: number;
			slice?: { unitMaxMb?: number; name?: string; maxMb?: number };
			/**
			 * `"on-demand"` on a guest: mint for it, gated — see `mintsOnDemand`.
			 * Read through that function, never directly.
			 */
			mint?: string;
			/**
			 * The node's HAND-SET p95 job peak — admission's second answer, after
			 * the queued run's repo figure. See {@link jobReserve}.
			 */
			jobP95Mb?: number;
			/** `"claw"` | `"guest"`. Read through `isGuestNode`, never directly. */
			role?: string;
			/**
			 * `"excluded"` means the reconciler will not register this node for
			 * ANYTHING, standing or JIT (`reconcile-fleet-runners.mjs`'s
			 * `placementFor`/`mayRunRepo`). Any other value, or absent, means
			 * nothing — there is no second value this reads today.
			 */
			placement?: string;
			/**
			 * The manifest's per-repo refusals, reason included — #82. Carried
			 * through to `NodeState.excludedRepos` below (as a `Map`, so
			 * `refusalFor` in `placement.ts` gets O(1) lookup rather than an
			 * object-key scan). `undefined`/absent is "excludes nothing", which is
			 * every node the manifest declares no `excludeRepos` for.
			 */
			excludeRepos?: Record<string, string>;
			/** The node's users by role. Read through `nodeUser`/`nodeHome`, never directly. */
			users?: UserBearingNode['users'];
		}
	>;
	isSick: (node: string) => boolean;
	/** The poll and reap universe. */
	repos: string[];
	/**
	 * Non-ephemeral nodes carrying the eligibility label right now.
	 *
	 * EMPTY means nothing standing can take a queued job, which is the normal
	 * state of an all-JIT fleet. The age gate below is a proxy for "a standing
	 * runner would have taken this by now"; with this empty there is no runner to
	 * wait for and no slot that can free, so the proxy waits for an event that
	 * cannot occur.
	 *
	 * Optional, and ABSENT means "unknown, keep the gate" — a caller that does not
	 * pass it gets the old behaviour rather than a silent removal of the wait.
	 */
	standingEligible?: ReadonlySet<string>;
}

/**
 * THE GENERAL-CAPACITY MINT SET: the ephemeral set, with every guest removed.
 *
 * `input.ephemeral` is general CI capacity, and both entry points
 * (`dispatchEphemeral`, `dispatchWarmCache`) read it that way: the warm cache
 * parks a listener on every member, and every member is ranked by load and
 * speed. Neither is true of a guest — the production host is the last resort,
 * not a peer — so a guest never enters this set, even when the manifest says
 * `ephemeral: true`. That is a manifest contradiction, logged every tick rather
 * than dropped quietly: a node that stops being minted for has to show up
 * somewhere.
 *
 * A guest that mints says so with `mint: "on-demand"` instead, and reaches the
 * dispatcher through {@link onDemandGuests}, placed last and gated — never
 * through this set.
 */
export function withoutGuests(input: EphemeralTickInput): EphemeralTickInput {
	const guests = [...input.ephemeral].filter((n) => isGuestNode(input.nodes[n]));
	if (!guests.length) return input;
	logger.warn(
		`[ephemeral-tick] ${guests.join(', ')} ${guests.length === 1 ? 'is' : 'are'} marked ephemeral ` +
			'but role: guest — a guest is not general capacity; declare `mint: "on-demand"` instead. ' +
			'Not minting there as ephemeral'
	);
	return { ...input, ephemeral: new Set([...input.ephemeral].filter((n) => !guests.includes(n))) };
}

/** A repo's derived reserve, as `reconcile --write-coverage` writes it. */
export interface RepoReserve {
	mb: number;
	/** `measured`: this repo's own p95. `fleet-p95`: under the min runs. */
	basis: 'measured' | 'fleet-p95';
	runs: number;
	/**
	 * Was `mb` itself raised to (or backed by) a run that hit a cap — OOM-killed,
	 * or pinned at a node's own ceiling? See `demand-derive.mjs`'s
	 * `deriveJobReserves`, which sets this. Additive; absent means false, the
	 * shape every repo carried before #76. A `true` here means `mb` is a FLOOR,
	 * not a measurement admission can trust as exact — {@link jobReserve} and
	 * `admitMint`'s placement clause both read it.
	 */
	lowerBound?: boolean;
}

/** Which answer admission used. The log line carries it as `from=`. */
export type ReserveSource = 'repo' | 'node' | 'default';

/**
 * What admission RESERVES for one queued job on one node — Wave 3g J2.
 *
 * THREE ANSWERS, IN ORDER, and the caller is told which one it got:
 *
 *   1. `repo`    the queued run's repo, from `fleet-runner-coverage.json`'s
 *                `facets[repo].jobP95Mb`. DERIVED from job-metrics, never
 *                declared. The memory axis is the repo (Wave 3d J: 35 %
 *                cross-node spread against 423 % across repos on one node),
 *                so this is the answer the other two only approximate. A
 *                `fleet-p95` basis is still this answer: the repo is covered
 *                and measured as a fleet, it just has too few runs of its own.
 *   2. `node`    the node's hand-set `jobP95Mb` — what every job reserved
 *                before this existed. Reached for a repo the roster has no
 *                figure for (not covered yet, or the file unreadable).
 *   3. `default` {@link JOB_RESERVE_DEFAULT_MB}.
 *
 * CLAMPED TO THE CAP, whichever answered — UNLESS the answer is a LOWER BOUND
 * (#76). `min()` lets an ordinary estimate and the cap disagree only in the
 * safe direction: a reserve above `MemoryMax` promises room the unit is not
 * permitted to use, so trimming it to the cap costs nothing the job could ever
 * have spent. A FLOOR built from capped runs is the opposite case — clamping
 * it down to a cap smaller than the floor would erase the one fact that makes
 * the floor meaningful (that THIS node's ceiling cannot be shown to clear it)
 * before `admitMint` ever sees it, which is the bug this whole mechanism exists
 * to catch. So a lower-bound repo reserve is passed through UNCLAMPED, and
 * `admitMint`'s own placement clause is where it is compared against the cap.
 * The clamp does not change `from` either way.
 */
export function jobReserve(i: {
	repoReserve?: RepoReserve | null;
	nodeJobP95Mb?: number;
	capMb: number;
}): { mb: number; from: ReserveSource; lowerBound: boolean } {
	const usable = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
	const pick: { mb: number; from: ReserveSource; lowerBound: boolean } = usable(i.repoReserve?.mb)
		? { mb: i.repoReserve.mb, from: 'repo', lowerBound: i.repoReserve?.lowerBound === true }
		: usable(i.nodeJobP95Mb)
			? { mb: i.nodeJobP95Mb, from: 'node', lowerBound: false }
			: { mb: JOB_RESERVE_DEFAULT_MB, from: 'default', lowerBound: false };
	return {
		mb: pick.lowerBound ? pick.mb : Math.min(pick.mb, i.capMb),
		from: pick.from,
		lowerBound: pick.lowerBound,
	};
}

/**
 * `facets[repo].jobP95Mb` for every covered repo, read fresh.
 *
 * AN UNREADABLE ROSTER IS NOT A FLEET OF ZERO-MEGABYTE JOBS. It returns an
 * empty map, which sends every job to the node's value — exactly what admission
 * reserved before this facet existed — and says so. Refusing every mint instead
 * would turn a missing file into a CI outage; guessing would be worse.
 */
export function loadRepoReserves(
	path: string = manifest('fleet-runner-coverage.json')
): ReadonlyMap<string, RepoReserve> {
	const out = new Map<string, RepoReserve>();
	let parsed: { facets?: Record<string, { jobP95Mb?: Partial<RepoReserve> } | undefined> };
	try {
		parsed = JSON.parse(readFileSync(path, 'utf8')) as typeof parsed;
	} catch (err) {
		logger.warn(
			`[ephemeral-tick] cannot read per-repo reserves from ${path} ` +
				`(${err instanceof Error ? err.message : String(err)}) — admission falls back to the node's value`
		);
		return out;
	}
	for (const [repo, f] of Object.entries(parsed.facets ?? {})) {
		const r = f?.jobP95Mb;
		if (typeof r?.mb !== 'number' || !(r.mb > 0)) continue;
		out.set(repo, {
			mb: r.mb,
			basis: r.basis === 'measured' ? 'measured' : 'fleet-p95',
			runs: typeof r.runs === 'number' ? r.runs : 0,
			// ADDITIVE (#76): absent on every roster written before this reads as
			// `false` here too, via `=== true` rather than a bare truthy check.
			lowerBound: r.lowerBound === true,
		});
	}
	return out;
}

/**
 * THE LABEL SET A JIT PATH ON THIS NODE PROJECTS — issue #19, through one door.
 *
 * Every JIT path in this file used `m.labels ?? []`, the manifest's DECLARED
 * array, three times: the mint's `labelsFor`, the warm listener's labels, and
 * the `NodeState.labels` that `placement.ts` refuses a node on. So the array
 * was the label WRITER for the whole ephemeral fleet, and the 2026-09-07
 * decision that capabilities are DERIVED and never declared could not be
 * carried out — emptying it minted `self-hosted,Linux,X64` while every covered
 * repo asks for `["self-hosted","hadoku-builder"]`, and `check-label-floor`
 * stayed green through it (proved by execution, Wave 2 closeout).
 *
 * `eligible: true` is not a guess. Under all-JIT no eligibility LABEL is
 * toggled on these nodes at all — `setTierEligibility` skips ephemeral ones —
 * so the dispatcher's decision to mint for a node IS the eligibility decision,
 * and it was already taken upstream: the ladder put the node in `ephemeral`,
 * `choosePlacement` still refuses it when `demoted`, `drained` or over its
 * admission cap. Re-deriving eligibility here would be a SECOND authority that
 * can disagree with the first, and it would disagree exactly when the demand
 * ledger is unreadable. See `nodeOffer`'s own docblock.
 *
 * `gate` (wave 4e follow-up, #102) IS THE PRODUCTION FIX for the defect the
 * manager's verification caught before landing: the lane's first draft had
 * every call here omit `nodeOffer`'s `workloadProofs`/`provenCounts`
 * entirely, which is the SAFE default for a caller that has not been wired
 * yet — but THIS is the mint's `labelsFor`, both warm-listener label sites
 * and placement's `labelsFor`, i.e. every real routing decision in the
 * fleet, and an omitted gate there would have meant claw-3's FAIL (or lane
 * B's STALE mark) withdrew NOTHING in production. `gate` is built ONCE per
 * tick by `loadWorkloadGateContext` (below), not once per node: it is a
 * single state-dir read reused for every node `offerFor` is asked about in
 * that pass.
 */
export function offerFor(
	nodes: EphemeralTickInput['nodes'],
	node: string,
	gate: WorkloadGateContext,
	/**
	 * Does this node offer the general CI label? Always for a claw: the
	 * dispatcher's decision to mint IS its eligibility decision. For an
	 * on-demand guest, only while the backstop holds it (#120) — the guest is
	 * still minted for the work only it can do, but `hadoku-builder` is the
	 * backstop's to grant, exactly as it was on the standing registrations.
	 */
	eligible = true
): string[] {
	return nodeOffer(nodes[node] ?? {}, {
		eligible,
		workloadProofs: gate.byNode[node] ?? {},
		provenCounts: gate.provenCounts,
		revoked: revokedFor(gate, node),
	});
}

/**
 * Build this TICK's `WorkloadGateContext` — one state-dir read, reused for
 * every `offerFor` call the tick makes, never one read per node (this runs on
 * the 15s dispatch loop).
 *
 * `proofFileStatus` is checked FIRST, separately from the per-capability
 * reads, for the same reason `src/routes/fleet.ts`'s own loader does it: an
 * UNREADABLE or MALFORMED `$proof` file must never be read as "no records at
 * all" (which `readProofsForCapability` alone would do, silently RE-GRANTING
 * a label a FAIL/STALE mark had just withdrawn). `workloadGateContext`'s
 * `opts.corrupt` is what turns that into "withhold every workload-gated label
 * fleet-wide until the file is fixed" instead — the safe failure direction.
 */
/**
 * The last `(reason, why)` this function logged about a corrupt `$proof`
 * file, or `null` when the file was readable last time this ran. This tick
 * runs every ~15s, so logging unconditionally would write the same line to
 * the log once per tick for as long as the file stays broken — true but
 * useless, and loud enough to bury whatever else is happening. `null` on a
 * HEALTHY read (not merely "same reason as before") is deliberate: a file
 * that recovers and later breaks again, even with byte-identical text, is a
 * NEW transition worth saying out loud again, not a repeat of the old one.
 */
let lastLoggedProofCorruption: string | null = null;

export function loadWorkloadGateContext(nodeNames: readonly string[]): WorkloadGateContext {
	if (workloadGateContextOverride) return workloadGateContextOverride;
	const revoked = loadRevoked();
	const status = proofFileStatus({ dir: stateDir() });
	if (status.corrupt) {
		const key = `${status.reason}:${status.why}`;
		if (key !== lastLoggedProofCorruption) {
			lastLoggedProofCorruption = key;
			logger.error(
				`[ephemeral-tick] $proof is ${status.reason} (${status.why}) — withholding every ` +
					`workload-gated label fleet-wide until it is readable again: "I could not look" must ` +
					`never silently re-grant a label a bad reading withdrew.`
			);
		}
		return workloadGateContext(nodeNames, {}, { corrupt: true, revoked });
	}
	lastLoggedProofCorruption = null;
	const proofsByCapability: Record<string, ProofRecord[]> = {};
	for (const id of workloadGatedCapabilities())
		proofsByCapability[id] = readProofsForCapability(id, { dir: stateDir() });
	return workloadGateContext(nodeNames, proofsByCapability, { revoked });
}

let lastLoggedRevocationCorruption: string | null = null;

/**
 * This tick's revoked labels — one state-dir read, alongside `$proof`'s. A
 * corrupt record withholds every probe-verified routing label (`'all'`) and
 * says so once per distinct reason: "I could not look" must never re-grant a
 * label a failed execution withdrew. See src/capability-revocations.ts.
 */
function loadRevoked(): Record<string, ReadonlySet<string>> | 'all' {
	const read = readRevocations(stateDir());
	if (read.corrupt) {
		if (read.why !== lastLoggedRevocationCorruption) {
			lastLoggedRevocationCorruption = read.why;
			logger.error(
				`[ephemeral-tick] ${REVOCATIONS_FILE} is unreadable (${read.why}) — withholding every ` +
					'probe-verified label fleet-wide until it is readable again.'
			);
		}
	} else lastLoggedRevocationCorruption = null;
	return revokedSets(read);
}

/** Test seam: the corruption-logging dedup is module-level, same leak class as every other reset in this file. */
export function __resetWorkloadGateCorruptionLogForTesting(): void {
	lastLoggedProofCorruption = null;
}

/**
 * Test seam, same shape as `__setAdmissionVerdictsForTesting` and the rest of
 * this file's module-level overrides. Real production code never calls this:
 * a test that wrote a REAL `$proof` fixture into the test host's shared state
 * dir would leak into every other test in the same process, since that
 * directory is not reset between tests the way each test's own `tmp` is.
 * `null` restores the real read.
 */
let workloadGateContextOverride: WorkloadGateContext | null = null;
export function __setWorkloadGateContextForTesting(ctx: WorkloadGateContext | null): void {
	workloadGateContextOverride = ctx;
}

/**
 * Run a command on a node and return its stdout, or null if it could not.
 *
 * `null` means UNREACHABLE and never "empty output" — the reaper refuses to
 * touch a node it cannot see, so collapsing the two would let a network blip
 * delete registrations whose listeners are mid-job.
 */
export function shellOnNode(node: string, cmd: string): Promise<string | null> {
	// The local branch. This function had NONE, which made it the fourth and
	// worst of the four answers to "is this node me?": hokon refuses ssh to
	// itself, so a local ephemeral node would come back `null` on every call —
	// and `null` is UNREACHABLE, which the reaper reads as "do not touch". It
	// would never have been reaped at all. Latent only because the one
	// `ephemeral: true` node today is claw-3 and this runs on hokon.
	// As ci: minting, the reap and the probe all act on CI's units and $HOME.
	let bin: string;
	let argv: string[];
	try {
		[bin, argv] = nodeShell(node, 'ci', cmd);
	} catch (err) {
		logger.warn(
			`[ephemeral] cannot reach ${node} as ci: ${err instanceof Error ? err.message : String(err)}`
		);
		return Promise.resolve(null);
	}
	return new Promise((res) => {
		execFile(bin, [...argv], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
			res(err ? null : String(stdout))
		);
	});
}

/**
 * #101: the `df -Pm` half of the space probe, shared VERBATIM between this
 * file's two ssh round-trips that read free space — `dispatchEphemeral`'s
 * node loop and `dispatchWarmCache`'s observation pass below — so the two
 * cannot drift into asking slightly different questions. Appended to
 * whichever `free -m` invocation each caller already makes; output is
 * always the free/total line(s) first, then exactly these two lines.
 */
const JIT_PROBE_DIR = jitRoot('~');
const JIT_PROBE_PARENT_DIR = JIT_PROBE_DIR.slice(0, JIT_PROBE_DIR.lastIndexOf('/'));
export const SPACE_PROBE_DF_CMD =
	"df -Pm /tmp | awk 'NR==2{print $4, $2}'; " +
	`(df -Pm ${JIT_PROBE_DIR} 2>/dev/null || df -Pm ${JIT_PROBE_PARENT_DIR} 2>/dev/null || df -Pm ~) | awk 'NR==2{print $4}'`;

/**
 * #101: the other half of the shared probe — parses `shellOnNode`'s RAW
 * output (which always ends in a newline, the way `execFile`'s stdout does;
 * a prior version split an already-split array and read the last TWO
 * elements, which on a trailing newline is `['...', '<tmp>', '<work>', '']`
 * — the real shape captured off claw-4 — so it silently read the WORK figure
 * as `/tmp`'s and the trailing empty string as "unreadable" `/work`. This
 * version splits the raw string itself, on `\r?\n`, trims every line, and
 * DROPS empty ones before counting, so a trailing (or stray blank) line
 * never shifts anything.
 *
 * The exact shape required is three non-empty lines: line 1 is the caller's
 * own `free -m` figures, handed back verbatim as `first` for its existing
 * parse; line 2 is `/tmp` free MB, then its total size MB (#132 — the
 * disk-watch advisory is judged against what the tmpfs can hold; a line
 * carrying the free figure alone reads with `tmpSizeMb: null`); line 3 is the
 * jit filesystem's free MB. Digits only, not `Number()`, on lines 2–3: an empty string, a `df` error
 * message, or a negative number must all read as unreadable (`null`), never
 * as 0-as-a-number (which would refuse) and never as `NaN` silently
 * admitted. Any shape other than exactly three non-empty lines makes BOTH
 * figures `null` — a shifted line must never be read as the other
 * filesystem's figure — even though `first` is still handed back whenever a
 * first line exists, since the caller's own parse of it is independent of
 * whether the df probe came back intact.
 */
export function parseSpaceProbe(out: string | null): {
	first: string;
	tmpFreeMb: number | null;
	tmpSizeMb: number | null;
	workFreeMb: number | null;
} {
	const lines = String(out ?? '')
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const first = lines[0] ?? '';
	if (lines.length !== 3) {
		return { first, tmpFreeMb: null, tmpSizeMb: null, workFreeMb: null };
	}
	const tmp = /^(\d+)(?:\s+(\d+))?$/.exec(lines[1]);
	const workRaw = lines[2];
	return {
		first,
		tmpFreeMb: tmp ? Number(tmp[1]) : null,
		tmpSizeMb: tmp?.[2] !== undefined ? Number(tmp[2]) : null,
		workFreeMb: /^\d+$/.test(workRaw) ? Number(workRaw) : null,
	};
}
