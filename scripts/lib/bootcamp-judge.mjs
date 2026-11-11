/**
 * `fleet bootcamp`'s PASS 3 — judge every node's probe answer and seed what
 * was earned. Split out of scripts/bootcamp.mjs (wave 5p lane D) so the CLI
 * stays under the 800-line ceiling. Takes the CLI's flags and run-scoped
 * state through `ctx`; never imports the CLI.
 */
import {
	capability,
	judgeMeasurement,
	measuredIdleOnly,
} from '../../dist/lib/capability-registry.js';
import { probeableIds } from '../../dist/lib/capability-labels.js';
import { nodeOffer } from '../../dist/lib/capability-offer.js';
import { measuredValue } from './idle-measure.mjs';
import { describeProof, proofKey } from './job-proof-record.mjs';
import { seedNode } from './capability-seeds.mjs';

/** Last job-proof per job-proofed capability this node carries. Read-only. */
function jobProofsFor(name, m, ctx) {
	if (!ctx.proofLedger.ok) return [];
	const rows = [];
	for (const id of nodeOffer(m, { eligible: false })) {
		const cap = capability(id);
		if (!cap?.jobProof) continue;
		const entry = ctx.proofLedger.proofs[proofKey(name, { capability: id })];
		rows.push({
			id,
			...describeProof(entry, id, name, Date.now()),
			last: entry?.last ?? null,
			lastPass: entry?.lastPass ?? null,
		});
	}
	return rows;
}

/**
 * PASS 3 — judge, and seed what was earned.
 */
export async function runPass3(ctx) {
	const {
		nodes,
		probed,
		idleHolds,
		report,
		revocationVerdicts,
		seedResultsByNode,
		CHECK_ONLY,
		seedDeps,
		manifest,
		REQUIRED,
		UNPROBED,
		NEVER_WRITTEN,
	} = ctx;
	await Promise.all(
		nodes.map(async ([name, m]) => {
			const got = probed[name];
			if (!got) return;
			const { caps, load } = got;
			const declared = new Set(m.labels ?? []);
			// The record ON DISK before this run — observed state, not this process's
			// belief — is what an unjudged measurement keeps.
			const prevEarned = new Set(m.$capabilities?.earned ?? []);
			// ONE judging rule, in the registry, for every capability — see
			// `meetsBar`, and `judgeMeasurement` above it. A binary capability passes
			// on `ok` exactly as before; a MEASURED one (`measure` declared) passes
			// only if the number the probe printed clears the declared bar — and an
			// IDLE-ONLY one is judged at all only if the probe counted zero live jobs
			// while it measured. Bootcamp deliberately does no comparing of its own:
			// the bar has one home, and the next payload capability is a registry
			// entry rather than a branch here.
			const barReason = {};
			const proven = new Set();
			// INCONCLUSIVE: an idle-only capability this run did not judge. It is
			// neither earned nor stripped — whatever the record on disk said stands —
			// and it is SAID. "I could not measure it quietly" is not "it is slow".
			const inconclusive = [];
			/** idle-only ids judged on a quiet node this run, for the record. */
			const judgedIdle = {};
			const heldOut = idleHolds[name]?.status === 'inconclusive' ? idleHolds[name].reason : null;
			for (const [id, v] of Object.entries(caps)) {
				const verdict = judgeMeasurement(capability(id), v.ok, v.detail ?? '', load[id]);
				barReason[id] = verdict.reason;
				if (!verdict.judged) {
					inconclusive.push({
						id,
						reason: heldOut ? `${verdict.reason}; idle re-measure: ${heldOut}` : verdict.reason,
						kept: prevEarned.has(id) ? 'earned' : 'not earned',
					});
					if (prevEarned.has(id)) proven.add(id);
					continue;
				}
				if (measuredIdleOnly(capability(id))) {
					judgedIdle[id] = { value: measuredValue(v.detail), earned: verdict.proven };
				}
				if (verdict.proven) proven.add(id);
			}
			// NOT DUE TONIGHT (lib/bootcamp-schedule.mjs): an idle-only benchmark this
			// node runs on another weekday. Its previous verdict stands, exactly as an
			// inconclusive one's does, but it is a schedule, not a finding.
			const deferred = [];
			for (const d of ctx.benchPlans?.[name]?.deferred ?? []) {
				if (caps[d.id]) continue;
				deferred.push({ ...d, kept: prevEarned.has(d.id) ? 'earned' : 'not earned' });
				if (prevEarned.has(d.id)) proven.add(d.id);
			}
			// A capability this controller could not enable was never probed: the
			// record on disk stands, and it is said.
			for (const [id, reason] of Object.entries(UNPROBED)) {
				if (caps[id]) continue;
				inconclusive.push({ id, reason, kept: prevEarned.has(id) ? 'earned' : 'not earned' });
				if (prevEarned.has(id)) proven.add(id);
			}

			// EARNED IS EVERYTHING THE PROBE EXECUTED SUCCESSFULLY (settled
			// 2026-09-10), not `proven ∩ declared` among label capabilities.
			//
			// WHY IT CHANGED. The claw floor's eligibility input is
			// `$capabilities.earned` (`claw-floor-design-2026-09-07.md` §1.1), and
			// under the old rule `av1-nvenc` was the fleet's ONLY earnable label — so
			// `earned` was `[]` on all seven claws while each of them had proved five
			// capabilities, and the field the floor reads said the fleet could do
			// nothing. `earned` is now the node's PROOF SET: one producer, one
			// question, "what has this box demonstrated".
			//
			// REGISTERED IDS ONLY. A `CAP` line with no registry entry is drift
			// `capability-schema`'s probe-drift rule owns; recording it here as earned
			// would make a typo in the probe script read as a capability.
			const earned = [...proven].filter((id) => capability(id)).sort();
			const unjudged = new Set([...inconclusive, ...deferred].map((i) => i.id));

			const unearned = [];
			const unclaimed = [];
			const blocked = [];

			// UNCLAIMED/UNEARNED STAY LABEL-SCOPED. They are statements about ROUTING —
			// "capacity the fleet cannot route to", "work routes here and fails" — and
			// a toolchain capability is routable by nothing, so widening them with
			// `earned` would turn every proven tool into a routing finding. Only LABEL
			// capabilities a probe can answer are in scope: a `role` label — today
			// `taskauto`, and `hadoku-builder`, which NEVER_WRITTEN excludes for a
			// second reason — is a decision about what the box is FOR, and no probe
			// can settle it. `pm2-host` LEFT that set on 2026-09-15 (#6): it is
			// probed and therefore earnable here, so a claw that proves it appears as
			// `unclaimed` rather than being invisible.
			for (const id of probeableIds()) {
				const cap = capability(id);
				if (!cap || cap.surface !== 'label' || NEVER_WRITTEN.has(id)) continue;
				const isProven = proven.has(id);
				const isDeclared = declared.has(id);
				// An UNJUDGED measurement says nothing either way, so it cannot make a
				// declared label UNEARNED; the INCONCLUSIVE line carries it instead.
				if (!isProven && isDeclared && !unjudged.has(id)) {
					unearned.push({ id, detail: barReason[id] ?? caps[id]?.detail ?? 'not probed' });
				} else if (isProven && !isDeclared) unclaimed.push(id);
			}
			// PREREQUISITES PROVEN, not just the ones that failed. A PASSES line that
			// lists nothing is a pass with no evidence behind it — the state
			// CLAUDE.md's "exit 0 with no evidence is a failure" rule is about — and
			// on a homogeneous fleet that is most lines: `av1-nvenc` is the only
			// earnable LABEL capability any node holds, so without this the report
			// says almost nothing about the five nodes that are fine.
			const prereqs = [];
			const unprobed = [];
			for (const id of REQUIRED) {
				if (!caps[id]) {
					// Declared required, and the probe never answered. Not a pass and not
					// a failure — the probe and the manifest disagree about what exists,
					// which `capability-schema`'s probe-drift rule exists to catch.
					unprobed.push(id);
					continue;
				}
				if (caps[id].ok) prereqs.push({ id, detail: caps[id].detail });
				else blocked.push({ id, detail: caps[id].detail });
			}
			// EVERY `no` GETS A REASON, INCLUDING THE ONES NOTHING ELSE PRINTS.
			//
			// `unearned` covers a declared LABEL and `blocked` covers a required
			// TOOLCHAIN capability. Between them they leave every `implicit`
			// capability's failure completely silent: `cargo-bevy` below the bar,
			// `cuda` on a box whose DKMS module is not in the running kernel,
			// `pm2-capable` on a node that could not fetch a supervisor — each of them
			// simply ABSENT from `earned`, which is CLAUDE.md's "I could not look must
			// never render as nothing is wrong" one level down. A reader could see
			// THAT a node did not earn something and never WHY, and a firewall, a
			// kernel that has not rebooted and a card that cannot do AV1 are three
			// different jobs.
			//
			// NOT A FINDING. A claw with no GPU is not broken, and an 8 GB box that
			// cannot hold a 9,784 MiB role is not broken either — this is the evidence
			// behind an absence, not a fault.
			//
			// AND DELIBERATELY NOT IN THE `$capabilities` RECORD. `meetsBar`'s reason
			// for a MEASURED capability carries the measurement, and that moves on
			// every pass — `cargo-bevy` prints a fresh throughput figure every run — so
			// recording it would make every re-probe a changed file, every changed file
			// a commit, and every commit an mgmt-api redeploy. That is issue #59
			// exactly, re-entering through a different field. A per-run measurement
			// belongs in the run's own output; the record keeps only what CHANGED.
			// (`measurements`, below, records an idle-only figure WITHOUT reopening
			// this: its entry moves only when that capability's verdict does.)
			const notEarned = [];
			const explained = new Set([
				...unearned.map((u) => u.id),
				...blocked.map((b) => b.id),
				...unjudged,
			]);
			for (const id of probeableIds()) {
				if (proven.has(id) || explained.has(id) || !caps[id] || !capability(id)) continue;
				notEarned.push({ id, detail: barReason[id] ?? caps[id].detail ?? 'no reason given' });
			}
			// REVOCATION VERDICTS (src/capability-revocations.ts): this run EXECUTED
			// these routing labels. A pass clears a revocation — the reboot cycle's
			// re-prove lands here — and a failure revokes one the node was offering.
			// An unjudged measurement moves nothing.
			const offeredBefore = new Set(nodeOffer(m, { eligible: true }));
			for (const id of probeableIds()) {
				const cap = capability(id);
				if (!cap || cap.surface !== 'label' || cap.kind !== 'identity') continue;
				if (!caps[id] || unjudged.has(id)) continue;
				const passed = proven.has(id);
				if (!passed && !offeredBefore.has(id)) continue;
				revocationVerdicts.push({
					node: name,
					capability: id,
					passed,
					reason: passed ? caps[id].detail : (barReason[id] ?? caps[id].detail ?? 'failed'),
				});
			}

			report[name] = {
				earned,
				unearned,
				unclaimed,
				blocked,
				prereqs,
				unprobed,
				notEarned,
				inconclusive,
				deferred,
				measuredIdle: judgedIdle,
				...(idleHolds[name] ? { idleHold: idleHolds[name] } : {}),
				declared: [...declared],
				jobProofs: jobProofsFor(name, m, ctx),
			};

			// EARNED CAPABILITIES COME WITH THEIR ARTIFACTS (#102, wave 4c lane E), run
			// unconditionally — like `ensureTools` above, NOT gated behind `--write`.
			// `earned` here is THIS RUN's fresh proof, not the manifest's possibly
			// stale `$capabilities` facet, so the synthetic node below carries it
			// directly rather than asking `seedNode` to re-derive it from `m`.
			seedResultsByNode[name] = CHECK_ONLY
				? []
				: await seedNode(name, { ...m, $capabilities: { earned, prereqs } }, manifest, seedDeps);
		})
	);
}
