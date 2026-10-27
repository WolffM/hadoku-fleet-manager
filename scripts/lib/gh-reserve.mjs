/**
 * The GitHub reserve every bulk gate honours (fleet-manager#9).
 *
 * The 5,000/h core limit belongs to the GitHub USER, not to a token. The host
 * `gh` login, HADOKU_SITE_TOKEN and every workflow PAT draw on one pool, so a
 * gate that spends it blinds runner-health, dispatch and minting for the rest
 * of the hour. On 2026-10-25 the pool went from 155 used at 05:05Z to 5,000 at
 * 05:30Z; one `ci:audit-gates` run costs ~650 (fleet-coverage 439,
 * history-coverage 168, runner-identity 30), and three manual runs in 45
 * minutes were most of the spend.
 *
 * mgmt-api's own loops are NOT gated here. Measured the same day, a whole
 * window of theirs charged tens of calls; nearly all of it is free 304s
 * (`gh-budget.ts`). The spend that blinds the fleet comes from bulk readers in
 * other processes, so the rule lives where those processes can read it.
 *
 * THE RULE: before spending, read `GET /rate_limit`, which GitHub does not
 * charge. Under `GH_RESERVE` calls left, the gate does not run and FAILS with
 * the reason: "I could not look" is never a pass (AGENTS.md). hadoku_site's
 * `ci:audit-gates` applies the same 1,500 before each gate (hadoku_site
 * 94f39e95); this is the same floor for every other way these gates run,
 * including by hand.
 *
 * AN UNREADABLE BUDGET DOES NOT REFUSE. A `gh` that cannot answer
 * `/rate_limit` will fail the gate's own first call, and that failure names
 * the real fault. Refusing here would report a broken `gh` as a spent budget.
 *
 * `FLEET_GH_RESERVE` overrides the floor for one run (`0` turns it off), for
 * an operator who has decided the run is worth part of the reserve.
 */
import { execFileSync } from 'node:child_process';

/** Calls held back for runner-health, dispatch and minting. Same as hadoku_site's `GITHUB_RESERVE`. */
export const GH_RESERVE = 1500;

const READ_TIMEOUT_MS = 15_000;

/** The floor for this run: `FLEET_GH_RESERVE` when it is a whole number, else `GH_RESERVE`. */
export function reserveFloor(env = process.env) {
	const raw = env.FLEET_GH_RESERVE;
	if (raw === undefined || raw === '') return GH_RESERVE;
	const n = Number(raw);
	return Number.isInteger(n) && n >= 0 ? n : GH_RESERVE;
}

/**
 * The core pool as `gh` sees it: `{ remaining, resetAtMs }`, or `null` when it
 * cannot be read.
 */
export function readCorePool() {
	try {
		const out = execFileSync(
			'gh',
			['api', 'rate_limit', '-q', '.resources.core | "\\(.remaining) \\(.reset)"'],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: READ_TIMEOUT_MS }
		);
		const [remaining, reset] = out.trim().split(/\s+/).map(Number);
		if (!Number.isInteger(remaining) || !Number.isFinite(reset)) return null;
		return { remaining, resetAtMs: reset * 1000 };
	} catch {
		// Deliberately null, not a refusal: see "an unreadable budget" above.
		return null;
	}
}

/**
 * May a bulk gate named `gate` spend now? `{ ok: true }`, or `{ ok: false,
 * reason }` with the reason to fail on.
 */
export function checkGhReserve(gate, { floor = reserveFloor(), read = readCorePool } = {}) {
	if (floor === 0) return { ok: true, remaining: null, floor };
	const pool = read();
	if (pool === null) return { ok: true, remaining: null, floor };
	if (pool.remaining >= floor) return { ok: true, remaining: pool.remaining, floor };
	const reset = new Date(pool.resetAtMs).toISOString().slice(11, 16);
	return {
		ok: false,
		remaining: pool.remaining,
		floor,
		reason:
			`${gate} NOT RUN: ${pool.remaining} GitHub calls left in the shared pool, under the ` +
			`${floor} held for runner-health, dispatch and minting (fleet-manager#9). This is ` +
			`"could not look", not a pass. The pool resets at ${reset}Z; FLEET_GH_RESERVE=0 ` +
			'overrides it for one run.',
	};
}
