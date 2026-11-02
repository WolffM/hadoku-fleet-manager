/**
 * The job-registry report shapes (wave 5r lane A pure move out of
 * `fleet-report-types.ts`). See that file's own header for why this is a
 * type-only barrel's section rather than a runtime module —
 * `fleet-report-types.ts` re-exports every name below for every existing
 * importer.
 */

/**
 * THE JOB-REGISTRY REPORT SHAPES (refactor plan §6.2: "report shapes:
 * ConvergeDoc (exists), GateDoc, RecordDoc" — `RecordDoc` itself had no
 * importer and was dropped, wave cruft-1 lane A), presented together because
 * `src/lib/job-runner.ts` classifies a job's tick by reading one of these,
 * never the other way around — a reader must not read its own writer's
 * artifact, but every artifact here is read by the ONE runner, so their
 * shapes belong next to each other for every importer of this barrel.
 *
 * `ConvergeDoc`/`ConvergeRow` moved back to `src/scheduled-converger.ts`
 * (wave clean-1 lane C, cut (iii)): that automation-layer module is their
 * real owner (`createConverger` is what produces one), and this file
 * (surfaces) importing them from there, rather than the other way round, is
 * the legal direction. Re-exported here under their original path for every
 * existing importer of `fleet-report-types(-registry).ts`.
 */
export type { ConvergeDoc, ConvergeRow } from './scheduled-converger.js';

/**
 * A gate's `--json`: it never mutates, and reports what it found rather than
 * what it changed. `unreadable` is never collapsed into `ok: true` — "could
 * not look" is its own entry, not a pass (AGENTS.md).
 */
export interface GateDoc {
	ok: boolean;
	findings: { node: string | null; kind: string; reason: string }[];
	unreadable: { node: string | null; why: string }[];
	why?: string;
}
