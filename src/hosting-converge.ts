/**
 * Hosted tenants' slices, converged by the controller to each tenant's
 * demand — fleet-manager#16. The second configuration of
 * src/scheduled-converger.ts; the first is provisioning-converge.ts.
 *
 * THE WORK IS THE SUBCOMMAND'S. `fleet hosting-converge --json` decides
 * (lib/hosting-converge.mjs) and acts through `fleet hosting`, and only for a
 * tenant whose hosting.json says `placement.auto: true`. For the rest it plans.
 * This module runs it on a clock and pages:
 *   - `unconverged`: the door refused or failed, or an auto tenant's demand
 *     cannot be met (no node fits; a singleton that needs a move). Once, then
 *     daily while it stays;
 *   - `deferred`: a slice declared and still not guaranteed after
 *     HOSTING_DEFER_PAGE_MS (an agent the tenant has not installed);
 *   - the converger not reporting for that long.
 *
 * A pass is one ssh per node and no GitHub call, so the clock is set by how
 * fast a tenant's demand should be met, not by a budget.
 */
import { packageScriptPath, spawnScriptJson, createConverger } from './scheduled-converger.js';
import type { ConvergeDoc, ConvergeRunner } from './scheduled-converger.js';

/** Between passes: a tenant's raised demand is met within this. */
export const HOSTING_CONVERGE_MS = 5 * 60_000;
/** A declared slice still not guaranteed, or a converger not reporting, pages after this. */
export const HOSTING_DEFER_PAGE_MS = 60 * 60_000;
const REPAGE_MS = 24 * 60 * 60_000;
/** Not in the boot window, when the fast loop probes every node. */
const FIRST_PASS_MIN_MS = 5 * 60_000;
/** A pass that declares several slices waits on each door; this kills a stuck one. */
const RUN_TIMEOUT_MS = 20 * 60_000;

export const runHostingConvergeScript: ConvergeRunner = () =>
	spawnScriptJson<ConvergeDoc>(
		packageScriptPath('hosting-converge.mjs'),
		['--json'],
		RUN_TIMEOUT_MS
	);

const converger = createConverger({
	name: 'hosting',
	stateFile: 'hosting-converge.json',
	intervalMs: HOSTING_CONVERGE_MS,
	deferPageMs: HOSTING_DEFER_PAGE_MS,
	repageMs: REPAGE_MS,
	firstPassMinMs: FIRST_PASS_MIN_MS,
	words: {
		silent: (h, why) =>
			`⚠️ fleet hosting-converge has not produced a report for ${h} — no tenant's slice demand ` +
			`is being met. Last: ${why}`,
		reporting: '✅ fleet hosting-converge is reporting again.',
		deferred: (r, h) =>
			`⚠️ ${r.node}: ${r.facet} slice declared ${h} ago and still not guaranteed (${r.why ?? ''}). ` +
			`Check: fleet hosting --check`,
		unconverged: (r) =>
			`🔴 ${r.facet}${r.node === '*' ? '' : ` on ${r.node}`}: ${r.why ?? ''}. ` +
			`Its view: fleet hosting-demand ${r.facet.replace(/^hosting:/, '')} --json`,
		recovered: (node, facet) => `✅ ${facet}${node === '*' ? '' : ` on ${node}`}: converged.`,
	},
});

export const convergeHostingTick = (run: ConvergeRunner = runHostingConvergeScript, now?: number) =>
	converger.tick(run, now);

/** Test seam: clear the timers and the `started` guard. */
export const __stopHostingConvergeForTesting = (): void => converger.stopForTesting();

/** Start the timer. Controller-only: `createFleetManager().start()` gates it. */
export const startHostingConverge = (run: ConvergeRunner = runHostingConvergeScript): void =>
	converger.start(run);
