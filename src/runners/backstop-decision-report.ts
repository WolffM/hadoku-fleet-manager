/**
 * WHY THE BACKSTOP IS — OR IS NOT — TAKING WORK, SAID EVERY TICK. Split out
 * of `backstop-decision.ts` (wave shrink-1 lane B, 800-line ceiling): pure
 * reporting (logger calls only, no label writes, no fan-out) over the
 * decision `runBackstopDecision` already made. `backstop-decision.ts`
 * re-exports `logBackstopEligibility` under its original path (it was
 * already private there, so nothing else imports it directly).
 */
import { logger } from '../host.js';
import {
	explainBackstop,
	describeSaturationHost,
	type BackstopInput,
	type BackstopDecision,
	type SaturationHostVerdict,
} from './backstop.js';
import { nodeIsSick } from '../lib/sick-node.js';
import { isDraining, type DrainState } from './drain.js';
import { BUILDER_LABEL } from './census.js';

/**
 * WHY THE PRODUCTION HOST IS REACHABLE, ON THE TICK IT IS REACHABLE.
 *
 * Until now the only lines this decision ever printed were its two EDGES,
 * the promote and the demote. Everything in between — the whole interval
 * during which hokon actually takes jobs — was silent, and a standing
 * registration wins GitHub's assignment race outright (hokon builder queue
 * p50 2s against a claw JIT's 16s), so that interval is where all the
 * traffic is. Over 2026-09-10 → 09-19 hokon served 204 `hadoku-builder`
 * jobs, 98 of them with ZERO claw jobs running anywhere, and there is not
 * one promote line in any retained log to explain a single one: the label
 * came from elsewhere and this function never knew. An operator asking
 * "why did hokon take that job" had nothing to read.
 *
 * So the eligible state says so every tick, and it says it through
 * `explainBackstop`, which lives beside the decision — a log line written
 * here by hand is a second copy of the reasoning and drifts from it. Six
 * lines an hour, and only while the reserve is actually in play.
 *
 * Returns `why` (`explainBackstop`'s own reasoning string) so the caller can
 * reuse it in the demote line later in the same tick without asking twice.
 */
export function logBackstopEligibility(args: {
	backstopInput: BackstopInput;
	decision: BackstopDecision;
	backstopWanted: boolean;
	heldNodes: readonly string[];
	outage: boolean;
	saturationHost: (node: string) => SaturationHostVerdict;
	queuePressureSec: number;
	backstopNodes: readonly string[];
	drain: DrainState;
	pm2BusyNodes: ReadonlySet<string>;
}): string {
	const {
		backstopInput,
		decision,
		backstopWanted,
		heldNodes,
		outage,
		saturationHost,
		queuePressureSec,
		backstopNodes,
		drain,
		pm2BusyNodes,
	} = args;
	const why = explainBackstop(backstopInput, decision);
	if (backstopWanted && heldNodes.length) {
		logger.info(
			`[runner-health] BACKSTOP ELIGIBLE — ${heldNodes
				.map((n) =>
					outage ? n : `${n} (${describeSaturationHost(saturationHost(n), queuePressureSec)})`
				)
				.join(', ')} may take '${BUILDER_LABEL}' work: ${why}`
		);
	} else if (backstopWanted) {
		// WANTED AND REACHED NOBODY. "We rejected them" and "they never asked"
		// are different facts and the fleet could not tell them apart (wave 3l);
		// so is "every holder is quarantined" against "every holder is serving
		// pm2-host", which are two different jobs for the operator. Say which,
		// per node.
		//
		// NOT IDLE IS THE COMMON REASON AND IT READ `unknown`. The host gate
		// (`hostMayTakeSaturation`, 2026-10-09/21) is the fourth clause of
		// `wantedOnNode`, and this map named the other three. On 2026-10-21
		// hokon sat at load 30-46 on 12 cores under the operator's own sessions
		// while a 20-run fan-out queued for 25 minutes, and every tick printed
		// `hokon=unknown` — the one word that sends an operator to the wrong
		// problem. The verdict carries its own measurement against the gate, so
		// the line says what would have to change.
		const because = backstopNodes.length
			? backstopNodes
					.map((n) => {
						const host = saturationHost(n);
						return `${n}=${
							nodeIsSick(n)
								? 'quarantined'
								: isDraining(n, drain)
									? 'drained'
									: pm2BusyNodes.has(n)
										? 'serving pm2-host'
										: !host.ok
											? host.why
											: 'unknown'
						}`;
					})
					.join(', ')
			: 'the pool is EMPTY — no runner in this repo carries pm2-host or backstop';
		logger.warn(
			`[runner-health] BACKSTOP wanted but REACHED NOBODY (${because}): ${why} — ` +
				'jobs queue until a claw returns or a holder frees up'
		);
	} else if (decision.unmeasured) {
		// "I could not look" must never render as "nothing is wrong", and it
		// must say WHY. This branch decided nothing at all.
		logger.info(`[runner-health] BACKSTOP could not look: ${why}`);
	}
	return why;
}
