/**
 * The WIRE CONTRACT with hadoku_site: the command station cannot import this
 * package (express in a browser bundle), so every key `FleetView.tsx` and
 * `FleetCharts.tsx` read is pinned here by NAME, including the job-phase
 * vocabulary — a renamed/removed field would pass every value-level test in
 * the other split files and silently blank or mis-chart a panel in another
 * repository. THE LIST IS THE DECLARATION: written out rather than derived,
 * because a count or a type check would agree with itself after a rename.
 * If you rename one of these, fix FleetView.tsx/FleetCharts.tsx in the SAME
 * pass. Split out of fleet-report.test.ts (wave 5o lane B) — see
 * `src/tests/helpers/fleet-report-rig.ts` for the shared `NO_JOBS`/`MANIFEST`
 * fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFleetReport } from '../routes/fleet-report.js';
import type { JobRecord } from '../job-history-store.js';
import type { RecentJobRecord } from '../job-history-stats.js';
import { __resetAdmissionVerdictsForTesting } from '../runners/ephemeral-tick.js';
import { __setAdmissionVerdictsForTesting } from '../admission-verdict-store.js';
import {
	NO_JOBS,
	upProbe,
	MANIFEST,
	EPHEMERAL_MANIFEST,
	installFleetReportRig,
} from './helpers/fleet-report-rig.js';

installFleetReportRig();

// Read from hadoku_site/src/components/ContactAdmin/System/FleetView.tsx and
// FleetCharts.tsx on 2026-09-02, after the panel stopped holding its own copy
// of the fleet's vocabulary and started reading `vocabulary` and `dispatch`.

const WIRE_TOP = [
	'probedAt',
	'healthAt',
	'machines',
	'fleet',
	'jobs',
	'reservation',
	// The panel's "Minting, last pass" section. It was in the contract and
	// rendered NOWHERE, which is what let a 409 name collision run at ~7% of
	// mints for the pilot's whole life — the very failure FleetDispatch's own
	// doc-comment was written about.
	'dispatch',
	// The fleet's words. Renaming this blanks a pill's colour, a legend, a
	// ladder and a threshold at once, and none of it would throw.
	'vocabulary',
];
const WIRE_MACHINE = [
	'name',
	'cores',
	'ramGb',
	'labels',
	'maxRegistrations',
	'maxConcurrent',
	'excludedRepos',
	'reachable',
	'workers',
	'capacity',
	'free',
	'liveLabels',
	'state',
	// The budget that actually admits work here — see FleetMachine.
	'admissionCapacity',
	'admissionFree',
	'admissionBasis',
	// Decides whether four legitimately-null columns read as "healthy JIT node"
	// or as "GitHub stopped listing this box". They are identical without it.
	'ephemeral',
	// `admissionRefusal` is DELIBERATELY NOT HERE. Wave 4a (#100): it is the
	// field that actually answers "can this node take a job right now" —
	// `admissionFree` above counts slots and never applies the memory clause
	// — but it is OPTIONAL on the wire (absent means "could not look", never
	// "admitted"; see its own doc comment), so this flat "every machine has
	// every key" sweep cannot guard it without producing a false failure on a
	// node this process has no verdict for. The dedicated check right after
	// this loop guards it instead — do not move it back here.
	//
	// `runner-health.ts`'s starvation finding, keyed onto the machine it is
	// about rather than left in a separate per-node map the panel has to join.
	'starved',
	// The OS as running, from the probe; `measured` is enrollment-time only.
	'os',
];

/**
 * The vocabulary block, which is the panel's ONLY source for these words.
 *
 * Losing one does not throw — it renders an undefined tone, an empty ladder, or
 * a legend that says "backstop" where a machine name belongs. Silent, on the
 * page opened when something is already wrong.
 */
const WIRE_VOCAB = [
	// The panel's last local copy of fleet semantics — see JobPhase.
	'jobPhases',
	'builderLabel',
	'pm2HostLabel',
	'implicitLabels',
	'ladder',
	'backstopNode',
	'labels',
	'queuedWarnMinutes',
	'censusRepo',
	// The report's own enums, described here rather than in the panel. See
	// telemetry-vocabulary.ts for why these are a wire field and not an import.
	'states',
	'backstopReasons',
	'admissionBases',
	'admissionCaveats',
	// Wave 4a (#100): what `FleetMachine.admissionRefusal.clause` means.
	'admissionClauses',
];

/** The JIT dispatch block behind "Minting, last pass". */
const WIRE_DISPATCH = [
	'at',
	'minted',
	'failed',
	'inFlight',
	'reaped',
	'error',
	'failingSince',
	'totals',
	'lastMintAt',
	'recent',
	'queue',
];
const WIRE_FLEET = [
	'clawsOnline',
	// ONE object where five scalars were. `clawsReady`, `clawsFree`,
	// `clawsFreeStanding`, `clawsFreeMintable` and `clawsPromotable` left the
	// contract on 2026-09-03: three of those names encoded a mechanism being
	// replaced, so growing a fourth kind of capacity was a cross-repo rename.
	'capacity',
	'queuedNow',
	'oldestQueuedMin',
	'runningNow',
	'longestRunningMin',
	'queuedStale',
	'hung',
	'failoverReruns',
	'oomReruns',
	'backstopReason',
];
const WIRE_JOBS = [
	'since',
	'total',
	'byMachine',
	'backstopJobs',
	'backstopShare',
	'recent',
	// The bounds of the trailing window `byMachine[].recent*` is cut over. Losing
	// either leaves the panel captioning an hour it has to assume — and the whole
	// reason the aggregate is cut server-side is that a consumer guessing its own
	// window is what issue #18 was about.
	'recentSince',
	'recentWindowSec',
];
/** The capacity block's own shape — a nested object hides its keys from the flat check. */
const WIRE_CAPACITY = ['ready', 'free', 'byKind', 'unmeasured'];
const WIRE_CAPACITY_SLICE = ['kind', 'free', 'caveats', 'available'];

test('wire contract: every key FleetView.tsx reads is still emitted', () => {
	const r = buildFleetReport(null, null, MANIFEST, NO_JOBS);
	const missing: string[] = [];
	for (const k of WIRE_TOP) if (!(k in r)) missing.push(k);
	for (const k of WIRE_MACHINE) if (!(k in (r.machines[0] ?? {}))) missing.push(`machines[].${k}`);
	// `admissionRefusal` is OPTIONAL (wave 4a, #100: absent means "could not
	// look", never "admitted" — see its own doc comment) so the flat sweep
	// above cannot guard it without a false failure on a node this process has
	// no verdict for. Guarded here instead, against a report where a verdict
	// DOES exist, so the field disappearing from the codebase entirely still
	// fails this test loudly.
	__setAdmissionVerdictsForTesting(new Map([['claw-3', { ok: true }]]));
	const withVerdict = buildFleetReport(
		null,
		{ at: 'now', nodes: { 'claw-3': upProbe() } },
		EPHEMERAL_MANIFEST,
		NO_JOBS
	);
	__resetAdmissionVerdictsForTesting();
	if (!('admissionRefusal' in (withVerdict.machines.find((m) => m.name === 'claw-3') ?? {}))) {
		missing.push('machines[].admissionRefusal (present whenever ephemeral-tick has a verdict)');
	}
	for (const k of WIRE_FLEET) if (!(k in r.fleet)) missing.push(`fleet.${k}`);
	// Nested, so the flat sweep above cannot see inside it. Every row is checked
	// too: `byKind` being present and EMPTY would pass a shape check and render
	// as a fleet with no capacity of any kind.
	for (const k of WIRE_CAPACITY) if (!(k in r.fleet.capacity)) missing.push(`capacity.${k}`);
	if (!r.fleet.capacity.byKind.length) missing.push('capacity.byKind is empty');
	for (const row of r.fleet.capacity.byKind) {
		for (const k of WIRE_CAPACITY_SLICE) {
			if (!(k in row)) missing.push(`capacity.byKind[${row.kind}].${k}`);
		}
	}
	for (const k of WIRE_JOBS) if (!(k in r.jobs)) missing.push(`jobs.${k}`);
	for (const k of WIRE_VOCAB) if (!(k in r.vocabulary)) missing.push(`vocabulary.${k}`);
	for (const k of WIRE_DISPATCH) if (!(k in r.dispatch)) missing.push(`dispatch.${k}`);
	assert.deepEqual(
		missing,
		[],
		`removed/renamed wire key(s). Fix hadoku_site FleetView.tsx in the same pass:\n  ${missing.join('\n  ')}`
	);
});

/**
 * The nested rows FleetCharts.tsx draws. `jobs.recent` and `jobs.byMachine` were
 * pinned as KEYS, but their element shape — which is what the three charts
 * actually index into — was not, so renaming `durationSec` passed here and drew
 * an empty timeline there. Verified by mutation: a rename across the type, the
 * producer and this fixture still fails on the literals below.
 */
const WIRE_JOB_STAT = [
	'machine',
	'jobs',
	'failures',
	'medianSec',
	'p95Sec',
	// The trailing-hour figures the panel compares a recent job against. Renaming
	// one of these does not throw over there — it draws a comparison against
	// undefined, which is the exact shape of the gap issue #18 filed.
	'recentJobs',
	'recentMedianSec',
	'recentP95Sec',
	// `failures` split by whose half of the fence it fell on — §5.5's zones plus
	// the fleet's own TTL kills. Additive (0.22.130); a consumer that does not
	// read it is unaffected, and one that does cannot re-derive it, because
	// folding a step name into a zone needs a pattern table this package does
	// not publish to a browser bundle.
	'failuresByZone',
];
const WIRE_JOB_RECORD = [
	'repo',
	// The forge ids the panel links a row to. On the wire long before they were
	// declared; see FleetJobRecord.
	'runId',
	'jobId',
	'name',
	'runner',
	// The node that served it. `runner` is a per-job mint name on a JIT node and
	// cannot be folded downstream — see FleetJobRecord.machine. Without this key
	// the 40 rows of `recent` cannot be related to the rows of `byMachine` at all.
	'machine',
	'labels',
	'startedAt',
	'durationSec',
	'conclusion',
];

test('wire contract: the ROW shapes the charts index into are pinned too', () => {
	const record: RecentJobRecord = {
		runId: 1,
		jobId: 2,
		repo: 'WolffM/x',
		name: 'build',
		runner: 'claw-1',
		machine: 'claw-1',
		labels: ['hadoku-builder'],
		startedAt: '2026-09-02T00:00:00Z',
		durationSec: 30,
		conclusion: 'success',
	};
	const r = buildFleetReport(null, null, MANIFEST, {
		...NO_JOBS,
		total: 1,
		since: record.startedAt,
		byMachine: [
			{
				machine: 'claw-1',
				jobs: 1,
				failures: 0,
				failuresByZone: { runner: 0, seam: 0, content: 0, fleet: 0, cancelled: 0 },
				medianSec: 30,
				p95Sec: 30,
				repos: 1,
				recentJobs: 0,
				recentMedianSec: null,
				recentP95Sec: null,
			},
		],
		recent: [record],
	});
	const missing: string[] = [];
	for (const k of WIRE_JOB_STAT) if (!(k in r.jobs.byMachine[0])) missing.push(`byMachine[].${k}`);
	for (const k of WIRE_JOB_RECORD) if (!(k in r.jobs.recent[0])) missing.push(`recent[].${k}`);
	assert.deepEqual(missing, [], `removed/renamed wire key(s). Fix hadoku_site FleetCharts.tsx too`);
});

test('wire contract: the report has machines to check, so the guard is not vacuous', () => {
	// Every assertion above is `deepEqual([], [])` if machines is empty, which
	// would make the guard pass while checking nothing.
	const r = buildFleetReport(null, null, MANIFEST, NO_JOBS);
	assert.ok(r.machines.length > 0, 'the fixture manifest must yield at least one machine');
});

test('wire contract: `state` may be null but the KEY must always be present', () => {
	// The 2026-09-02 fix made clawState omit unknown nodes, and the route turns a
	// missing entry into `state: null`. FleetView renders null as "unpolled" — but
	// only if the key exists to be read.
	const r = buildFleetReport(null, null, MANIFEST, NO_JOBS);
	const m = r.machines[0]!;
	assert.ok('state' in m, 'the key is the contract; null is a legitimate value for it');
	assert.equal(m.state, null, 'and with no health snapshot it is null, never invented');
});

// ── job phases travel with the numbers ──────────────────────────────────────
//
// The panel carried its own table of four phases — id, label and meaning — and
// when queueSec gained a dispatch/assign split it did not fail to compile. It
// kept drawing one `queued` block over two numbers that name different people
// to go and fix.

test('vocabulary.jobPhases is ordered and every field is a real record field', () => {
	const r = buildFleetReport(null, null, MANIFEST, NO_JOBS);
	const ids = r.vocabulary.jobPhases.map((p) => p.id);
	assert.deepEqual(ids, ['queue', 'setup', 'run', 'cleanup'], 'order is the fleet’s to state');
	// A phase naming a field the record does not carry renders an empty segment
	// forever, silently — the exact failure mode of a hand-kept table.
	const record: JobRecord = {
		runId: 1,
		jobId: 2,
		repo: 'WolffM/x',
		name: 'build',
		runner: 'claw-1',
		labels: [],
		startedAt: '2026-09-04T00:00:00Z',
		durationSec: 30,
		queueSec: 10,
		dispatchSec: 8,
		assignSec: 2,
		setupSec: 3,
		runSec: 25,
		cleanupSec: 2,
		conclusion: 'success',
	};
	const flat = r.vocabulary.jobPhases.flatMap((p) => [p, ...(p.detail ?? [])]);
	for (const p of flat) {
		assert.ok(p.field in record, `${p.id} names ${p.field}, which is not on FleetJobRecord`);
		assert.ok(p.description.length > 10, `${p.id} has no usable description`);
	}
});

test('queue declares its split as DETAIL, and the halves sum to it', () => {
	// A renderer draws detail INSTEAD of the parent, so if these did not sum the
	// bar would change length depending on which records happened to carry the
	// split.
	const r = buildFleetReport(null, null, MANIFEST, NO_JOBS);
	const queue = r.vocabulary.jobPhases.find((p) => p.id === 'queue')!;
	assert.deepEqual(
		queue.detail?.map((d) => d.id),
		['dispatch', 'assign']
	);
	assert.deepEqual(
		queue.detail?.map((d) => d.field),
		['dispatchSec', 'assignSec']
	);
	// The one thing a reader must be able to tell apart: which half is ours.
	assert.match(queue.detail![0].description, /OURS/);
	assert.match(queue.detail![1].description, /GITHUB/);
});

test('the split reaches the WIRE, not just the store', () => {
	// It was derived and stored on 2026-09-03 and typed on 2026-09-04. In between
	// `jobs.recent` passed whole JobRecords through, so the values were on the
	// wire while the contract declared nothing — unreadable by a typed consumer
	// and unpinnable by the guard below.
	const record: RecentJobRecord = {
		runId: 1,
		jobId: 2,
		repo: 'WolffM/x',
		name: 'build',
		runner: 'jit-claw-1-x',
		machine: 'claw-1',
		labels: [],
		startedAt: '2026-09-04T00:00:00Z',
		durationSec: 30,
		queueSec: 10,
		dispatchSec: 8,
		assignSec: 2,
		conclusion: 'success',
	};
	const r = buildFleetReport(null, null, MANIFEST, {
		...NO_JOBS,
		total: 1,
		since: record.startedAt,
		recent: [record],
	});
	const out = r.jobs.recent[0];
	assert.equal(out.dispatchSec, 8);
	assert.equal(out.assignSec, 2);
	assert.equal(out.dispatchSec! + out.assignSec!, out.queueSec, 'the halves sum to the total');
});
