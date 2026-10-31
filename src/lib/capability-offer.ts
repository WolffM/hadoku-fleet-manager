import {
	CAPABILITIES,
	capability,
	verificationFor,
	type ManifestNode,
} from './capability-registry.js';
import { eligibilityLabels, ephemeralOnlyLabels } from './capability-labels.js';
import { provenCapabilities } from './bootcamp-proof.js';
import { workloadGateStatus, type ProofRecord } from './workload-gate.js';

/**
 * THE ONE ANSWER TO "WHAT LABELS DOES THIS NODE OFFER" — issue #19.
 *
 * Four readers asked it separately off `machines[].labels` and the array was
 * both the JIT mint's label WRITER and a filtered identity source, with no type
 * and no gate separating the two: `ephemeral-tick.ts` (mints and warm
 * listeners), `placement.ts` (refuses a node whose labels do not satisfy the
 * job), `floor-probe.mjs` (mints probes). Stripping the eight `hadoku-builder`
 * declarations — which the 2026-09-07 operator decision requires, since
 * capabilities are DERIVED and never declared — therefore minted
 * `self-hosted,Linux,X64` while every covered repo asks for
 * `["self-hosted","hadoku-builder"]`, and `check-label-floor` stayed GREEN
 * through it. Proved by execution, twice, in the Wave 2 closeout.
 *
 * THE THREE KINDS OF EVIDENCE, AND WHY THEY ARE NOT INTERCHANGEABLE:
 *
 *   verify: 'probe'  the bootcamp record ANSWERS it. A declaration is a claim,
 *                    and `av1-nvenc` is the registry's own example of a claim
 *                    that lies (Debian's ffmpeg reports the encoder whether or
 *                    not the GPU can use it). So a declared probe-verified
 *                    label is REPLACED by `provenCapabilities` — not unioned
 *                    with it, or this function could never disagree with the
 *                    manifest and `check-label-floor`'s disagreement check
 *                    would be the verifier-reads-its-own-writer trap.
 *   verify: 'role'   nothing to execute, or nothing this fleet may execute.
 *          / 'mint'  `hadoku-builder` is a routing lever, `jit-canary` is proven
 *                    only by a mint, and EVERY label on a GUEST reads as `role`
 *                    ({@link verificationFor}) because the fleet does not touch a
 *                    guest at all. The declaration is the only evidence there is
 *                    and it is passed through.
 *   ELIGIBILITY      never derived here at all — see `opts.eligible`.
 *
 * A FOURTH, ADDED WAVE 4E (#102): a capability whose `jobProof` declares a
 * `budget` is a WORKLOAD proof, not just a tool proof, and `provenCapabilities`
 * saying the tool is earned is no longer sufficient to offer it — see
 * {@link workloadGateStatus}. `opts.workloadProofs`/`opts.provenCounts` are
 * how the caller supplies that evidence; OMITTING `workloadProofs` (every
 * call site today) is the WAVE 4E ROLLOUT CONSTRAINT made structural rather
 * than a flag: no `$proof` exists yet for any node, so a caller that always
 * supplied an empty gate would offer `jdk21` to NOBODY and queue every
 * cardtable Forge job the moment this landed. Until a caller is wired to
 * read the state dir and pass real records, this id is offered exactly as it
 * was before this wave — tool-earned, nothing more.
 *
 * AND WHEN NOTHING HAS LOOKED, the declaration stands. A node with no bootcamp
 * facet keeps exactly the labels it declares, so this function is a no-op
 * against a node the producer has never reached. That is the only direction
 * that is safe: the alternative silently strips `av1-nvenc` off hokon — one
 * node deep, and the reason 22 dataplatform tests skip when it is dark — on an
 * unreadable state file. `check-label-floor` is what turns the missing record
 * into a FINDING, so the quiet fallback is never also a silent one.
 *
 * An UNREGISTERED label passes through unchanged, for the reason
 * `identityLabels` already gives: the schema gate rejects a manifest typo, and
 * a derivation that also filtered would unroute live jobs on one.
 *
 * @param opts.eligible has the CALLER decided this node may take general CI?
 *        This function does not re-decide it: a second authority here could
 *        disagree with the real one — precisely when the demand ledger is
 *        unreadable, i.e. at 3am. For a mint, the dispatcher's decision to mint
 *        IS the eligibility decision. For a standing registration the fast
 *        loop's safety rule decides (`nodeIsSafe`), or the backstop on a guest,
 *        and never at registration time — see `registrationLabels`. See `provesRequiredSet` for the
 *        consumer-contract predicate, which is this function's input, not its
 *        business.
 * @param opts.workloadProofs This node's OWN `$proof` record per workload-gated
 *        capability id — `undefined`/`null` for an id the caller looked up and
 *        found nothing. An id with NO entry in this map (including the whole
 *        map being omitted) is left ungated: see the fourth-evidence note
 *        above for why that is the safe default everywhere this has not been
 *        wired to the state dir yet.
 * @param opts.provenCounts Fleet-wide fresh-passing-node count per workload-
 *        gated capability id, deciding whether that id's gate is ACTIVE yet
 *        (`>= budget.minProven`). Missing or absent reads as 0 (dormant).
 */
export function nodeOffer(
	node: ManifestNode,
	opts: {
		eligible: boolean;
		workloadProofs?: Record<string, ProofRecord | null | undefined>;
		provenCounts?: Record<string, number>;
		/**
		 * Labels a probe EXECUTED on this node and judged failed
		 * (src/capability-revocations.ts). Withheld until a passing probe clears
		 * them. `'all'`: the revocation record is unreadable, so every
		 * probe-verified routing label is withheld — never re-granted on a bad read.
		 */
		revoked?: ReadonlySet<string> | 'all';
	}
): string[] {
	const eligibility = new Set(eligibilityLabels());
	const proven = provenCapabilities(node);
	const out: string[] = [];
	for (const id of node.labels ?? []) {
		if (eligibility.has(id)) continue;
		const cap = capability(id);
		// The declaration is a CLAIM about something executable, and the record
		// is the answer. Skipped only when there IS a record to answer with —
		// and `verificationFor`, not `cap.verify`, because on a GUEST there is
		// nothing the fleet is allowed to execute and the declaration stands.
		if (cap && cap.surface === 'label' && verificationFor(node, cap) === 'probe' && proven) {
			continue;
		}
		out.push(id);
	}
	if (proven) {
		for (const id of proven) {
			const cap = capability(id);
			if (!cap || cap.surface !== 'label' || cap.kind !== 'identity') continue;
			// THE FOURTH KIND OF EVIDENCE (wave 4e): a workload-gated id additionally
			// needs `workloadGateStatus` to say yes. Gated ONLY when the caller opted
			// in by naming this id in `workloadProofs` — see this function's own doc.
			if (opts.workloadProofs && Object.hasOwn(opts.workloadProofs, id)) {
				const gate = workloadGateStatus(cap, opts.workloadProofs[id], opts.provenCounts?.[id] ?? 0);
				if (!gate.offer) continue;
			}
			out.push(id);
		}
	}
	// MINT-VERIFIED LABELS ARE DERIVED, NEVER DECLARED. `jit-canary` is true of
	// every node that mints a runner per job, and it was hand-declared on claw-3
	// alone — so the hourly canary only ever proved claw-3's JIT path, read the
	// weakest claw being down as the dispatcher being down, and the panel showed
	// "JIT runner per job" on one claw of eight that all do it.
	//
	// Only on a node bootcamp has reached, like every earned label: a node with
	// no record offers nothing routable ("no evidence is not evidence").
	if (proven) {
		for (const cap of CAPABILITIES) {
			if (cap.surface !== 'label' || cap.verify !== 'mint') continue;
			if ((cap.requires?.facts ?? []).every((f) => f.holds(node))) out.push(cap.id);
		}
	}
	const revoked = opts.revoked;
	const kept = revoked
		? out.filter((id) => {
				if (revoked !== 'all') return !revoked.has(id);
				const cap = capability(id);
				return !(cap && cap.surface === 'label' && verificationFor(node, cap) === 'probe');
			})
		: out;
	// Eligibility is the fast loop's and the backstop's to grant, never a probe's
	// to revoke: general CI keeps flowing whatever the revocation record says.
	if (opts.eligible) kept.push(...eligibilityLabels());
	return [...new Set(kept)];
}

/**
 * The `--labels` argument for a fresh registration on this node.
 *
 * NEVER BORN ELIGIBLE. A registration carries the node's capabilities and
 * nothing that grants general CI: eligibility is granted by the fast loop once
 * the node is judged safe (or by the backstop, on a guest), within one tick. A
 * node born eligible starts schedulable before anything has judged it — which
 * is how 24 hokon runners once came up eligible on the PRODUCTION host. (Until
 * 2026-09-21 this took a `demotable` flag from the tier ladder, and a node in
 * an `alwaysOn` tier WAS born eligible.)
 *
 * DELEGATES to `nodeOffer` rather than carrying its own derivation: "one
 * question, one answer" is this repo's first critical rule, and a standing
 * registration and a JIT mint are the same question asked on different paths.
 */
export function registrationLabels(
	node: ManifestNode,
	gate: {
		workloadProofs?: Record<string, ProofRecord | null | undefined>;
		provenCounts?: Record<string, number>;
		revoked?: ReadonlySet<string> | 'all';
	} = {}
): string[] {
	// NEVER a mint-only label on a standing registration. `nodeOffer` derives
	// `jit-canary` for every ephemeral node since 0.29.5 — right for a mint, and
	// fatal here: a standing runner carrying it answers the canary with nothing
	// minted, which is the outage the canary exists to catch.
	const mintOnly = new Set(ephemeralOnlyLabels());
	return nodeOffer(node, { eligible: false, ...gate }).filter((l) => !mintOnly.has(l));
}
