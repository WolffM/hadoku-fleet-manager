/**
 * check-label-floor's small standalone predicates (scripts/check-label-floor.mjs,
 * wave 5m lane D split #21 — pure move): who offers a label, whether a
 * declaration or an earned proof is the right side of a derivation
 * disagreement, and the cause behind one node's label transition.
 *
 * Everything ELSE in that script is bare top-level sequential gate logic —
 * the fleet-wide demand computation, the exit branches, `emitJson` — tightly
 * coupled to state computed earlier in the same run (`manifest`, `holdings`,
 * `requiredSet`, `transitions`, …), so wrapping it into functions here would
 * be a restructuring, not a move. This module holds only the functions that
 * were ALREADY standalone. Not named `lib/label-floor.mjs`: `src/label-floor.ts`
 * is the unrelated TS predicate module the CLI also imports, and
 * `scripts/lib/label-floor.test.mjs` already exercises the CLI end to end —
 * either name would collide.
 *
 * `manifest` and `holdings` are passed in explicitly by every caller — both
 * are computed once near the top of the CLI's run and never reassigned, so a
 * reverse import back out of `check-label-floor.mjs` would have worked by
 * load order alone, which is exactly the circular dependency this module
 * exists to avoid. See that file's own header for why.
 */
import { capability } from '../../dist/lib/capability-registry.js';
import { readDrains } from './expected-down.mjs';

/**
 * WHO OFFERS A LABEL, once labels are DERIVED rather than DECLARED.
 *
 * `hadoku-builder` is the CONSUMER contract — "any CI-capable claw" — and since
 * 2026-09-09 its WRITER is bootcamp, not this manifest. Seven machines carried a
 * literal `labels: ["hadoku-builder"]` and every one of them was a human typing
 * a fact the probe had already established; the array is being emptied of it.
 *
 * So a declaration is one source of "offers", and it is no longer the only one.
 * A node OFFERS a label if it declares it, if its bootcamp finding EARNED it,
 * or — for the builder label specifically — if its bootcamp finding qualifies
 * it at all, which is exactly the `eligibleNodes` set printed at the bottom of
 * this gate. `unverifiedNodes` deliberately do NOT offer: bootcamp has never
 * run against them, and "no evidence" is not evidence.
 *
 * This is what keeps `servedByMintOnly` HONEST. It reports a routing label
 * every offerer of which mints, and computed off `labels` alone it would have
 * silently lost `hadoku-builder` the moment the declarations were removed — a
 * report emptied by the very cleanup that was supposed to make it honest,
 * which is the shape this repo keeps paying for.
 */
export function offerersOf(manifest, holdings, label) {
	return Object.keys(manifest.machines ?? {}).filter((name) => holdings[name].includes(label));
}

/**
 * THE TWO PLACES A DECLARATION IS RIGHT, and nothing else.
 *
 * Capabilities are DERIVED (operator, 2026-09-09) and question 3 above compares
 * the derivation against the declaration. A label the manifest is SUPPOSED to
 * declare therefore has to be exempt from that comparison, or the gate reports
 * the correct state as a disagreement — and it did, on `jit-canary`, the moment
 * `nodeOffer` stopped honouring declarations for anything a probe can settle.
 *
 * The exemption is read from the REGISTRY (`mintOnly`), never listed here: a
 * literal list in a gate is the third copy of a policy this repo has paid for
 * three times. `mintOnly` carries the reasoning.
 *
 * NARROW ON PURPOSE, IN TWO DIRECTIONS. It exempts the DECLARED-BUT-NOT-DERIVED
 * side only. The reverse — a mint-only label the derivation projects that the
 * manifest does NOT declare — is never exempt: the only way one reaches the
 * offer is through `earned`, and a probe cannot earn what minting proves. That
 * case has its own finding below (`mintOnlyEarned`), because a bootcamp record
 * claiming it is the record lying, not the declaration.
 *
 * `check-capability-schema` still refuses `jit-canary` on a node without
 * `ephemeral: true`, which is the failure a mint-only label actually has, and
 * the floor and unoffered checks above still see it.
 */
export function declarationIsRight(label) {
	return capability(label)?.mintOnly === true;
}

/**
 * A label the derivation adds because the node EARNED it — the design, not a
 * disagreement.
 *
 * `cargo-bevy` is the case that exists, and the registry entry says why in its
 * own words: it is "routed by `nodeOffer`, so `machines[].labels` stays
 * untouched and the manifest cannot claim a speed the box has not
 * demonstrated". Four claws earned it on 2026-09-14 and this gate reported four
 * disagreements, because the only exemption on the `added` side was
 * ELIGIBILITY. The end state for every probe-settled label is exactly this:
 * present in `earned`, absent from `labels`.
 *
 * KEYED ON THIS NODE'S OWN `earned`, not on the capability alone. A probe-
 * verified label that appears in the offer WITHOUT the node having earned it
 * came from somewhere else and still fails — the exemption is "the probe put it
 * there", not "labels of this kind are never compared".
 *
 * The `lost` direction is deliberately NOT exempt: a manifest that DECLARES a
 * probe-verified label the record does not earn is the dangerous direction
 * (av1-nvenc on a node whose GPU cannot encode it) and must stay red.
 */
export function derivedByEarning(label, earned) {
	if (!earned.has(label)) return false;
	const cap = capability(label);
	return cap?.surface === 'label' && cap.verify === 'probe';
}

/** The bootcamp finding (or the declaration) that explains a node's label. */
export function causeFor(manifest, node, label) {
	const m = manifest.machines?.[node];
	if (!m) return { kind: 'node-removed', why: `${node} is no longer in the manifest` };
	// `earned` FIRST, because it is the answer `nodeOffer` uses for anything a
	// probe can settle. A label that is both declared and earned got onto the
	// registration because the probe passed, and reporting the declaration as the
	// cause would send an operator to the manifest to explain a transition the
	// manifest did not cause.
	if ((m.$capabilities?.earned ?? []).includes(label)) {
		return { kind: 'earned', why: `earned in bootcamp — the probe for \`${label}\` passed` };
	}
	if ((m.labels ?? []).includes(label)) {
		return { kind: 'declared', why: `declared in the manifest's \`labels\` array` };
	}
	const rec = m.$capabilities;
	if (!rec) {
		return {
			kind: 'no-finding',
			why: 'no bootcamp finding on record — run `fleet bootcamp --write`',
		};
	}
	const blocked = (rec.blocked ?? []).map((b) => b.id ?? b);
	const unprobed = rec.unprobed ?? [];
	const prereqs = (rec.prereqs ?? []).map((p) => p.id ?? p);
	return {
		kind: 'bootcamp',
		at: rec.at ?? null,
		by: rec.by ?? null,
		blocked,
		unprobed,
		prereqs,
		why:
			blocked.length || unprobed.length
				? `bootcamp ${rec.at ?? '(undated)'} — blocked ${blocked.join(', ') || '(none)'}, ` +
					`unprobed ${unprobed.join(', ') || '(none)'}`
				: `bootcamp ${rec.at ?? '(undated)'} — proves ${prereqs.join(', ') || '(nothing required)'}`,
	};
}

/**
 * Nodes held out of service, read exactly like `fleet drain` — this is a
 * standalone script with no in-process host to inject the path, so it resolves
 * the same two locations `drain-node.mjs` does. A parse failure THROWS: an
 * unreadable drain file must not read as "nothing is drained" and wave a
 * holder through that somebody has a screwdriver in.
 */
export function drainedNodeNames() {
	return new Set(Object.keys(readDrains()));
}
