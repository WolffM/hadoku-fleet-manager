/**
 * THE PROOF RUNNER'S LIFECYCLE — tears it down (the node's unit, GitHub's
 * registration, and the scratch branch/dispatched runs it leaves behind),
 * reaps a stale one an earlier run left, and resolves the branch a run
 * dispatches on. Split out of `prove-job.ts` (wave shrink-1 lane B,
 * 800-line ceiling). Minting and the liveness check stay in `prove-job.ts`
 * itself — both call through `ephemeral-exec.ts` (`ci-scheduling`), and
 * `prove-job.ts` already carries that cross-domain edge; moving them here
 * would duplicate it rather than close it (same reasoning as this file's
 * own header note on `MintPort`, now in `prove-job.ts`'s header). Nothing
 * below needs that import at all.
 *
 * TEARDOWN NEEDS NO ABORT AWARENESS OF ITS OWN. `proveJob`'s `nap`/`read`
 * (its abort-aware retry machinery) check a shared `tornDown` flag that
 * `proveJob` sets to `true` BEFORE calling {@link teardownProofRunners} —
 * the exact moment every `nap` from then on (including the ones inside
 * `listRunners`, passed in here as a callback that still closes over that
 * flag) must stop honouring the signal, because the signal is WHY teardown
 * is running. This file's own waits during the GitHub deregister retry are
 * therefore plain sleeps: by the time it runs, `tornDown` is already true in
 * every caller that matters, so there is nothing left to opt out of.
 */
import {
	type ProveSpec,
	type ProveDeps,
	type ProofResult,
	type RunnerTeardown,
	type Owned,
	type RunRow,
	sq,
	type ListedRunner,
} from './prove-job-types.js';
import { scratchBranchName } from './prove-job-parse.js';
import { isProofRunnerName } from '../lib/jit-naming.js';

/** GitHub calls here go through the operator's own `gh` auth, never a token we hold. */
const NO_TOKEN = '';

/**
 * Teardown, once. Never throws; what it could not do is recorded, loudly,
 * onto `td` (the caller's `ProofResult.teardown`). The caller is
 * responsible for the idempotency guard (`tornDown`) and for setting it
 * BEFORE calling this — see this file's own header for why.
 */
export async function teardownProofRunners(
	spec: ProveSpec,
	d: ProveDeps,
	find: (rule: string, message: string) => void,
	owned: readonly Owned[],
	dispatched: ReadonlySet<number>,
	scratch: string | null,
	listRunners: () => Promise<ListedRunner[]>,
	td: ProofResult['teardown']
): Promise<void> {
	const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));
	const problem = (m: string): void => {
		td.ok = false;
		td.problems.push(m);
		find('teardown-failed', m);
	};
	// 1. A run we dispatched that is still going holds the workflow's concurrency
	//    group and, worse, may still be using the proof runner.
	for (const id of dispatched) {
		try {
			const run = (await d.gh.get(`/actions/runs/${id}`, NO_TOKEN, spec.repo)) as RunRow | null;
			if (run?.status && run.status !== 'completed') {
				const res = await d.gh.write(
					'POST',
					`/actions/runs/${id}/cancel`,
					NO_TOKEN,
					undefined,
					spec.repo
				);
				if (!res.ok && res.status !== 409)
					problem(`could not cancel run ${id}: HTTP ${res.status}`);
				else td.cancelledRuns.push(id);
			}
		} catch (e) {
			problem(`could not read or cancel run ${id}: ${why(e)}`);
		}
	}
	// 1b. The scratch branch. Deleted even when a run on it was just cancelled:
	//     a cancelled run keeps its record, and a left branch is litter in the repo.
	if (scratch) {
		try {
			const res = await d.gh.write(
				'DELETE',
				`/git/refs/heads/${scratch}`,
				NO_TOKEN,
				undefined,
				spec.repo
			);
			if (!res.ok && res.status !== 404 && res.status !== 422)
				problem(`could not delete the scratch branch ${scratch}: HTTP ${res.status}`);
		} catch (e) {
			problem(`could not delete the scratch branch ${scratch}: ${why(e)}`);
		}
	}
	// 2. The node: stop the unit, remove any staged config, prove both from the node.
	for (const o of owned) {
		const t: RunnerTeardown = {
			name: o.name,
			unitStopped: false,
			configGone: false,
			listenerGone: false,
			deregistered: false,
		};
		td.runners.push(t);
		const cfg = `${o.slot}/.jitconfig`;
		const out = await d.sh(
			spec.node,
			[
				`XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user stop ${sq(o.unit)} 2>/dev/null`,
				`rm -f ${sq(cfg)}`,
				`if XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active --quiet ${sq(o.unit)}; then echo UNIT-ACTIVE; else echo UNIT-GONE; fi`,
				`if [ -e ${sq(cfg)} ]; then echo CFG-PRESENT; else echo CFG-GONE; fi`,
				`if pgrep -f ${sq(`jit/slot${o.slotIndex}/bin/Runner\\.Listener`)} >/dev/null 2>&1; then echo LISTENER-UP; else echo LISTENER-GONE; fi`,
				'true',
			].join('\n')
		);
		if (out === null) {
			problem(
				`could not reach ${spec.node} to tear down ${o.name} — its unit may still be running`
			);
		} else {
			t.unitStopped = out.includes('UNIT-GONE');
			t.configGone = out.includes('CFG-GONE');
			t.listenerGone = out.includes('LISTENER-GONE');
			if (!t.unitStopped) problem(`unit ${o.unit} is still active on ${spec.node} after stop`);
			if (!t.configGone) problem(`${cfg} is still staged on ${spec.node}`);
			if (!t.listenerGone)
				problem(`a Runner.Listener is still running in slot${o.slotIndex} on ${spec.node}`);
		}
	}
	// 3. GitHub: an ephemeral runner deregisters itself after its job, so give it a
	//    moment, then delete whatever is left and VERIFY from the API.
	if (owned.length) {
		const names = new Set(owned.map((o) => o.name));
		try {
			let left: { id: number; name: string }[] = [];
			for (let i = 0; i < 6; i++) {
				left = (await listRunners()).filter((x) => names.has(x.name));
				if (!left.length) break;
				// `d.sleep` with NO signal: abort is already being honoured by the
				// caller returning from the race, not by this cleanup — see this
				// file's own header.
				if (i < 2) await d.sleep(3_000);
				else break;
			}
			for (const x of left) {
				const res = await d.gh.write(
					'DELETE',
					`/actions/runners/${x.id}`,
					NO_TOKEN,
					undefined,
					spec.repo
				);
				if (!res.ok && res.status !== 404)
					problem(`could not deregister ${x.name}: HTTP ${res.status}`);
			}
			const after = (await listRunners()).filter((x) => names.has(x.name));
			for (const t of td.runners) t.deregistered = !after.some((x) => x.name === t.name);
			for (const x of after) problem(`LEAK: ${x.name} is still registered in ${spec.repo}`);
		} catch (e) {
			problem(`could not verify the proof runner is deregistered: ${why(e)}`);
		}
	}
}

/** What `reapStaleProofRunner` found, for the caller's own refusal/finalise shape. */
export type StaleProofOutcome =
	| { kind: 'ok'; cleaned: string[] }
	| { kind: 'refused'; rule: string; message: string }
	| { kind: 'error'; message: string; cleaned: string[] };

/**
 * Cleans up a proof runner an EARLIER run of `prove-job` left behind on
 * `spec.node`, before this run touches anything of its own. A BUSY one or a
 * LIVE one (without `--reap-stale`) refuses outright, same as every other
 * refusal here: nothing has been minted yet, so refusing costs nothing.
 */
export async function reapStaleProofRunner(
	spec: ProveSpec,
	d: ProveDeps,
	liveUnitNames: readonly string[],
	listRunners: () => Promise<ListedRunner[]>
): Promise<StaleProofOutcome> {
	const listed = await listRunners();
	const stale = listed.filter((x) => isProofRunnerName(x.name, spec.node));
	for (const x of stale) {
		if (x.busy) {
			return {
				kind: 'refused',
				rule: 'proof-in-flight',
				message: `${x.name} is BUSY — another proof is running a job on ${spec.node}`,
			};
		}
		if (liveUnitNames.includes(x.name) && !spec.reapStale) {
			return {
				kind: 'refused',
				rule: 'stale-proof-live',
				message: `${x.name} has a LIVE unit on ${spec.node}: another prove-job is running, or one was killed. Re-run with --reap-stale to tear it down`,
			};
		}
	}
	const cleaned: string[] = [];
	for (const x of stale) {
		if (liveUnitNames.includes(x.name)) {
			await d.sh(
				spec.node,
				`XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user stop ${sq(x.name)} 2>/dev/null; true`
			);
		}
		const res = await d.gh.write(
			'DELETE',
			`/actions/runners/${x.id}`,
			NO_TOKEN,
			undefined,
			spec.repo
		);
		if (!res.ok) {
			return {
				kind: 'error',
				message: `could not remove stale proof runner ${x.name}: HTTP ${res.status}`,
				cleaned,
			};
		}
		cleaned.push(x.name);
	}
	return { kind: 'ok', cleaned };
}

/**
 * What `resolveDispatchRef` found. `scratch` is set as soon as a scratch
 * NAME is chosen — before the write that tries to create it — on both
 * branches, so the caller tears it down even when `ok` is `false`: a half
 * -made branch is still litter in the repo. On `ok: false` a finding has
 * already been recorded; the caller finalises as `error`.
 */
export type DispatchRefOutcome =
	{ ok: true; ref: string; scratch: string | null } | { ok: false; scratch: string | null };

/**
 * The branch the run is actually dispatched on: `spec.ref` itself, or a
 * fresh scratch branch made from its head sha when `spec.scratchBranch`
 * asks for one — so a canary job can carry a label nothing else answers
 * without a real branch push.
 */
export async function resolveDispatchRef(
	spec: ProveSpec,
	d: ProveDeps,
	find: (rule: string, message: string) => void,
	read: <T>(what: string, fn: () => Promise<T>) => Promise<T>
): Promise<DispatchRefOutcome> {
	if (!spec.scratchBranch) return { ok: true, ref: spec.ref, scratch: null };
	let sha: string | undefined;
	let hadFinding = false;
	try {
		const head = (await read(`ref ${spec.ref}`, () =>
			d.gh.get(`/git/ref/heads/${encodeURIComponent(spec.ref)}`, NO_TOKEN, spec.repo)
		)) as { object?: { sha?: string } } | null;
		sha = head?.object?.sha;
	} catch (e) {
		find('ref-unreadable', e instanceof Error ? e.message : String(e));
		hadFinding = true;
	}
	if (!sha) {
		if (!hadFinding) find('ref-unreadable', `${spec.ref} has no head sha`);
		return { ok: false, scratch: null };
	}
	const name = scratchBranchName(spec.node, d.now());
	// Before the write, so a half-made branch is still torn down.
	const made = await d.gh.write(
		'POST',
		'/git/refs',
		NO_TOKEN,
		{ ref: `refs/heads/${name}`, sha },
		spec.repo
	);
	if (!made.ok) {
		find('scratch-branch', `could not create ${name} at ${spec.ref}: HTTP ${made.status}`);
		return { ok: false, scratch: name };
	}
	return { ok: true, ref: name, scratch: name };
}
