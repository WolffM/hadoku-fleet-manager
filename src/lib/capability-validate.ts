import { isGuestNode } from './node-role.js';

import {
	CAPABILITIES,
	capability,
	type Capability,
	type FleetManifestShape,
} from './capability-registry.js';
import { probeableIds } from './capability-labels.js';
import { provenCapabilities } from './bootcamp-proof.js';
import { nodeOffer, registrationLabels } from './capability-offer.js';
import type { WorkloadGateContext } from './workload-gate.js';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface CapabilityFinding {
	/** Stable id so a gate can be reasoned about without matching prose. */
	rule: string;
	/**
	 * The node this finding is about. The KEY stays `node`: findings are
	 * printed by `fleet capability-schema --json`, and stdout shape is a
	 * contract. See docs/VOCABULARY.md §"Where the rename stops".
	 */
	machine: string | null;
	capability: string | null;
	message: string;
}

/**
 * Validate a manifest against the registry.
 *
 * PURE. No network, no ssh, no filesystem — which is the point: `fleet
 * capabilities` proves a node can DO what it claims and needs to reach every
 * box to say so, and a node it cannot reach is a node whose promises went
 * unchecked. This answers the cheaper question, offline and completely: is what
 * the manifest CLAIMS even coherent. The two are different layers and neither
 * substitutes for the other.
 *
 * @param manifest the parsed fleet-runner-manifest.json
 * @param probeEmits the capability ids `capability-probe.sh` actually prints,
 *        parsed from the script itself. Omit to skip the drift rule — a caller
 *        that cannot read the probe must not silently report it as consistent.
 * @param opts.workloadGate the `$proof` state, built by `workloadGateContext`
 *        exactly as the reconciler builds it. The only input that is not the
 *        manifest itself — the caller reads the state dir. Omitted, a standing
 *        node's workload-gated label cannot be judged and is reported.
 */
export function validateCapabilities(
	manifest: FleetManifestShape,
	probeEmits?: Set<string>,
	opts: { workloadGate?: WorkloadGateContext } = {}
): CapabilityFinding[] {
	const findings: CapabilityFinding[] = [];
	const nodes = Object.entries(manifest.machines ?? {});
	const add = (rule: string, node: string | null, cap: string | null, message: string): void => {
		findings.push({ rule, machine: node, capability: cap, message });
	};

	// --- what nodes declare -------------------------------------------
	for (const [name, m] of nodes) {
		for (const id of m.labels ?? []) {
			const cap = capability(id);
			if (!cap) {
				add(
					'unknown-capability',
					name,
					id,
					`declares label "${id}", which is in no capability registry entry. A label is a ` +
						`PROMISE that GitHub routes on: an unregistered one has no meaning, no floor ` +
						`alert and nothing that can verify it. Add it to CAPABILITIES in src/capabilities.ts.`
				);
				continue;
			}
			if (cap.surface !== 'label') {
				add(
					'surface-mismatch',
					name,
					id,
					`declares "${id}" as a node label, but it is a ${cap.surface} capability — ` +
						`${cap.description}`
				);
			}
		}
	}

	// --- what nodes OFFER must be supportable --------------------------------
	// READ FROM `nodeOffer`, NOT FROM `labels` (#98). This loop used to walk the
	// declared array only, and under the 2026-09-09 decision nothing declares
	// `hadoku-builder` any more — so its THROTTLE_FIELDS were checked on no node
	// at all, and a claw with no `maxConcurrent` would have rendered
	// MAX_CONCURRENT=99 with this rule green. A capability's requirements bind
	// whoever OFFERS it: declared, earned, or eligible for general CI.
	//
	// ELIGIBLE means every non-guest. That is not `nodeFailsBootcamp`'s answer
	// for this tick and does not try to be: the fast loop can grant the builder
	// label to any claw at any tick, so any claw must be ready to carry it. A
	// guest gets it only through the backstop, and its declared and earned labels
	// are still checked here.
	for (const [name, m] of nodes) {
		const offered = new Set([
			...(m.labels ?? []).filter((id) => capability(id)?.surface === 'label'),
			...nodeOffer(m, { eligible: !isGuestNode(m) }),
		]);
		for (const id of offered) {
			const cap = capability(id);
			if (!cap || cap.surface !== 'label') continue;
			for (const f of cap.requires?.fields ?? []) {
				if (m[f.field] === undefined) {
					add(
						'missing-required-field',
						name,
						id,
						`offers "${id}" (declared, earned or eligible) but declares no \`${f.field}\`. ${f.why}`
					);
				}
			}
			for (const fact of cap.requires?.facts ?? []) {
				if (!fact.holds(m)) {
					add(
						'unsupported-claim',
						name,
						id,
						`claims "${id}" but does not satisfy \`${fact.id}\`. ${fact.why}`
					);
				}
			}
		}
	}

	// --- what the fleet requires of everybody ------------------------------
	// AN ABSENT OR EMPTY REQUIREMENT IS A FINDING (#98). `?? []` made a missing
	// `toolchain.capabilities` iterate nothing and report nothing — every node
	// then clears a bar of zero, and bootcamp, converge-toolchain and
	// check-capabilities all read this list. Same for `toolCache`: the versions
	// seeded under /opt/hostedtoolcache are what `actions/setup-python` finds,
	// and an empty map means no node is checked for any of them.
	const required = manifest.toolchain?.capabilities;
	if (!Array.isArray(required) || required.length === 0) {
		add(
			'toolchain-unset',
			null,
			null,
			`toolchain.capabilities is ${Array.isArray(required) ? 'empty' : 'missing'}. It is what ` +
				`every managed node must prove; without it every node clears a bar of zero and ` +
				`nothing says so.`
		);
	}
	const toolCache = manifest.toolchain?.toolCache;
	const seeded = Object.entries(toolCache ?? {}).filter(
		([k, v]) => !k.startsWith('$') && Array.isArray(v) && v.length > 0
	);
	if (!seeded.length) {
		add(
			'toolchain-unset',
			null,
			null,
			`toolchain.toolCache is ${toolCache ? 'empty (no language with any version)' : 'missing'}. ` +
				`It names the versions seeded under /opt/hostedtoolcache that actions/setup-python ` +
				`reads; without it no node is checked for any of them.`
		);
	}
	for (const id of required ?? []) {
		const cap = capability(id);
		if (!cap) {
			add(
				'unknown-capability',
				null,
				id,
				`toolchain.capabilities requires "${id}", which is in no capability registry entry. ` +
					`Nothing can probe it, so it is required of every node and checked on none.`
			);
		} else if (cap.surface !== 'toolchain') {
			add(
				'surface-mismatch',
				null,
				id,
				`toolchain.capabilities requires "${id}", but it is a ${cap.surface} capability. ` +
					`A toolchain requirement applies to EVERY managed node, so it can never be ` +
					`something one node offers and another does not.`
			);
		}
	}

	// --- the floor: a STANDING offer must be EARNED like a mint ------------
	// The label floor (`src/label-floor.ts`) counts a label SERVED when a
	// standing online runner carries it, or when a minting node offers it
	// through `nodeOffer` — tool probe, plus the workload proof for a gated
	// label. The minting arm therefore only ever counts capacity that proved
	// itself. The standing arm counts whatever GitHub's listing shows, so a
	// standing registration carrying an earnable label its node has NOT earned
	// is capacity the floor reads as serving, and nothing has shown it can do
	// the work. That is the bypass, and it is the only one left.
	//
	// WHAT IT IS NOT, any more: "a standing node offers a `floor: false` label".
	// That rule existed because the old floor was standing-only and a label
	// claws minted had to be kept out of it; with one rule for every label there
	// is no exemption for a standing offerer to break, and hokon earning `jdk21`
	// and `cargo-bevy` the way a claw does is exactly what it should do.
	//
	// HOW A STANDING NODE COMES TO OFFER WHAT IT DID NOT EARN. A guest's labels
	// read as `role` ({@link verificationFor}), so its DECLARATIONS stand — the
	// documented exception for a guest nothing has looked at. The gap is a guest
	// bootcamp HAS looked at: a declared `av1-nvenc` or `pm2-host` its record does
	// not earn is a declaration the evidence contradicts, still projected onto
	// every standing registration. And a workload-gated label, when nobody
	// supplied the gate to judge it by.
	//
	// The standing offer is `registrationLabels` — what the reconciler projects —
	// with the same workload gate the reconciler builds. Without `workloadGate`
	// a gated label cannot be judged, and "I could not look" is a finding.
	//
	// `floor-unoffered` (a watched label no node offers) is GONE from this
	// static check: "watched" is now DEMAND, which only `fleet label-floor` can
	// read (it scans every covered repo's workflows and job history), and that
	// gate fails on exactly this case as `unoffered`.
	for (const [name, m] of nodes) {
		if (m.ephemeral === true) continue;
		const proven = provenCapabilities(m);
		const gate = opts.workloadGate
			? {
					workloadProofs: opts.workloadGate.byNode[name] ?? {},
					provenCounts: opts.workloadGate.provenCounts,
				}
			: {};
		for (const id of registrationLabels(m, gate)) {
			const cap = capability(id);
			if (!cap || cap.surface !== 'label' || cap.kind !== 'identity' || cap.verify !== 'probe') {
				continue;
			}
			let unearned: string | null = null;
			if (!proven) {
				// A GUEST nothing has looked at keeps its declarations — the documented
				// exception (`Capability.mintOnly`), not a gap: the fleet does not probe
				// a guest by policy. Anyone else standing with no record has simply not
				// been bootcamped.
				if (!isGuestNode(m)) {
					unearned = 'it has no bootcamp record, so nothing has executed the probe on it';
				}
			} else if (!proven.has(id)) {
				unearned =
					'its bootcamp record does not earn it — the offer stands on a declaration the ' +
					'evidence contradicts';
			} else if (cap.jobProof?.budget && !opts.workloadGate) {
				unearned =
					'it is workload-gated and no workload-proof context was supplied, so whether a ' +
					'minting node in its place would be offered it was not judged';
			}
			if (!unearned) continue;
			add(
				'floor-bypassed',
				name,
				id,
				`offers "${id}" on STANDING registrations, and the label floor counts every one of ` +
					`them online as SERVING "${id}" — but ${unearned}. A minting node offers it only ` +
					`once it has earned it (probe, plus the workload proof where one is declared), so ` +
					`the floor would read green on capacity nothing has proven. Run ` +
					`\`fleet bootcamp --write\` against ${name}, or stop declaring it.`
			);
		}
	}

	// --- registry vs probe ---------------------------------------------------
	// The registry says which capabilities are proven by EXECUTING them. The
	// probe script is what executes them. Neither reads the other at runtime, so
	// nothing but this rule stops them drifting — and the drift is silent in both
	// directions: a registry `verify: 'probe'` the script does not emit reports
	// `no result` on every node forever, and a `CAP` line the registry does not
	// know is a probe nobody reads.
	if (probeEmits) {
		for (const id of probeableIds()) {
			if (!probeEmits.has(id)) {
				add(
					'probe-drift',
					null,
					id,
					`the registry says "${id}" is proven by EXECUTING it, but capability-probe.sh ` +
						`emits no \`CAP ${id}\` line. Every node claiming it would report ` +
						`"no result" — a promise that can never be verified reads as drift on a ` +
						`healthy fleet.`
				);
			}
		}
		for (const id of probeEmits) {
			const cap = capability(id);
			if (!cap) {
				add(
					'probe-drift',
					null,
					id,
					`capability-probe.sh emits \`CAP ${id}\` and no registry entry claims it. ` +
						`The probe result is computed on every node and read by nothing.`
				);
			} else if (cap.verify !== 'probe') {
				add(
					'probe-drift',
					null,
					id,
					`capability-probe.sh executes "${id}", but the registry says it is verified by ` +
						`\`${cap.verify}\` — so check-capabilities skips the probe result it just paid ` +
						`an ssh round-trip for.`
				);
			}
		}
	}

	// --- workload-proof budgets (wave 4e, #102) -----------------------------
	// Registry-internal: a nonsensical bar is a nonsensical bar whether or not
	// any node has ever claimed the capability, so this does not wait for a
	// manifest declaration to find it — unlike every rule above, it checks
	// `CAPABILITIES` itself, not `manifest`.
	for (const cap of CAPABILITIES) findings.push(...jobProofBudgetFindings(cap));

	return findings;
}

/**
 * The `invalid-job-proof-budget` arm, pulled out of {@link validateCapabilities}
 * so it is callable with a FIXTURE `Capability` directly — `CAPABILITIES` is
 * the live registry, not a test manifest, and there is no other seam for
 * proving each check actually fires.
 */
export function jobProofBudgetFindings(cap: Capability): CapabilityFinding[] {
	const budget = cap.jobProof?.budget;
	if (!budget) return [];
	const out: CapabilityFinding[] = [];
	const add = (message: string): void =>
		void out.push({ rule: 'invalid-job-proof-budget', machine: null, capability: cap.id, message });
	if (!(budget.factor > 1)) {
		add(
			`"${cap.id}"'s workload-proof budget.factor is ${budget.factor}, which admits no slack ` +
				`over the median at all (or shrinks it) — every proven node would be at permanent risk ` +
				`of falling outside its own measurement.`
		);
	}
	if (!(Number.isInteger(budget.minProven) && budget.minProven >= 1)) {
		add(
			`"${cap.id}"'s workload-proof budget.minProven is ${budget.minProven} — it must be a ` +
				`positive integer, or the budget can never bootstrap.`
		);
	}
	try {
		new RegExp(cap.jobProof!.evidence, 'i');
	} catch (err) {
		add(`"${cap.id}"'s jobProof.evidence is not a valid regex: ${(err as Error).message}`);
	}
	return out;
}

/**
 * The capability ids `capability-probe.sh` emits, parsed from the script text.
 *
 * Reads the `say <id> …` calls rather than a hand-kept list beside them: a
 * verifier that reads its own writer's artifact cannot fail. Returns null when
 * the text contains no `say` calls at all, because an empty set would make the
 * drift rule report every probeable capability as missing — a parser failure
 * must not render as a fleet finding.
 */
export function parseProbeCapabilities(scriptText: string): Set<string> | null {
	const out = new Set<string>();
	for (const m of scriptText.matchAll(/^\s*say\s+([A-Za-z0-9_-]+)\s/gm)) out.add(m[1]);
	return out.size ? out : null;
}
