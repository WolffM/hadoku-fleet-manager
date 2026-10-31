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
 * (see `scripts/lib/json-contract.mjs`'s `PROSE_CONTRACT` and
 * `parseAuditGates`). Duplicating those fourteen gates' identities into a
 * second hand list here would be exactly the kind of copy `json-contract.mjs`
 * already warns against ("derive, don't copy"); instead the one umbrella row
 * names which COMMANDS entries it discharges, each with its OWN detection
 * budget against the umbrella's shared cadence — which is how two of the
 * fourteen (`warm-canary`, `label-floor`) surface as real findings below:
 * they are liveness checks on a daily cron, and `validateRegistry` says so
 * rather than silently passing.
 *
 * `kindDrift` exists because `src/cli.ts`'s `COMMANDS` table carries SEVEN
 * kinds (plan §3.4) and this registry only needs the three that are ever
 * scheduled (`gate` | `converger` | `recorder`). Four real subcommands are
 * scheduled — and therefore belong here — despite `COMMANDS` filing them
 * under `operator` or `mutator`: `benchmark` and `service-inventory` write a
 * declared record on a cron (plan §3.2 rule 6: that is a `recorder`, whatever
 * the door calls it), `node-users` is judged pass/fail by its consumer (a
 * `gate`), and `cleanup --confirm` is the plan's OWN example of a mutating
 * check that "moves to the registry as" a `converger` (§3.2 rule 6, verbatim).
 * `validateRegistry` requires every such disagreement to carry a `kindDrift`
 * explaining it — an undocumented one is a finding, not a silent re-kind.
 */

/** What this job IS, for the three kinds that are ever put on a clock. */
export type JobKind = 'gate' | 'converger' | 'recorder';

/** The COMMANDS kinds a mismatch against is worth checking — the other four never carry a clock. */
const GUARD_KINDS: ReadonlySet<string> = new Set<string>(['gate', 'converger', 'recorder']);

/** A flag a registered `gate` invocation may never carry (plan §3.4: "a gate never mutates"). */
const MUTATING_FLAGS: readonly string[] = ['--confirm', '--write', '--apply'];

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

/**
 * THE 22 `JSON_CONTRACT` JOBS, read from hadoku_site `origin/main`
 * 2026-10-31: `services/cron-worker/profiles.json` for the cadence and
 * `timeout_s`, `scripts/lib/json-contract.mjs`'s existing `JSON_CONTRACT` for
 * `argv`/`hostBound`/the consumer file. Every `detectionBudget` below is 2x
 * the job's own cadence period UNLESS the entry's `why` says a different
 * number is the actually-justified one (health-freshness, fleet-kills).
 *
 * PLUS the one prose umbrella (`ci:audit-gates`) and the three in-process
 * convergers — see the module header for both.
 */
export const JOB_REGISTRY: JobEntry[] = [
	// ---- fleet-pulse ( */10 * * * *, 10-minute cadence; budget 20m = 2x) ----
	{
		name: 'ci:drain-enforced',
		sub: 'drain-check',
		args: ['--json'],
		kind: 'gate',
		detectionBudget: '20m',
		cadence: { cron: '*/10 * * * *' },
		timeoutS: 60,
		hostBound: false,
		mgmtApiFile: 'services/mgmt-api/src/routes/jobs/drain-enforced-check.ts',
		contract: 'json',
		why: 'Is a drained node actually idle — a safety fact about a physical machine, read from job history rather than the drain file (claw-5 was believed drained by three documents while serving 61 jobs). Ten-minute cadence is the fleet-pulse default; nothing about drain enforcement needs it tighter.',
	},
	{
		name: 'ci:reap-timeout-trend',
		sub: 'reap-trend',
		args: ['--json'],
		kind: 'gate',
		detectionBudget: '20m',
		cadence: { cron: '*/10 * * * *' },
		timeoutS: 30,
		hostBound: true,
		mgmtApiFile: 'services/mgmt-api/src/routes/jobs/reap-timeout-trend-check.ts',
		contract: 'json',
		why: "Is the reap's GET-runners timeout rate CLIMBING against mgmt-api's own pm2 log, so it must run on the box mgmt-api runs on (hostBound). Ten-minute cadence; a trend needs two windows to compare, not a tighter budget.",
	},
	{
		name: 'ci:srv-drift',
		sub: 'srv-drift',
		args: ['--json'],
		kind: 'gate',
		detectionBudget: '20m',
		cadence: { cron: '*/10 * * * *' },
		timeoutS: 60,
		hostBound: true,
		mgmtApiFile: 'services/mgmt-api/src/routes/jobs/srv-drift-check.ts',
		contract: 'json',
		why: 'Is the DEPLOYED manifest under ~/srv the one main holds — a publish resets ~/srv, so a hand edit or an unlanded write is erased at the next deploy anywhere in the ecosystem. Ten-minute cadence catches a redeploy window quickly without reading the in-flight deploy itself as drift.',
	},
	{
		name: 'ci:queue-health',
		sub: 'queue-health',
		args: ['--json'],
		kind: 'gate',
		detectionBudget: '1h',
		cadence: { cron: '*/10 * * * *' },
		timeoutS: 120,
		hostBound: false,
		mgmtApiFile: 'services/mgmt-api/src/routes/jobs/queue-health-check.ts',
		contract: 'json',
		why: 'Is the fleet actually SERVING work. The one entry here that reads an OUTCOME rather than a declaration, built after 13 jobs sat queued 11-19 minutes with every other gate green. 1h rather than the generic 2x10m=20m because its own why names the real tolerance: "a stall resolves or escalates inside the hour."',
	},

	// ---- repo-sync (0 13 * * *, daily; budget 48h = 2x unless noted) ----
	{
		name: 'ci:fleet-coverage',
		sub: 'reconcile',
		args: ['--json'],
		kind: 'converger',
		detectionBudget: '48h',
		cadence: { cron: '0 13 * * *' },
		timeoutS: 300,
		hostBound: false,
		mgmtApiFile: 'services/mgmt-api/src/routes/jobs/fleet-coverage-check.ts',
		contract: 'json',
		why: "Does every covered repo have a runner; also run a second time as --json --confirm to apply. Daily is this job's own cadence; nothing here argues for tighter.",
	},
	{
		name: 'ci:fleet-toolchain',
		sub: 'toolchain',
		args: ['--json'],
		kind: 'gate',
		detectionBudget: '48h',
		cadence: { cron: '0 13 * * *' },
		timeoutS: 120,
		hostBound: false,
		mgmtApiFile: 'services/mgmt-api/src/routes/jobs/fleet-toolchain-check.ts',
		contract: 'json',
		why: 'Can each node build what its neighbours can. Detection only, never --confirm.',
	},
	{
		name: 'ci:header-fleet',
		sub: 'header-audit',
		args: ['--json'],
		kind: 'gate',
		detectionBudget: '48h',
		cadence: { cron: '0 13 * * *' },
		timeoutS: 660,
		hostBound: false,
		mgmtApiFile: 'services/mgmt-api/src/routes/jobs/header-fleet-check.ts',
		contract: 'json',
		why: 'The @wolffm consumer contract across every checkout — 660s because it scans every covered repo.',
	},
	{
		name: 'ci:identity-model',
		sub: 'identity-model',
		args: ['--fleet', '--json'],
		kind: 'gate',
		detectionBudget: '48h',
		cadence: { cron: '0 13 * * *' },
		timeoutS: 120,
		hostBound: false,
		mgmtApiFile: 'services/mgmt-api/src/routes/jobs/identity-model-check.ts',
		contract: 'json',
		why: "The child half of the per-user storage contract. --fleet is not optional: without it the run covers only the hub's own repo, which lint.yml already does.",
	},
	{
		name: 'ci:claw-cleanup',
		sub: 'cleanup',
		args: ['--json', '--confirm'],
		kind: 'converger',
		detectionBudget: '48h',
		cadence: { cron: '0 13 * * *' },
		timeoutS: 600,
		hostBound: false,
		mgmtApiFile: 'services/mgmt-api/src/routes/jobs/claw-cleanup.ts',
		contract: 'json',
		kindDrift:
			"src/cli.ts files `cleanup` as kind: 'mutator'. Plan §3.2 rule 6 names this exact case: \"reconcile --confirm, cleanup --confirm and toolchain --refresh change other domains' state, so they are convergers and move to the registry as such.\" cli.ts is not this lane's to edit (wave 5e lane A); recorded here rather than silently re-kinded.",
		why: 'Reclaims what runner self-update strands. The only JSON_CONTRACT entry that mutates the fleet by default.',
	},
	{
		name: 'ci:runner-var',
		sub: 'check-runner-var',
		args: ['--json'],
		kind: 'gate',
		detectionBudget: '48h',
		cadence: { cron: '0 13 * * *' },
		timeoutS: 300,
		hostBound: false,
		mgmtApiFile: 'services/mgmt-api/src/routes/jobs/runner-var-check.ts',
		contract: 'json',
		why: 'Does every repo that asks for vars.CI_RUNNER actually have it set. Wider than the coverage roster on purpose.',
	},
	{
		name: 'ci:site-token',
		sub: 'check-site-token',
		args: ['--json'],
		kind: 'gate',
		detectionBudget: '48h',
		cadence: { cron: '0 13 * * *' },
		timeoutS: 300,
		hostBound: false,
		mgmtApiFile: 'services/mgmt-api/src/routes/jobs/site-token-check.ts',
		contract: 'json',
		why: 'Is HADOKU_SITE_TOKEN held only by the hub and the declared siteTokenHolders.',
	},
	{
		name: 'ci:egress-slices',
		sub: 'egress-slices',
		args: ['--json'],
		kind: 'gate',
		detectionBudget: '48h',
		cadence: { cron: '0 13 * * *' },
		timeoutS: 120,
		hostBound: true,
		mgmtApiFile: 'services/mgmt-api/src/routes/jobs/egress-slices-check.ts',
		contract: 'json',
		why: "Fleet-manager's half of the cgroup split-tunnel agreement with local-hawk; reads THIS box's own cgroups (hostBound) because the claws carry no VPN to audit.",
	},
	{
		name: 'ci:fleet-inventory',
		sub: 'inventory',
		args: ['--check', '--json'],
		kind: 'gate',
		detectionBudget: '48h',
		cadence: { cron: '0 13 * * *' },
		timeoutS: 120,
		hostBound: false,
		mgmtApiFile: 'services/mgmt-api/src/routes/jobs/fleet-inventory-check.ts',
		contract: 'json',
		why: "Is the hub's generated blast-radius doc still the fleet. Detection only; nothing here writes.",
	},
	{
		name: 'ci:node-users',
		sub: 'node-users',
		args: ['--json'],
		kind: 'gate',
		detectionBudget: '48h',
		cadence: { cron: '0 13 * * *' },
		timeoutS: 120,
		hostBound: false,
		mgmtApiFile: 'services/mgmt-api/src/routes/jobs/node-users-check.ts',
		contract: 'json',
		kindDrift:
			"src/cli.ts files `node-users` as kind: 'operator'. Its consumer fails the run on any class:'blocking' finding and treats `ok:false` as a real failure, not advisory reading — that is a gate's contract, not an operator report's. cli.ts is not this lane's to edit; recorded rather than silently re-kinded.",
		why: 'Who runs CI on each claw (the ci role), read from the node. A node still running CI as admin is advisory (not-cut-over); a drifted cut-over node or an unreachable one fails.',
	},
	{
		name: 'ci:runner-units',
		sub: 'runner-units',
		args: ['--json'],
		kind: 'gate',
		detectionBudget: '48h',
		cadence: { cron: '0 13 * * *' },
		timeoutS: 300,
		hostBound: false,
		mgmtApiFile: 'services/mgmt-api/src/routes/jobs/runner-units-check.ts',
		contract: 'json',
		why: 'Does every standing runner install name a live, on-roster, unarchived repo — reads the box, not GitHub.',
	},
	{
		name: 'ci:fleet-kills',
		sub: 'fleet-kills',
		args: ['--days', '2', '--json'],
		kind: 'gate',
		detectionBudget: '48h',
		cadence: { cron: '0 13 * * *' },
		timeoutS: 60,
		hostBound: false,
		mgmtApiFile: 'services/mgmt-api/src/routes/jobs/fleet-kills-check.ts',
		contract: 'json',
		why: 'Did the FLEET stop a job at a unit TTL, read from job history after the fact. --days 2 (not the daily cadence) is its OWN scan window, chosen because history is immutable and a longer window would hold one kill red for days; 48h still re-reads every record at least once a day.',
	},
	{
		name: 'ci:fleet-preflight',
		sub: 'preflight',
		args: ['--json'],
		kind: 'gate',
		detectionBudget: '48h',
		cadence: { cron: '0 13 * * *' },
		timeoutS: 120,
		hostBound: false,
		mgmtApiFile: 'services/mgmt-api/src/routes/jobs/fleet-preflight-check.ts',
		contract: 'json',
		why: 'The nightly slow-motion sweep: node-key expiry, HADOKU_SITE_TOKEN expiry, runner-version drift, pending reboots. Named "nightly" by its own job; daily cadence is the design, not a shortfall.',
	},
	{
		name: 'ci:health-freshness',
		sub: 'health-freshness',
		args: ['--json'],
		kind: 'gate',
		detectionBudget: '48h',
		cadence: { cron: '0 13 * * *' },
		timeoutS: 60,
		hostBound: false,
		mgmtApiFile: 'services/mgmt-api/src/routes/jobs/health-freshness-check.ts',
		contract: 'json',
		why: "How old the $health record every placement rule reads is allowed to get is this gate's OWN separate threshold (HEALTH_STALE_DAYS = 14d, scripts/check-health-freshness.mjs) — a fact about the RECORD, not about this cron's own run cadence, which is why this entry's detectionBudget is the generic 2x and not 14d.",
	},

	// ---- fleet-benchmark (0 12 * * *, daily; budget 48h = 2x unless noted) ----
	{
		name: 'ci:fleet-benchmark',
		sub: 'benchmark',
		args: ['--due', '30', '--cadence', '--json'],
		kind: 'recorder',
		detectionBudget: '48h',
		cadence: { cron: '0 12 * * *' },
		timeoutS: 1500,
		hostBound: false,
		mgmtApiFile: 'services/mgmt-api/src/routes/jobs/fleet-benchmark-check.ts',
		contract: 'json',
		kindDrift:
			"src/cli.ts files `benchmark` as kind: 'operator'. --cadence (automated since 2026-10-04, #87/#93) measures one claw per run and writes <stateDir>/benchmark.json — plan §3.2 rule 6's definition of a recorder (\"writes ONE declared record\"). cli.ts predates that automation; recorded rather than silently re-kinded.",
		why: "Is the hardware still what the manifest says, one claw measured per run (never a guest, busy node, or someone else's drain). A full rotation across the fleet takes about as many days as there are claws; this entry's budget is about whether THIS cron fired on schedule, not about any one node's rotation slot.",
	},
	{
		name: 'ci:health-refresh',
		sub: 'doctor',
		args: ['--cadence', '--write', '--json'],
		kind: 'recorder',
		detectionBudget: '48h',
		cadence: { cron: '0 12 * * *' },
		timeoutS: 600,
		hostBound: false,
		mgmtApiFile: 'services/mgmt-api/src/routes/jobs/health-refresh.ts',
		contract: 'json',
		why: 'The WRITER of $health, which ci:health-freshness only judges. --cadence defers a busy node (advisory) rather than blocking on it.',
	},
	{
		name: 'ci:slice-inventory',
		sub: 'service-inventory',
		args: ['--slices', '--write', '--json'],
		kind: 'recorder',
		detectionBudget: '48h',
		cadence: { cron: '0 12 * * *' },
		timeoutS: 240,
		hostBound: false,
		mgmtApiFile: 'services/mgmt-api/src/routes/jobs/slice-inventory.ts',
		contract: 'json',
		kindDrift:
			"src/cli.ts files `service-inventory` as kind: 'operator'. --slices --write is the WRITER of the kind:'slice' resident rows in the demand ledger — a recorder by plan §3.2 rule 6, not a read-only report. cli.ts predates its 2026-10-29 scheduling; recorded rather than silently re-kinded.",
		why: "The WRITER of each declared hosting slice's measured working set and CPU, over ssh. Ran only by hand from 2026-10-28 to 2026-10-29; scheduled since.",
	},
	{
		name: 'ci:toolchain-refresh',
		sub: 'converge-toolchain',
		args: ['--refresh', '--json'],
		kind: 'converger',
		detectionBudget: '48h',
		cadence: { cron: '0 12 * * *' },
		timeoutS: 10800,
		deployHold: true,
		hostBound: false,
		mgmtApiFile: 'services/mgmt-api/src/routes/jobs/toolchain-refresh.ts',
		contract: 'json',
		why: "Drain -> wait DRAINED -> update -> re-probe -> undrain, one node at a time. Runs inside fleet-benchmark's declared deploy-hold window (profiles.json names it explicitly beside ci:fleet-benchmark and ci:health-refresh) because it can take up to its full 10800s timeout.",
	},

	// ---- ci:audit-gates (0 13 * * *, daily; prose, 14 inner `fleet` checks) ----
	{
		name: 'ci:audit-gates',
		args: [],
		kind: 'gate',
		detectionBudget: '48h',
		cadence: { cron: '0 13 * * *' },
		timeoutS: 1500,
		hostBound: false,
		mgmtApiFile: 'services/mgmt-api/src/routes/jobs/audit-gates.ts',
		contract: 'prose',
		why: "Runs 14 `fleet <sub>` checks (today's count — see scripts/lib/json-contract.mjs's own warning not to trust a number in prose) through hadoku_site's GATES table and judges each by a regex over stdout+stderr, under FLEET_NO_BANNER=1. Two of the 14 are deliberately given a tighter budget below than this umbrella's own daily cadence can meet — see `coversSubs`.",
		coversSubs: [
			{
				sub: 'tier-fleet',
				args: [],
				detectionBudget: '48h',
				why: 'The child-repo half of the tier model; an incomplete vocabulary fails closed and silently.',
			},
			{
				sub: 'mf-externals',
				args: [],
				detectionBudget: '48h',
				why: 'A micro-frontend that inlines a mapped singleton breaks only in the browser, invisible to typecheck/lint/build/tests.',
			},
			{
				sub: 'throttle',
				args: ['--check'],
				detectionBudget: '48h',
				why: "The runner job-started hook, read-only: is the fleet's only real concurrency limit actually wired.",
			},
			{
				sub: 'slice',
				args: ['--check'],
				detectionBudget: '48h',
				why: 'The memory half of the same idea, read-only: is the cgroup memory ceiling actually applied.',
			},
			{
				sub: 'identity',
				args: [],
				detectionBudget: '48h',
				why: 'A listener that escaped its systemd unit reports ONLINE to GitHub and is never restarted; every other runner check asks GitHub, which cannot see this class.',
			},
			{
				sub: 'warm-canary',
				args: [],
				detectionBudget: '1h',
				why: 'A LIVENESS check — is at least one warm listener actually held on an eligible node — explicitly named in plan §6.1 as a cadence oddity: it runs daily "while queue-health runs every 10 minutes." Budget set to the plan\'s own stated figure ("a liveness check with a one-hour budget") so validateRegistry reports the real gap rather than papering over it with the umbrella\'s daily cadence.',
			},
			{
				sub: 'label-floor',
				args: [],
				detectionBudget: '1h',
				why: 'A LIVENESS check — zero online runners for a required label queues jobs indefinitely rather than failing — named beside warm-canary in plan §6.1 as the same cadence oddity, same reasoning, same 1h figure.',
			},
			{
				sub: 'capabilities',
				args: [],
				detectionBudget: '48h',
				why: 'Capabilities are probed by EXECUTING them, not by trusting a declaration.',
			},
			{
				sub: 'tool-inventory',
				args: [],
				detectionBudget: '48h',
				why: 'A workflow may invoke a tool its assigned machines lack — invisible as anything but flaky CI.',
			},
			{
				sub: 'ci-watch',
				args: ['--check'],
				detectionBudget: '48h',
				why: 'The CI-alert watch list is DERIVED from the fleet roster; read-only check that the derivation is current.',
			},
			{
				sub: 'history-coverage',
				args: [],
				detectionBudget: '48h',
				why: 'Every speed/placement statistic the fleet reports is over job-history.jsonl; this is whether that file is actually recording.',
			},
			{
				sub: 'contract-consumers',
				args: [],
				detectionBudget: '48h',
				why: 'The other half of the --json contract: that every JSON_CONTRACT/PROSE_CONTRACT consumer file actually exists in hadoku_site.',
			},
			{
				sub: 'boundary-contracts',
				args: [],
				detectionBudget: '48h',
				why: "The real shape of every boundary this package's own tests mock (network + ssh), checked from fleet-manager's own install so it resolves the real fleet-exec.",
			},
		],
	},

	// ---- in-process control-loop convergers (this package's own clock, running inside mgmt-api's process) ----
	{
		name: 'fleet:converge-provisioning',
		sub: 'converge-provisioning',
		args: ['--json'],
		kind: 'converger',
		detectionBudget: '60m',
		cadence: { clockMs: 30 * 60_000 },
		timeoutS: 1200,
		contract: 'in-process',
		pager: { repageMs: 24 * 60 * 60_000, deferPageMs: 6 * 60 * 60_000 },
		why: 'Standing-runner throttle/slice/apt-security drift, repaired unattended (fleet-manager#1). src/provisioning-converge.ts owns the clock; it spawns scripts/converge-provisioning.mjs, which in turn drives apt-security.mjs/throttle.mjs/slice.mjs directly by script path — those three are NOT independently scheduled (see MANUAL).',
	},
	{
		name: 'fleet:hosting-converge',
		sub: 'hosting-converge',
		args: ['--json'],
		kind: 'converger',
		detectionBudget: '10m',
		cadence: { clockMs: 5 * 60_000 },
		timeoutS: 1200,
		contract: 'in-process',
		pager: { repageMs: 24 * 60 * 60_000, deferPageMs: 60 * 60_000 },
		why: 'Declares and ends hosting slices to meet demand for placement.auto tenants (fleet-manager#16). src/hosting-converge.ts owns the clock.',
	},
	{
		name: 'fleet:reboot-claws',
		sub: 'reboot-claws',
		args: [],
		kind: 'converger',
		detectionBudget: '120m',
		cadence: { clockMs: 60 * 60_000 },
		timeoutS: 6000,
		contract: 'in-process',
		pager: { repageMs: 24 * 60 * 60_000, deferPageMs: 6 * 60 * 60_000 },
		why: 'Drain, wait idle, reboot, verify kernel + runners, undrain — one claw per pass. src/claw-reboot.ts owns the clock and spawns scripts/reboot-claws.mjs, the same script `fleet reboot-claws` runs by hand.',
	},
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
 * Returns every issue found rather than throwing on the first one — the
 * known, named cadence-budget gap (`warm-canary`/`label-floor`) is an
 * EXPECTED finding, not a bug in this function, and the caller decides what
 * to do with `ok: false`.
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
		}
	}

	return { ok: issues.length === 0, issues };
}
