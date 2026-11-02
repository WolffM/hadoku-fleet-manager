/**
 * The `GET /fleet` response contract.
 *
 * DECLARED, not inferred. `buildFleetReport` had no return type, and the
 * command station hand-maintained a 76-line copy of this shape in
 * `System/types.ts` — two descriptions of one payload with nothing checking
 * they agreed. A field renamed here would have surfaced as `undefined` in the
 * panel at runtime, on a page nobody opens until something is already wrong.
 *
 * The UI now imports these, so tsc fails the build instead.
 *
 * `floorBreach` LEFT THIS CONTRACT on 2026-09-02. It was computed in
 * captureSnapshot from `label_online` — a count of ONLINE STANDING runners
 * carrying each required label — and on an all-JIT fleet nothing standing
 * carries any label, so it read `true` permanently while the fleet placed and
 * completed work normally. 840a696 had already taught the ALERT path
 * (`checkLabelFloor`) to count minting; the snapshot's own copy was the second
 * answer to the same question and was never updated.
 *
 * It had exactly ONE consumer — a red banner on this panel saying "every fleet
 * job will queue until one returns", which was false every time it rendered.
 * The genuine floor alerting is `checkLabelFloor` and is unaffected. A field
 * that is both wrong and unread is not a contract, so it is gone rather than
 * fixed-and-unrendered.
 *
 * The COMPONENTS deliberately stay in the command station. It owns the panels
 * for PM2, secrets and keys the same way; the fleet is not special, and moving
 * them would make this package ship React. The contract is what had to be
 * shared, not the presentation.
 *
 * THIS FILE IS THE ONE MODULE IMPORTERS USE (wave 5r lane A). At 1,215 lines
 * it crossed the 800-line source ceiling, so the types split BY SECTION into
 * `fleet-report-types-{machines,jobs,dispatch,capacity,budget,vocabulary,
 * registry}.ts` — a pure move, byte-identical apart from import/export lines.
 * This file re-exports every one of them (plus `ClawState`/`BackstopReason`,
 * which already lived in `lib/fleet-vocabulary.ts`), so no importer anywhere
 * in this package or in hadoku_site changes by a single path. A TYPE-ONLY
 * BARREL is the right shape here, deliberately, where it would not be
 * elsewhere in this codebase: this file IS the wire contract's public face —
 * the one thing a reader or a consumer is meant to import — not a module
 * hiding a real dependency edge behind a re-export.
 */
import type { ClawState, BackstopReason } from './lib/fleet-vocabulary.js';
import type { FleetMachine, BackstopForced } from './fleet-report-types-machines.js';
import type {
	FleetMachineJobStats,
	FleetRepoJobStats,
	FleetDailyJobStats,
	FleetJobRecord,
} from './fleet-report-types-jobs.js';
import type { FleetReservation } from './fleet-report-types-dispatch.js';
import type { FleetDispatch } from './fleet-loop.js';
import type { FleetDispatchAffinity } from './runners/dispatch-pass-state.js';
import type { FleetCapacity } from './fleet-report-types-capacity.js';
import type { FleetGithubBudget } from './gh-budget.js';
import type { FleetVocabulary } from './fleet-report-types-vocabulary.js';

export * from './fleet-report-types-machines.js';
export * from './fleet-report-types-jobs.js';
export * from './fleet-report-types-dispatch.js';
export * from './fleet-report-types-capacity.js';
export * from './fleet-report-types-budget.js';
export * from './fleet-report-types-vocabulary.js';
export * from './fleet-report-types-registry.js';

export interface FleetReport {
	success: boolean;
	probedAt: string | null;
	healthAt: string | null;
	machines: FleetMachine[];
	fleet: {
		runnersOnline: number | null;
		runnersOffline: number | null;
		clawsOnline: number | null;
		/**
		 * FREE CAPACITY, SPLIT BY WHAT HAS TO HAPPEN BEFORE A JOB CAN LAND ON IT.
		 *
		 * This replaced five scalars — `clawsReady`, `clawsFree`,
		 * `clawsFreeStanding`, `clawsFreeMintable`, `clawsPromotable` — plus
		 * `ephemeralUnknown`, on 2026-09-03.
		 *
		 * THE PROBLEM WAS THE NAMES. Three of those five encoded a MECHANISM in a
		 * wire key: `Standing` and `Mintable` are the standing/ephemeral split,
		 * `Promotable` was the tier ladder (retired 2026-09-21). Mechanisms get
		 * replaced, and a
		 * consumer cannot be asked to notice. Worse, a fleet that grew a THIRD way
		 * of becoming available had nowhere to put it: adding a scalar is a
		 * cross-repo rename, so the pressure was always to fold the new thing into
		 * an existing number and lose it.
		 *
		 * The axis underneath all three is the same question, and it is not about
		 * mechanism at all: WHAT HAS TO HAPPEN BEFORE WORK LANDS HERE. Nothing (a
		 * runner is standing by) or the dispatcher mints. A new
		 * mechanism is a new ROW, described in `vocabulary.capacityKinds`, and no
		 * consumer changes.
		 */
		capacity: FleetCapacity;
		/** machine -> state. A count cannot be diagnosed; this can. */
		clawState: Record<string, ClawState> | null;
		backstopReason: BackstopReason | null;
		/**
		 * Nodes an operator is holding eligible with `fleet backstop --force`,
		 * each with its expiry — the green light (`backstop-force.ts`). Empty
		 * when nobody has the switch on; `null` when the switch file could not
		 * be read, which is "could not look", not "off".
		 */
		backstopForced: BackstopForced[] | null;
		queuedNow: number | null;
		runningNow: number | null;
		oldestQueuedMin: number | null;
		longestRunningMin: number | null;
		queuedStale: number | null;
		hung: number | null;
		failoverReruns: number | null;
		oomReruns: number | null;
		pm2HostBusy: boolean | null;
	};
	reservation: FleetReservation;
	/** `affinity` is the only field not from the fast loop's snapshot — see FleetDispatchAffinity. */
	dispatch: FleetDispatch & {
		affinity: FleetDispatchAffinity;
		/**
		 * The queue from the dispatcher's own 15s listing, aged at request time
		 * — fresher than `fleet.queuedNow`, which is cut every 10 minutes. `at`
		 * is the stalest read it rests on; `unread` repos had no read since
		 * restart and are NOT counted as empty.
		 */
		queue: { at: string | null; runs: number; oldestQueuedMin: number | null; unread: number };
	};
	/** @see FleetGithubBudget — empty until this process has seen a GitHub response. */
	githubBudget: FleetGithubBudget[];
	/** @see FleetVocabulary — the words, shipped with the numbers. */
	vocabulary: FleetVocabulary;
	jobs: {
		since: string | null;
		total: number;
		byMachine: FleetMachineJobStats[];
		/** Per repo over the same window, most jobs first. */
		byRepo: FleetRepoJobStats[];
		/** Every UTC day of the window, oldest first, today included. */
		daily: FleetDailyJobStats[];
		backstopJobs: number;
		backstopShare: number;
		recent: FleetJobRecord[];
		/**
		 * THE TRAILING WINDOW'S OWN BOUNDS — what `byMachine[].recent*` was cut
		 * against, stated rather than assumed.
		 *
		 * `recentSince` is the START of the window, ISO; the report was built at
		 * `recentSince + recentWindowSec`, so both ends are recoverable from the
		 * payload. They are always present, including on a fleet that completed
		 * nothing: "we looked at 14:05–15:05 and it was empty" is a statement and
		 * it needs the hour named to be one. A consumer that renders the window
		 * from these can never disagree with the figures, which is the same reason
		 * `vocabulary.queuedWarnMinutes` travels with the count it thresholds.
		 */
		recentSince: string;
		recentWindowSec: number;
	};
}
