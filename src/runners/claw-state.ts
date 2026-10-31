/**
 * One word for what each node is doing, for the Fleet panel.
 *
 * Extracted from runner-health's tick so the THREE-STATE discipline is
 * assertable. The panel distinguishes "free", "down", and "not looked at yet",
 * and the third is the one that keeps getting collapsed into the second.
 */
import type { ClawState } from '../lib/fleet-vocabulary.js';

export interface ClawStateRunner {
	name: string;
	status?: string;
	busy?: boolean;
}

export interface ClawStateInput<R extends ClawStateRunner> {
	/** Every node in the fleet, standing and ephemeral. */
	fleetNodes: string[];
	/** Nodes that mint per job instead of holding registrations. */
	ephemeral: ReadonlySet<string>;
	runners: R[];
	/** Fold a runner name to its node — JIT and instance names included. */
	nodeOf: (name: string, nodes: string[]) => string;
	/** Does this runner carry the eligibility label? */
	isEligible: (r: R) => boolean;
	/**
	 * The fast loop's probe for a node, or undefined if it has not run yet.
	 *
	 * `undefined` and `{reachable: false}` are DIFFERENT and the difference is
	 * the point — see below.
	 */
	probeFor: (node: string) => { reachable: boolean; sick?: boolean } | undefined;
}

/**
 * An EPHEMERAL node's state, from its probe alone. `undefined` ⇒ `null`.
 *
 * SPLIT OUT SO TWO READERS CAN SHARE IT. An ephemeral node holds no standing
 * registration, so unlike every other node its state does not depend on the
 * runner listing at all — it is a pure function of the last ssh probe. That
 * makes it the one state `buildFleetReport` can, and should, compute for itself
 * from the probe it already holds: this tick runs every 10 minutes, the probe
 * every 60 seconds, and the panel renders both in the same table row.
 *
 * Omitting the fix left claw-1 reading `mintable` for up to ten minutes after
 * it went down, next to `reachable: false` from the fresh probe beside it — the
 * same contradiction as the restart race documented below, just in the other
 * direction and in steady state rather than at boot.
 *
 * `null`, not `'unreachable'`, for an absent probe: see the note in
 * `deriveClawState`.
 */
export function ephemeralState(
	probe: { reachable: boolean; sick?: boolean } | undefined
): ClawState | null {
	if (!probe) return null;
	return !probe.reachable ? 'unreachable' : probe.sick ? 'sick' : 'mintable';
}

/**
 * A node with no entry is UNKNOWN. Callers render a missing key as null rather
 * than as a verdict, which is why omission is the correct output and not a gap.
 */
export function deriveClawState<R extends ClawStateRunner>(
	i: ClawStateInput<R>
): Record<string, ClawState> {
	const out: Record<string, ClawState> = {};
	const standing = i.fleetNodes.filter((m) => !i.ephemeral.has(m));

	for (const m of standing) {
		const regs = i.runners.filter((r) => i.nodeOf(r.name, i.fleetNodes) === m);
		out[m] =
			regs.length === 0
				? 'absent'
				: regs.some((r) => r.status === 'online')
					? regs.some((r) => i.isEligible(r))
						? regs.every((r) => r.busy)
							? 'busy'
							: 'free'
						: 'demoted'
					: 'offline';
	}

	for (const m of i.ephemeral) {
		const probe = i.probeFor(m);
		// AN ABSENT PROBE IS UNKNOWN, NOT UNREACHABLE.
		//
		// This read collapsed "the fast loop has not probed yet" into "the machine
		// is down". Both loops start together and the health tick wins the race —
		// the tier probe ssh's the whole fleet and takes seconds — so on EVERY
		// restart the first health pass saw an empty snapshot and stamped
		// `unreachable` on every ephemeral node. State is rewritten once per
		// 10-minute tick, so a verdict invented in a one-second gap was served for
		// up to ten minutes.
		//
		// Measured on the Fleet panel 2026-09-02: claw-1 and claw-3 rendered
		// `unreachable` beside `reachable: true` in the SAME payload, because the
		// machines list reads the live probe while this came from the stale health
		// snapshot. Both were up; claw-3 had been up seven days.
		//
		// Omitting the key is the fix rather than inventing a value, because the
		// route already does `claw_state?.[name] ?? null` and renders null as "not
		// looked at yet". That is the discipline every other field in the payload
		// keeps: absent means null, never zero and never false.
		const st = ephemeralState(probe);
		if (st) out[m] = st;
	}

	return out;
}
