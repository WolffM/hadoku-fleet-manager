/**
 * The KIND of a job: its name with a numeric matrix suffix removed, so the
 * shards of one job — `forge-e2e (1)`, `forge-e2e (2)`, `forge-e2e (3)` — are
 * one kind to every model keyed on (repo, job name).
 *
 * WHY (2026-10-08). cardtable sharded `forge-e2e` three ways. GitHub names a
 * matrix job `<name> (<value>)`, so each shard arrived under a name nothing
 * in the fleet had seen: the heavy-kind model read them as light (no history),
 * the speed model as unmeasured, lane B's regression check as not gated, and
 * `prove-job` could not find its canary's job at all.
 *
 * A shard written as INDEX/TOTAL folds the same way: cardtable's `unit (1/2)`
 * and `unit (2/2)` are two halves of one suite. Until 2026-10-29 they were two
 * kinds, so each model met them with half the history they had between them.
 *
 * ONLY a numeric suffix. `test (ubuntu, 20)` is a different job from
 * `test (windows, 20)` and stays distinct; a shard index is a slice of the
 * same work.
 */
export function jobKind(name: string): string {
	return name.replace(/ \(\d+(?:\/\d+)?\)$/, '');
}
