/**
 * `fleet floor-probe rerun` — §5/§6's forced re-run (Control A). Split out of
 * `scripts/floor-probe.mjs` (wave 5q lane A, ctx restructure) so that file
 * reaches the 800-line ceiling. Takes the CLI's flags and run-scoped state
 * through `ctx`, built once there; never imports the CLI. The one `runOn`
 * call site (`ctx.sh`) and its slot check (`ctx.probeSlotIsFree`) stay in the
 * CLI — `expected-down-guard.test.mjs` scans only top-level `scripts/*.mjs`
 * files for that pairing — and are threaded through here instead.
 */
import {
	classifyZone,
	warrantsForcedRerun,
	CallBudget,
	RERUN_CALL_CEILING,
} from './floor-probe.mjs';
import { githubToken, meteredGh } from './floor-probe-dispatch.mjs';
import { appendLedger } from './floor-probe-state.mjs';
import { declareProbeIntent } from './floor-probe-intent.mjs';
import { mintProbeRunner, watchProbeJobToSettle } from './floor-probe-mint-watch.mjs';
import { nodeOf } from '../../dist/runners/census.js';
import { jitRunnerName } from '../../dist/runners/ephemeral.js';
import { ghWrite } from '../../dist/lib/github-client.js';

/**
 * §5/§6's forced re-run — Control A.
 *
 * Rides the EXISTING budget rather than the 200-call shadow cap: it is a POST
 * plus the listings the failover check already makes, and it fires only on a
 * genuine failure (17 in 1,030 jobs). Metering it would mean declining to
 * investigate a real fleet failure because a synthetic sweep had spent the
 * allowance first.
 *
 * `--onto <node>` IS REQUIRED, AND IT IS THE WHOLE CONTROL. §5.1 does not say
 * "re-run it and see" — it says "re-dispatch the SAME job with the failing node
 * EXCLUDED". A bare `rerun-failed-jobs` cannot do that: GitHub and the
 * dispatcher pick the node, and on 2026-09-08 attempt 2 of the fleet's only
 * retried run went straight back to the same claw. So the exclusion is
 * manufactured the same way the shadow path manufactures placement — a runner
 * is already listening on the chosen node when the re-dispatch lands — and the
 * chosen node is refused if it is the one that failed.
 *
 * `against` on the settled ledger entry is what makes this a POINT under §5.2:
 * a pass on a DIFFERENT node is one piece of evidence against the original.
 * `flakyVerdicts` reads that field and nothing else, so a re-run without an
 * exclusion could never have produced evidence at all.
 */
export async function modeRerun(ctx, rows) {
	const {
		flag,
		fail,
		CONFIRM,
		JSON_OUT,
		emitter,
		log,
		NODES,
		CLAWS,
		machines,
		notAProbeTarget,
		sh,
		probeSlotIsFree,
		PROBE_SLOT,
		PROBE_TTL_SECONDS,
		mintLabelsFor,
	} = ctx;
	const repo = flag('repo');
	const runId = Number(flag('run'));
	const onto = flag('onto');
	if (!repo || !Number.isFinite(runId)) fail('rerun needs --repo <owner/name> --run <runId>');

	const failed = rows.filter(
		(r) => r.repo === repo && r.runId === runId && r.conclusion !== 'success'
	);
	if (!failed.length) {
		fail(`no failed job recorded for ${repo} run ${runId} — nothing here says the fleet failed`);
	}
	const judged = failed.map((r) => ({ record: r, verdict: warrantsForcedRerun(r) }));
	const worth = judged.filter((j) => j.verdict.ok).map((j) => j.record);
	if (!worth.length) {
		// SAY WHY, per failure. "No probe was spent" and "no probe was warranted"
		// look identical from the outside, and a refusal with no reason is the
		// undiagnosable finding CLAUDE.md names.
		const why = judged.map((j) => `${j.record.name}: ${j.verdict.zone} — ${j.verdict.reason}`);
		fail(`nothing on run ${runId} warrants a forced re-run`, { runId, detail: why });
	}

	const failedOn = [...new Set(worth.map((r) => nodeOf(r.runner, NODES)))];
	const jobName = worth[0].name;
	if (!onto) {
		fail(
			'rerun needs --onto <claw-N>: §5.1 requires the FAILING node excluded, and a bare ' +
				'rerun-failed-jobs cannot exclude anything — attempt 2 of the fleet’s only ' +
				'retried run went straight back to the same claw',
			{ failedOn, candidates: CLAWS.filter((c) => !failedOn.includes(c)) }
		);
	}
	if (!CLAWS.includes(onto)) fail(notAProbeTarget(onto));
	if (failedOn.includes(onto)) {
		fail(`${onto} is where it already failed — that is the node the control EXCLUDES`, {
			failedOn,
		});
	}

	const token = githubToken();
	if (!token) fail('no GitHub token');
	if (!CONFIRM) {
		const plan = {
			repo,
			runId,
			onto,
			failedOn,
			jobs: worth.map((r) => ({
				job: r.name,
				node: nodeOf(r.runner, NODES),
				zone: classifyZone(r),
				failedStep: r.failedStep ?? null,
			})),
		};
		if (JSON_OUT) emitter.emit({ ok: true, mode: 'rerun', planned: true, ...plan });
		else {
			log(`PLAN — forced re-run of ${repo} run ${runId}, onto ${onto}`);
			for (const r of worth) {
				log(
					`  ${r.name}: failed on ${nodeOf(r.runner, NODES)} in the ${classifyZone(r)} zone ` +
						`(${r.failedStep ?? 'no step record'})`
				);
			}
			log('');
			log('  Nothing was written. Re-run with --confirm to actually re-dispatch.');
		}
		return 0;
	}

	// A RUNNER ON `onto`, LISTENING, BEFORE THE RE-DISPATCH LANDS. This is the
	// exclusion: GitHub hands a queued job to an idle matching runner in about two
	// seconds, so the re-run goes where we put it rather than back to the node
	// that failed. Same reasoning, same slot and same verification as the shadow
	// path — see `modeProbe`.
	if (!(await probeSlotIsFree(onto))) {
		fail(
			`slot ${PROBE_SLOT} on ${onto} is already in use — another probe is running there, and ` +
				`provisioning runs RESET=1, so minting anyway would rewrite its config`
		);
	}
	const runnerName = jitRunnerName(onto, repo, Date.now(), 0, 0);
	// SAME DECLARATION AS THE SHADOW PATH, and for the same reason:
	// `rerun-failed-jobs` re-queues the job, the dispatcher sees it queued and mints
	// a competitor that can take the attempt this control exists to place.
	const releaseIntent = declareProbeIntent(
		{ repo, job: jobName, node: onto, runnerName },
		{ fail, ttlSeconds: PROBE_TTL_SECONDS }
	);
	// RERUN_CALL_CEILING, not the shadow cap — see that constant. What this meter
	// buys here is the blackout check and a bound against a spinning watch loop,
	// not an allowance that could refuse to investigate a real failure.
	const gh = meteredGh(new CallBudget(RERUN_CALL_CEILING), token);
	const cleanUp = await mintProbeRunner({
		node: onto,
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
	});

	// DECLARED BEFORE THE POST. `ingestRuns` lifts its `seenRuns` skip for a run
	// the ledger names as `forced-rerun` and for nothing else — a declaration
	// that arrived after the poller's next tick would be a re-run whose second
	// attempt is never fetched, which is the exact gap this whole mechanism
	// exists to close.
	appendLedger({ runId, repo, origin: 'forced-rerun', job: jobName, intendedNode: onto, failedOn });

	const res = await ghWrite(
		'POST',
		`/actions/runs/${runId}/rerun-failed-jobs`,
		token,
		undefined,
		repo
	);
	if (!res.ok) {
		await cleanUp();
		fail(`rerun-failed-jobs returned ${res.status}`, { runId });
	}

	// WATCH THE NEW ATTEMPT. `rerun-failed-jobs` keeps the run id and increments
	// the attempt, so the same jobs listing answers — with the new attempt's jobs,
	// which is exactly why `ingestRuns` had to lift its skip for this run id.
	// Cleans up our runner unless it was the one consumed (same rule as the
	// shadow path — a re-run that landed back on the failing node completes
	// normally and leaves this one listening) and releases the intent either way.
	const { observed, conclusion, durationSec, failedStep, jobId } = await watchProbeJobToSettle({
		gh,
		runId,
		repo,
		jobName,
		NODES,
		runnerName,
		cleanUp,
		releaseIntent,
	});

	const forced = observed === onto;
	const out = {
		runId,
		jobId,
		repo,
		origin: 'forced-rerun',
		job: jobName,
		intendedNode: onto,
		node: observed,
		forced,
		conclusion: conclusion ?? 'unknown',
		durationSec,
		failedStep,
		// §5.2's POINT, and it is recorded ONLY when the re-dispatch actually
		// passed somewhere else. A re-run that landed back on the failing node, or
		// that failed again, is not evidence against anything — it is one more
		// observation, and `flakyVerdicts` treats it as such.
		against: forced && conclusion === 'success' ? failedOn[0] : undefined,
		failedOn,
		runnerName,
		settled: true,
	};
	appendLedger(out);

	if (JSON_OUT) emitter.emit({ ok: conclusion !== null, mode: 'rerun', ...out });
	else {
		log(`RERUN ${repo}#${jobName} run ${runId}`);
		log(`  failed on ${failedOn.join(', ')}   re-dispatched onto ${onto}`);
		log(
			`  observed ${observed ?? '(never reported a runner)'}   ${forced ? 'EXCLUDED' : 'NOT EXCLUDED'}   ` +
				`conclusion=${out.conclusion}`
		);
		if (out.against) {
			log(`  → one point of evidence against ${out.against} for ${repo}#${jobName}`);
			log('    §5.3: two such points with no intervening pass is the flaky verdict. One is not.');
		} else {
			log('  → NOT a point. §5.2 needs a pass on a DIFFERENT node than the one that failed.');
		}
	}
	return conclusion === null ? 1 : 0;
}
