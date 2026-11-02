/**
 * label-floor-holdings — which nodes are eligible to carry `hadoku-builder`,
 * and every label every node currently OFFERS.
 *
 * Moved out of `check-label-floor.mjs` (wave shrink-1 lane D), body
 * unchanged — this is the half of that gate's setup that turns the raw
 * manifest into the `holdings` map `label-floor-gate.mjs`'s guards and
 * `label-floor-check.mjs`'s `offerersOf` both read.
 */

import { nodeOffer } from '../../dist/lib/capability-offer.js';

/**
 * Which nodes hold `hadoku-builder` and WHY (which capabilities proved) —
 * mirrors `nodeFailsBootcamp` in src/fleet-loop.ts exactly: a node with NO
 * recorded finding fails OPEN (unverified, not disqualified — bootcamp has
 * never run against it, which is not the same as having failed), and one
 * with a finding is disqualified only if it names something `blocked` or
 * `unprobed`.
 *
 * @param {object} manifest
 */
export function eligibilityOf(manifest) {
	const eligibleNodes = [];
	const unverifiedNodes = [];
	const disqualifiedNodes = [];
	for (const [name, m] of Object.entries(manifest.machines ?? {})) {
		const rec = m.$capabilities;
		if (!rec) {
			unverifiedNodes.push(name);
			continue;
		}
		const blocked = rec.blocked ?? [];
		const unprobed = rec.unprobed ?? [];
		if (blocked.length || unprobed.length) {
			disqualifiedNodes.push({ name, blocked: blocked.map((b) => b.id), unprobed });
		} else {
			eligibleNodes.push({ name, prereqs: (rec.prereqs ?? []).map((p) => p.id) });
		}
	}
	return { eligibleNodes, unverifiedNodes, disqualifiedNodes };
}

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
 *
 * Every label every machine offers, node -> sorted labels. The input to the
 * transition log and to `offerersOf`, which is this answer transposed.
 *
 * `nodeOffer` IS THE ANSWER, not a second derivation beside it (issue #19).
 * This used to be `labels ∪ earned ∪ {builder if eligible}`, which was three
 * sources unioned by hand — and under the 2026-09-10 `earned` semantics
 * (everything the probe executed) that union would have reported `ffmpeg`,
 * `gh`, `python-venv`, `python-toolcache`, `playwright` and `jitconfig` as
 * LABELS every node newly gained, burying the one transition an operator is
 * looking for under ten per node that are not labels at all. `nodeOffer` keeps
 * only label-surface identity capabilities, and it is the same function the
 * mint, the warm listener and the reconciler project.
 *
 * @param {object} manifest
 * @param {{name:string}[]} eligibleNodes
 */
export function holdingsOf(manifest, eligibleNodes) {
	const eligibleNames = new Set(eligibleNodes.map((n) => n.name));
	return Object.fromEntries(
		Object.entries(manifest.machines ?? {}).map(([name, m]) => [
			name,
			nodeOffer(m, { eligible: eligibleNames.has(name) }).sort(),
		])
	);
}
