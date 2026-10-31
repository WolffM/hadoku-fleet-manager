import { loadLedger } from './floor-probe-state.mjs';

/**
 * Merge this harness's settled probes into the unit's samples.
 *
 * TWO SOURCES, MERGED — NOT ONE PREFERRED OVER THE OTHER. job-history is the
 * record every other consumer reads, and `ingestRuns` stamps the `probe` tag
 * from the ledger — but only inside the process that HOLDS the window, which is
 * the DEPLOYED mgmt-api. Until this version is published, a probe run lands in
 * job-history untagged.
 *
 * Dropping the ledger row when history already has the job was the first
 * attempt, and it was wrong in a way that got worse over time: the probes showed
 * in the table for a few minutes and then VANISHED, one by one, as the poller
 * caught up and the untagged copy won. `pinned` on claw-2 went 3 → 0 while the
 * probes sat green in the ledger. A table that loses its own evidence as the
 * fleet observes it is exactly the shape `deployed-not-published-2026-09-05.md`
 * warns about.
 *
 * So: history supplies the MEASUREMENT (it re-read every field from GitHub
 * independently), the ledger supplies the PROVENANCE (`probe`, `intendedNode`),
 * and a job present in both gets one row carrying both. Once this version is
 * published the two agree and the merge is a no-op.
 *
 * This is NOT the harness reading back its own writer's artifact. `node`,
 * `conclusion` and `durationSec` in a settled entry were read from GitHub's job
 * listing, not from the probe's intention — the intention is the separate
 * `intendedNode` field, and `forced` is the comparison between them.
 *
 * A MISSED probe is kept, with the node that ACTUALLY served it. It is a real
 * sample of that node, and dropping it would be discarding a measurement for not
 * being the one we asked for.
 */
export function mergeProbeProvenance(key, fromHistory) {
	const byJob = new Map();
	const byRun = new Map();
	for (const e of loadLedger()) {
		if (!e.settled || e.repo !== key.repo || e.job !== key.job || !e.node) continue;
		if (typeof e.jobId === 'number') byJob.set(e.jobId, e);
		else byRun.set(e.runId, e);
	}
	let tagged = 0;
	const merged = fromHistory.map((r) => {
		const e = byJob.get(r.jobId) ?? byRun.get(r.runId);
		if (!e) return r;
		byJob.delete(r.jobId);
		byRun.delete(r.runId);
		tagged++;
		return { ...r, probe: e.origin, intendedNode: e.intendedNode ?? null };
	});
	// Whatever the poller has not ingested yet, as its own sample.
	const extra = [...byJob.values(), ...byRun.values()].map((e) => ({
		repo: e.repo,
		runId: e.runId,
		jobId: e.jobId ?? null,
		name: e.job,
		node: e.node,
		durationSec: e.durationSec ?? null,
		conclusion: e.conclusion ?? 'unknown',
		failedStep: e.failedStep ?? undefined,
		probe: e.origin,
		intendedNode: e.intendedNode ?? null,
	}));
	return { samples: [...merged, ...extra], tagged, extra: extra.length };
}
