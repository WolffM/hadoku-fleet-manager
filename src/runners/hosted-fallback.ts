import { withGhCaller } from '../gh-budget.js';
import { logger } from '../host.js';
import { syncHostedFallback } from '../ci-runner-fallback.js';
import { alertOnce, clearAlert } from '../lib/alert-ledger.js';
import { TICK_INTERVAL_MS, OFFLINE_TICKS_BEFORE_ALERT } from '../lib/runner-health-shared.js';
import type { TickReport } from '../runner-health-snapshot.js';

/**
 * Repo → consecutive ticks its CI_RUNNER write has FAILED.
 *
 * Counted rather than alerted on sight for the same reason the label floor is:
 * a 403 from a token whose scope was revoked is permanent and worth waking
 * someone for, a 502 from GitHub's control plane is neither. Two ticks is 20
 * minutes, which no transient survives and every real one does.
 */
const ciRunnerWriteFailTicks = new Map<string, number>();

// Repos currently flipped to hosted. Process-local, and deliberately so: it is a
// CHANGE-detector for alerting, not the source of truth. The GitHub variable is
// the truth.
//
// This set is EMPTY after a restart, and empty means "unknown", not "nothing is
// hosted". `syncHostedFallback` therefore ignores it on the first pass of a new
// process and writes through — without that, a restart during a hosted window
// left every repo pinned to billed runners with nothing able to clear it, which
// is exactly what happened on 2026-08-17. Do not reintroduce a skip that treats
// this set as authoritative before the first reconcile.
const hostedRepos = new Set<string>();

export async function runHostedFallback(args: {
	token: string;
	ephemeralUnknown: boolean;
	clawsOnline: number;
	backstopOnline: number;
	data: TickReport;
}): Promise<void> {
	const { token, ephemeralUnknown, clawsOnline, backstopOnline, data } = args;
	// --- Hosted-runner fallback (CI_RUNNER across the whole fleet) ---
	// Now a genuine LAST resort. The hokon backstop above is fleet-wide (see
	// syncBackstopAcrossFleet), so counting hokon as self-hosted capacity here
	// finally describes capacity every repo can actually reach — which is what
	// this sum always assumed and, until 2026-08-23, never had.
	//
	// Driven purely by runner availability — never by a job's outcome — so a red
	// build is never retried or masked.
	try {
		// Escalation order is claws → hokon → GitHub-hosted. Hosted is the LAST
		// resort, not the second: it costs billed minutes on 12 private repos,
		// and a hosted runner cannot reach the vault (the fetch comes back as a
		// CF challenge, which is what broke auto-format on 2026-08-17). So the
		// fallback is driven by TOTAL self-hosted capacity — claws plus the
		// promoted hokon pool — and only flips when both are gone.
		// `null`, not the sum, when the probe has not run. Under all-JIT both
		// terms are derived from it, so on the first tick after a restart this
		// sum is not a small reading — it is no reading at all. `census` already
		// draws that line as `ephemeralUnknown`; the backstop consults it and
		// this call was the last consumer still acting on the zero.
		const selfHostedOnline = ephemeralUnknown ? null : clawsOnline + backstopOnline;
		const fb = await withGhCaller('ci-runner-var', () =>
			syncHostedFallback(selfHostedOnline, token, { alreadyHosted: hostedRepos })
		);
		data.ci_runner = fb.desired;
		// Deliberately NOT its own Discord alert. All-claws-down already pages
		// through the backstop promote and the label-floor breach, and a second
		// message for the same root cause is noise the operator learns to skip.
		// The fleet flip is reported inside the promote note (below) and here in
		// the log. `ci_runner` reaches the daily digest through the job-sink
		// payload below — NOT through the snapshot, which has no such field.
		if (fb.changed.length) {
			logger.info(
				`[runner-health] CI_RUNNER → ${fb.desired} on ${fb.changed.length} repo(s): ${fb.changed.join(', ')}`
			);
		}
		data.ci_runner_write_failed = fb.failed.length;
		// A FAILED WRITE IS A FINDING, NOT A LOG LINE.
		//
		// This was `logger.warn` alone, and nothing else read `fb.failed` — no
		// alert, no cron finding, no digest field — while the enclosing catch
		// is fail-soft too. So a repo whose variable could not be written
		// retried every 10 minutes, forever, and said so only into a log nobody
		// tails.
		//
		// What that costs depends on the runs-on form, and BOTH are bad. Fleet
		// workflows are now bare `fromJSON(vars.CI_RUNNER)`, so a repo that
		// never got its value has `runs-on` resolve to nothing and EVERY
		// workflow in it fails to start. And on the hosted flip — the one path
		// that only runs while every claw is already down — a failed write
		// leaves that repo pointed at claws that are not there, so it queues
		// through the outage the fallback exists to route around.
		//
		// COUNTED per repo, ANNOUNCED once.
		//
		// The debounce has to be per repo — one flaky repo and a fleet-wide token
		// scope loss are different faults and must not share a counter. The ALERT
		// must not be, though: these fail together far more often than singly (one
		// revoked token covers all 26), and a message per repo would be a 26-page
		// storm for one cause — the same noise this file already refuses to send
		// for the all-claws-down case.
		const failedNow = new Set(fb.failed);
		for (const repo of [...ciRunnerWriteFailTicks.keys()]) {
			// Not failing this tick — including repos syncHostedFallback SKIPPED
			// because its cache says they already hold the desired value. Skipped is
			// not failed, and treating it as such would hold this open on a repo
			// that is fine.
			if (failedNow.has(repo)) continue;
			ciRunnerWriteFailTicks.delete(repo);
		}
		const sustained: string[] = [];
		for (const repo of fb.failed) {
			const seen = (ciRunnerWriteFailTicks.get(repo) ?? 0) + 1;
			ciRunnerWriteFailTicks.set(repo, seen);
			if (seen >= OFFLINE_TICKS_BEFORE_ALERT) sustained.push(repo);
		}
		if (!sustained.length) {
			clearAlert('ci-runner-write');
		} else {
			const mins = Math.round((OFFLINE_TICKS_BEFORE_ALERT * TICK_INTERVAL_MS) / 60000);
			const named = sustained.slice(0, 5).join(', ');
			const more = sustained.length > 5 ? ` (+${sustained.length - 5} more)` : '';
			await alertOnce(
				'ci-runner-write',
				`🚨 **CI_RUNNER** could not be written on ${sustained.length} repo(s) for ` +
					`${mins}+ min (wanted \`${fb.desired}\`): ${named}${more}. Fleet workflows use ` +
					'bare `runs-on: ${{ fromJSON(vars.CI_RUNNER) }}`, so a repo that never got ' +
					'the value will FAIL TO START rather than queue. Usually the token has lost ' +
					'`actions:write`. Check: `gh api /repos/<repo>/actions/variables`'
			);
		}
		if (fb.failed.length) {
			logger.warn(
				`[runner-health] CI_RUNNER ${fb.desired} FAILED on ${fb.failed.length} repo(s): ${fb.failed.join(', ')} ` +
					'(token needs actions:write on each repo)'
			);
		}
	} catch (err) {
		// Fail-soft, like every other write here: a broken fallback must not
		// take down the monitor that is reporting the outage.
		logger.warn(
			`[runner-health] CI_RUNNER sync threw: ${err instanceof Error ? err.message : String(err)}`
		);
	}
}

/** Test seam: cross-tick memory this module owns. */
export function __resetHostedFallbackForTesting(): void {
	// Cross-tick memory, so it belongs in this list — see the comment below. A
	// leaked count would let one test's failed write pre-arm the next test's
	// debounce, which passes while measuring nothing.
	ciRunnerWriteFailTicks.clear();
	// `hostedRepos` is module-level and therefore leaks between tests: an
	// all-claws-down case leaves every repo marked hosted, so the NEXT test sees
	// a fleet→hosted recovery it never set up and posts an unexpected alert.
	// Every piece of cross-tick memory in this module has to be listed here.
	hostedRepos.clear();
}
