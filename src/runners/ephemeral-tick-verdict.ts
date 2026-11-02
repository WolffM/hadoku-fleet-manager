/**
 * The ephemeral tick's generic admission verdict — wave 5r lane D split of
 * `ephemeral-tick.ts` (pure move), so that file falls under the 800-line
 * source ceiling.
 *
 * `onDemandBackstops` (which nodes the dispatcher mints backstops for),
 * `AdmissionClause`/`AdmissionVerdict` (how one node's GENERIC admission
 * check this tick is classified and reported) and `admissionVerdictFor`
 * (the function that reaches that verdict from a `NodeState`) are stateless
 * — the MAP that remembers the last published verdict per node, and the
 * `__reset*`/`__set*`/`*ForReport` accessors that own it, stay in
 * `ephemeral-tick.ts` beside `dispatchEphemeral`, which is the only thing
 * that WRITES it (lane rule: module state moves with the functions that
 * own it). `recentJobsPerDay` travels here too — same shape (stateless,
 * self-contained, called once per tick) even though it answers a different
 * question.
 *
 * Every name here is re-exported from `ephemeral-tick.ts` so its existing
 * importers compile unchanged.
 */

import { mintsOnDemand } from '../lib/node-role.js';
import { jobRecords } from '../job-history-store.js';
import { admitMint, spaceRefusal } from './ephemeral-admission.js';
import { TMP_FREE_FLOOR_MB } from '../lib/jit-naming.js';
import { type EphemeralTickInput } from './ephemeral-shared.js';
import { type ReserveSource } from '../lib/job-reserve.js';
import { type NodeState } from './placement-node-state.js';

/**
 * The backstops the dispatcher mints for on demand (#120), in manifest order.
 *
 * Operator, 2026-10-19: "the runners get brought online the same way the JIT
 * process does. not having standing runners squatting on ram." Until then the
 * backstop kept ~30 standing listeners alive around the clock (~2.8 GB RSS+swap on
 * the production host) and the backstop's promotion was a label flip on them.
 * Now promotion is a mint, and demotion leaves nothing listening.
 *
 * A DRAINED backstop is still returned: the drain reaches placement as
 * `NodeState.drained` like every other node's, which is what keeps it from
 * taking anything — the drain is the backstop's red light, and it has to read the
 * same way here as it does on a claw.
 */
export function onDemandBackstops(input: EphemeralTickInput): string[] {
	return Object.keys(input.nodes).filter((n) => mintsOnDemand(input.nodes[n]));
}

/**
 * `AdmissionClause`/`AdmissionVerdict` moved to `../lib/fleet-vocabulary.ts`
 * (wave clean-2 lane A, cut (iii)): `runner-health-mint.ts` (observation)
 * reads the same verdict shape through `admission-verdict-store.ts`'s
 * `admissionVerdictsForReport`, and neither domain can host the other's
 * import legally — the vocabulary module is config, which both may import.
 * Re-exported here under the original path so every existing importer
 * (including this file) compiles unchanged.
 */

import type { AdmissionClause, AdmissionVerdict } from '../lib/fleet-vocabulary.js';

function classifyAdmissionClause(reason: string): AdmissionClause {
	if (reason.startsWith('drained:')) return 'drained';
	if (reason.startsWith('at capacity:')) return 'concurrency';
	if (reason.startsWith('memory:') || reason.startsWith('placement:')) return 'memory';
	if (reason.startsWith('space:')) return 'space';
	return 'other';
}

/** `admitMint(ns)`, folded into the shape callers actually want to read. */
export function admissionVerdictFor(ns: NodeState, reserveBasis: ReserveSource): AdmissionVerdict {
	const admit = admitMint(ns);
	if (admit.ok) return { ok: true };
	const reason = admit.reason ?? 'refused';
	const clause = classifyAdmissionClause(reason);
	if (clause === 'space') {
		// Single source of truth with `admitMint` itself — ask `spaceRefusal`
		// the SAME question rather than re-deriving `filesystem` from a string
		// match on `reason`.
		const space = spaceRefusal(ns);
		return {
			ok: false,
			clause,
			availableMb: space?.freeMb ?? 0,
			needMb: space?.floorMb ?? TMP_FREE_FLOOR_MB,
			filesystem: space?.filesystem ?? 'tmp',
			...(space?.freeMb === null ? { unreadable: true as const } : {}),
			reserveBasis,
			reason,
		};
	}
	return {
		ok: false,
		clause,
		availableMb: ns.freeMb,
		needMb: ns.requiredMb,
		reserveBasis,
		reason,
	};
}

/**
 * Jobs per day per repo, from the persisted history.
 *
 * Feeds the hot/cold poll split. This was a literal empty map for the pilot's
 * whole first day, which made EVERY repo cold: a 10-minute poll interval instead
 * of 60 s, so a starved job waited up to eleven minutes for a runner that could
 * have been minted in two. `deriveHotRepos` exists precisely to stop a
 * hand-maintained list going stale, and it was wired to nothing.
 */
export function recentJobsPerDay(): Map<string, number> {
	const out = new Map<string, number>();
	try {
		const records = jobRecords();
		if (!records.length) return out;
		let oldest = Infinity;
		for (const r of records) {
			const t = Date.parse(r.startedAt);
			if (Number.isFinite(t)) oldest = Math.min(oldest, t);
		}
		const days = Math.max(1, (Date.now() - oldest) / 86_400_000);
		const counts = new Map<string, number>();
		for (const r of records) counts.set(r.repo, (counts.get(r.repo) ?? 0) + 1);
		for (const [repo, n] of counts) out.set(repo, n / days);
	} catch {
		// A missing or unreadable history means every repo polls cold — slower,
		// never wrong. It must not take the dispatch pass down with it.
	}
	return out;
}
