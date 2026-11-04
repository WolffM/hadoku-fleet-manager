/**
 * THE PUBLIC SURFACE, PINNED. Every name `src/index.ts` exports — values and
 * types — read off the compiled `dist/index.d.ts` by the TypeScript checker,
 * against the list below.
 *
 * Why it exists: on 2026-11-02 a dead-export sweep removed `ClawState` and
 * `BackstopReason` from `fleet-report-types.ts`. Nothing in this repo imported
 * them from there, but `index.ts` re-exports that barrel with `export type *`,
 * and hadoku_site's command-station panel imports both from the package. Every
 * gate here stayed green; the site's type-aware lint found it, on 0.34.324.
 *
 * Changing the list is a CROSS-REPO change, same as renaming a `--json`
 * subcommand: removing a name needs every consumer checked first
 * (hadoku_site/services/mgmt-api and the site's panel; see
 * docs/planning/fleet-manager-extraction-2026-08-29.md §3). Adding one needs §3
 * read first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const DIST = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

const PUBLIC_SURFACE = [
	'AdmissionBasis',
	'AdmissionCaveat',
	'AdmissionClause',
	'AdmissionRefusal',
	'BackstopDecision',
	'BackstopForced',
	'BackstopInput',
	'BackstopReason',
	'BackstopState',
	'CapabilityKind',
	'CapabilitySurface',
	'CapabilityVerification',
	'CapacityKind',
	'CapacitySlice',
	'ClawState',
	'ConvergeDoc',
	'ConvergeRow',
	'FailureZoneTerm',
	'FleetCapacity',
	'FleetDailyJobStats',
	'FleetDispatch',
	'FleetDispatchAffinity',
	'FleetFailuresByZone',
	'FleetGithubBudget',
	'FleetHost',
	'FleetHostLogger',
	'FleetJobRecord',
	'FleetLiveness',
	'FleetMachine',
	'FleetMachineCapabilities',
	'FleetMachineJobStats',
	'FleetMachineLedger',
	'FleetMachineMeasured',
	'FleetManager',
	'FleetRepoJobStats',
	'FleetReport',
	'FleetReservation',
	'FleetVocabulary',
	'FleetWorkloadGate',
	'FleetWorkloadProof',
	'ForceRecord',
	'ForceState',
	'GateDoc',
	'GhCaller',
	'GhPoolReading',
	'JOB_REGISTRY',
	'JobPhase',
	'LabelledTerm',
	'LoopLiveness',
	'Reservation',
	'RunnerHealthSnapshot',
	'SaturationHostVerdict',
	'TelemetryKind',
	'TelemetryTerm',
	'TenantBackstop',
	'TenantUsable',
	'UsableNodeRow',
	'UsableSlice',
	'UsableVerdict',
	'__resetFleetManagerForTesting',
	'cadencePeriodMs',
	'createFleetManager',
	'getFleetLiveness',
	'judgeTenantBackstop',
	'meterGhPool',
	'noteCronEnd',
	'noteCronStart',
	'parseDurationMs',
	'tenantUsableOn',
];

test('the package exports exactly the pinned public surface', () => {
	const entry = resolve(DIST, 'index.d.ts');
	const program = ts.createProgram({
		rootNames: [entry],
		options: {
			noEmit: true,
			skipLibCheck: true,
			module: ts.ModuleKind.NodeNext,
			moduleResolution: ts.ModuleResolutionKind.NodeNext,
		},
	});
	const checker = program.getTypeChecker();
	const source = program.getSourceFile(entry);
	assert.ok(source, `no ${entry} — build first`);
	const moduleSymbol = checker.getSymbolAtLocation(source);
	assert.ok(moduleSymbol, 'dist/index.d.ts has no module symbol');
	const actual = checker
		.getExportsOfModule(moduleSymbol)
		.map((s) => s.getName())
		.sort();
	const expected = [...PUBLIC_SURFACE].sort();
	const missing = expected.filter((n) => !actual.includes(n));
	const added = actual.filter((n) => !expected.includes(n));
	assert.deepEqual(
		{ missing, added },
		{ missing: [], added: [] },
		'the public surface changed: check every consumer before editing PUBLIC_SURFACE'
	);
});
