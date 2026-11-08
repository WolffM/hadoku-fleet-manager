/**
 * THE LANES EACH REPO'S JOBS ASK FOR, as the dispatcher has seen them.
 *
 * A JIT mint carries only its own job's lane (`MintAction.lanes`). A WARM
 * listener is promised to no job in particular, so it carries every lane its
 * repo has asked for; otherwise a laned job could never take a warm listener
 * and would wait for a mint (about 2 s warm against 26 s JIT).
 *
 * Learned from the queued jobs each dispatch pass reads. In-process only: after
 * a restart a warm listener minted before the first laned job of its repo is
 * seen lacks that lane, and the warm pass rotates it once the lane is learned
 * (`missingLane`). Nothing here is ever a reason to refuse a job.
 */
import { laneLabelsOf } from '../lib/capability-labels.js';

const seen = new Map<string, Set<string>>();

/** Record the lanes in a queued job's labels. */
export function observeLanes(repo: string, labels: readonly string[] | undefined): void {
	const lanes = laneLabelsOf(labels ?? []);
	if (!lanes.length) return;
	const set = seen.get(repo) ?? new Set<string>();
	for (const l of lanes) set.add(l.toLowerCase());
	seen.set(repo, set);
}

/** Every lane `repo` has asked for, sorted. */
export function lanesFor(repo: string): string[] {
	return [...(seen.get(repo) ?? [])].sort();
}

/** The first lane of `repo` that a registration's `labels` lacks, if any. */
export function missingLane(repo: string, labels: readonly string[]): string | undefined {
	const have = new Set(labels.map((l) => l.toLowerCase()));
	return lanesFor(repo).find((l) => !have.has(l));
}

export function __resetRepoLanesForTesting(): void {
	seen.clear();
}
