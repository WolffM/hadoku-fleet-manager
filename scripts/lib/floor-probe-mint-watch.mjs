/**
 * Mint-and-watch: the mechanics `floor-probe-mode-probe.mjs`'s shadow path
 * and `floor-probe-mode-rerun.mjs`'s forced re-run share once a target node
 * and a runner name have been chosen — §6's forced-placement trick (a runner
 * already LISTENING before the job exists, read back to see where GitHub
 * actually sent it) was byte-identical in both files. Pulled out here (wave
 * shrink-1 lane A dedup) rather than left duplicated.
 *
 * Neither function talks to the CLI or to `ctx` — everything each needs
 * (`gh`, `sh`, `fail`, the slot/ttl constants) is a parameter, the same way
 * `mintEphemeralRunner` itself takes `gh`/`sh` rather than reaching for them,
 * so both are testable with fakes and without a node.
 */
import { nodeHome } from '../../dist/lib/node-users.js';
import { mintEphemeralRunner } from '../../dist/runners/ephemeral-exec-jit.js';
import { nodeOf } from '../../dist/runners/census.js';
import { PROBE_CALLS } from './floor-probe.mjs';
import { sleep } from './floor-probe-dispatch.mjs';

/**
 * Mint the probe's runner on `node` and hand back its teardown.
 *
 * ORDER: `releaseIntent` runs BEFORE `fail` on a failed mint, in both
 * callers — once the mint has failed the declaration is a licence to not
 * mint for a job nothing is listening for, under all-JIT the dispatcher is
 * the only thing that would. `fail` itself is the CLI's own (it exits or
 * emits `{ok:false}`), so a failed mint never returns from here.
 *
 * `mintFailDetail()` is called only on that failure path, AFTER the mint
 * attempt — so `gh.spent()` inside it reads the budget post-mint, same as
 * the shadow path's inline `fail(..., {node, spent: gh.spent()})` did before
 * this moved. The forced-rerun path passes none, matching its own `fail(msg)`
 * with no second argument (the CLI's `fail` defaults `extra` to `{}` either
 * way, so this is not a behaviour change).
 */
export async function mintProbeRunner({
	node,
	repo,
	runnerName,
	mintLabelsFor,
	machines,
	token,
	gh,
	sh,
	releaseIntent,
	fail,
	PROBE_SLOT,
	PROBE_TTL_SECONDS,
	mintFailDetail = () => undefined,
}) {
	const mint = await mintEphemeralRunner(
		{
			node,
			repo,
			runnerName,
			// DERIVED, not the declared array (issue #19) — see the shadow path's
			// own note on why a declaration-read mint became unschedulable.
			labels: mintLabelsFor(node),
			slotIndex: PROBE_SLOT,
			homeDir: nodeHome(machines[node], 'ci'),
			tarballUrl: null,
			memoryMaxMb: machines[node]?.slice?.unitMaxMb ?? 4096,
			ttlSeconds: PROBE_TTL_SECONDS,
		},
		token,
		{ write: (m, p, t, b, r) => gh.write(m, p, t, b, r) },
		sh
	);
	if (!mint.ok) {
		releaseIntent();
		fail(`could not mint on ${node}: ${mint.reason}`, mintFailDetail());
	}

	/**
	 * Remove our runner. Every exit path that does not CONSUME it comes here.
	 *
	 * A registration with nothing listening is §12.8's black hole — GitHub will
	 * schedule onto it and the job hangs. The reaper would eventually take it,
	 * but "eventually" is a 10-minute grace, and a probe that leaves a hole open
	 * for ten minutes has cost a consumer more than it measured.
	 */
	return async function cleanUp() {
		// THE INTENT GOES FIRST — see above.
		releaseIntent();
		const list = await gh.get('/actions/runners?per_page=100', repo);
		const r = (list.body?.runners ?? []).find((x) => x.name === runnerName);
		if (r) await gh.write('DELETE', `/actions/runners/${r.id}`, token, undefined, repo);
		await sh(
			node,
			`XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user stop ${runnerName} 2>/dev/null || true`
		);
	};
}

/**
 * Watch a dispatched job until it settles (or the poll budget runs out),
 * clean up the probe's runner unless it was the one that served the job, and
 * release the slot's intent declaration either way.
 *
 * CLEAN UP UNLESS OUR RUNNER WAS CONSUMED. `conclusion === null` is not the
 * only case that leaks: a probe that MISSED still completes — the job ran
 * somewhere else — and our runner is then sitting there LISTENING, with its
 * TTL, free to pick up an unrelated job in the same repo. The test is the
 * runner NAME, not the node: a competitor mint can land on the same node,
 * which still makes the probe FORCED (the evidence is about the node) while
 * leaving ours unconsumed. CONSUMED OR NOT, the job is no longer waiting for
 * a runner once it settles, so the declaration has done its job and must
 * stop suppressing mints for this unit either way.
 *
 * `wait` is the between-polls delay, injectable so a test can drive several
 * iterations without a real 20s sleep per poll — both callers omit it, so
 * production always gets the real `sleep` from `floor-probe-dispatch.mjs`.
 */
export async function watchProbeJobToSettle({
	gh,
	runId,
	repo,
	jobName,
	NODES,
	runnerName,
	cleanUp,
	releaseIntent,
	wait = sleep,
}) {
	let observed = null;
	let conclusion = null;
	let durationSec = null;
	let failedStep = null;
	let jobId = null;
	let servedBy = null;
	for (let i = 0; i < PROBE_CALLS.jobPolls; i++) {
		const r = await gh.get(`/actions/runs/${runId}/jobs`, repo);
		if (r.ok) {
			const j = (r.body?.jobs ?? []).find((x) => x.name === jobName);
			if (j) {
				jobId = j.id ?? jobId;
				if (j.runner_name) {
					servedBy = j.runner_name;
					observed = nodeOf(j.runner_name, NODES);
				}
				if (j.status === 'completed') {
					conclusion = j.conclusion;
					failedStep = (j.steps ?? []).find((s) => s.conclusion === 'failure')?.name ?? null;
					const s = Date.parse(j.started_at ?? '');
					const e = Date.parse(j.completed_at ?? '');
					if (Number.isFinite(s) && Number.isFinite(e)) durationSec = Math.round((e - s) / 1000);
					break;
				}
			}
		}
		await wait(20_000);
	}
	if (servedBy !== runnerName) await cleanUp();
	releaseIntent();
	return { observed, conclusion, durationSec, failedStep, jobId, servedBy };
}
