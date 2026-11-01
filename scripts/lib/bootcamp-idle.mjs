/**
 * `fleet bootcamp`'s PASS 2 — split out of scripts/bootcamp.mjs (wave 5p lane
 * D) so the CLI stays under the 800-line ceiling. Takes the CLI's flags and
 * run-scoped state through `ctx`, including the CLI-local `probe` function
 * (never imported — it is one of the two places bootcamp calls `runOn`, kept
 * in the CLI file for `expected-down-guard.test.mjs`'s scan).
 */
import process from 'node:process';
import { underIdleHold } from './proof-drain.mjs';
import { busyCount, waitUntilDrained, createLiveDeps } from './refresh-cycle.mjs';

/**
 * PASS 2 — `--write` RE-TAKES every idle-only measurement PASS 1 took beside a
 * live job, on a node it has DRAINED and waited out. ONE NODE AT A TIME, in
 * manifest order: draining every claw at once to measure them in parallel would
 * stop the fleet's CI for the length of the slowest wait.
 *
 * WHY ONLY THE BUSY ONES. The probe counts live `Runner.Worker`s once a second
 * for the whole measurement (`LOAD`), and a node that read zero throughout WAS
 * idle — the drain is how bootcamp tries to get that zero, not the evidence for
 * it. Draining a node that is already quiet buys nothing and costs a settle.
 *
 * WHY ONLY UNDER `--write`. A drain takes a node out of service; a read-only run
 * that did that would be a surprise to anyone who typed `fleet bootcamp` to
 * look. Without `--write` a busy measurement is reported as unjudged, carried,
 * and not counted — nothing is being recorded on it.
 */
export async function runIdlePass2(ctx) {
	if (!ctx.WRITE) return;
	const { nodes, probed, IDLE_ONLY, IDLE_TIMING, idleHolds, log, probe } = ctx;
	const hold = { held: null };
	const live = createLiveDeps();
	// A process killed mid-wait must not leave the node out of service. The drain
	// is dated and `fleet drain --status` would show it, but nothing would lift it.
	for (const sig of ['SIGINT', 'SIGTERM']) {
		process.once(sig, () => {
			if (hold.held) live.undrain(hold.held);
			process.exit(sig === 'SIGINT' ? 130 : 143);
		});
	}
	for (const [name] of nodes) {
		const got = probed[name];
		if (!got) continue;
		const busyIds = IDLE_ONLY.filter((id) => got.caps[id] && got.load[id] !== 0);
		if (!busyIds.length) continue;
		log(
			`── ${name}  ${busyIds.join(', ')} measured beside a live job — draining to re-measure idle ` +
				`(waits up to ${Math.round(IDLE_TIMING.timeoutMs / 60_000)} min)`
		);
		let outcome;
		try {
			outcome = await underIdleHold(
				name,
				busyIds,
				{
					isDrained: live.isDrained,
					drain: live.drain,
					undrain: live.undrain,
					waitQuiet: (node) =>
						waitUntilDrained({
							node,
							busy: busyCount,
							clock: { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
							...IDLE_TIMING,
						}),
				},
				() => probe(name, 'measured'),
				hold
			);
		} catch (e) {
			outcome = { status: 'inconclusive', reason: `the idle hold failed: ${e.message}` };
		}
		if (outcome.status === 'measured' && outcome.result === null) {
			outcome = {
				...outcome,
				status: 'inconclusive',
				reason: 'unreachable during the idle re-measurement',
			};
		}
		if (outcome.status === 'measured') {
			for (const id of busyIds) {
				const again = outcome.result.caps[id];
				if (!again) continue;
				got.caps[id] = again;
				got.load[id] = id in outcome.result.load ? outcome.result.load[id] : null;
			}
		}
		const { status, reason, heldBy, undrainFailed } = outcome;
		idleHolds[name] = { status, reason, heldBy, undrainFailed, capabilities: busyIds };
	}
}
