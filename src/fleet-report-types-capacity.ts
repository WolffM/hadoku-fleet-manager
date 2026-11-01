/**
 * The capacity-breakdown SECTION of the `GET /fleet` contract (wave 5r lane
 * A pure move out of `fleet-report-types.ts`): free slots split by what has
 * to happen before a job can land. See that file's own header for why this
 * is a type-only barrel's section rather than a runtime module —
 * `fleet-report-types.ts` re-exports every name below for every existing
 * importer.
 */
import type { AdmissionCaveat } from './fleet-report-types-machines.js';

/**
 * A way capacity becomes available — the ROWS of `FleetCapacity.byKind`.
 *
 * One axis: what has to happen before a job can land. Deliberately NOT the
 * mechanism that provides it, because every mechanism this fleet has had is on
 * its way out and the question survives all of them.
 */
export type CapacityKind = 'immediate' | 'mintable';

/** One row of the capacity breakdown. @see FleetReport.fleet.capacity */
export interface CapacitySlice {
	kind: CapacityKind;
	/** Free job SLOTS of this kind. `null` = not measured, which is not zero. */
	free: number | null;
	/**
	 * Why part of `free` is a guess, by reason, counted per node.
	 *
	 * A slot count cannot say this on its own: it is summed with `?? 0`, so a
	 * node nobody could reach contributes the same zero as a node that is
	 * genuinely full. Those are two different emergencies. Empty = every node in
	 * this row was measured against a budget its operator declared.
	 */
	caveats: Partial<Record<AdmissionCaveat, number>>;
	/**
	 * Is this row counted in `FleetCapacity.free`?
	 *
	 * DECLARED, never inferred: a row can be real capacity that no job can reach
	 * yet, and counting it as free is how a saturation promote of the production
	 * host gets justified by slots nothing can currently use.
	 *
	 * A consumer must not decide this for itself by matching on `kind`. That is
	 * precisely the fleet logic this shape exists to keep out of the panel.
	 */
	available: boolean;
}

/** @see FleetReport.fleet.capacity */
export interface FleetCapacity {
	/**
	 * MACHINES that can take a job right now.
	 *
	 * THE headline, and the only figure here that counts boxes. `clawsOnline`
	 * counts machines that are UP — a fully saturated fleet is fully online — and
	 * every number in `byKind` counts SLOTS, which on an all-JIT fleet is larger
	 * than the fleet itself ("15 free" across 6 machines) and reads as a bug
	 * rather than as capacity.
	 */
	ready: number | null;
	/**
	 * Free SLOTS right now: the sum of the rows below with `available: true`.
	 *
	 * Summed HERE so no consumer has to know which rows count. A panel that adds
	 * up the breakdown itself will one day add up a row that should not have been
	 * in the total, and it will be right about the arithmetic and wrong about the
	 * fleet.
	 */
	free: number | null;
	/** Free slots by what has to happen first. Order is not significant. */
	byKind: CapacitySlice[];
	/**
	 * No probe has been taken since the last restart, so every figure above is a
	 * FLOOR rather than a reading.
	 *
	 * A reader must render this as "not measured", never as zero capacity. The
	 * two are the difference between a healthy garage and a dark one, and
	 * collapsing them put a red "0 standing · 0 mintable" over six reachable
	 * claws after every deploy.
	 */
	unmeasured: boolean;
}
