/**
 * PROVE A JOB ON A NODE — run one real workflow job on a named node and read
 * back, from GitHub, where it actually ran.
 *
 * WHY THIS EXISTS (wave 3q lane E, 2026-09-30)
 * --------------------------------------------
 * `taskauto` is `verify: 'role'`: assigned, so no probe can settle it, and the
 * job that exercises it (`hadoku-tenhands`' `backend pytest`) needs an Actions
 * SECRET that lives only in GitHub. The only honest proof is a workflow run, and
 * a workflow run goes wherever GitHub sends it — the job asks for
 * `[self-hosted, pm2-host, taskauto]`, the claw does not carry `pm2-host` (and
 * must not; that is #6's routing decision), and hokon, which does, wins.
 * Wave 3p aimed one run at claw-8 by a HAND recipe. The operator rejected a
 * recipe: "the whole point of this system is for fleet-manager to provision my
 * claws". This is that recipe, built on the machinery that already mints.
 *
 * ANY NODE THE DISPATCHER MINTS ON — an ephemeral claw or the on-demand
 * backstop (`mintsJitRunners`). The backstop's proof runner takes its unit cap
 * from `backstopUnitMemoryMaxMb`, exactly as the dispatcher's mints there do.
 * (The backstop, called `guest` until 2026-10-31, was proved through its
 * standing registration instead; that mode is gone.)
 *
 * WHAT IS REUSED, AND THE ONE SEAM
 * --------------------------------
 * The mint is `mintEphemeralRunner` — slot preparation, `generate-jitconfig`,
 * the DisableUpdate/Ephemeral assertion, the 0600 config, the transient unit in
 * `runners.slice` — called exactly as the dispatcher calls it. The seam is that
 * `MintRequest.labels` is ALREADY per call, so a proof runner carries the label
 * set the target job asks for without the manifest, the node's offer
 * (`nodeOffer`) or the routing of any real job being touched. The manifest node
 * is treated as READ-ONLY here and a test freezes it.
 *
 * THE NAME IS `jit-<node>-proof-<repo>-j0-r0-<epoch>`, AND THAT IS THE ANSWER TO
 * "DOES THE REAP SWEEP PROTECT IT?". `reapJitRunners` keys on the `jit-` prefix,
 * and keeps a registration that is busy, that has a LIVE unit of the same name,
 * or whose mint epoch is inside the grace. A `jit-` name therefore is protected
 * for exactly its bounded lifetime — while the unit lives or a job is on it — and
 * is REAPED AFTER THE GRACE if a crash strands the registration with no unit
 * behind it, so a leak has a backstop. The 3p recipe's non-`jit-` name was
 * invisible to the sweep, which is also why nothing would ever have cleaned it
 * up. `j0-r0` parse as a run id no real run has, so the dispatcher's in-flight
 * reconstruction (`parseJitName`) neither blocks nor is confused by it. The unit
 * and the registration count against the node's `maxConcurrent`, which is honest:
 * the proof spends a slot and real memory.
 *
 * THE RACE, HONESTLY
 * ------------------
 * Two runners match, GitHub picks. There is no way to direct an unaimed job,
 * so: dispatch, read the job's `runner_name` from
 * the API, and if it was not ours cancel that run and try again — up to a hard
 * cap. A job that concluded `success` on the WRONG runner is a `lost-race`,
 * never a pass. `ranOnTarget` is read from the job object and from nothing else.
 *
 * NOTHING HERE DECIDES "HEALTHY" BY SILENCE
 * -----------------------------------------
 * Every unreadable thing — the workflow file, the runs listing, the job, the log,
 * the node — is a FINDING carrying its reason and a non-pass verdict. Teardown
 * runs on every path including abort, and what it could not verify is a finding
 * of its own: a leaked registration is a runner GitHub will schedule onto with
 * nothing behind it.
 *
 * PURE ORCHESTRATION OVER INJECTED PORTS. `gh`, `sh`, the clock and the sleeper
 * are parameters, so the order of operations — where the leaks live — is tested
 * without a node or a token. `scripts/prove-job.mjs` is the real wiring.
 *
 * THE MINT ITSELF STILL COMES THROUGH `ephemeral-exec.ts` DIRECTLY (wave
 * clean2 lane B looked at a lifecycle-owned `MintPort` port/adapter here,
 * same shape as `GhLike`/`ShellLike`, but every file that could construct
 * the REAL adapter — `scripts/prove-job.mjs` included — is itself
 * `layer-map.json`-classified `domain`, same as this file, so the port
 * would only relocate the edge, not close it; see
 * `docs/planning/wave-clean2-2026-11-01.md` and this wave's report).
 */

import { capability } from '../lib/capability-registry.js';
import { nodeOffer } from '../lib/capability-offer.js';
import { mintsJitRunners, mintsOnDemand } from '../lib/node-role.js';
import {
	admitMint,
	liveJitUnits,
	liveJitSlots,
	slotDir,
	mintEphemeralRunner,
	runnerTarballUrl,
	backstopUnitMemoryMaxMb,
	unitMemoryMaxMb,
	JIT_UNIT_MAX_SEC,
} from './ephemeral-exec.js';
import { jobKind } from '../lib/job-kind.js';
import {
	MAX_ATTEMPTS_CEILING,
	DEFAULT_MAX_ATTEMPTS,
	type ProveSpec,
	type ProveDeps,
	type ProofAttempt,
	type ProofResult,
	type Owned,
	type RunRow,
	type JobRow,
	Abort,
	Unreadable,
	type ListedRunner,
} from './prove-job-types.js';
import {
	proofLabel,
	proofRunnerName,
	dispatchBody,
	runsOnForJob,
	isDispatchable,
} from './prove-job-parse.js';
import {
	teardownProofRunners,
	reapStaleProofRunner,
	resolveDispatchRef,
} from './prove-job-lifecycle.js';
import { awaitLandedVerdict } from './prove-job-verdict.js';

// `runner-health.ts` (out of scope for this split) imports `isProofRunnerName`
// from this path; everything else moved below is imported from its real new
// module by every importer that needs it.

/** GitHub calls here go through the operator's own `gh` auth, never a token we hold. */
const NO_TOKEN = '';

// --- orchestration ----------------------------------------------------------

export async function proveJob(spec: ProveSpec, d: ProveDeps): Promise<ProofResult> {
	const started = d.now();
	const home = d.homeDir;
	const pollMs = d.pollMs ?? 4_000;
	const maxAttempts = Math.min(
		Math.max(1, Math.floor(spec.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)),
		MAX_ATTEMPTS_CEILING
	);
	const deadline = started + (spec.timeoutMs ?? 40 * 60_000);
	const assignMs = spec.assignTimeoutMs ?? 120_000;
	const jobMs = spec.jobTimeoutMs ?? 25 * 60_000;

	const r: ProofResult = {
		ok: false,
		verdict: 'error',
		node: spec.node,
		repo: spec.repo,
		workflow: spec.workflow,
		job: spec.job,
		ref: spec.ref,
		dispatchRef: null,
		capability: spec.capability ?? null,
		labels: [],
		labelSource: null,
		runId: null,
		jobId: null,
		jobConclusion: null,
		runnerName: null,
		durationSec: null,
		ranOnTarget: false,
		attempts: [],
		evidence: [],
		findings: [],
		minted: [],
		staleCleaned: [],
		teardown: { ok: true, runners: [], cancelledRuns: [], problems: [] },
		startedAt: new Date(started).toISOString(),
		finishedAt: '',
	};
	const find = (rule: string, message: string): void => void r.findings.push({ rule, message });
	const owned: Owned[] = [];
	const dispatched = new Set<number>();
	let scratch: string | null = null;
	const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

	// Teardown must not itself be abortable: the signal is WHY it is running.
	let tornDown = false;
	const checkAbort = (): void => {
		if (!tornDown && d.signal?.aborted) throw new Abort('aborted by signal');
	};
	const nap = async (ms: number): Promise<void> => {
		checkAbort();
		try {
			await d.sleep(ms, tornDown ? undefined : d.signal);
		} catch (e) {
			// A sleeper rejects when the signal fires; that is an abort, not a fault.
			checkAbort();
			throw e;
		}
		checkAbort();
	};
	/** One read, retried once, carrying the reason. "I could not look" is never a pass. */
	const read = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
		try {
			return await fn();
		} catch (first) {
			checkAbort();
			await nap(1_000);
			try {
				return await fn();
			} catch (second) {
				throw new Unreadable(`${what}: ${why(second)} (first attempt: ${why(first)})`);
			}
		}
	};
	const listRunners = async (): Promise<ListedRunner[]> => {
		const res = (await read('runner listing', () =>
			d.gh.get('/actions/runners?per_page=100', NO_TOKEN, spec.repo)
		)) as { runners?: ListedRunner[] } | null;
		if (!res || !Array.isArray(res.runners))
			throw new Unreadable('runner listing: no `runners` array');
		return res.runners;
	};

	/**
	 * Teardown, once. Never throws; what it could not do is recorded, loudly.
	 * The guard and the `tornDown = true` live HERE, not inside the extracted
	 * {@link teardownProofRunners}: they are what makes every `nap`/`read`
	 * call from this point on (including ones inside `listRunners`, which
	 * teardown itself calls) stop honouring the abort signal — see
	 * `prove-job-lifecycle.ts`'s own header.
	 */
	const teardown = async (): Promise<void> => {
		if (tornDown) return;
		tornDown = true;
		await teardownProofRunners(spec, d, find, owned, dispatched, scratch, listRunners, r.teardown);
	};

	const slice = d.node.slice as { unitMaxMb?: number; maxMb?: number } | undefined;
	const mint = async (): Promise<Owned | null> => {
		const used = await liveJitSlots(spec.node, d.sh);
		let slotIndex = 0;
		for (const o of owned) used.add(o.slotIndex);
		while (used.has(slotIndex)) slotIndex++;
		const name = proofRunnerName(spec.node, spec.repo, d.now() + owned.length * 1_000);
		// Fail-soft by design (null): only a node with no payload needs it.
		const tarball = await runnerTarballUrl(
			(p, t, repo) => d.gh.get(p, t, repo),
			NO_TOKEN,
			spec.repo,
			d.now()
		);
		// REGISTERED BEFORE THE MINT RETURNS, so teardown covers a mint that half-succeeds:
		// a jitconfig that was issued and whose listener never started is the black hole.
		const o: Owned = { name, unit: name, slotIndex, slot: slotDir(home, slotIndex) };
		owned.push(o);
		r.minted.push(name);
		const res = await mintEphemeralRunner(
			{
				node: spec.node,
				repo: spec.repo,
				runnerName: name,
				// THE SEAM: per-call, this runner only. Not `nodeOffer`, not the manifest.
				labels: r.labels,
				slotIndex,
				homeDir: home,
				memoryMaxMb: mintsOnDemand(d.node)
					? backstopUnitMemoryMaxMb({ requestedMb: slice?.unitMaxMb, sliceMaxMb: slice?.maxMb })
					: unitMemoryMaxMb({ requestedMb: slice?.unitMaxMb }),
				ttlSeconds: JIT_UNIT_MAX_SEC,
				tarballUrl: tarball,
			},
			NO_TOKEN,
			d.gh,
			d.sh
		);
		if (!res.ok) {
			find('mint-failed', `could not mint the proof runner on ${spec.node}: ${res.reason}`);
			return null;
		}
		return o;
	};

	const runnerAlive = async (name: string): Promise<boolean> => {
		const units = await liveJitUnits(spec.node, d.sh);
		if (!units.includes(name)) return false;
		return (await listRunners()).some((x) => x.name === name);
	};

	try {
		// --- refusals: nothing has been touched yet -----------------------------
		const refuse = (rule: string, message: string): ProofResult => {
			find(rule, message);
			r.verdict = 'refused';
			return r;
		};
		if (spec.capability) {
			if (!capability(spec.capability)) {
				return finalise(
					refuse('capability', `"${spec.capability}" is not a registered capability`)
				);
			}
			if (!nodeOffer(d.node, { eligible: false }).includes(spec.capability)) {
				return finalise(
					refuse(
						'capability-state',
						`${spec.node} does not carry "${spec.capability}" (assigned or earned) — proving a capability a node was never given would only show it CAN, not that it IS`
					)
				);
			}
		}
		if (!mintsJitRunners(d.node)) {
			return finalise(
				refuse(
					'not-minted',
					`${spec.node} is neither \`ephemeral: true\` nor an on-demand backstop; the proof runner goes through the JIT mint, which only those nodes take`
				)
			);
		}
		if (spec.evidence !== undefined) {
			try {
				new RegExp(spec.evidence, 'i');
			} catch (e) {
				return finalise(refuse('bad-evidence', `--evidence is not a regex: ${why(e)}`));
			}
		}

		// --- read the job's label needs (reads only) -----------------------------
		let workflowText: string;
		try {
			workflowText = await read('workflow file', () =>
				d.gh.text(
					`/contents/.github/workflows/${encodeURIComponent(spec.workflow)}?ref=${encodeURIComponent(spec.ref)}`,
					NO_TOKEN,
					spec.repo,
					'application/vnd.github.raw'
				)
			);
		} catch (e) {
			find('workflow-unreadable', why(e));
			r.verdict = 'error';
			return finalise(r);
		}
		if (!isDispatchable(workflowText)) {
			return finalise(
				refuse(
					'not-dispatchable',
					`${spec.workflow} has no workflow_dispatch trigger — a proof cannot start it`
				)
			);
		}
		if (spec.labelsOverride?.length) {
			r.labels = [...new Set(spec.labelsOverride)];
			r.labelSource = 'override';
			// Aimed: one label nothing else in the fleet carries, sent as the job's
			// `runs-on` — the canary cannot be taken by another listener.
			if (spec.runsOnInput) r.labels.push(proofLabel(d.now()));
		} else {
			const ro = runsOnForJob(workflowText, spec.job);
			if (!ro.ok) return finalise(refuse('runs-on', ro.reason));
			r.labels = ro.labels;
			r.labelSource = 'runs-on';
		}

		// --- the node: reachable, not drained, room for one more ---------------------
		const probe = await d.sh(spec.node, 'echo REACHABLE');
		if (probe === null || !probe.includes('REACHABLE')) {
			find('unreachable', `${spec.node} did not answer ssh — "I could not look" is not a pass`);
			r.verdict = 'error';
			return finalise(r);
		}
		const units = await liveJitUnits(spec.node, d.sh);
		const admission = admitMint({
			drained: d.drained,
			liveUnits: units.length,
			standingBusy: 0,
			maxConcurrent: typeof d.node.maxConcurrent === 'number' ? d.node.maxConcurrent : 1,
			freeMb: Number.POSITIVE_INFINITY,
			requiredMb: 0,
			minFreeMb: 0,
		});
		if (!admission.ok) return finalise(refuse('admission', `${spec.node}: ${admission.reason}`));

		// --- a proof runner an earlier run left behind ---------------------------
		// See `prove-job-lifecycle.ts`'s own doc for the full reasoning.
		const staleOutcome = await reapStaleProofRunner(spec, d, units, listRunners);
		if (staleOutcome.kind === 'refused') {
			return finalise(refuse(staleOutcome.rule, staleOutcome.message));
		}
		if (staleOutcome.kind === 'error') {
			r.staleCleaned.push(...staleOutcome.cleaned);
			find('stale-cleanup', staleOutcome.message);
			r.verdict = 'error';
			return finalise(r);
		}
		r.staleCleaned.push(...staleOutcome.cleaned);

		// --- the branch the run is dispatched on -------------------------------------
		// See `prove-job-lifecycle.ts`'s own doc for the full reasoning.
		const refOutcome = await resolveDispatchRef(spec, d, find, read);
		scratch = refOutcome.scratch;
		if (!refOutcome.ok) {
			r.verdict = 'error';
			return finalise(r);
		}
		r.dispatchRef = refOutcome.ref;
		const on = { ...spec, ref: r.dispatchRef };

		// --- mint once, then dispatch ---------------------------------------------
		checkAbort();
		if (!(await mint())) {
			r.verdict = 'error';
			return finalise(r);
		}
		/** The registration names the job counts on: a proof runner minted here. */
		const isTarget = (name: string | null | undefined): boolean =>
			Boolean(name) && owned.some((o) => o.name === name);

		let landed: { run: RunRow; job: JobRow } | null = null;
		for (let attempt = 1; attempt <= maxAttempts && !landed; attempt++) {
			checkAbort();
			if (d.now() >= deadline) {
				r.verdict = 'timeout';
				find(
					'timeout',
					`the ${Math.round((spec.timeoutMs ?? 40 * 60_000) / 60_000)} minute bound ran out before the job landed`
				);
				return finalise(r);
			}
			// A proof runner that took someone else's job is gone (ephemeral): re-mint.
			if (attempt > 1 && !(await runnerAlive(owned[owned.length - 1].name))) {
				if (!(await mint())) {
					r.verdict = 'error';
					return finalise(r);
				}
			}
			const wf = `/actions/workflows/${encodeURIComponent(spec.workflow)}/runs?event=workflow_dispatch&branch=${encodeURIComponent(on.ref)}&per_page=20`;
			const before = new Set<number>(
				(
					(await read('runs listing', () => d.gh.get(wf, NO_TOKEN, spec.repo))) as {
						workflow_runs?: RunRow[];
					} | null
				)?.workflow_runs?.map((x) => x.id) ?? []
			);
			const disp = await d.gh.write(
				'POST',
				`/actions/workflows/${encodeURIComponent(spec.workflow)}/dispatches`,
				NO_TOKEN,
				dispatchBody(on, r.labels),
				spec.repo
			);
			if (!disp.ok) {
				find('dispatch-failed', `workflow_dispatch answered HTTP ${disp.status}`);
				r.verdict = 'error';
				return finalise(r);
			}
			// Attribute the run by set difference against the pre-dispatch listing.
			let fresh: RunRow[] = [];
			for (let t = d.now(); d.now() - t < 90_000 && !fresh.length;) {
				await nap(pollMs);
				const now = (await read('runs listing', () => d.gh.get(wf, NO_TOKEN, spec.repo))) as {
					workflow_runs?: RunRow[];
				} | null;
				fresh = (now?.workflow_runs ?? []).filter((x) => !before.has(x.id));
			}
			if (!fresh.length) {
				find('run-not-found', 'the dispatch was accepted but no new run appeared within 90s');
				r.verdict = 'error';
				return finalise(r);
			}
			if (fresh.length > 1) {
				fresh.forEach((x) => dispatched.add(x.id));
				find(
					'ambiguous-run',
					`${fresh.length} new runs appeared (${fresh.map((x) => x.id).join(', ')}) — someone else dispatched the same workflow, so which one is ours cannot be told`
				);
				r.verdict = 'error';
				return finalise(r);
			}
			const run = fresh[0];
			dispatched.add(run.id);
			r.runId = run.id;

			// Which runner took the job — from the API, never inferred.
			const pick = async (): Promise<JobRow | null> => {
				const res = (await read('jobs listing', () =>
					d.gh.get(`/actions/runs/${run.id}/jobs?per_page=100`, NO_TOKEN, spec.repo)
				)) as { jobs?: JobRow[] } | null;
				return res?.jobs?.find((j) => jobKind(j.name) === spec.job) ?? null;
			};
			// AIMED, the target job can land on nothing but a proof runner, so a proof
			// runner that is gone before it landed was taken by an unaimed job in the
			// same run — a `needs:` prerequisite such as forge.yml's `changes`, which
			// runs on the plain pool labels the proof runner also carries. Cancelling
			// would only repeat that on every attempt (claw-4, 2026-10-08): mint another
			// in place and restart the assignment clock, up to the attempt ceiling.
			let job: JobRow | null = null;
			let reminted = 0;
			for (let t = d.now(); d.now() - t < assignMs;) {
				job = await pick();
				if (job && (job.runner_name || job.status === 'completed')) break;
				if (
					spec.runsOnInput &&
					reminted < MAX_ATTEMPTS_CEILING &&
					!(await runnerAlive(owned[owned.length - 1].name))
				) {
					reminted++;
					if (!(await mint())) {
						r.verdict = 'error';
						return finalise(r);
					}
					t = d.now();
				}
				await nap(pollMs);
			}
			const row: ProofAttempt = {
				attempt,
				runId: run.id,
				jobId: job?.id ?? null,
				runnerName: job?.runner_name ?? null,
				jobConclusion: job?.conclusion ?? null,
				ranOnTarget: isTarget(job?.runner_name),
				// Not a finding: a finding fails the proof, and this is the fleet's own
				// prerequisite job, not anything the node did.
				...(reminted
					? { note: `${reminted} proof runner(s) taken by another job in the run first; re-minted` }
					: {}),
			};
			r.attempts.push(row);
			if (!job) {
				find('job-not-found', `run ${run.id} never listed a job named "${spec.job}"`);
				r.verdict = 'error';
				return finalise(r);
			}
			if (row.ranOnTarget) {
				landed = { run, job };
				break;
			}
			// THE WORKFLOW SKIPPED IT, before any runner was asked: an `if:` or a
			// `needs:` job decided. Not a race, and a re-dispatch with the same ref
			// and inputs decides the same way. forge.yml answers a repeat of an
			// already-green dispatch exactly like this (claw-10, 2026-11-03: three
			// "lost-race" attempts, all skipped by the workflow).
			if (job.status === 'completed' && job.conclusion === 'skipped' && !job.runner_name) {
				r.jobConclusion = 'skipped';
				find(
					'skipped-by-workflow',
					`run ${run.id}: the workflow skipped "${spec.job}" before any runner was asked, so the dispatch, not the node, decided. Re-dispatching the same ref and inputs decides the same way: change an input the workflow keys on, or the ref.`
				);
				r.verdict = 'error';
				return finalise(r);
			}
			// MISSED. Cancel our run so it frees the concurrency group and stops burning
			// the other runner, then let the next attempt try again.
			row.note = job.runner_name
				? `took ${job.runner_name}, not a proof runner on ${spec.node}`
				: `no runner took the job within ${Math.round(assignMs / 1000)}s`;
			if (job.status !== 'completed') {
				const c = await d.gh.write(
					'POST',
					`/actions/runs/${run.id}/cancel`,
					NO_TOKEN,
					undefined,
					spec.repo
				);
				if (c.ok) r.teardown.cancelledRuns.push(run.id);
				else if (c.status !== 409)
					find('cancel-failed', `could not cancel run ${run.id}: HTTP ${c.status}`);
				for (let t = d.now(); d.now() - t < 60_000;) {
					const cur = (await d.gh.get(
						`/actions/runs/${run.id}`,
						NO_TOKEN,
						spec.repo
					)) as RunRow | null;
					if (cur?.status === 'completed') break;
					await nap(pollMs);
				}
			}
		}

		if (!landed) {
			const last = r.attempts[r.attempts.length - 1];
			r.jobConclusion = last?.jobConclusion ?? null;
			r.runnerName = last?.runnerName ?? null;
			r.verdict = 'lost-race';
			find(
				'lost-race',
				`the job never landed on ${spec.node} in ${r.attempts.length} attempt(s) (runners that took it: ${r.attempts.map((a) => a.runnerName ?? 'none').join(', ')})`
			);
			return finalise(r);
		}

		// --- landed: wait for it, read the verdict from the API ------------------
		// See `prove-job-verdict.ts`'s own doc; mutates `r` in place.
		await awaitLandedVerdict(spec, d, r, find, read, nap, jobMs, landed, isTarget, pollMs);
		return finalise(r);
	} catch (e) {
		if (e instanceof Abort) {
			find('aborted', 'stopped by a signal; tearing down');
			r.verdict = 'error';
		} else {
			find(e instanceof Unreadable ? 'unreadable' : 'unexpected', why(e));
			r.verdict = 'error';
		}
		return finalise(r);
	}

	/** Teardown, then the verdict. Awaited on every return path above. */
	async function finalise(res: ProofResult): Promise<ProofResult> {
		if (owned.length || dispatched.size || scratch) await teardown();
		if (!res.teardown.ok) res.verdict = 'teardown-failed';
		res.ok = res.verdict === 'pass' && res.ranOnTarget && res.findings.length === 0;
		res.finishedAt = new Date(d.now()).toISOString();
		return res;
	}
}
