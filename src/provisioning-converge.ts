/**
 * Standing-runner provisioning, converged by the controller — fleet-manager#1.
 *
 * WHY THIS EXISTS. A standing runner whose `.env` lacks the throttle keys has
 * no concurrency limit and cannot see the shared tool cache, and one running
 * outside its slice has no group memory ceiling. A claw whose unattended-
 * upgrades selects nothing never installs a security update (2026-10-25:
 * every claw, from first boot; `apt-security` is the third facet, and its
 * repair restarts nothing so it is never deferred). Until 2026-10-24 the only
 * thing that noticed either was hadoku_site's nightly check:throttle /
 * check:slice, and hadoku_site does not run fleet fixes. So every drift waited
 * for a human: claw-4 and claw-6 sat in that state from 10-22 to 10-24. Now
 * `fleet converge-provisioning` runs here on its own timer. It repairs what is
 * safe to repair unattended, re-reads the node, and reports what it changed.
 * It pages only on what it could not converge. The nightly gates stay as the
 * backstop and should find nothing.
 *
 * THE WORK IS THE SUBCOMMAND'S. This module schedules it, reads its `--json`,
 * and decides what is worth a page. The repair rules, idle units only and one
 * restart per unit, live in scripts/converge-provisioning.mjs and
 * lib/provisioning-converge.mjs, where the operator's CLI runs the same code.
 *
 * WHAT PAGES, and only this:
 *   - a (node, facet) the repair ran on and the re-check still disagrees with
 *     (`unconverged`), once, then again every REPAGE_MS while it stays;
 *   - a (node, facet) deferred behind a live job for longer than
 *     DEFER_PAGE_MS. A standing runner is idle most of the time, so one that
 *     never is at a pass for that long is not "busy", it is stuck;
 *   - the converger itself failing to produce a report for DEFER_PAGE_MS.
 * A recovery is posted for anything that paged. An UNREADABLE node is
 * logged, not paged: node reachability already pages from runner-health, and
 * the nightly gates still fail on it.
 *
 * STATE IS ON DISK. mgmt-api restarts many times a day (28 in one morning,
 * 2026-09), so a module-level timer that started fresh at every boot could
 * run the converger at every boot, or never run it at all if restarts come
 * faster than the interval. The last run time, the deferral clocks and what
 * has paged all live in `provisioning-converge.json` under stateDir.
 *
 * The schedule, the paging and the state are src/scheduled-converger.ts's,
 * shared with every other converger. This file is the words and the clock.
 */
import {
	createConverger,
	packageScriptPath,
	spawnScriptJson,
	type ConvergeDoc as Doc,
	type ConvergeRow as Row,
	type ConvergeRunner as Runner,
	type ConvergeTickSummary,
} from './scheduled-converger.js';

export type { ConvergeTickSummary };

/** Between converger passes. Each pass is two fleet-wide `--check` sweeps (~20s) and no GitHub call. */
export const PROVISIONING_CONVERGE_MS = 30 * 60_000;
/** A deferral, or a converger that cannot run, pages after this long. */
export const DEFER_PAGE_MS = 6 * 60 * 60_000;
/** An unconverged facet that stays that way pages again after this long. */
export const REPAGE_MS = 24 * 60 * 60_000;
/**
 * The earliest a pass runs after boot, however overdue it is. Boot is when the
 * fast loop probes every node, and a converger due at once would put two ssh
 * sweeps on the fleet together.
 */
export const FIRST_PASS_MIN_MS = 5 * 60_000;
/** The converger is killed past this. A pass that repairs several nodes is minutes, not this. */
const RUN_TIMEOUT_MS = 20 * 60_000;

export interface ConvergeRow extends Row {
	facet: 'throttle' | 'slice' | 'apt-security';
}

/** `fleet converge-provisioning --json`, as far as this module reads it. */
export type ConvergeDoc = Doc<ConvergeRow>;
export type ConvergeRunner = Runner<ConvergeRow>;

/** The packaged subcommand, beside this module's `dist/` in the installed package. */
export const convergeScriptPath = (): string => packageScriptPath('converge-provisioning.mjs');

export const runConvergeScript: ConvergeRunner = () =>
	spawnScriptJson<ConvergeDoc>(convergeScriptPath(), ['--json'], RUN_TIMEOUT_MS);

const converger = createConverger<ConvergeRow>({
	name: 'provisioning',
	stateFile: 'provisioning-converge.json',
	intervalMs: PROVISIONING_CONVERGE_MS,
	deferPageMs: DEFER_PAGE_MS,
	repageMs: REPAGE_MS,
	firstPassMinMs: FIRST_PASS_MIN_MS,
	words: {
		silent: (h, why) =>
			`⚠️ fleet converge-provisioning has not produced a report for ${h} — ` +
			`standing-runner throttle env, slice placement and claw security upgrades are not being ` +
			`converged. Last: ${why}`,
		reporting: '✅ fleet converge-provisioning is reporting again.',
		deferred: (r, h) =>
			`⚠️ ${r.node}: ${r.facet} drift on a standing runner has been deferred behind a live job for ` +
			`${h} (${r.why ?? r.before ?? ''}). A standing runner is idle most of the ` +
			`time, so this one is stuck rather than busy. Fix: fleet ${r.facet} --machine ${r.node} ` +
			`--confirm${r.facet === 'slice' ? ' --restart' : ''} once it is idle.`,
		unconverged: (r) =>
			`🔴 ${r.node}: fleet converge-provisioning repaired ${r.facet} drift (${r.before ?? ''}) and the ` +
			`re-check still disagrees: ${r.why ?? ''}. Needs a human: fleet ${r.facet} --machine ${r.node} --check`,
		recovered: (node, facet) =>
			facet === 'apt-security'
				? `✅ ${node}: unattended security upgrades converged.`
				: `✅ ${node}: standing-runner ${facet} provisioning converged.`,
	},
});

/**
 * One converger pass: run it, log what it changed, and page by the rules in
 * the header. Never throws: a broken pass is logged and retried next interval.
 */
export const convergeProvisioningTick = (
	run: ConvergeRunner = runConvergeScript,
	now: number = Date.now()
): Promise<ConvergeTickSummary> => converger.tick(run, now);

/** Test seam: clear the timers and the `started` guard. */
export const __stopProvisioningConvergeForTesting = (): void => converger.stopForTesting();

/**
 * Start the converger's timer. The first pass is due PROVISIONING_CONVERGE_MS
 * after the LAST one, read from disk, so a restart neither skips the interval
 * nor reruns it. Controller-only: `createFleetManager().start()` gates it.
 */
export const startProvisioningConverge = (run: ConvergeRunner = runConvergeScript): void =>
	converger.start(run);
