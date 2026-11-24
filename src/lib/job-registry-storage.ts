import type { JobEntry } from './job-registry-types.js';

export const jobRegistryStorage: JobEntry[] = [
	// ---- storage-pool (40 * * * *, hourly; budget 2h = 2x) ----
	{
		name: 'ci:storage-pool',
		sub: 'storage-pool',
		args: ['--json'],
		kind: 'gate',
		detectionBudget: '2h',
		cadence: { cron: '40 * * * *' },
		timeoutS: 600,
		hostBound: true,
		mgmtApiFile: 'services/mgmt-api/src/routes/jobs/storage-pool.ts',
		contract: 'json',
		why: "The storage pool's page (fleet-manager#142, bootcamp F7): a block on fewer than 3 copies for over 24 h, or a disk over 85%, fails it; N+1 broken or a disk over 75% is a warning in the document, and N+1 with exactly 3 zones (the pilot) is a known state. Numbers are F3's (doctor-findings-pool.mjs). Read live over ssh through the first member's Garage admin API: readCluster makes 7 admin calls of up to 30 s each, so three dead members are the 600 s worst case; a healthy first member answers in seconds. hostBound because the 24 h clock (`storage-pool.json`, underReplicatedSince) lives in this controller's state dir. No node offers storage: 'no pool', exit 0. Hourly so the 24 h line is crossed within the hour it is.",
	},
];
