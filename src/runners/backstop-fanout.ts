/**
 * Fanning the backstop decision out to the rest of the fleet — split out of
 * `backstop-decision.ts` (wave 5r lane C, pure move) to bring that file
 * under the 800-line ceiling. `syncBackstopAcrossFleet` was not previously
 * exported from that file (an internal helper of `runBackstopDecision`), so
 * nothing outside it needs a re-export.
 */
import { ghWrite, readRunnerListingShared, SELF_REPO } from '../lib/github-client.js';
import { SWEEP_CONCURRENCY, mapConcurrent } from '../lib/concurrency.js';
import { BACKSTOP_LABEL, BUILDER_LABEL, PM2_HOST_LABEL } from '../lib/capability-registry-ids.js';
import { backstopLabelWrite } from './backstop.js';

/**
 * Apply the backstop label to hokon's runner on EVERY fleet repo, not just this
 * one.
 *
 * SELF_REPO's runner listing is a valid fleet-wide view for the CLAWS — they
 * register to every covered repo under the same names with the same labels — and
 * that is what the comment on SELF_REPO means. It was never true of hokon, and
 * on 2026-08-23 it stopped being harmless: hokon gained a runner on all 26 repos,
 * each carrying only `pm2-host,taskauto`. The promote below writes labels by
 * runner ID, and a runner ID is repo-scoped, so a full claw outage promoted
 * hokon for hadoku_site and left the other 25 repos' hokon runners unlabelled.
 *
 * That combination strands them. `runs-on: [self-hosted, hadoku-builder]` matches
 * nothing once the claws are down, and the hosted fallback cannot rescue them
 * either — it flips on `clawsOnline + backstopOnline`, and backstopOnline counts
 * hokon as capacity even though that capacity was only ever reachable from one
 * repo. So the escalation claws → hokon → hosted silently skipped BOTH remaining
 * rungs for 25 of 26 repos, and their jobs would queue until a claw came back.
 *
 * Costs nothing on the happy path: the fan-out only runs on a state CHANGE, and
 * re-asserts every tick only while the backstop is up — the state where a write
 * that silently failed last tick is worth the calls.
 *
 * One state change it ALWAYS sees is a restart: `backstopFleetState` is null in
 * a new process, so the first tick reads every child repo's runner listing to
 * converge. Read one after another that was ~12s of the first tick — measured
 * 2026-09-01 on 0.21.2, the first tick took 19.5s with the runs sweep already
 * fanned out. The repos are independent here (each is read and written on its
 * own id), so they go `SWEEP_CONCURRENCY` at a time. The two result lists are
 * sorted, so the log line does not depend on which listing answered first.
 */
export async function syncBackstopAcrossFleet(
	on: boolean,
	token: string,
	repos: string[],
	/**
	 * Runners that must NOT carry the label whatever `on` says — the pool
	 * members on a quarantined or drained node. Same predicate as the local
	 * loop, so the fan-out cannot re-label on twenty repos a node this tick
	 * refused on this one.
	 */
	unsafe: (runnerName: string) => boolean = () => false
): Promise<{ changed: string[]; failed: string[] }> {
	const changed: string[] = [];
	const failed: string[] = [];
	const converge = async (repo: string): Promise<void> => {
		if (repo === SELF_REPO) return; // handled by the ID-based loop above
		// Shared (#118): the reap and the warm cache list these repos on a minute
		// clock, and a label sweep on a 10-minute one can use their answer. Its
		// own writes drop the entry, so a re-assert never reads back its past.
		const resp = await readRunnerListingShared(repo, token);
		if (!resp || !Array.isArray(resp.runners)) {
			failed.push(repo);
			return;
		}
		for (const r of resp.runners) {
			const labels = r.labels ?? [];
			const inPool = labels.some((l) => l.name === PM2_HOST_LABEL || l.name === BACKSTOP_LABEL);
			// Only the hokon pool is ever relabelled here. A claw carries neither
			// label, so it can never be demoted by this path even by accident.
			if (!inPool) continue;
			// ONE PREDICATE, shared with the id-based loop in `tick` — see
			// `backstopLabelWrite`. This arm used to skip an offline runner for the
			// DEMOTE as well as the promote, which is how hadoku-cardtable kept
			// `hadoku-builder` through the 2026-09-18T19:29Z sweep and served seven
			// more builder jobs on it.
			const write = backstopLabelWrite(
				{
					hasBuilder: labels.some((l) => l.name === BUILDER_LABEL),
					online: r.status === 'online',
				},
				on && !unsafe(r.name)
			);
			if (write === null) continue;
			const want = write === 'promote';
			const res = want
				? await ghWrite(
						'POST',
						`/actions/runners/${r.id}/labels`,
						token,
						{
							labels: [BUILDER_LABEL],
						},
						repo
					)
				: await ghWrite(
						'DELETE',
						`/actions/runners/${r.id}/labels/${BUILDER_LABEL}`,
						token,
						undefined,
						repo
					);
			// A demote that 404s found the label already gone — which is the state
			// being converged to, so it is neither a change nor a failure. The other
			// writer of this label (the tier ladder, see runners/backstop-hold.ts)
			// demotes hokon on its own first pass after a restart, and since the
			// first tick here fires at t=0 the two can strip the same label within
			// the same second. Counting that as failed left `backstopFleetState`
			// unset, which forced a second full converge next tick, and logged
			// "those repos queue until this succeeds" about repos that were fine.
			if (res.ok) changed.push(`${repo.split('/')[1]}:${r.name}`);
			else if (!(want === false && res.status === 404)) {
				failed.push(`${repo.split('/')[1]}:${r.name}`);
			}
		}
	};
	await mapConcurrent(repos, SWEEP_CONCURRENCY, converge);
	changed.sort();
	failed.sort();
	return { changed, failed };
}
