/**
 * THE LABEL FLOOR — one model for every routable label (operator, 2026-10-10:
 * `jdk21` and `cargo-bevy` must "function the same as other runners").
 *
 * WHAT IT REPLACES
 * ----------------
 * Until 2026-10-10 the floor was a per-capability boolean (`floor: true|false`
 * in the registry) and runner-health counted STANDING online runners only. That
 * model could not express the fleet it was watching: every claw is JIT, so a
 * label a claw earns is carried by nobody until a job asks for it. `jdk21` and
 * `cargo-bevy` were therefore marked `floor: false` — watched by nothing — and
 * `check-label-floor` reported both as `missing` every night with a note that
 * the machinery "cannot express earned JIT offerers". The fix was never an
 * allowlist; it was a floor that knows what a mint is.
 *
 * THE MODEL
 * ---------
 * A label is SERVED when at least one of:
 *
 *   (a) STANDING  a standing, online runner carries it (GitHub's own listing);
 *   (b) MINTING   a minting node OFFERS it — `nodeOffer` with the workload gate,
 *                 the exact answer the dispatcher mints from — and that node is
 *                 eligible the way the dispatcher judges it: not drained, not
 *                 sick, not `placement: "excluded"`, and REACHABLE and not sick
 *                 in the fast loop's last probe.
 *
 * The floor pages when NEITHER holds for a label workflows demand.
 *
 * UNMEASURED IS NOT ZERO. The probe is null until the fast loop's first pass,
 * ~60s after every mgmt-api restart, and runner-health's first tick lands inside
 * that window. A label whose only path is minting cannot be called served there
 * (nothing has looked) and cannot be called unserved either (that is how every
 * deploy used to manufacture an outage — census.ts, 2026-09-02). It is HELD: the
 * streak neither advances nor clears. Same shape as `census.ephemeralUnknown`.
 *
 * WHAT IS WATCHED: DEMAND, NOT A HAND LIST
 * ----------------------------------------
 * The watched set is every label covered repos ask for — the same demand
 * `check-label-floor` computes, from the same two halves:
 *
 *   OBSERVED  labels jobs actually requested over job history's retention
 *             window, proof canaries excluded. runner-health reads this
 *             in-process from `jobRecords()`.
 *   STATIC    labels covered repos' workflows CAN request, per job
 *             (`scripts/lib/runs-on-demand.mjs`). That needs every sibling
 *             checkout, so `fleet label-floor` computes it and persists it to
 *             {@link FLOOR_DEMAND_FILE}; runner-health reads the file. Without
 *             it a label demanded by a rarely-run workflow (`cargo-bevy`: zero
 *             observed jobs in the 14 days to 2026-10-10) would be unwatched,
 *             and a job that queues forever never STARTS, so it never reaches
 *             the observed half either.
 *
 * Both halves exclude `self-hosted`/`Linux`/`X64` (implicit on every
 * registration) and hosted images (no node earns them) through ONE predicate,
 * {@link isFloorDemandLabel}, which the gate imports.
 *
 * Pure. No fs, no network: runner-health and the gate do the reading.
 */

import {
	IMPLICIT_LABELS,
	nodeOffer,
	revokedFor,
	type ManifestNode,
	type WorkloadGateContext,
} from './capabilities.js';
import { mintsJitRunners } from './lib/node-role.js';

/** State-dir file `fleet label-floor` writes and runner-health reads: the static half of demand. */
export const FLOOR_DEMAND_FILE = 'label-floor-demand.json';

/** Implicit on every self-hosted registration. Compared case-insensitively. */
const IMPLICIT = new Set(['self-hosted', 'linux', 'x64']);

const HOSTED_RE = /ubuntu-latest|ubuntu-\d|windows-|macos-/;
const HOSTED_PREFIX = /^(ubuntu|macos|windows)(-|$)/;

/**
 * A GitHub-HOSTED image label, e.g. `ubuntu-latest`, `ubuntu-24.04`,
 * `windows-2022`, `macos-14` — or a BARE `ubuntu`/`macos`/`windows` with
 * nothing after it at all, which `HOSTED_RE` alone does not catch and
 * `HOSTED_PREFIX` exists for.
 *
 * THE CANONICAL PREDICATE (plan §4.1 F13). Until this it lived three times:
 * here as these two unexported regexes folded into `isFloorDemandLabel`'s
 * own negation, `scripts/lib/runs-on-demand.mjs`'s own `isHostedLabel` (the
 * same union, correctly, via `demand-derive.mjs`'s `HOSTED_RE` plus its own
 * inline copy of the prefix rule), and `runner-health.ts`'s own
 * `isHostedLabel` — which required a `-` and something after it
 * (`/^(ubuntu|windows|macos)-[\w.]+$/`) and so answered `false` for a bare
 * `ubuntu`, a real label GitHub serves (5a, §8.3). A queued job landing on a
 * bare-`ubuntu` hosted runner read as a self-hosted coverage gap instead of
 * the hosted job it was.
 *
 * Exported so `runner-health.ts` (same file, TS — a direct import) and
 * `scripts/lib/runs-on-demand.mjs` (via the compiled `dist/label-floor.js`:
 * `tsconfig.json` sets no `allowJs` and `include`s only `src/**\/*.ts`, so a
 * `.mjs` cannot import this SOURCE file — same restriction `cli.ts`'s own
 * header names, same `dist/*.js` door every other `scripts/lib/*.mjs` uses)
 * can both drop their own copy.
 */
export function isHostedLabel(label: string): boolean {
	return HOSTED_RE.test(label) || HOSTED_PREFIX.test(label);
}

/** Is this a label a node can lose, i.e. one the floor can watch? */
/**
 * A workload canary's one-off aiming label, the shape `proofLabel()` mints
 * (`proof-<base36 ms>`). Never demand: nobody but the canary will ask for it
 * again. Matched by LABEL, not only by runner: a standing-mode proof (2026-10-10)
 * runs on the node's own registration (`hokon`), so the runner-name filter let
 * `proof-mv334990` into observed demand and the floor paged for it at 06:24Z.
 * `label-floor.test.ts` pins this to `proofLabel()` so the two cannot drift.
 */
export const PROOF_LABEL_RE = /^proof-[0-9a-z]+$/;

export function isFloorDemandLabel(label: string): boolean {
	return (
		typeof label === 'string' &&
		label.length > 0 &&
		!IMPLICIT.has(label.toLowerCase()) &&
		!isHostedLabel(label) &&
		!PROOF_LABEL_RE.test(label)
	);
}

/** The fields of a job-history record the observed half reads. */
export interface DemandJobRecord {
	labels?: readonly string[];
	runner?: string;
	startedAt?: string;
}

/**
 * The OBSERVED half: every floor-demand label a job requested at or after
 * `sinceIso`, excluding jobs `isProof` claims (a workload canary is pinned with
 * a one-off `proof-*` label nobody else will ever request).
 */
export function observedFloorDemand(
	records: readonly DemandJobRecord[],
	opts: { sinceIso: string; isProof: (runner: string) => boolean }
): Set<string> {
	const out = new Set<string>();
	for (const r of records) {
		if (typeof r.startedAt !== 'string' || r.startedAt < opts.sinceIso) continue;
		if (typeof r.runner === 'string' && opts.isProof(r.runner)) continue;
		// A job aimed with a proof label IS a proof, whatever runner took it.
		if ((r.labels ?? []).some((l) => PROOF_LABEL_RE.test(l))) continue;
		for (const l of r.labels ?? []) if (isFloorDemandLabel(l)) out.add(l);
	}
	return out;
}

/**
 * THE WATCHED SET — `REQUIRED_LABELS`' successor. Every floor-demand label in
 * `demand`, sorted, deduplicated.
 *
 * Deliberately NOT filtered by the registry. A demanded label no capability
 * registers is still a routing dependency, and if nothing serves it the jobs on
 * it queue forever — dropping it here is how a floor gets easier to pass the
 * more the fleet loses.
 */
export function floorLabels(demand: Iterable<string>): string[] {
	return [...new Set([...demand].filter(isFloorDemandLabel))].sort();
}

/** What runner-health knows about one MINTING node this tick. */
export interface MintingNode {
	name: string;
	/** `nodeOffer(node, {eligible: true, ...workloadGate})` — the dispatcher's own answer. */
	offers: readonly string[];
	drained: boolean;
	/** Quarantined by the fast loop (`nodeIsSick`). */
	sick: boolean;
	/** `placement: "excluded"` — the dispatcher's NodeState.eligible is false. */
	excluded: boolean;
	/** The fast loop's last probe for this node, or undefined when the snapshot has no entry. */
	probe?: { reachable?: boolean; sick?: boolean };
}

/**
 * The minting half of the fleet, as the floor sees it.
 *
 * `measured: false` is the fast loop's probe not existing yet. It is NOT the
 * same as every node being unreachable — see the module header.
 */
export interface MintView {
	measured: boolean;
	nodes: readonly MintingNode[];
}

export type LabelFloorVerdict =
	| { state: 'standing'; count: number }
	| { state: 'minting'; nodes: string[] }
	| { state: 'unmeasured'; nodes: string[] }
	| { state: 'unserved'; why: string };

/**
 * Is `label` served? One verdict, four answers — see the module header.
 *
 * `served` is `standing` or `minting`. `unmeasured` HOLDS (never pages, never
 * counts as served). `unserved` is the only state that may advance a page, and
 * its `why` says which half failed so the page is actionable.
 */
export function judgeLabelFloor(
	label: string,
	standingOnline: number,
	mint: MintView
): LabelFloorVerdict {
	if (standingOnline > 0) return { state: 'standing', count: standingOnline };
	return judgeOfferers(
		mint.nodes.filter((n) => n.offers.includes(label)),
		mint,
		'no standing runner carries it online'
	);
}

/**
 * Could a MINT serve a job asking for `labels`? The floor's minting arm, asked
 * of a whole JOB rather than one label (#110).
 *
 * A job is one placement: it needs ONE node offering every label it asks for,
 * so `jdk21` offered by claw-3 and `claw-8` offered by claw-8 do not add up to
 * a node that can take `[jdk21, claw-8]`. The implicit labels are on every
 * registration and are matched the way `placement.ts` matches them,
 * case-insensitively. The eligibility filters, the probe and the unmeasured
 * hold are the floor's own, through the same helper, so the two cannot
 * disagree about which nodes mint.
 *
 * Never `standing`: the caller asks this only after the repo's standing
 * runners have already failed to cover the job.
 */
export function judgeJobMint(labels: readonly string[], mint: MintView): LabelFloorVerdict {
	const implicit = new Set(IMPLICIT_LABELS.map((l) => l.toLowerCase()));
	const wanted = labels.map((l) => l.toLowerCase()).filter((l) => !implicit.has(l));
	return judgeOfferers(
		mint.nodes.filter((n) => {
			const has = new Set(n.offers.map((o) => o.toLowerCase()));
			return wanted.every((l) => has.has(l));
		}),
		mint,
		'no standing runner of this repo can take it'
	);
}

/** The minting arm: of the nodes that OFFER the thing, is one eligible and live? */
function judgeOfferers(
	offerers: readonly MintingNode[],
	mint: MintView,
	standingWhy: string
): LabelFloorVerdict {
	if (!offerers.length) {
		return { state: 'unserved', why: `${standingWhy} and no minting node offers it` };
	}
	// Eligible by everything this tick can know WITHOUT the probe.
	const candidates = offerers.filter((n) => !n.drained && !n.sick && !n.excluded);
	if (!candidates.length) {
		const held = offerers.map(
			(n) =>
				`${n.name} (${[n.drained && 'drained', n.sick && 'sick', n.excluded && 'excluded'].filter(Boolean).join(', ')})`
		);
		return {
			state: 'unserved',
			why: `${standingWhy}, and every minting node that offers it is out of service: ${held.join(', ')}`,
		};
	}
	if (!mint.measured) return { state: 'unmeasured', nodes: candidates.map((n) => n.name) };
	const live = candidates.filter((n) => Boolean(n.probe?.reachable) && !n.probe?.sick);
	if (live.length) return { state: 'minting', nodes: live.map((n) => n.name) };
	return {
		state: 'unserved',
		why:
			`${standingWhy}, and every minting node that offers it is ` +
			`unreachable or sick in the fast loop's last probe: ${candidates.map((n) => n.name).join(', ')}`,
	};
}

/**
 * Build the {@link MintView} from manifest nodes, the SAME way the dispatcher
 * builds its NodeState (`ephemeral-tick.ts`): offers through `nodeOffer` with
 * this tick's workload gate, `eligible: true` (the dispatcher's decision to mint
 * IS the eligibility decision), drained from the drain file, excluded from
 * `placement`.
 *
 * Every node the dispatcher mints on: the `ephemeral: true` claws, and an
 * on-demand guest (#120). The guest offers `hadoku-builder` here only while the
 * backstop holds it — `held`, the same answer the dispatcher's `offerFor`
 * reads — and its own labels (`taskauto`, `av1-nvenc`, ...) always: since its
 * standing runners were retired, a mint is the only thing that serves them,
 * so leaving it out would read every such job as a coverage gap. A guest that
 * keeps standing registrations is not here; arm (a) counts those from GitHub's
 * listing.
 */
export function buildMintView(input: {
	machines: Readonly<Record<string, ManifestNode>>;
	gate: WorkloadGateContext;
	drained: ReadonlySet<string>;
	isSick: (node: string) => boolean;
	probe: { nodes?: Record<string, { reachable?: boolean; sick?: boolean }> } | null;
	/** Is this on-demand guest held by the backstop? Absent reads as no. */
	held?: (node: string) => boolean;
}): MintView {
	const nodes: MintingNode[] = [];
	for (const [name, m] of Object.entries(input.machines)) {
		if (!mintsJitRunners(m)) continue;
		nodes.push({
			name,
			offers: nodeOffer(m, {
				eligible: m.ephemeral === true || (input.held?.(name) ?? false),
				workloadProofs: input.gate.byNode[name] ?? {},
				provenCounts: input.gate.provenCounts,
				revoked: revokedFor(input.gate, name),
			}),
			drained: input.drained.has(name),
			sick: input.isSick(name),
			excluded: m.placement === 'excluded',
			probe: input.probe?.nodes?.[name],
		});
	}
	return { measured: input.probe != null, nodes };
}
