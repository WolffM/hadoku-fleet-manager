/**
 * The job-registry report shapes (wave 5r lane A pure move out of
 * `fleet-report-types.ts`). See that file's own header for why this is a
 * type-only barrel's section rather than a runtime module —
 * `fleet-report-types.ts` re-exports every name below for every existing
 * importer.
 */

/**
 * THE THREE JOB-REGISTRY REPORT SHAPES (refactor plan §6.2: "report shapes:
 * ConvergeDoc (exists), GateDoc, RecordDoc"), placed together because
 * `src/lib/job-runner.ts` classifies a job's tick by reading one of these,
 * never the other way around — a reader must not read its own writer's
 * artifact, but all three artifacts are read by the ONE runner, so their
 * shapes belong next to each other rather than beside each job's own file.
 *
 * `ConvergeDoc` moved here from `src/scheduled-converger.ts` (still
 * re-exported there, and from `src/provisioning-converge.ts`, for every
 * existing importer) when `GateDoc`/`RecordDoc` were added, so the three
 * shapes have one home instead of drifting apart as each gained its own.
 */

/** One (node, facet) finding, as every converger's `--json` reports it. */
export interface ConvergeRow {
	node: string;
	facet: string;
	before?: string;
	changed?: string;
	why?: string;
}

/** A converger subcommand's `--json`, as far as the job runner reads it. */
export interface ConvergeDoc<R extends ConvergeRow = ConvergeRow> {
	ok: boolean;
	planned: R[];
	converged: R[];
	deferred: R[];
	unconverged: R[];
	unreadable: { node: string; facet: string; why: string }[];
	changed: { node: string; facet: string; changed: string }[];
}

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

/**
 * A recorder's `--json`: it writes measurements and converges nothing
 * (`benchmark`, `doctor --write` — plan §3.2 rule 6). `recorded` is what it
 * wrote this pass; `unreadable` is what it could not measure, which must
 * never read as "nothing to record".
 */
export interface RecordDoc {
	ok: boolean;
	recorded: { node: string; facet: string }[];
	unreadable: { node: string; facet: string; why: string }[];
	why?: string;
}
