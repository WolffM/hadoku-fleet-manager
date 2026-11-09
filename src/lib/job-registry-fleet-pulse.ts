import type { JobEntry } from './job-registry-types.js';

export const jobRegistryFleetPulse: JobEntry[] = [
	// ---- fleet-pulse ( */10 * * * *, 10-minute cadence; budget 20m = 2x) ----
	{
		name: 'ci:fleet-placement',
		sub: 'hosting-placement',
		args: ['--json'],
		kind: 'gate',
		detectionBudget: '20m',
		cadence: { cron: '*/10 * * * *' },
		timeoutS: 120,
		hostBound: true,
		mgmtApiFile: 'services/mgmt-api/src/routes/jobs/fleet-placement-check.ts',
		contract: 'json',
		why: 'Does every `"placement": "fleet"` row in the app layer match where the fleet placed it — node, epoch, a guaranteed slice, the port (site#491 part 2). Read per tenant (`hosting-placement <tenant> --json`), live; hostBound because the placement record lives on the controller. `moving` is reported, not red.',
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
];
