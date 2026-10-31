/**
 * Every hosted tenant's home, checked from its node and put back when it
 * drifted — fleet-manager#31. The fourth configuration of
 * src/scheduled-converger.ts, after provisioning, reboots and hosting demand.
 *
 * THE WORK IS THE SUBCOMMAND'S. `fleet hosting-verify --json` runs `fleet
 * hosting --check` and re-asserts each slice that is not guaranteed and that
 * the node side can repair (scripts/lib/hosting-verify.mjs). This module runs
 * it on a clock and pages:
 *   - `unconverged`: a slice the re-assert did not make guaranteed, or one it
 *     cannot repair. Once, then daily while it stays;
 *   - the verifier not reporting for its registry row's deferPageMs.
 * An unreachable node is logged, not paged: node-status pages it already.
 *
 * HOURLY. Before it, a tenant's `.npmrc` going missing surfaced as its next
 * deploy failing with a 401 (#28). A deploy is the moment a home file is
 * read, and tenants deploy several times a day, so an hour is ahead of most
 * of them; a pass costs one ssh per slice and no GitHub call.
 */
import { inProcessClock } from './lib/job-registry.js';
import { packageScriptPath, spawnScriptJson, createConverger } from './scheduled-converger.js';
import type { ConvergeDoc, ConvergeRunner } from './scheduled-converger.js';

/** Hourly, paging daily, silent after 3 h: `fleet:hosting-verify`'s row in the job registry. */
const JOB = 'fleet:hosting-verify';
const CLOCK = inProcessClock(JOB);
/** Not in the boot window, when the fast loop probes every node. */
const FIRST_PASS_MIN_MS = 10 * 60_000;
/** A check of every slice, then a re-assert of each that drifted. */
const RUN_TIMEOUT_MS = 20 * 60_000;

export const runHostingVerifyScript: ConvergeRunner = () =>
	spawnScriptJson<ConvergeDoc>(packageScriptPath('hosting-verify.mjs'), ['--json'], RUN_TIMEOUT_MS);

const converger = createConverger({
	name: 'hosting-verify',
	job: JOB,
	stateFile: 'hosting-verify.json',
	...CLOCK,
	firstPassMinMs: FIRST_PASS_MIN_MS,
	words: {
		silent: (h, why) =>
			`⚠️ fleet hosting-verify has not produced a report for ${h}: no hosted tenant's home is ` +
			`being checked. Last: ${why}`,
		reporting: '✅ fleet hosting-verify is reporting again.',
		deferred: (r, h) =>
			`⚠️ ${r.node}: ${r.facet} not guaranteed for ${h} (${r.why ?? ''}). Check: fleet hosting --check`,
		unconverged: (r) =>
			`🔴 ${r.node}: ${r.facet} is not guaranteed and a re-assert did not fix it: ${r.why ?? ''}. ` +
			`Check: fleet hosting --check`,
		recovered: (node, facet) => `✅ ${node}: ${facet} is guaranteed again.`,
	},
});

export const verifyHostingTick = (run: ConvergeRunner = runHostingVerifyScript, now?: number) =>
	converger.tick(run, now);

/** Test seam: clear the timers and the `started` guard. */
export const __stopHostingVerifyForTesting = (): void => converger.stopForTesting();

/** Start the timer. Controller-only: `createFleetManager().start()` gates it. */
export const startHostingVerify = (run: ConvergeRunner = runHostingVerifyScript): void =>
	converger.start(run);
