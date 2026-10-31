import { logger } from '../host.js';
import type { SkipReason } from './dispatcher.js';
import { satisfiesLabels, type NodeState } from './placement.js';

/**
 * How long a run that NO node could take goes un-probed (#117).
 *
 * The jobs probe ran for every candidate on every 15s tick, and a run nothing
 * could serve got the same answer every time and paid for it every time: on
 * 2026-10-16 hadoku-cardtable run 38948244350 was probed and skipped 65 times
 * between 18:33 and 18:50Z — 240 calls an hour for one run — because the three
 * jdk21 nodes were full. Its siblings were RUNNING, so their steps changed the
 * body and the ETag above rarely answered 304. 251 such skips in the window
 * that ended in that day's blackout.
 *
 * The backoff is BOUNDED and lifts early on exactly the two things that can
 * change the answer: a node that could take the job changing state (see
 * `placementFingerprint`), and a time-based hold reaching its release
 * (`SkipReason.releaseAtMs`). So a full fleet stops paying per tick, and a
 * freed slot is still seen on the very next one.
 */
export const PROBE_BACKOFF_MS = 120_000;

/** `repo#runId` -> do not re-probe before `untilMs` while `fingerprint` holds. */
export const probeBackoff = new Map<
	string,
	{ untilMs: number; fingerprint: string; wanted: string[][] }
>();

/**
 * What a job's placement answer depends on, over the nodes that could ever
 * take it — the ones carrying one of its label sets and not excluding its
 * repo. A node that lacks `jdk21` finishing a job elsewhere cannot change
 * whether a jdk21 job places, so it must not lift the backoff; one of the
 * three jdk21 nodes freeing a slot must.
 *
 * NOT `freeMb`: it is re-read every tick and never repeats, so including it
 * would lift every backoff on every tick. A memory refusal is re-asked when a
 * relevant node's unit count moves (a job finishing is what frees memory) and
 * at the latest after PROBE_BACKOFF_MS.
 */
export function placementFingerprint(
	nodes: readonly NodeState[],
	repo: string,
	wanted: readonly (readonly string[])[]
): string {
	return nodes
		.filter(
			(n) =>
				!n.excludedRepos?.has(repo) &&
				(!wanted.length || wanted.some((w) => satisfiesLabels(n.labels ?? [], w)))
		)
		.map((n) =>
			[
				n.name,
				n.healthy,
				n.eligible,
				n.schedulable ?? '',
				n.liveUnits,
				n.standingBusy,
				n.maxConcurrent,
				n.heavyJobs ?? 0,
				n.runningHeavy ?? false,
			].join(':')
		)
		.sort()
		.join('|');
}

/**
 * Back off every run whose EVERY pending job this pass refused as unplaceable.
 * A run with one job minted or in flight is moving, and is probed as usual.
 */
export function recordProbeBackoff(
	nodes: readonly NodeState[],
	pending: readonly { id: number; repo: string; labels?: string[] }[],
	unplaceable: readonly SkipReason[],
	nowMs: number
): void {
	const jobsOf = new Map<string, { labels?: string[] }[]>();
	for (const p of pending) {
		const k = `${p.repo}#${p.id}`;
		jobsOf.set(k, [...(jobsOf.get(k) ?? []), p]);
	}
	const skipsOf = new Map<string, SkipReason[]>();
	for (const s of unplaceable) {
		const k = `${s.repo}#${s.runId}`;
		skipsOf.set(k, [...(skipsOf.get(k) ?? []), s]);
	}
	const fresh: string[] = [];
	for (const [k, skips] of skipsOf) {
		const jobs = jobsOf.get(k) ?? [];
		if (skips.length !== jobs.length) continue;
		const release = Math.min(...skips.map((s) => s.releaseAtMs ?? Infinity));
		const untilMs = Math.min(nowMs + PROBE_BACKOFF_MS, release);
		if (untilMs <= nowMs) continue;
		const repo = skips[0].repo;
		const wanted = jobs.map((j) => j.labels ?? []);
		probeBackoff.set(k, {
			untilMs,
			fingerprint: placementFingerprint(nodes, repo, wanted),
			wanted,
		});
		fresh.push(`${k} ${Math.round((untilMs - nowMs) / 1000)}s`);
	}
	if (fresh.length) {
		// Says why the `skipped run` lines go quiet: the run is still queued and
		// still unplaceable, it is simply not being re-asked every tick.
		logger.info(
			`[dispatch-tick] no node can take ${fresh.length} run(s); not re-probing until a node ` +
				`that could changes or the hold releases: ${fresh.slice(0, 5).join(', ')}` +
				(fresh.length > 5 ? ` (+${fresh.length - 5} more)` : '')
		);
	}
}
