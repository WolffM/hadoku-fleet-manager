/**
 * runner-identity-diff — GitHub's belief about a repo's registrations,
 * diffed against the node-side install/unit truth `reconcile-runner-identity.mjs`
 * already probed.
 *
 * Moved out of `reconcile-runner-identity.mjs` (wave shrink-1 lane D), body
 * unchanged. See that file's own header for ONE INVARIANT, TWO FAILURES and
 * the warm-registration note (#112, after #61/#103) on why a WARM name is
 * backed by a unit, never an install dir.
 */

import { deferralFor, deferralNote } from './expected-down.mjs';
import { readRunners, mintAgeMs } from './runner-identity-reads.mjs';
import { WARM_PREFIX } from '../../dist/lib/jit-naming.js';
import { nodeOf } from '../../dist/runners/census.js';

/**
 * The name prefix that marks a registration as OURS and disposable.
 * Anything minted by the dispatcher must carry it; anything not carrying it is
 * treated as a persistent runner and is never deleted by this tool.
 */
export const JIT_PREFIX = 'jit-';

/**
 * @param {{repos: string[], fleetWide: boolean, nodes: string[], installs: Map,
 *   jitUnits: Map, warmUnits: Map, drains: object, nowMs: number,
 *   graceMs: number, unreapedAfterMs: number}} args
 */
export async function diffGithubBelief({
	repos,
	fleetWide,
	nodes,
	installs,
	jitUnits,
	warmUnits,
	drains,
	nowMs,
	graceMs,
	unreapedAfterMs,
}) {
	const ghosts = [];
	const jitOrphans = [];
	/** Online JIT orphans older than unreapedAfterMs — the sweep is not clearing them. */
	const unreaped = [];
	/** Minted within graceMs — too young to judge, reported so the skip is visible. */
	const young = [];
	const noInstall = [];
	/** Registered-no-install rows held back because the node is drained ON PURPOSE. */
	const expectedDown = [];
	const unreadableRepos = [];
	/** Warm registrations the snapshot did not back — judged after a second look. */
	const warmSuspects = [];

	// The registration-side rules need a COMPLETE picture of the fleet: "no node
	// holds an install for this repo" and "no node has a live listener" are both
	// claims about every node at once. Under --machine the probe saw one box, so
	// every install on the others is missing from `installs` and both rules fire on
	// the whole fleet. Caught by a mutation test that ran clean fleet-wide and then
	// reported a healthy claw-2 runner as install-less under --machine hokon.
	for (const repo of fleetWide ? repos : []) {
		const listing = await readRunners(repo);
		if (!listing.ok) {
			unreadableRepos.push({ repo, reason: listing.reason });
			continue;
		}
		for (const r of listing.runners) {
			const isJit = r.name.startsWith(JIT_PREFIX);

			// A WARM registration is backed by a transient unit on the node its name
			// carries, never by an install dir (#112, after #61/#103). Falling through
			// to the install check reported every live warm listener the warm cache
			// had rotated in since that node was probed: the nodes are probed one by
			// one BEFORE any listing is read, and the 2026-10-15 13:18Z red was two
			// listeners minted at 13:15:20, mid-sweep.
			if (r.name.startsWith(WARM_PREFIX)) {
				const node = nodeOf(r.name, nodes);
				if (!warmUnits.get(node)?.has(`${r.name}.service`))
					warmSuspects.push({ repo, name: r.name, id: r.id, status: r.status, node });
				continue;
			}
			const local = (installs.get(r.name) ?? []).filter((i) => i.repo === repo);
			const liveHere = local.some((i) => i.alive);

			// A JIT registration is backed by a transient unit, not an install dir.
			const jitLive = isJit && [...jitUnits.values()].some((s) => s.has(`${r.name}.service`));

			if (isJit && !jitLive) {
				const age = mintAgeMs(r.name, nowMs);
				if (age < graceMs) {
					young.push({ repo, name: r.name, ageMs: age });
				} else {
					jitOrphans.push({ repo, name: r.name, id: r.id, status: r.status, ageMs: age });
					if (r.status === 'online' && age > unreapedAfterMs)
						unreaped.push({ repo, name: r.name, ageMs: age });
				}
				continue;
			}
			if (isJit) continue;

			// A registration exists for this repo, but no node holds an install
			// configured against it. Either the install was removed without
			// deregistering, or its identity was overwritten — the 2026-08-26
			// signature. Report the nodes that DO carry this runner name so the
			// reader can see which box to look at, not the 26 repos it also serves.
			if (!local.length) {
				// A persistent registration is named for the node that holds it, so the
				// drain record can be asked about it by name. Only an OFFLINE one: a
				// drained node reporting `online` with nothing listening is a black hole
				// wearing a drain as a disguise, and it fails here exactly as it would on
				// any other node.
				const defer = r.status === 'online' ? null : deferralFor(r.name, drains);
				if (defer?.deferred) {
					expectedDown.push({
						repo,
						node: r.name,
						status: r.status,
						why: deferralNote(r.name, defer),
					});
					continue;
				}
				const carriers = [...new Set((installs.get(r.name) ?? []).map((i) => i.machine))];
				noInstall.push({ repo, name: r.name, status: r.status, carriers });
				continue;
			}

			if (r.status === 'online' && !liveHere) {
				ghosts.push({ repo, name: r.name, id: r.id, busy: r.busy === true });
			}
		}
	}

	return {
		ghosts,
		jitOrphans,
		unreaped,
		young,
		noInstall,
		expectedDown,
		unreadableRepos,
		warmSuspects,
	};
}
