import type { ReserveSource } from './job-reserve.js';

/** @see FleetMachine.state */
export type ClawState =
	'free' | 'busy' | 'demoted' | 'offline' | 'absent' | 'mintable' | 'unreachable' | 'sick';

/**
 * Why the backstop is up, or `'none'`. A UNION, not `string`.
 *
 * `decideBackstop` has returned exactly these four since it was written, and the
 * report widened them to `string | null` on the way out — so the panel's
 * four-branch switch fell through to "unknown" for any value it had not been
 * told about, and a rename here would have surfaced as a grey pill on the one
 * page opened when something is already wrong.
 */
export type BackstopReason = 'outage' | 'saturation' | 'holding' | 'none';

/**
 * Which `admitMint` clause refused a node's GENERIC admission check this tick
 * — see {@link AdmissionVerdict}. Moved out of `ephemeral-tick-verdict.ts`
 * (ci-scheduling) wave clean-2 lane A (cut (iii)): `runner-health-mint.ts`
 * (observation) reads the same verdict shape through `admission-verdict-store.ts`,
 * and neither domain can host the other's import legally — same shape as
 * `ClawState`/`BackstopReason` above. `ephemeral-tick-verdict.ts` re-exports
 * this name under its original path, so no existing importer changes.
 *
 * `admitMint` has returned exactly three refusal shapes since it was written
 * (`ephemeral.ts`): drained, at-capacity, and memory (the plain clause and the
 * #76 lower-bound PLACEMENT clause, folded together here as 'memory' — both
 * are refused for want of room, and the generic check never sets
 * `requiredIsLowerBound`, so the placement wording can never actually reach
 * this classifier; it is handled anyway so a future caller that DOES set it
 * is not silently misread).
 *
 * `'other'` is defensive. A reason this file does not recognise must not
 * silently satisfy `clause === 'memory'` and feed the starvation finding
 * (`runner-health.ts`) something `admitMint` was never asked to mean.
 *
 * `'space'` (#101): refused for want of `/tmp` or `~/.hadoku/jit` free space,
 * never folded into `'memory'` — a dataplatform pytest run plus a site build
 * can fill a tmpfs while plenty of RAM remains free, and the finding needs to
 * say which resource actually ran out.
 */
export type AdmissionClause = 'drained' | 'concurrency' | 'memory' | 'space' | 'other';

/**
 * The verdict `admitMint` reaches for one EPHEMERAL node's GENERIC admission
 * check this tick — DISPLAY, never a second decision (wave 4a §A.1, #100).
 * Moved alongside {@link AdmissionClause}; see that type's own doc for why.
 *
 * `placement.ts`'s `refusalFor` calls `admitMint` again, per queued run, with
 * the run's own repo's reserve substituted in when #76's lower bound applies
 * — THAT call is the one which actually gates a mint. This verdict is
 * computed from the SAME `NodeState` `dispatchEphemeral` already builds for
 * placement, before any run is known, so it answers "could this node take A
 * job right now" rather than "could it take THIS one" — close enough to
 * drive a finding and a panel field, wrong to feed back into scheduling.
 * Nothing here changes what `admitMint` admits, the reserves, or the order.
 *
 * WHY THIS EXISTS: claw-6 and claw-2 were refused by the memory clause on
 * every tick for days (2026-09-30 / 2026-10-04) and nothing recorded it —
 * `admitMint`'s own refusal reached nowhere past a per-run log line, and
 * `admissionFree` (fleet-report-types.ts) counts SLOTS and never applies this
 * clause. This is that answer, held where a reader can reach it without
 * re-deriving `admitMint`'s own logic.
 */
export type AdmissionVerdict =
	| { ok: true }
	| {
			ok: false;
			clause: AdmissionClause;
			/** This node's free memory, measured this tick (`NodeState.freeMb`) —
			 *  or, when `clause === 'space'`, the free MB on the filesystem named
			 *  by {@link filesystem} instead. */
			availableMb: number;
			/** What this generic check reserved against it (`NodeState.requiredMb`)
			 *  — or, when `clause === 'space'`, the floor that filesystem failed to
			 *  clear (`TMP_FREE_FLOOR_MB` or `WORK_FREE_FLOOR_MB`). */
			needMb: number;
			/** Only set when `clause === 'space'`: which filesystem refused —
			 *  `'tmp'` for `/tmp`, `'work'` for the filesystem holding
			 *  `~/.hadoku/jit`. Absent for every other clause. */
			filesystem?: 'tmp' | 'work';
			/** Only set (`true`) when `clause === 'space'` AND the free space on
			 *  {@link filesystem} could not be read (`spaceRefusal`'s `freeMb:
			 *  null`) — `availableMb` is then `0` and is NOT a measurement, only a
			 *  placeholder so the field stays a `number`. A reader that prints
			 *  "…MB free" must check this first. Absent for every other case,
			 *  including a measured below-floor space refusal. */
			unreadable?: true;
			/** Which of `jobReserve`'s three answers produced `needMb`. Meaningless
			 *  for `clause === 'space'` (carried anyway — it is cheap and callers
			 *  already read it unconditionally). */
			reserveBasis: ReserveSource;
			/** `admitMint`'s own reason string, verbatim — the detail a clause alone
			 *  cannot carry (e.g. the exact capacity count, or the exact MB gap). */
			reason: string;
	  };
