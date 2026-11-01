import type { JobEntry } from './job-registry-types.js';

export const jobRegistryLiveness: JobEntry[] = [
	// ---- fleet-liveness (*/30 * * * *, 30-minute cadence; budget 1h = 2x) ----
	// Liveness checks that rode ci:audit-gates' daily cron until fleet-manager#38:
	// check-schedule judged their 1h budget against that umbrella cron and
	// reported CRON-CANNOT-MEET-BUDGET every day, and meeting it from hadoku_site
	// meant running every audit gate hourly. Every 30 minutes, not hourly: the
	// staleness watcher (hadoku_site schedule-staleness.ts) judges the last run
	// against `detectionBudget`, so a 1h budget on a 1h cron would flap on every
	// slow run.
	{
		name: 'ci:warm-canary',
		sub: 'warm-canary',
		args: ['--json'],
		kind: 'gate',
		detectionBudget: '1h',
		cadence: { cron: '*/30 * * * *' },
		timeoutS: 180,
		// ssh to the CANDIDATE nodes, never this box's own state — the same
		// class as every other ssh-based fleet gate (node-users, runner-units),
		// not reap-trend/egress-slices/srv-drift's own log/cgroup/deploy-clone.
		hostBound: false,
		mgmtApiFile: 'services/mgmt-api/src/routes/jobs/warm-canary-check.ts',
		contract: 'json',
		why: 'A LIVENESS check — is every eligible node actually holding a warm listener — named in plan §6.1 as a cadence oddity while it ran daily "while queue-health runs every 10 minutes"; the plan\'s own figure is "a liveness check with a one-hour budget". No GitHub call: ssh plus systemd on each candidate node.',
	},
	{
		name: 'ci:label-floor',
		sub: 'label-floor',
		args: ['--json'],
		kind: 'gate',
		detectionBudget: '1h',
		cadence: { cron: '*/30 * * * *' },
		timeoutS: 120,
		// Reads job-history.jsonl AND demand-ledger.jsonl under
		// HADOKU_STATE_DIR — THIS process's own recorded ingest, same class and
		// same file as history-coverage (docs/control-plane.md §2: a different
		// answer on a passive replica than on the active controller).
		hostBound: true,
		mgmtApiFile: 'services/mgmt-api/src/routes/jobs/label-floor-check.ts',
		contract: 'json',
		why: 'A LIVENESS check — zero online runners for a required label queues jobs indefinitely rather than failing (one repo sat 854 minutes) — named beside warm-canary in plan §6.1, same 1h figure. Workflows come through fleet-source (git, not the REST budget); one runner listing per run.',
	},
];
