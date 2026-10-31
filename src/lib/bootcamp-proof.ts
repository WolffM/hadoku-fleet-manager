import type { BootcampFacet, ManifestNode } from './capability-registry.js';

/**
 * One record from `~/.hadoku-mgmt/demand-ledger.jsonl`, the shape
 * `fleet tool-inventory --write` emits (`scripts/lib/demand-derive.mjs`). Only
 * the fields `requiredIdentitySet` reads.
 */
export interface DemandRecord {
	/**
	 * `"ci"` or `"resident"` — the wave-3-prep discriminator
	 * (`docs/planning/service-ledger-2026-09-10.md` §1). One file, two
	 * populations, so the floor reads one ledger; absent on every row written
	 * before 2026-09-10.
	 */
	class?: string;
	fleetForm?: boolean;
	selfHosted?: boolean;
	hosted?: boolean;
	capabilities?: string[];
}

/** The demand ledger's CI class — one row per `(repo, job)`. */
export const CI_DEMAND_CLASS = 'ci';

/**
 * Is this a CI-demand row?
 *
 * ABSENT COUNTS AS `ci`, and that is the backward-compatibility half rather
 * than a looseness: `fleet tool-inventory --write` was the ledger's only writer
 * until 2026-09-10, so every one of the 147 rows on the live ledger is a CI row
 * with no `class` field. Treating absent as "not ci" would empty
 * `requiredIdentitySet` the instant this shipped and before the ledger was
 * re-emitted — and an empty required set makes `check-label-floor`'s
 * required-gap check pass having checked nothing, which is CLAUDE.md's "no gate
 * may get easier to pass the worse the failure gets" exactly.
 *
 * The ledger's other writer discharges the mirror obligation: resident rows
 * ALWAYS carry `class: "resident"` (S's §2), so nothing unlabelled is ever
 * resident demand.
 */
export function isCiDemandRecord(record: DemandRecord): boolean {
	return record.class === undefined || record.class === CI_DEMAND_CLASS;
}

/**
 * The identity capabilities the covered repos' jobs actually ask for, on the
 * GENERAL POOL — union of every demand-ledger record's `capabilities` where
 * the job can land on ANY claw (`fleetForm && selfHosted && !hosted`).
 *
 * DERIVED, NEVER DECLARED (`bootcamp-earned-labels-2026-09-02.md` §4,
 * `tier-assignment-2026-09-03.md` §5.3): this is `hadoku-builder`'s required
 * set, and it is computed from the ledger every time rather than typed by
 * hand, so it cannot go stale the way "9 of the 26 covered repos" and then
 * "3" did before the ledger existed.
 *
 * Excludes a job pinned to hosted runners or to one specific machine
 * (`hosted`, or `selfHosted` without `fleetForm`) on purpose — a repo must not
 * be able to raise the FLEET-WIDE bar with a job no claw will ever receive.
 *
 * Pure: the caller reads the ledger file and hands the parsed records here.
 * An id this returns that is not a registered capability (`docker` is
 * demand-derivable and, at zero demand as of 2026-09-07, unregistered) is a
 * real gap — `check-label-floor` is what turns that into a finding, because
 * "the ledger asks for it" and "the registry knows how to prove it" are
 * different facts and only the second is decided here.
 */
export function requiredIdentitySet(records: readonly DemandRecord[]): Set<string> {
	const out = new Set<string>();
	for (const r of records) {
		// EXPLICIT, not safe-by-accident. A resident row has no `fleetForm`, so the
		// next line already dropped it — but that is the accident of a CI-only
		// predicate needing a field resident demand does not carry, and the next
		// reader to be written will not be so lucky
		// (`service-ledger-2026-09-10.md` §3).
		if (!isCiDemandRecord(r)) continue;
		if (!r.fleetForm || !r.selfHosted || r.hosted) continue;
		for (const id of r.capabilities ?? []) out.add(id);
	}
	return out;
}

/**
 * The bootcamp facet on this node, or null when nothing has ever looked.
 *
 * `null` is the "I could not look" answer and every caller must keep it
 * distinct from an empty one: a node bootcamp has never reached has no
 * evidence, which is not the same as evidence that it can do nothing.
 */
export function bootcampFacet(node: ManifestNode): BootcampFacet | null {
	const rec: unknown = node.$capabilities;
	if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
	return rec;
}

/**
 * What this node has PROVEN BY EXECUTION — or `null` when nothing has looked.
 *
 * `earned ∪ prereqs`, and the union is the transition bridge rather than
 * belt-and-braces. Until 2026-09-10 bootcamp promoted only
 * `proven ∩ declared` among probeable LABEL capabilities, and `av1-nvenc` is
 * the fleet's only earnable label — so `earned` is `[]` on all seven claws on
 * the live manifest (measured 2026-09-10) while `prereqs` carries the five
 * capabilities each of them actually proved. Reading `earned` alone would say
 * every claw has proven nothing, which is how a derivation that is "more
 * correct" takes a healthy fleet down. `earned` alone is sufficient once the
 * producer has run; the union stays correct either way because `earned`
 * supersets `prereqs` under the new semantics.
 *
 * `null` when there is no facet at all, AND when the facet carries no `earned`
 * array — a record written by something that is not this bootcamp cannot
 * answer the question, and guessing is what "I could not look must never
 * render as nothing is wrong" forbids.
 */
export function provenCapabilities(node: ManifestNode): Set<string> | null {
	const rec = bootcampFacet(node);
	if (!rec || !Array.isArray(rec.earned)) return null;
	const prereqs = (Array.isArray(rec.prereqs) ? rec.prereqs : [])
		.map((p) => p?.id)
		.filter((id): id is string => typeof id === 'string');
	return new Set([...rec.earned, ...prereqs]);
}

/** Why a node does or does not satisfy `hadoku-builder`'s consumer contract. */
export interface RequiredSetVerdict {
	ok: boolean;
	/** Required ids this node does not prove. Empty when `ok`. */
	missing: string[];
	/** One operator-facing line, or null when the contract holds. */
	reason: string | null;
}

/**
 * `hadoku-builder`'s CONSUMER CONTRACT, as a predicate: "a node carries it iff
 * it proves the required set" (operator, 2026-09-07).
 *
 * `required` is the demand-derived set — `requiredIdentitySet` over the
 * `class: "ci"` rows of the demand ledger — never a declared list. Pure, so the
 * caller does the I/O.
 *
 * NOT YET WIRED INTO THE LADDER, DELIBERATELY. `nodeFailsBootcamp`
 * (`src/fleet-loop.ts:266`) fails OPEN: a node with no recorded finding is
 * born eligible, which is the opposite of "iff it proves". Flipping it is the
 * right end state and is NOT a same-commit change, because the flip is only
 * safe once the required set can be read reliably — an unreadable ledger would
 * otherwise demote the entire fleet at once. This function exists so the gate
 * that REPORTS the gap and the ladder that will eventually enforce it share one
 * implementation instead of two that drift. See
 * `docs/planning/claw-floor-design-2026-09-07.md` §1.1.
 */
export function provesRequiredSet(
	node: ManifestNode,
	required: ReadonlySet<string>
): RequiredSetVerdict {
	const rec = bootcampFacet(node);
	const proven = provenCapabilities(node);
	if (!rec || !proven) {
		return {
			ok: false,
			missing: [...required].sort(),
			reason:
				'no `fleet bootcamp --write` finding on record — nothing has looked, which is ' +
				'not the same as having failed',
		};
	}
	const blocked = (rec.blocked ?? []).map((b) => b?.id).filter(Boolean);
	const unprobed = rec.unprobed ?? [];
	if (blocked.length || unprobed.length) {
		return {
			ok: false,
			missing: [...required].filter((id) => !proven.has(id)).sort(),
			reason:
				`bootcamp ${rec.at ?? '(undated)'} reports blocked ${blocked.join(', ') || '(none)'}, ` +
				`unprobed ${unprobed.join(', ') || '(none)'}`,
		};
	}
	const missing = [...required].filter((id) => !proven.has(id)).sort();
	return {
		ok: missing.length === 0,
		missing,
		reason: missing.length ? `does not prove ${missing.join(', ')}` : null,
	};
}
