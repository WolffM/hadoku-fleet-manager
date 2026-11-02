/**
 * WRITES `hadoku-builder` ONTO THE POOL, per node, and folds in the
 * on-demand mint-hold edges (a hold promotes/demotes an on-demand backstop
 * with no label of its own to write). Split out of `backstop-decision.ts`
 * (wave shrink-1 lane B, 800-line ceiling): the one place this tick calls
 * GitHub to change a registration's labels; `backstop-decision.ts`
 * re-exports `applyBackstopLabels` under its original path (it was already
 * private there, so nothing else imports it directly).
 */
import { logger } from '../host.js';
import { ghWrite, type GhRunner } from '../lib/github-client.js';
import { backstopLabelWrite } from './backstop.js';
import { BUILDER_LABEL, nodeOf } from './census.js';

/**
 * COULD NOT LOOK IS NOT AN ORDER. On an unmeasured tick (the first after
 * every restart) `decision.wanted` is the remembered state, and memory is
 * empty after a restart — so this loop and the mint-hold sweep below it
 * DEMOTED a promoted hokon on every deploy, and the next measured tick
 * promoted it again ten minutes later (2026-10-09 20:36, 20:52). Nothing is
 * written until a tick has actually measured the fleet (`unmeasured`).
 */
export async function applyBackstopLabels(args: {
	unmeasured: boolean;
	backstopPool: readonly GhRunner[];
	fleetNodes: readonly string[];
	wantedOnNode: (node: string) => boolean;
	labelsMayPromote: (node: string) => boolean;
	has: (r: GhRunner, label: string) => boolean;
	token: string;
	heldNodes: readonly string[];
	onDemand: (node: string) => boolean;
	wasHeld: ReadonlySet<string>;
}): Promise<{ promoted: string[]; demoted: string[] }> {
	const {
		unmeasured,
		backstopPool,
		fleetNodes,
		wantedOnNode,
		labelsMayPromote,
		has,
		token,
		heldNodes,
		onDemand,
		wasHeld,
	} = args;
	const promoted: string[] = [];
	const demoted: string[] = [];

	for (const runner of unmeasured ? [] : backstopPool) {
		// THE RUNG IS THIS NODE'S, NOT THE FLEET'S. A pool node serving pm2-host
		// work stays off builder duty while the rest of the pool is promoted;
		// fleet-wide, this was the whole pool or none of it.
		const runnerNode = nodeOf(runner.name, fleetNodes);
		const nodeWanted = wantedOnNode(runnerNode) && labelsMayPromote(runnerNode);
		// ONE PREDICATE, shared with the fan-out — see `backstopLabelWrite`.
		// Spelled out twice, the two came to disagree about offline runners.
		const write = backstopLabelWrite(
			{ hasBuilder: has(runner, BUILDER_LABEL), online: runner.status === 'online' },
			nodeWanted
		);
		const missing = [BUILDER_LABEL];
		if (write === 'promote') {
			const res = await ghWrite('POST', `/actions/runners/${runner.id}/labels`, token, {
				labels: missing,
			});
			if (res.ok) {
				for (const l of missing) (runner.labels ??= []).push({ name: l });
				promoted.push(runner.name);
			} else {
				logger.warn(
					`[runner-health] promote ${runner.name} → ${missing.join(',')} failed: HTTP ${res.status} ` +
						'(token may lack runner-admin) — all-claws-down jobs will queue until a claw returns'
				);
			}
		} else if (write === 'demote') {
			// Strip only what we grant. hokon keeps pm2-host, the backstops keep
			// their own label, so the pool returns to being invisible to CI.
			// One label, since hadoku-builder-heavy was retired on 2026-08-19 and no
			// runner reports it any more (checked across four repos, 2026-08-29).
			const res = await ghWrite(
				'DELETE',
				`/actions/runners/${runner.id}/labels/${BUILDER_LABEL}`,
				token
			);
			if (res.ok) {
				runner.labels = (runner.labels ?? []).filter((l) => l.name !== BUILDER_LABEL);
				if (!demoted.includes(runner.name)) demoted.push(runner.name);
			} else {
				logger.warn(
					`[runner-health] demote ${runner.name} (remove ${BUILDER_LABEL}) failed: HTTP ${res.status}`
				);
			}
		}
	}

	for (const n of heldNodes) if (onDemand(n) && !wasHeld.has(n)) promoted.push(`${n} (mint)`);
	for (const n of wasHeld) {
		if (onDemand(n) && !heldNodes.includes(n)) demoted.push(`${n} (mint)`);
	}

	return { promoted, demoted };
}
