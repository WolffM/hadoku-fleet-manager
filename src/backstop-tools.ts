/**
 * The backstop's hand-installed yt-dlp and deno, against their newest
 * releases — fleet-manager#34. A configuration of src/scheduled-converger.ts
 * that never converges anything: `fleet backstop-tools --json` only reads, and
 * a stale tool is reported `unconverged` so the shared policy posts it.
 *
 * OPERATOR'S RULING (2026-10-31): a reminder to update the backstop by hand,
 * at most once a month, in the emergency channel. So a stale tool posts once,
 * again every month while it stays stale (the registry row's `repageMs`), and
 * a recovery once it is current. "Stale" is 30 days behind the newest release
 * (scripts/lib/backstop-tools.mjs), so an operator who updates monthly is never
 * reminded at all.
 *
 * DAILY. A release is a fact that changes at most daily, and a pass costs one
 * local login shell and two unauthenticated GitHub calls.
 */
import { inProcessClock } from './lib/job-registry.js';
import { packageScriptPath, spawnScriptJson, createConverger } from './scheduled-converger.js';
import type { ConvergeDoc, ConvergeRunner } from './scheduled-converger.js';

/** Daily, reminding monthly: `fleet:backstop-tools`'s row in the job registry. */
const JOB = 'fleet:backstop-tools';
const CLOCK = inProcessClock(JOB);
const FIRST_PASS_MIN_MS = 15 * 60_000;
const RUN_TIMEOUT_MS = 2 * 60_000;

export const runBackstopToolsScript: ConvergeRunner = () =>
	spawnScriptJson<ConvergeDoc>(packageScriptPath('backstop-tools.mjs'), ['--json'], RUN_TIMEOUT_MS);

const converger = createConverger({
	name: 'backstop-tools',
	job: JOB,
	stateFile: 'backstop-tools.json',
	...CLOCK,
	firstPassMinMs: FIRST_PASS_MIN_MS,
	words: {
		silent: (h, why) =>
			`⚠️ fleet backstop-tools has not reported for ${h}: the backstop's yt-dlp and deno are not ` +
			`being compared with their releases. Last: ${why}`,
		reporting: '✅ fleet backstop-tools is reporting again.',
		deferred: (r) => `🛠️ ${r.node}: ${r.why ?? r.facet}`,
		unconverged: (r) =>
			`🛠️ ${r.node}: ${r.why ?? r.facet} (monthly reminder; fleet backstop-tools)`,
		recovered: (node, facet) => `✅ ${node}: ${facet.replace(/^tool:/, '')} is current.`,
	},
});

export const backstopToolsTick = (run: ConvergeRunner = runBackstopToolsScript, now?: number) =>
	converger.tick(run, now);

/** Test seam: clear the timers and the `started` guard. */
export const __stopBackstopToolsForTesting = (): void => converger.stopForTesting();

/** Start the timer. Controller-only: `createFleetManager().start()` gates it. */
export const startBackstopTools = (run: ConvergeRunner = runBackstopToolsScript): void =>
	converger.start(run);
