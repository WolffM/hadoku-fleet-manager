/**
 * `fleet floor-probe probe` — §6's shadow path. Split out of
 * `scripts/floor-probe.mjs` (wave 5q lane A, ctx restructure) so that file
 * reaches the 800-line ceiling. Takes the CLI's flags and run-scoped state
 * through `ctx`, built once there; never imports the CLI. The one `runOn`
 * call site (`ctx.sh`) and its slot check (`ctx.probeSlotIsFree`) stay in the
 * CLI — `expected-down-guard.test.mjs` scans only top-level `scripts/*.mjs`
 * files for that pairing — and are threaded through here instead.
 */
import { tryShipped } from './fleet-source.mjs';
import { stripYamlComments } from './yaml-comments.mjs';
import { shadowSafety } from './floor-probe-safety.mjs';
import {
	CallBudget,
	PROBE_CALLS,
	SHADOW_CALL_BUDGET,
	callsPerProbe,
	maxProbesPerRun,
} from './floor-probe.mjs';
import { classifyZone } from '../../dist/job-history-zone.js';
import { githubToken, meteredGh, sleep } from './floor-probe-dispatch.mjs';
import { appendLedger } from './floor-probe-state.mjs';
import { declareProbeIntent } from './floor-probe-intent.mjs';
import { mintProbeRunner, watchProbeJobToSettle } from './floor-probe-mint-watch.mjs';
import { PROBE_INTENT_DIR } from '../../dist/runners/dispatch-tick-probe-intents.js';
import { jitRunnerName } from '../../dist/lib/jit-naming.js';

/**
 * §6's shadow path: one probe, one node.
 *
 * ORDERED SO NOTHING IRREVERSIBLE HAPPENS BEFORE EVERY REFUSAL HAS SPOKEN —
 * safety, then window, then budget, then the runner, then the dispatch.
 *
 * THE RUNNER IS MINTED BEFORE THE JOB EXISTS, and the first version of this did
 * it the other way round. Measured on the fleet, 2026-09-08, dispatching first
 * and then minting for the job id:
 *
 *   18:04:11  this harness minted jit-claw-2-…-r34260822017-1788890650
 *   18:04:13  mgmt-api  minted jit-claw-2-…-r34260822017-1788890649
 *
 * TWO registrations, ONE second apart, on ONE node, for ONE job — and both took
 * slot 0, so the second provision ran `RESET=1` over the first's config. That is
 * §12.16 reproduced by the code written to avoid it. `planTick`'s interlock
 * ("a job already being served is never minted for again") could not help: the
 * dispatcher ticks every 15s and mints within ~3s of seeing a queued job, so a
 * harness that waits for the job id to appear has already lost. The job then ran
 * on claw-1 at 18:05:42, which this probe would have had to report as MISSED.
 *
 * Both halves are fixed here:
 *
 *   - A runner ALREADY LISTENING when the job is created gets it from GitHub in
 *     about two seconds, well inside the dispatcher's 15s tick, so usually no
 *     second mint happens at all.
 *   - PROBE_SLOT is high on purpose. `dispatch-pass` takes the LOWEST free slot,
 *     so a probe sitting at 9 is never the slot it picks while any claw's
 *     `maxConcurrent` is 3. Even when the dispatcher does mint a competitor, it
 *     cannot reset this one's config underneath it.
 *
 * It is still a race and it is still not pretended otherwise: `runner_name` is
 * read BACK from GitHub, and a probe that landed elsewhere reports MISSED and is
 * not counted as evidence about the intended node.
 */
export async function modeProbe(ctx) {
	const {
		flag,
		argv,
		fail,
		CONFIRM,
		JSON_OUT,
		emitter,
		log,
		NODES,
		CLAWS,
		machines,
		notAProbeTarget,
		checkQuietWindow,
		sh,
		probeSlotIsFree,
		PROBE_SLOT,
		PROBE_TTL_SECONDS,
		mintLabelsFor,
	} = ctx;
	const repo = flag('repo');
	const workflow = flag('workflow');
	const jobName = flag('job');
	const node = flag('node');
	const ref = flag('ref', 'main');
	if (!repo || !workflow || !jobName || !node) {
		fail('probe needs --repo <owner/name> --workflow <file.yml> --job <job name> --node <claw-N>');
	}
	if (!CLAWS.includes(node)) fail(notAProbeTarget(node));

	// 1. SAFETY. Read the workflow as SHIPPED, at the default branch — the
	//    bytes a dispatch at that ref will run, never a sibling checkout that may
	//    be behind, dirty or CRLF (fleet-manager#7). A `--ref` this cannot read
	//    is a refusal: the safety verdict would be about some other file.
	if (ref !== 'main') fail(`refusing to dispatch a workflow I cannot inspect at ${ref}`);
	const source = tryShipped(repo);
	if ('unreadable' in source) {
		fail(
			`cannot read ${repo}'s shipped workflows (${source.unreadable}) — refusing to dispatch a workflow I cannot inspect`
		);
	}
	const wfText = source.read(`.github/workflows/${workflow}`);
	if (wfText === null) {
		fail(
			`${repo} ships no .github/workflows/${workflow} — refusing to dispatch a workflow I cannot inspect`
		);
	}
	const safety = shadowSafety(stripYamlComments(wfText));
	if (!safety.ok) fail(`${repo}/${workflow} is not safe to shadow-dispatch: ${safety.reason}`);

	// 2. WINDOW.
	const window = checkQuietWindow();
	if (!window.quiet && !argv.includes('--ignore-window')) {
		fail(`not a quiet window (${window.why}): ${window.detail}`, { window });
	}

	// 3. BUDGET + blackout.
	const budget = new CallBudget(SHADOW_CALL_BUDGET);
	const token = githubToken();
	if (!token) fail('no GitHub token (HADOKU_SITE_TOKEN / GITHUB_TOKEN / `gh auth token`)');
	const gh = meteredGh(budget, token);

	if (!CONFIRM) {
		const plan = {
			repo,
			workflow,
			job: jobName,
			node,
			ref,
			slot: PROBE_SLOT,
			callsBudgeted: callsPerProbe(),
			budget: SHADOW_CALL_BUDGET,
			maxProbesPerRun: maxProbesPerRun(),
			window,
			safety,
		};
		if (JSON_OUT) emitter.emit({ ok: true, mode: 'probe', planned: true, ...plan });
		else {
			log(`PLAN — shadow probe ${repo}/${workflow} job "${jobName}" onto ${node} @ ${ref}`);
			log(`  quiet window: ${window.quiet ? 'yes' : `NO (${window.why}: ${window.detail})`}`);
			log(
				`  budget: ${callsPerProbe()} of ${SHADOW_CALL_BUDGET} calls; ` +
					`${maxProbesPerRun()} probes fit per run`
			);
			log(`  slot ${PROBE_SLOT}, reserved so the dispatcher's lowest-free walk cannot collide`);
			log(
				`  intent: declares ${repo}#${jobName} in ${PROBE_INTENT_DIR}/ for ` +
					`${PROBE_TTL_SECONDS}s, so the dispatcher mints no competitor for it ` +
					`(honoured only by a deployed mgmt-api carrying this version)`
			);
			log('  safe to dispatch: yes');
			log('');
			log('  Nothing was written. Re-run with --confirm to actually dispatch.');
		}
		return 0;
	}

	// 4. MINT FIRST. The ids are not known yet, so the name carries zeros where
	//    the run and job would be: `parseJitName` reads those back as run 0 /
	//    job 0, which no real job collides with, and the trailing epoch — the part
	//    the reaper actually ages on — is real.
	if (!(await probeSlotIsFree(node))) {
		fail(
			`slot ${PROBE_SLOT} on ${node} is already in use — another probe is running there, and ` +
				`provisioning runs RESET=1, so minting anyway would rewrite its config`
		);
	}
	const runnerName = jitRunnerName(node, repo, Date.now(), 0, 0);
	// BEFORE THE MINT — see `declareProbeIntent`. This is what stops mgmt-api
	// minting a second runner for the same job on its next 15s tick.
	const releaseIntent = declareProbeIntent(
		{ repo, job: jobName, node, runnerName },
		{ fail, ttlSeconds: PROBE_TTL_SECONDS }
	);
	const cleanUp = await mintProbeRunner({
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
		mintFailDetail: () => ({ node, spent: gh.spent() }),
	});

	const started = Date.now();
	// 5. DISPATCH.
	const disp = await gh.write(
		'POST',
		`/actions/workflows/${workflow}/dispatches`,
		token,
		{ ref },
		repo
	);
	if (!disp.ok) {
		await cleanUp();
		fail(`workflow_dispatch failed: ${disp.why}`, { spent: gh.spent() });
	}

	// 6. FIND THE RUN. The POST answers 204 with no body, so the id has to be
	//    looked up. Bounded by PROBE_CALLS.runLookupPolls, and metered.
	let runId = null;
	for (let i = 0; i < PROBE_CALLS.runLookupPolls && runId === null; i++) {
		await sleep(4000);
		const r = await gh.get('/actions/runs?event=workflow_dispatch&per_page=10', repo);
		if (!r.ok) continue;
		const hit = (r.body?.workflow_runs ?? []).find(
			(w) => Date.parse(w.created_at ?? '') >= started - 60_000 && (w.path ?? '').endsWith(workflow)
		);
		if (hit) runId = hit.id;
	}
	if (runId === null) {
		await cleanUp();
		fail('dispatched, but the run never appeared in the listing — could not look further', {
			spent: gh.spent(),
		});
	}

	// 7. DECLARE IT BEFORE IT FINISHES. mgmt-api's poller has to see the ledger
	//    entry by the time it ingests this run, or the sample lands untagged and
	//    the ranking cannot tell a probe from organic traffic.
	appendLedger({ runId, repo, origin: 'shadow', job: jobName, intendedNode: node, runnerName });

	// 8. WATCH. Bounded by PROBE_CALLS.jobPolls. Cleans up our runner unless it
	// was the one consumed, and releases the slot's intent declaration either
	// way — see `watchProbeJobToSettle`'s own header for the §12.8/observed-at
	// reasoning this carries.
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

	// 9. SETTLE. Intended AND observed, always — a probe that silently retargets
	//    itself is worse than one that admits it did.
	const forced = observed === node;
	const outcome = {
		runId,
		jobId,
		repo,
		origin: 'shadow',
		job: jobName,
		intendedNode: node,
		node: observed,
		forced,
		conclusion: conclusion ?? 'unknown',
		durationSec,
		failedStep,
		zone: conclusion && conclusion !== 'success' ? classifyZone({ failedStep }) : null,
		runnerName,
		slot: PROBE_SLOT,
		settled: true,
		spent: gh.spent(),
	};
	appendLedger(outcome);

	if (JSON_OUT) emitter.emit({ ok: conclusion !== null, mode: 'probe', ...outcome });
	else {
		log(`PROBE ${repo}#${jobName} run ${runId}`);
		log(
			`  intended ${node}   observed ${observed ?? '(never reported a runner)'}   ` +
				`${forced ? 'FORCED' : 'MISSED'}`
		);
		log(`  conclusion=${outcome.conclusion}  duration=${durationSec ?? '—'}s`);
		log(`  calls spent: ${gh.spent()} of ${SHADOW_CALL_BUDGET}`);
		if (!forced) {
			log('');
			log(
				'  MISSED is not a failure of the job — GitHub handed it to a runner other\n' +
					'  than the one minted for it, so this sample is NOT evidence about the\n' +
					'  intended node and must not be counted as forced.'
			);
		}
	}
	// A probe that never reached a conclusion is "I could not look", and that is a
	// non-zero exit — the dispatch happened and nothing was learned.
	return conclusion === null ? 1 : 0;
}
