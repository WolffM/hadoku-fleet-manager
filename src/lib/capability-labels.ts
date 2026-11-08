import { CAPABILITIES, type Capability, type ManifestNode } from './capability-registry.js';

/** Every capability expressed as a GitHub runner label. */
export function labelCapabilities(): Capability[] {
	return CAPABILITIES.filter((c) => c.surface === 'label');
}

/**
 * The PRIORITY LADDER, highest rung first: `pm2-host > hadoku-builder > taskauto`.
 *
 * GitHub has no runner priority, so this ordering is not something the forge
 * enforces — it is enforced by the fast loop writing and removing
 * `hadoku-builder`, and by `node-reservation` holding the production host off
 * lower rungs while it serves a higher one. Which makes the ordering itself a
 * FACT ABOUT THE FLEET that readers need and, until now, could only copy out of
 * a comment.
 *
 * Derived from `rung`, so adding a middle rung reorders every reader at once
 * instead of leaving four prose copies to be found by hand.
 */
export function ladder(): string[] {
	return labelCapabilities()
		.filter((c) => typeof c.rung === 'number')
		.sort((a, b) => (a.rung ?? 0) - (b.rung ?? 0))
		.map((c) => c.id);
}

/**
 * Labels GitHub puts on every self-hosted registration by itself.
 *
 * Not capabilities: nothing declares them, nothing can lose them, and a job
 * asking for one is not asking for anything a node had to earn. They are here
 * because every reader that displays a runner's labels has to subtract them,
 * and there were THREE copies of this list — `placement.IMPLICIT_LABELS`
 * (lower-cased, for matching), `ephemeral-exec.mintLabels` (cased, because a
 * JIT mint must add them explicitly — `generate-jitconfig` does not), and a
 * fourth in the command station's Machines table, in another repo entirely.
 *
 * Cased as GitHub reports them. Compare case-insensitively; `satisfiesLabels`
 * does, and a JIT mint sends `Linux`/`X64` while a job asks for `linux`/`x64`.
 */
export const IMPLICIT_LABELS: readonly string[] = ['self-hosted', 'Linux', 'X64'];

/**
 * A LANE label: `lane-<name>`, asked for by a workflow so that ONLY runners
 * minted for that workflow's jobs can take them.
 *
 * GitHub gives a runner to ANY queued job of the repo whose labels are a
 * subset of the runner's. A JIT mint carries its node's whole label set, so
 * the runner the dispatcher minted for one job is routinely taken by another:
 * on 2026-11-08 03:40:54Z a claw-6 runner minted for cardtable's main-push CI
 * `static` was taken 9 s later by a verify-branch Forge dispatch's `changes`,
 * and `static` was re-placed three more times while the deploy gate waited.
 * The dispatcher's priority order cannot fix that; GitHub picks the job.
 *
 * A lane is satisfiable on EVERY node (no node has to earn it) and is added to
 * a mint only when the job it was minted for asked for it. Two workflows that
 * each ask for their own lane cannot take each other's runners.
 */
export const LANE_LABEL_RE = /^lane-[a-z0-9][a-z0-9-]*$/i;

export function isLaneLabel(label: string): boolean {
	return LANE_LABEL_RE.test(label);
}

/** The lane labels in `labels`, in order, de-duplicated case-insensitively. */
export function laneLabelsOf(labels: readonly string[]): string[] {
	const seen = new Set<string>();
	return labels.filter(
		(l) => isLaneLabel(l) && !seen.has(l.toLowerCase()) && seen.add(l.toLowerCase())
	);
}

/**
 * Labels a STANDING listener must never carry, derived from the registry.
 *
 * A capability whose `requires.facts` include the ephemeral fact is one only a
 * JIT mint may offer. `jit-canary` is the case that exists, and its own entry
 * says why: "A standing runner carrying this label would answer the canary
 * without minting anything, so it would stay green through a total dispatcher
 * outage."
 *
 * WHY THIS EXISTS. The warm-listener cache provisioned its runners with
 * `mintLabels()` — the same set a JIT mint gets — so a warm listener on claw-3
 * inherited `jit-canary` and answered the canary. Observed 2026-09-08/09: five
 * consecutive `site:jit-canary` failures, every one served by
 * `warm-claw-3-hadoku_site`, failing on the step named "prove this ran on a
 * minted runner". The canary caught it, which is the system working — but the
 * warm cache should never have been able to answer it.
 *
 * DERIVED, not a hardcoded list, because the whole point of this registry is
 * that a new ephemeral-only capability should not need three files edited. If
 * one is added tomorrow, warm listeners stop carrying it for free.
 */
export function ephemeralOnlyLabels(): string[] {
	return CAPABILITIES.filter(
		(c) => c.surface === 'label' && (c.requires?.facts ?? []).some((f) => f.id === 'ephemeral')
	).map((c) => c.id);
}

/**
 * Eligibility label ids — the ones the fast loop owns and this package must
 * never write from the registration path.
 */
export function eligibilityLabels(): string[] {
	return labelCapabilities()
		.filter((c) => c.kind === 'eligibility')
		.map((c) => c.id);
}

/** Ids a probe can execute — the `verify === 'probe'` half of CAPABILITIES. */
export function probeableIds(): Set<string> {
	return new Set(CAPABILITIES.filter((c) => c.verify === 'probe').map((c) => c.id));
}

/**
 * A node's IDENTITY labels — the facts about it, projected onto every runner
 * the reconciler registers.
 *
 * DERIVED, not filtered by hand. The reconciler carried
 * `.filter(l => l !== BUILDER_LABEL)` in two places with a paragraph beside each
 * explaining that `hadoku-builder` is eligibility and must be excluded. That is
 * the registry's `kind` field written twice in prose, and it only ever excluded
 * the ONE eligibility label someone remembered to name.
 *
 * An UNDECLARED label is passed through unchanged rather than dropped. The
 * reconciler is additive on purpose — it registers and relabels, it never
 * strips — and a derivation that silently swallowed an unknown label would
 * unroute live jobs on a manifest typo. The schema gate is what rejects the
 * typo; this function must not also be a filter, or the two fight.
 */
export function identityLabels(node: ManifestNode): string[] {
	const eligibility = new Set(eligibilityLabels());
	return (node.labels ?? []).filter((l) => !eligibility.has(l));
}
