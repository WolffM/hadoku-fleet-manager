/**
 * THE DRAIN-AND-WAIT PRIMITIVE — drain a node, wait until it is actually
 * quiet, undrain it — shared by two domains: lifecycle's own toolchain
 * cadence (`refresh-cycle.mjs`, reboot-claws, bootcamp's idle/canary checks)
 * and observation's `benchmark-fleet.mjs --cadence`, which asks the identical
 * "is it busy / can I drain it / put it back" questions before measuring a
 * node on its own nightly schedule.
 *
 * MOVED OUT of `refresh-cycle.mjs`/`refresh-cycle-live.mjs` (wave clean-2
 * lane C, cut (iii) layer debt): both of those are classified lifecycle, and
 * `benchmark-fleet.mjs` (observation) importing `busyCount`/`createLiveDeps`/
 * `waitUntilDrained` straight from them crossed the domain boundary cut
 * (iii) forbids. Classified observation/run here instead — the same
 * stratum `expected-down.mjs`'s `readDrains` already sits in — which is what
 * lets BOTH a lifecycle file (index below observation) and an observation
 * file (the same index) import it legally, while the primitive itself still
 * reaches `readDrains` (also observation) without pointing back up at
 * lifecycle. `refresh-cycle.mjs` and `refresh-cycle-live.mjs` re-export every
 * name here unchanged, so every existing importer of THOSE files keeps
 * compiling and behaving byte-identically.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { readDrains } from './expected-down.mjs';
import { nodeHostsSessions, runOnSync } from './fleet-exec.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');

/** How long to wait for a node to go quiet before giving up and putting it back. */
export const DRAIN_TIMEOUT_MS = 45 * 60_000;
export const POLL_MS = 15_000;
/**
 * A standing node's `hadoku-builder` label is stripped on the fast loop's NEXT
 * tick (~60s), so zero jobs at one instant is not quiet: a job can still be
 * assigned before the strip lands. Zero must HOLD for longer than a tick.
 */
export const SETTLE_MS = 90_000;

/**
 * CI job count on a node, or null for "could not look" (treated as busy).
 * Sessions are added by {@link busyCount}, which is what the waiters call.
 *
 * EXPORTED (wave 3x, #87) so `benchmark-fleet.mjs`'s cadence mode can ask the
 * same question before committing to a drain, rather than growing a second
 * "is this node busy" prober. No behaviour change — this is the function
 * `createLiveDeps()` already wired into `waitUntilDrained` below.
 */
export function jobCount(node) {
	// AS THE CI ROLE: the jobs are ci's processes. claw-1, claw-2 and claw-3
	// mount /proc `hidepid=invisible`, so admin's pgrep there counts 0 with jobs
	// running (measured 11-06: claw-1 admin 0, ci 3; claw-3 admin 0, ci 1), and
	// a reboot on 10-31 passed this check with two jobs live (fleet-manager#68).
	const res = runOnSync(node, 'pgrep -c -f "[R]unner\\.Worker" || true', {
		as: 'ci',
		timeoutMs: 20_000,
		connectTimeout: 6,
	});
	if (!res.ok) return null;
	const n = parseInt(String(res.out).trim().split('\n')[0], 10);
	return Number.isFinite(n) ? n : null;
}

/**
 * A LIVE SESSION IS ACTIVE WORK (operator, 2026-11-19). On a node whose
 * manifest names `users.dev`, the operator runs Claude sessions as that user
 * (herdr, `docs/herdr.md`). A drain stops new CI work; it never stopped a
 * session, and before this a reboot cycle read a node with a session and no
 * job as idle.
 *
 * A session is a `claude` process owned by the dev user. Read AS DEV, which
 * sees its own processes on a hidepid node (admin and ci may not). A long
 * build in a herdr pane with no claude in it is not counted.
 *
 * THE CAP (operator, 2026-11-21): a session holds a node off for at most
 * SESSION_CAP_SEC. One older than that is reported as past the cap and no
 * longer counted, so the cycle goes ahead and says why. "Nothing should take
 * that long anyway": a day-old claude is an abandoned pane, not work.
 */
export const SESSION_CAP_SEC = 24 * 3600;

/** One `SESSIONS <live> <past-cap>` line. `ps x`: every process of the user it runs as, tty or not. */
export const SESSION_SCRIPT = [
	`ps x -o comm=,etimes= | awk -v cap=${SESSION_CAP_SEC} '$1 == "claude" { if ($2 + 0 < cap) live++; else over++ } END { printf "SESSIONS %d %d\\n", live, over }'`,
	'',
].join('\n');

/** `{ live, pastCap }` from {@link SESSION_SCRIPT}'s output, or null when the line is missing. */
export function parseSessions(out) {
	const m = /^SESSIONS (\d+) (\d+)$/m.exec(String(out ?? ''));
	return m ? { live: Number(m[1]), pastCap: Number(m[2]) } : null;
}

/**
 * Sessions on `node`: `{ live, pastCap }`, `{ live: 0, pastCap: 0 }` on a node
 * that hosts none (nothing to read), or null for "could not look" (busy).
 */
export function sessionCount(node, { hosts = nodeHostsSessions, run = runOnSync } = {}) {
	if (!hosts(node)) return { live: 0, pastCap: 0 };
	const res = run(node, SESSION_SCRIPT, { as: 'dev', timeoutMs: 20_000, connectTimeout: 6 });
	return res.ok ? parseSessions(res.out) : null;
}

/**
 * Jobs plus live sessions: the one "how much active work is on this node"
 * number every drain waiter reads. null if either could not be read.
 */
export function busyCount(node, { jobs = jobCount, sessions = sessionCount } = {}) {
	const j = jobs(node);
	if (j === null) return null;
	const s = sessions(node);
	if (s === null) return null;
	return j + s.live;
}

/** `fleet drain <args>`, as `{ ok, reason? }`. Also the reboot cycle's (lib/reboot-cycle.mjs) one way to drain. */
export function drainCli(args) {
	try {
		execFileSync(process.execPath, [join(SCRIPTS, 'drain-node.mjs'), ...args], {
			encoding: 'utf8',
			timeout: 60_000,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { ok: true };
	} catch (e) {
		return {
			ok: false,
			reason: String(e.stderr || e.message)
				.trim()
				.slice(0, 300),
		};
	}
}

/** Whether `fleet drain` currently holds `node`, from the one state file both callers read. */
export function isDrained(node) {
	return Boolean(readDrains()[node]);
}

/** Drain `node`, THROWING on refusal — the shape `createLiveDeps().drain` and the benchmark cadence both need. */
export function drain(node, { kind, reason }) {
	const r = drainCli([node, '--reason', reason, '--kind', kind]);
	if (!r.ok) throw new Error(r.reason);
	return r;
}

/** `fleet drain <node> --undo`. */
export function undrain(node) {
	return drainCli([node, '--undo']);
}

/**
 * Poll `busy(node)` until it has read ZERO continuously for `settleMs`.
 * `busy` returns a job count, or null for "could not look", which is BUSY.
 * Pure over an injected clock `{ now(), sleep(ms) }`.
 */
export async function waitUntilDrained({
	node,
	busy,
	clock,
	timeoutMs = DRAIN_TIMEOUT_MS,
	pollMs = POLL_MS,
	settleMs = SETTLE_MS,
}) {
	const start = clock.now();
	let quietSince = null;
	let last = 'no reading';
	for (;;) {
		const n = await busy(node);
		if (n === 0) {
			quietSince ??= clock.now();
			if (clock.now() - quietSince >= settleMs) return { drained: true };
			last = `idle for ${clock.now() - quietSince} ms of the ${settleMs} ms settle`;
		} else {
			quietSince = null;
			last =
				n === null
					? 'could not count running jobs and sessions (treated as busy)'
					: `${n} job(s) or session(s) running`;
		}
		if (clock.now() - start >= timeoutMs) {
			return { drained: false, reason: `not drained after ${timeoutMs} ms: ${last}` };
		}
		await clock.sleep(pollMs);
	}
}
