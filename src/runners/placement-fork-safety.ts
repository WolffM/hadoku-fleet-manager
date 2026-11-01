/**
 * B8 fork safety — wave 5s lane A split of `placement.ts` (pure move), so
 * that file falls under the 800-line source ceiling.
 *
 * May a runner be minted for this run at all, independent of which node —
 * see `placement.ts` for the capability/order decision this gate sits
 * ahead of. Every name here is re-exported from `placement.ts` so its
 * existing importers compile unchanged.
 */
import type { AdmissionResult } from './ephemeral.js';

export interface RunIdentity {
	/** The repo the workflow belongs to. */
	repository?: { full_name?: string };
	/** Where the CODE came from. Differs from `repository` for a fork PR. */
	head_repository?: { full_name?: string; fork?: boolean };
	event?: string;
}

/**
 * May a runner be minted for this run?
 *
 * **This gate FAILS CLOSED**, unlike every other guard in this workstream. The
 * supersede gate and the throttle both proceed on their own malfunction, because
 * the cost of a false skip there is wasted work. Here the cost of a false ALLOW
 * is executing a stranger's code on a node holding vault credentials, PM2
 * control and the production host — so anything unproven is refused.
 *
 * The fleet already has four controls that stop a fork PR reaching a self-hosted
 * runner (§6), and this deliberately does not rely on any of them. §6's own
 * audit had to be retracted once for reading a comment as a live trigger; a
 * dispatcher that mints from a queued-jobs API is a NEW path those controls were
 * not designed against, and `runs-on` having filtered it is not something the
 * mint can observe.
 */
export function isForkSafe(run: RunIdentity): AdmissionResult {
	// pull_request_target runs base-repo secrets against head-repo code. Nothing
	// in this fleet uses it (check:supply-chain enforces that), so seeing one here
	// means something changed underneath us.
	if (run.event === 'pull_request_target') {
		return { ok: false, reason: 'pull_request_target: base secrets, head code' };
	}
	const base = run.repository?.full_name;
	const head = run.head_repository?.full_name;
	if (!base) return { ok: false, reason: 'run has no repository — cannot prove it is first-party' };
	// A run with no head_repository is not a code-bearing PR event (schedule,
	// workflow_dispatch, repository_dispatch). Those are first-party by
	// construction: only someone with write access can trigger them.
	if (head === undefined) return { ok: true };
	if (run.head_repository?.fork === true) {
		return { ok: false, reason: `head repository ${head} is a fork` };
	}
	if (head !== base) {
		return { ok: false, reason: `head repository ${head} is not ${base}` };
	}
	return { ok: true };
}
