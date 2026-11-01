/**
 * The job shapes `src/lib/job-registry.ts`'s `JOB_REGISTRY` is built from —
 * split out (wave 5s lane C, TypeScript long tail) so the `job-registry-*.ts`
 * domain modules can declare their own `JobEntry[]` arrays without importing
 * `job-registry.ts` itself (which assembles them). Pure move: no behaviour
 * here, just the types `job-registry.ts` used to declare inline.
 */
/** What this job IS, for the three kinds that are ever put on a clock. */
export type JobKind = 'gate' | 'converger' | 'recorder';

export interface JobCadenceCron {
	readonly cron: string;
}
export interface JobCadenceClock {
	readonly clockMs: number;
}
export type JobCadence = JobCadenceCron | JobCadenceClock;

export interface JobPager {
	readonly repageMs: number;
	readonly deferPageMs: number;
}

/** One `fleet <sub>` invocation discharged by an umbrella job rather than its own row. */
export interface CoveredSub {
	readonly sub: string;
	readonly args: string[];
	readonly detectionBudget: string;
	readonly why: string;
	/**
	 * Wave 5f lane B (plan §6.2: "audit-gates' 14 prose gates migrate to
	 * GateDoc one at a time"). Absent (the default) means this covered sub is
	 * still judged the old way — `PROSE_CONTRACT`'s evidence/exit-code rule
	 * over stdout+stderr. `'json'` means it has migrated: the SAME umbrella
	 * invocation (`ci:audit-gates`, same `mgmtApiFile` — there is no second
	 * cron) now passes `--json` and hadoku_site's `audit-gates.ts` reads back
	 * a `GateDoc` instead, falling back to the old rule when stdout is not
	 * one (an older fleet-manager) — see `wave5f-2026-10-31.md`'s blast-radius
	 * row. `scripts/lib/json-contract.mjs`'s `deriveJsonContract` folds a
	 * migrated covered sub into `JSON_CONTRACT` beside the ten directly
	 * registered entries; `validateRegistry` requires `args` to actually
	 * carry `--json` once this is set.
	 */
	readonly contract?: 'json';
	/**
	 * Required once `contract: 'json'` is set — absent for a sub still judged
	 * by `PROSE_CONTRACT`, which has no host-bound concept at all (the
	 * umbrella runs every covered sub from the one place that invokes it; see
	 * `JobEntry.hostBound`'s own doc comment for what the field means once a
	 * sub is actually under the JSON contract).
	 */
	readonly hostBound?: boolean;
}

export type JobContract = 'json' | 'prose' | 'in-process';

export interface JobEntry {
	/** The mgmt-api job name (`ci:queue-health`) or, for an in-process loop, this package's own name for it (`fleet:hosting-converge`). */
	readonly name: string;
	/** The `fleet` subcommand this job runs, when it maps 1:1 onto one `COMMANDS` entry. Absent for an umbrella job (see `coversSubs`). */
	readonly sub?: string;
	/** The argv actually passed, copied from the call site — not the minimum that would work. */
	readonly args: string[];
	readonly kind: JobKind;
	/** How stale this job's own last run may get before it is a finding, as `<n>m|h|d`. */
	readonly detectionBudget: string;
	readonly cadence: JobCadence;
	readonly timeoutS?: number;
	/** This job runs inside a declared deploy-hold window (profiles.json names it explicitly). */
	readonly deployHold?: boolean;
	/** Reads something that belongs to THIS box rather than the fleet (json-contract.mjs's own field, carried through). */
	readonly hostBound?: boolean;
	/** The mgmt-api route file that dispatches/consumes this job. Absent for an in-process loop — there is no route. */
	readonly mgmtApiFile?: string;
	readonly contract: JobContract;
	/** Paging policy, where one is actually implemented (today: the three in-process convergers; see `src/scheduled-converger.ts`). */
	readonly pager?: JobPager;
	readonly why: string;
	/** Present only when `kind` disagrees with `COMMANDS[sub].kind` — see the module header. */
	readonly kindDrift?: string;
	/** Other `COMMANDS` entries this umbrella job discharges — see the module header. Only `ci:audit-gates` uses this today. */
	readonly coversSubs?: CoveredSub[];
}
