/**
 * The wire vocabulary assembly for `routes/fleet.ts` — a pure move out of
 * that file (wave 5r lane A), split off because the module crossed the
 * 800-line source ceiling. `JOB_PHASES` and `buildVocabulary` are the two
 * pieces that turn the capability registry and the manifest into
 * `FleetVocabulary` for the wire; see that type's own doc for why the
 * values travel with the report at all.
 */
import { QUEUED_WARN_MINUTES, SELF_REPO } from '../runner-health.js';
import {
	BACKSTOP_LABEL,
	BUILDER_LABEL,
	CAPABILITIES,
	PM2_HOST_LABEL,
} from '../lib/capability-registry.js';
import { IMPLICIT_LABELS, labelCapabilities, ladder } from '../lib/capability-labels.js';
import { BOOTCAMP_STALE_DAYS, workloadGatedCapabilities } from '../lib/workload-gate.js';
import {
	ADMISSION_BASES,
	ADMISSION_CAVEATS,
	ADMISSION_CLAUSES,
	BACKSTOP_REASONS,
	CAPABILITY_SURFACES,
	CAPABILITY_VERIFICATIONS,
	CAPACITY_KINDS,
	GH_CALLERS,
	CLAW_STATES,
	FAILURE_ZONES,
} from '../telemetry-vocabulary.js';
import type { FleetVocabulary, JobPhase } from '../fleet-report-types.js';
import { backstopNodeOf, type ManifestNode } from './fleet-manifest.js';

/**
 * The segments of a job's wall time, in order, with the fleet's own words.
 *
 * DECLARED HERE, not in the panel, for the same reason `capacityKinds` is: the
 * panel's own copy of this table did not fail to compile when `queueSec` gained
 * a dispatch/assign split, it just kept drawing one `queued` block over two
 * numbers that name different people to go and fix.
 *
 * `queue` keeps its own entry AND its detail: `jobs.recent` is a rolling window
 * and records ingested before the split carry only the total, so both shapes are
 * live at once for as long as the window takes to turn over.
 */
const JOB_PHASES: JobPhase[] = [
	{
		id: 'queue',
		field: 'queueSec',
		description: 'waiting for a runner — job created until the job started',
		detail: [
			{
				id: 'dispatch',
				field: 'dispatchSec',
				description:
					'OURS: job created until this fleet minted a runner. The median wait is this half, ' +
					'so it is the half worth tuning.',
			},
			{
				id: 'assign',
				field: 'assignSec',
				description:
					"GITHUB'S: the runner was up and idle, waiting to be handed its job. Nothing in " +
					'this fleet can shorten it.',
			},
		],
	},
	{
		id: 'setup',
		field: 'setupSec',
		description:
			'the runner coming up, plus "Set up job". On a JIT node this contains the mint itself.',
	},
	{ id: 'run', field: 'runSec', description: "the job's own steps" },
	{ id: 'cleanup', field: 'cleanupSec', description: '`Post *` teardown and "Complete job"' },
];

/**
 * The fleet's vocabulary, assembled for the wire. See `FleetVocabulary` for why
 * words travel with the numbers.
 *
 * Every field is DERIVED — from the capability registry, from the manifest, or
 * from the constant the counting itself uses. Nothing here is a second copy
 * that could disagree with the first.
 */
export function buildVocabulary(nodes: Record<string, ManifestNode>): FleetVocabulary {
	return {
		builderLabel: BUILDER_LABEL,
		pm2HostLabel: PM2_HOST_LABEL,
		backstopLabel: BACKSTOP_LABEL,
		implicitLabels: [...IMPLICIT_LABELS],
		ladder: ladder(),
		backstopNode: backstopNodeOf(nodes),
		labels: Object.fromEntries(
			labelCapabilities().map((c) => [c.id, { kind: c.kind, description: c.description }])
		),
		capabilities: (() => {
			const gated = new Set(workloadGatedCapabilities());
			return Object.fromEntries(
				CAPABILITIES.map((c) => [
					c.id,
					{
						kind: c.kind,
						surface: c.surface,
						verify: c.verify,
						label: c.label,
						description: c.description,
						workloadGated: gated.has(c.id),
					},
				])
			);
		})(),
		bootcampStaleDays: BOOTCAMP_STALE_DAYS,
		capabilitySurfaces: CAPABILITY_SURFACES,
		capabilityVerifications: CAPABILITY_VERIFICATIONS,
		failureZones: FAILURE_ZONES,
		queuedWarnMinutes: QUEUED_WARN_MINUTES,
		censusRepo: SELF_REPO,
		// The report's own enums, described where they are emitted. Quoted, never
		// re-authored: a consumer that writes its own sentence for a state is
		// holding an opinion this package is supposed to own.
		states: CLAW_STATES,
		backstopReasons: BACKSTOP_REASONS,
		admissionBases: ADMISSION_BASES,
		admissionCaveats: ADMISSION_CAVEATS,
		admissionClauses: ADMISSION_CLAUSES,
		jobPhases: JOB_PHASES,
		capacityKinds: CAPACITY_KINDS,
		ghCallers: GH_CALLERS,
	};
}
