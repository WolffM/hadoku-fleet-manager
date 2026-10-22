/**
 * The drain around a workload canary, decided in one place for both sides:
 * `fleet bootcamp --prove` (which drains the node) and `fleet prove-job`
 * (which mints the canary's runner onto it).
 *
 * WHY THIS EXISTS (2026-10-08). As wave 4e landed it, `--prove` could never
 * record a proof:
 *   1. It skipped a node with any job running BEFORE draining it. On a working
 *      fleet a claw is rarely idle (claw-4/8/9 had 1–2 jobs each at the first
 *      attempt), so the canary never ran.
 *   2. When a node WAS idle, bootcamp drained it, and then `prove-job`'s
 *      admission (`admitMint`) refused the mint because the node was drained.
 *      The drain meant to protect the canary blocked it.
 * The tracker found both by reading the code after the first live attempt
 * skipped all three claws.
 *
 * The rule: bootcamp drains FIRST and waits for quiet. Being busy is a reason
 * to wait, not to skip. `prove-job`, told `--under-own-drain`, treats the node
 * as undrained ONLY when the drain row is bootcamp's own canary drain (kind
 * `training`, reason with {@link OWN_DRAIN_REASON_PREFIX}). A maintenance drain,
 * or anyone else's, still refuses. The flag is a claim the drain file must
 * back; it is not a bypass.
 */

/** The reason prefix bootcamp writes on its canary drain. */
export const OWN_DRAIN_REASON_PREFIX = 'fleet bootcamp --prove:';

/**
 * What `--prove` does with one node before a canary.
 *
 * @param {{ alreadyDrained: boolean|null, busy: number|null }} s
 *   `alreadyDrained`: is there a drain row before we write ours (null: could
 *   not read). `busy`: running jobs (null: could not reach the node).
 * @returns {{ action: 'drain' } | { action: 'skip', reason: string }}
 */
export function canaryPlan({ alreadyDrained, busy }) {
	if (alreadyDrained) return { action: 'skip', reason: 'already drained by someone else' };
	if (busy === null)
		return { action: 'skip', reason: 'could not reach it to check for running jobs' };
	// Busy is NOT a skip: the drain stops new work, and `waitUntilDrained` lets
	// the running jobs finish before the canary starts.
	return { action: 'drain' };
}

/**
 * Whether `prove-job` should treat the node as drained.
 *
 * @param {{ kind?: string, reason?: string } | undefined} row  the node's drain
 *   row, or undefined when the node is not drained
 * @param {boolean} underOwnDrain  `--under-own-drain` was passed
 * @returns {{ drained: boolean } | { error: string }}
 */
export function proofDrainState(row, underOwnDrain) {
	if (!underOwnDrain) return { drained: Boolean(row) };
	if (!row) {
		return {
			error:
				'--under-own-drain was given but the node is not drained — the canary would ' +
				'share the node with production work and its duration would set a skewed budget',
		};
	}
	const own =
		row.kind === 'training' &&
		typeof row.reason === 'string' &&
		row.reason.startsWith(OWN_DRAIN_REASON_PREFIX);
	if (!own) {
		return {
			error:
				`--under-own-drain was given but the drain is not bootcamp's canary drain ` +
				`(kind=${row.kind ?? 'unset'}, reason=${JSON.stringify(row.reason ?? '')}) — ` +
				'someone else holds this node out of service',
		};
	}
	return { drained: false };
}

/**
 * The reason prefix bootcamp writes on the drain it takes to MEASURE an
 * idle-only capability (2026-10-10). Deliberately NOT
 * {@link OWN_DRAIN_REASON_PREFIX}: that one is a claim `prove-job
 * --under-own-drain` honours to mint a canary, and a measurement drain must
 * not be able to make it.
 */
export const MEASURE_DRAIN_REASON_PREFIX = 'fleet bootcamp: idle measurement:';

const reasonOf = (e) => (e instanceof Error ? e.message : String(e));

/**
 * Run `measure()` on a node held IDLE: the same drain → wait-for-quiet →
 * act → undrain shape `--prove` uses for a canary, for a measurement that is
 * worthless beside a running job (`cargo-bevy`; `measuredIdleOnly`).
 *
 * WHY (2026-10-10). claw-4 scored 2281 on the all-core compile benchmark idle
 * and 1169 beside CI; claw-6 1529 and 1024. `bootcamp --write` measured
 * whenever it was invoked, so whether a node earned the label depended on
 * what CI happened to be running — unfair in both directions.
 *
 * THE RULES, each a branch below:
 *   - someone else's drain is LEFT ALONE: never rewritten, never lifted. It
 *     already stops new work, so we wait for quiet under it and measure. (The
 *     refresh cycle re-bootcamps a node it holds; this is that path.)
 *   - a drain state we cannot read is INCONCLUSIVE, not "not drained": writing
 *     a row over a file nobody can parse is how a hold gets lost.
 *   - a drain that fails or is refused (`drain-node`'s capacity guard) is
 *     inconclusive — and if the write landed anyway, it is undone.
 *   - a node that never goes quiet within the bound is inconclusive. Nothing is
 *     measured: "busy" must never become a reading.
 *   - OUR drain is lifted on EVERY path after it lands, `measure()` throwing
 *     included. An undrain that fails is returned as `undrainFailed` for the
 *     caller to say loudly — the node is still out of service.
 *
 * `state.held` names the node while OUR drain is on it, so a signal handler can
 * put it back if the process dies mid-wait (refresh-cycle's same field).
 *
 * @param {string} node
 * @param {string[]} ids  the capabilities being measured, for the drain reason
 * @param {{
 *   isDrained: (node: string) => boolean | Promise<boolean>,
 *   drain: (node: string, o: { kind: string, reason: string }) => unknown,
 *   undrain: (node: string) => unknown,
 *   waitQuiet: (node: string) => Promise<{ drained: boolean, reason?: string }>,
 * }} deps
 * @param {() => Promise<unknown>} measure
 * @param {{ held?: string | null }} [state]
 * @returns {Promise<
 *   | { status: 'measured', result: unknown, heldBy: 'bootcamp' | 'someone-else', undrainFailed?: string }
 *   | { status: 'inconclusive', reason: string, undrainFailed?: string }
 * >}
 */
export async function underIdleHold(node, ids, deps, measure, state = {}) {
	let already;
	try {
		already = await deps.isDrained(node);
	} catch (e) {
		return { status: 'inconclusive', reason: `could not read the drain state: ${reasonOf(e)}` };
	}
	if (already) {
		const w = await deps.waitQuiet(node);
		if (!w.drained) {
			return {
				status: 'inconclusive',
				reason: `held by someone else's drain and never went quiet: ${w.reason ?? 'timed out'}`,
			};
		}
		return { status: 'measured', result: await measure(), heldBy: 'someone-else' };
	}

	let refused = null;
	try {
		const d = await deps.drain(node, {
			kind: 'training',
			reason: `${MEASURE_DRAIN_REASON_PREFIX} ${ids.join(', ')} (returns when measured)`,
		});
		if (d && typeof d === 'object' && 'ok' in d && d.ok === false) {
			refused = `drain refused: ${d.reason ?? 'no reason given'}`;
		}
	} catch (e) {
		refused = `drain failed: ${reasonOf(e)}`;
	}
	if (refused) {
		// The write may have landed before the failure surfaced; undo only that.
		let landed;
		try {
			landed = await deps.isDrained(node);
		} catch {
			landed = true; // cannot tell, so assume it did and try to undo
		}
		const undo = landed ? await liftHold(node, deps) : {};
		return { status: 'inconclusive', reason: refused, ...undo };
	}

	state.held = node;
	let outcome;
	try {
		const w = await deps.waitQuiet(node);
		outcome = w.drained
			? { status: 'measured', result: await measure(), heldBy: 'bootcamp' }
			: { status: 'inconclusive', reason: `never went quiet: ${w.reason ?? 'timed out'}` };
	} finally {
		const undo = await liftHold(node, deps);
		state.held = null;
		if (outcome) Object.assign(outcome, undo);
	}
	return outcome;
}

/** Undrain; `{}` on success, `{ undrainFailed }` carrying the reason otherwise. */
async function liftHold(node, deps) {
	try {
		const r = await deps.undrain(node);
		if (r && typeof r === 'object' && 'ok' in r && r.ok === false) {
			return { undrainFailed: r.reason ?? 'undrain refused' };
		}
		return {};
	} catch (e) {
		return { undrainFailed: reasonOf(e) };
	}
}
