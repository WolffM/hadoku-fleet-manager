/**
 * ONE JOB REGISTRY — every automated fleet job (gate, converger or recorder),
 * its own clock, and the detection budget that clock must meet.
 *
 * Refactor plan 2026-10-28 §6.2 item 2, wave 5e lane A. Config layer: DATA,
 * TYPES and pure validation only — no network, no ssh, no filesystem read of
 * another repo. `scripts/lib/json-contract.mjs` derives `JSON_CONTRACT` and
 * `PROSE_CONTRACT` FROM this file (plan §6.2 item 4); this is the one place
 * cadence and detection budget are declared, so a cadence disagreement
 * between this package and hadoku_site's `profiles.json` has one source to
 * fix rather than two to reconcile.
 *
 * TWO KINDS OF CLOCK:
 *   - `{ cron }` — Temporal's cron-worker dispatches `POST
 *     /api/cron/run/<job>` on this schedule, which a hand-written wrapper in
 *     hadoku_site turns into `fleet <sub> --json`. Every `cron` entry here was
 *     read, today, from `services/cron-worker/profiles.json` on hadoku_site's
 *     `origin/main` (repo-sync 0 13 UTC, fleet-benchmark 0 12 UTC, fleet-pulse
 *     `* /10 * * * *` — this file is PUBLIC and cannot name internal hosts, so
 *     read the three profile names if you need the literal cron strings).
 *   - `{ clockMs }` — an IN-PROCESS control loop, running inside mgmt-api's
 *     own Node process because this package is consumed in-process (not a
 *     service). `createConverger` (`src/scheduled-converger.ts`) is the one
 *     implementation; `src/provisioning-converge.ts`, `src/hosting-converge.ts`
 *     and `src/claw-reboot.ts` each supply a clock and spawn the matching
 *     script by its OWN resolved path, not through the `fleet` CLI door — so
 *     these three rows have no `mgmtApiFile`: there is no mgmt-api route, the
 *     clock is this package's own module.
 *
 * DETECTION BUDGET is "how stale the verdict may get" (plan §6.2): did THIS
 * job run recently enough for its last answer to still mean something. The
 * honest default, absent a reason to do otherwise, is 2x the job's own
 * cadence period — the same multiple §6.2's "clock watches itself" gate uses
 * ("every job has a run younger than 2x its cadence"). Where a tighter or
 * looser number is actually justified, the `why` on that entry says so and
 * `validateRegistry` is where the number is CHECKED against the cadence, not
 * merely stated.
 *
 * `coversSubs` exists for exactly one entry: `ci:audit-gates` runs fourteen
 * `fleet <sub>` invocations under ONE umbrella job and judges each by prose
 * by default (see `scripts/lib/json-contract.mjs`'s `PROSE_CONTRACT` and
 * `parseAuditGates`). Duplicating those fourteen gates' identities into a
 * second hand list here would be exactly the kind of copy `json-contract.mjs`
 * already warns against ("derive, don't copy"); instead the one umbrella row
 * names which COMMANDS entries it discharges, each with its OWN detection
 * budget against the umbrella's shared cadence. Two of them (`warm-canary`,
 * `label-floor`) carried a 1h budget the daily cron could not meet, which
 * `validateRegistry` and `fleet check-schedule` reported every day; since
 * fleet-manager#38 they are rows of their own on a 30-minute cron instead.
 *
 * WAVE 5F LANE B (5h, 5i and 5j lane B after it) migrates these fourteen off
 * prose one at a time: a covered sub may carry `contract: 'json'` (see
 * `CoveredSub`'s own doc comment), which folds it into `JSON_CONTRACT`
 * instead of `PROSE_CONTRACT` while it stays discharged by the SAME umbrella
 * invocation — there is no second cron and no second `mgmtApiFile`.
 * `warm-canary`, `history-coverage` and `contract-consumers` migrated in
 * wave 5f lane B; `tier-fleet`, `capabilities` and `boundary-contracts`
 * migrated in wave 5h lane B; `label-floor` and `throttle` migrated in wave
 * 5i lane B; `mf-externals` and `identity` migrated in wave 5j lane B — the
 * last two non-d3 prose gates. Only `slice`/`tool-inventory` (d3's lane) and
 * `ci-watch` carry no `contract` field at all now.
 *
 * `kindDrift` exists for the case `src/cli.ts`'s `COMMANDS` table disagrees
 * with the three kinds this registry ever puts a clock on (`gate` |
 * `converger` | `recorder`) and the disagreement has NOT been fixed yet.
 * `validateRegistry` requires every such disagreement to carry a `kindDrift`
 * explaining it — an undocumented one is a finding, not a silent re-kind. Four
 * entries used to carry one (`ci:claw-cleanup`, `ci:node-users`,
 * `ci:fleet-benchmark`, `ci:slice-inventory` — `cleanup`, `node-users`,
 * `benchmark` and `service-inventory` were filed under `mutator`/`operator` in
 * `COMMANDS` while actually running as a converger/gate/recorder/recorder);
 * wave 5e lane D corrected `COMMANDS` itself on 2026-10-31, so none remain.
 */

import type { JobKind, JobEntry, JobCadence } from './job-registry-types.js';
export type {
	JobKind,
	JobEntry,
	JobCadence,
	JobCadenceCron,
	JobCadenceClock,
	JobPager,
	CoveredSub,
	JobContract,
} from './job-registry-types.js';

/** The COMMANDS kinds a mismatch against is worth checking — the other four never carry a clock. */
const GUARD_KINDS: ReadonlySet<string> = new Set<string>(['gate', 'converger', 'recorder']);

/** A flag a registered `gate` invocation may never carry (plan §3.4: "a gate never mutates"). */
const MUTATING_FLAGS: readonly string[] = ['--confirm', '--write', '--apply'];

import { jobRegistryFleetPulse } from './job-registry-fleet-pulse.js';
import { jobRegistryRepoSync } from './job-registry-repo-sync.js';
import { jobRegistryBenchmark } from './job-registry-benchmark.js';
import { jobRegistryLiveness } from './job-registry-liveness.js';
import { jobRegistryAuditGates } from './job-registry-audit-gates.js';
import { jobRegistryInProcess } from './job-registry-in-process.js';

/**
 * THE DIRECTLY REGISTERED `JSON_CONTRACT` JOBS (22 at wave 5e lane A's
 * landing, lane D's own `ci:schedule`, then `ci:warm-canary` and
 * `ci:label-floor` out of the umbrella — fleet-manager#38), read from
 * hadoku_site `origin/main` 2026-10-31:
 * `services/cron-worker/profiles.json` for the cadence and `timeout_s`,
 * `scripts/lib/json-contract.mjs`'s existing `JSON_CONTRACT` for
 * `argv`/`hostBound`/the consumer file. Every `detectionBudget` below is 2x
 * the job's own cadence period UNLESS the entry's `why` says a different
 * number is the actually-justified one (health-freshness, fleet-kills).
 *
 * PLUS the one prose umbrella (`ci:audit-gates`) and the three in-process
 * convergers — see the module header for both.
 */
export const JOB_REGISTRY: JobEntry[] = [
	...jobRegistryFleetPulse,
	...jobRegistryRepoSync,
	...jobRegistryBenchmark,
	...jobRegistryLiveness,
	...jobRegistryAuditGates,
	...jobRegistryInProcess,
];

/**
 * `COMMANDS` entries that are a `gate`, `converger` or `recorder` in
 * `src/cli.ts` but carry no clock at all — automation touches their SCRIPT
 * (as a facet of another registered job) or nothing, never the subcommand
 * itself. Keyed by the subcommand name, same shape as the guard's own
 * `manual: '<why>'` field (plan §6.2 item 4 / wave 5e lane A task 3).
 */
export const MANUAL: Record<string, string> = {
	'apt-security':
		"Driven as a facet inside ci:converge-provisioning's own 30-minute pass (scripts/converge-provisioning.mjs's DRIVER map resolves apt-security.mjs by its own script path, not through the `fleet` door). `fleet apt-security` as a standalone subcommand is operator-only; its registered automation is the converge-provisioning row above.",
	toolpack:
		'A standalone operator tool ("run it before bootcamp" — converge-toolchain.md): nothing calls toolpack.mjs from a cron or a converger (grepped; the only callers are src/cli.ts and the operator).',
	bootcamp:
		'Invoked only by scripts/provision-fleet.mjs (an operator-run mutator, "bring a node up from bare") and by hand; never on a timer. A node earns its labels when an operator runs provision or bootcamp, not on a schedule.',
	'hosting-request':
		"An operator/tenant debugging aid — reads one app's hosting.json the way the fleet will, before that tenant declares a slice. No cron parses it; TENANT_CONTRACT's `hosting --check` (a separate COMMANDS entry, kind: 'mutator', polled by hadoku-cardtable) is what a tenant actually reads on its own cadence.",
	'capability-schema':
		'Build-time-only (offline: no network, no ssh) — AGENTS.md\'s own "known gaps" names this exact file as the one whose header claims a cron that does not exist. Not scheduled; recorded here rather than silently assumed covered.',
	'hosting-demand':
		"Restated by hadoku-cardtable's own coordinator on ITS poll cadence (TENANT_CONTRACT), not by fleet-manager or mgmt-api. There is no fleet-owned clock to validate a budget against.",
};

export interface ValidationIssue {
	/** The job name, or `<job>:<sub>` for an issue scoped to one covered sub. */
	readonly entry: string;
	readonly kind:
		'duplicate-name' | 'cadence-budget' | 'kind-mismatch' | 'gate-mutates' | 'malformed';
	readonly message: string;
}

export interface ValidationResult {
	readonly ok: boolean;
	readonly issues: ValidationIssue[];
}

/**
 * `<n>m|h|d` -> milliseconds. Throws on anything else: a budget this function
 * cannot parse must fail loudly, not silently compare as `NaN` (which is
 * neither `>` nor `<=` anything and would make every check it touches vacuously pass).
 */
export function parseDurationMs(spec: string): number {
	const m = /^(\d+)(m|h|d)$/.exec(spec.trim());
	if (!m)
		throw new Error(
			`parseDurationMs: not a duration this registry understands: "${spec}" (want <n>m|h|d)`
		);
	const n = Number(m[1]);
	const unitMs = m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000;
	return n * unitMs;
}

/**
 * The period between runs, in milliseconds. For `{ clockMs }` this IS the
 * period. For `{ cron }` this package only ever needs two shapes — every-N-
 * minutes and daily-at-a-fixed-hour, the only two in `profiles.json` today —
 * and throws on anything else rather than guessing a period for a shape it
 * was not written to understand.
 */
export function cadencePeriodMs(cadence: JobCadence): number {
	if ('clockMs' in cadence) return cadence.clockMs;
	const { cron } = cadence;
	const everyNMinutes = /^\*\/(\d+) \* \* \* \*$/.exec(cron);
	if (everyNMinutes) return Number(everyNMinutes[1]) * 60_000;
	const dailyAtFixedHour = /^\d{1,2} \d{1,2} \* \* \*$/.exec(cron);
	if (dailyAtFixedHour) return 86_400_000;
	throw new Error(
		`cadencePeriodMs: does not understand cron "${cron}" — extend this function rather than guessing a period`
	);
}

/**
 * An in-process job's clock and paging, read from its row: the one place they
 * are declared (F12), so its module never states a second copy. THROWS for a
 * name with no row, no `clockMs` or no `pager`: a loop with no declared clock
 * must not start on a guessed one.
 */
export function inProcessClock(name: string): {
	intervalMs: number;
	repageMs: number;
	deferPageMs: number;
} {
	const e = JOB_REGISTRY.find((j) => j.name === name);
	if (!e || !('clockMs' in e.cadence) || !e.pager)
		throw new Error(`job-registry: ${name} declares no in-process clock and pager`);
	return {
		intervalMs: e.cadence.clockMs,
		repageMs: e.pager.repageMs,
		deferPageMs: e.pager.deferPageMs,
	};
}

/**
 * THROWS unless `name` is an in-process row whose clock is `intervalMs`. A
 * loop calls this when it is built, so a job that reports under a name the
 * registry does not hold, or ticks on a clock the registry does not declare,
 * fails at load instead of in the job sink (fleet-manager#35).
 */
export function assertRegisteredClock(name: string, intervalMs: number): void {
	const declared = inProcessClock(name).intervalMs;
	if (declared !== intervalMs)
		throw new Error(
			`job-registry: ${name} ticks every ${intervalMs}ms, its row declares ${declared}ms`
		);
}

/** Every `sub` this registry discharges, directly or through `coversSubs`. */
export function registeredSubs(entries: readonly JobEntry[] = JOB_REGISTRY): Set<string> {
	const out = new Set<string>();
	for (const e of entries) {
		if (e.sub) out.add(e.sub);
		for (const c of e.coversSubs ?? []) out.add(c.sub);
	}
	return out;
}

/**
 * Checks, in order:
 *   1. `name` is unique.
 *   2. Every entry (and covered sub) has a `why`, an `args` array, a
 *      `detectionBudget` that parses, and a `cadence` that parses.
 *   3. The cadence's own period can MEET the detection budget (period <=
 *      budget) — for the entry itself and for each covered sub against the
 *      SAME shared cadence.
 *   4. No `gate`-kind entry (or covered sub, when the umbrella's kind is
 *      `gate`) carries a mutating flag in its registered `args`.
 *   5. When `opts.commandsKind` is supplied (the guard test's job — parsing
 *      `src/cli.ts` is I/O, which this pure module does not do): `kind`
 *      agrees with `COMMANDS[sub].kind` whenever that kind is itself one
 *      this registry tracks, UNLESS the entry carries `kindDrift`.
 *
 * Returns every issue found rather than throwing on the first one; the
 * caller decides what to do with `ok: false`.
 */
export function validateRegistry(
	entries: readonly JobEntry[] = JOB_REGISTRY,
	opts: { commandsKind?: ReadonlyMap<string, string> } = {}
): ValidationResult {
	const issues: ValidationIssue[] = [];
	const seen = new Set<string>();

	const checkMutatingGate = (label: string, kind: JobKind, args: readonly string[]) => {
		if (kind !== 'gate') return;
		for (const flag of MUTATING_FLAGS) {
			if (args.includes(flag)) {
				issues.push({
					entry: label,
					kind: 'gate-mutates',
					message: `a gate's registered args include mutating flag "${flag}": [${args.join(', ')}]`,
				});
			}
		}
	};

	const checkBudget = (label: string, cadence: JobCadence, budget: string) => {
		let periodMs: number;
		try {
			periodMs = cadencePeriodMs(cadence);
		} catch (err) {
			issues.push({ entry: label, kind: 'malformed', message: String(err) });
			return;
		}
		let budgetMs: number;
		try {
			budgetMs = parseDurationMs(budget);
		} catch (err) {
			issues.push({ entry: label, kind: 'malformed', message: String(err) });
			return;
		}
		if (periodMs > budgetMs) {
			issues.push({
				entry: label,
				kind: 'cadence-budget',
				message: `cadence period ${periodMs}ms cannot meet detectionBudget "${budget}" (${budgetMs}ms)`,
			});
		}
	};

	const checkKind = (
		sub: string | undefined,
		kind: JobKind,
		drift: string | undefined,
		label: string
	) => {
		if (!sub || !opts.commandsKind) return;
		const declared = opts.commandsKind.get(sub);
		if (declared === undefined || !GUARD_KINDS.has(declared)) return;
		if (declared !== kind && !drift) {
			issues.push({
				entry: label,
				kind: 'kind-mismatch',
				message: `COMMANDS['${sub}'].kind is '${declared}', registry says '${kind}', and no kindDrift explains it`,
			});
		}
	};

	for (const e of entries) {
		if (seen.has(e.name)) {
			issues.push({
				entry: e.name,
				kind: 'duplicate-name',
				message: 'declared twice in JOB_REGISTRY',
			});
		}
		seen.add(e.name);

		if (!e.why) issues.push({ entry: e.name, kind: 'malformed', message: 'missing why' });
		if (!Array.isArray(e.args))
			issues.push({ entry: e.name, kind: 'malformed', message: 'args is not an array' });

		checkBudget(e.name, e.cadence, e.detectionBudget);
		checkMutatingGate(e.name, e.kind, e.args);
		checkKind(e.sub, e.kind, e.kindDrift, e.name);

		for (const c of e.coversSubs ?? []) {
			const label = `${e.name}:${c.sub}`;
			if (!c.why) issues.push({ entry: label, kind: 'malformed', message: 'missing why' });
			checkBudget(label, e.cadence, c.detectionBudget);
			checkMutatingGate(label, e.kind, c.args);
			checkKind(c.sub, e.kind, undefined, label);
			// Wave 5f lane B: a covered sub migrated onto GateDoc is discharged
			// by the SAME umbrella invocation under `--json` — the declaration
			// and the actual argv must agree, or `deriveJsonContract` would
			// derive an entry the real `fleet <sub>` call never satisfies.
			if (c.contract === 'json' && !c.args.includes('--json')) {
				issues.push({
					entry: label,
					kind: 'malformed',
					message: 'contract: "json" covered sub must pass --json in its args',
				});
			}
		}
	}

	return { ok: issues.length === 0, issues };
}
