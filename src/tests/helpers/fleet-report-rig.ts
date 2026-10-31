/**
 * Shared fixture for fleet-report.test.ts's split: the empty job-history
 * summary, a minimal runner-health snapshot builder, the two manifests used
 * across most sections, the probe builder, the capacity-row reader, and the
 * admission-verdict reset every file needs.
 *
 * node:test scopes beforeEach PER FILE (confirmed empirically: a hook
 * registered anywhere at a file's top level applies to every test in that
 * file, including ones declared textually ABOVE it) — the original file's
 * single `beforeEach(() => __resetAdmissionVerdictsForTesting())` therefore
 * ran before all 70 of its tests, not only the admissionRefusal ones below
 * it. Every file split out of fleet-report.test.ts calls
 * `installFleetReportRig()` once at its own top level, before any `test()`
 * calls, exactly where that single inline `beforeEach` used to sit — the
 * same shape as `src/tests/helpers/runner-health-rig.ts`.
 */
import { beforeEach } from 'node:test';

import type { RunnerHealthSnapshot } from '../../runner-health.js';
import type { CapacityKind, FleetReport } from '../../fleet-report-types.js';
import type { NodeProbe } from '../../lib/node-probe.js';
import type { JobHistorySummary } from '../../job-history-stats.js';
import { __resetAdmissionVerdictsForTesting } from '../../runners/ephemeral-tick.js';

/**
 * An EMPTY job history, passed explicitly.
 *
 * buildFleetReport's fourth parameter defaults to `summarise(...)`, which reads
 * the real ~/.hadoku-mgmt/job-history.jsonl. Every call below left it defaulted,
 * so these tests' results moved with whatever the live fleet had been doing —
 * the same class of problem as the tickFleet suite SSHing the garage. The other
 * three snapshots were already injectable; this one was missed.
 */
export const NO_JOBS: JobHistorySummary = {
	since: null,
	total: 0,
	byMachine: [],
	byRepo: [],
	daily: [],
	backstopJobs: 0,
	backstopShare: 0,
	recent: [],
	recentSince: '2026-09-09T00:00:00.000Z',
	recentWindowSec: 3600,
};

/** A minimal runner-health snapshot — the three required fields plus overrides. */
export const health = (m: Partial<RunnerHealthSnapshot> = {}): RunnerHealthSnapshot => ({
	at: 'now',
	runnersChecked: true,
	runsChecked: true,
	floorBreach: false,
	...m,
});

export const MANIFEST = {
	'claw-1': { cores: 8, ramGb: 11, maxRegistrations: 32, maxConcurrent: 4, labels: [] },
	hokon: {
		cores: 12,
		ramGb: 61,
		maxRegistrations: 32,
		maxConcurrent: 4,
		labels: ['pm2-host', 'taskauto'],
		excludeRepos: { 'WolffM/x': 'why' },
	},
};

export const upProbe = (m: Partial<NodeProbe> = {}): NodeProbe => ({
	workers: 1,
	cores: 8,
	capacity: 4,
	free: 3,
	sick: false,
	reachable: true,
	busyRepos: null,
	...m,
});

export const EPHEMERAL_MANIFEST = {
	'claw-3': { cores: 4, maxConcurrent: 3, labels: ['hadoku-builder'], ephemeral: true },
	hokon: { cores: 12, maxConcurrent: 4, labels: ['pm2-host'] },
};

/**
 * Read one capacity row out of the breakdown.
 *
 * The tests below asserted on `slot(r, 'mintable')` and friends until the
 * rollup became `byKind` rows. Kept as a helper rather than inlined so the
 * assertions still read as one line each — and so a row that stops being
 * emitted fails as `undefined` here rather than as a silent `?? 0` somewhere.
 */
export function slot(r: Pick<FleetReport, 'fleet'>, kind: CapacityKind): number | null | undefined {
	return r.fleet.capacity.byKind.find((k) => k.kind === kind)?.free;
}

export function installFleetReportRig(): void {
	beforeEach(() => {
		__resetAdmissionVerdictsForTesting();
	});
}
