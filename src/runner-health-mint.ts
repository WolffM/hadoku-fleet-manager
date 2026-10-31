import { loadFleetManifestMachines } from './lib/manifest.js';
import { readDrain } from './runners/drain.js';
import { buildMintView, type MintView } from './label-floor.js';
import { loadWorkloadGateContext, admissionVerdictsForReport } from './runners/ephemeral-tick.js';
// Re-exported so runner-health-watch.ts's checkStarvation does not open a
// second direct edge to runners/ephemeral-tick.ts for this reader.
export { admissionVerdictsForReport };
import { nodeIsSick } from './lib/sick-node.js';
import { isBackstopHeld } from './runners/backstop-hold.js';
import type { GhRunner } from './lib/github-client.js';

/**
 * The MINTING half of the fleet as the floor sees it — `null` when the manifest
 * could not be read, which is "I could not look", never "nothing mints".
 *
 * Built from the SAME inputs the dispatcher reads (`ephemeral-tick.ts`): the
 * workload gate from the same loader, the drain file, the fast loop's sick set
 * and its last probe. A floor that judged mintability by a different rule than
 * the mint would be a second authority, and it would disagree exactly when it
 * matters.
 *
 * AN UNREADABLE DRAIN FILE FAILS CLOSED, like every other reader of it
 * (`drain.ts`): every node reads as drained, so a label served only by minting
 * reads unserved — which is true, because the dispatcher's tick throws on the
 * same file and mints nothing. `drainProblem` goes into the page so it names
 * the real cause.
 */
export function loadMintView(
	probe: { nodes?: Record<string, { reachable?: boolean; sick?: boolean }> } | null
): { view: MintView; drainProblem: string | null } | null {
	const machines = loadFleetManifestMachines();
	if (!machines) return null;
	let drained: Set<string>;
	let drainProblem: string | null = null;
	try {
		drained = new Set(Object.keys(readDrain()));
	} catch (err) {
		drained = new Set(Object.keys(machines));
		drainProblem = `the drain file is unreadable (${err instanceof Error ? err.message : String(err)}), so every node reads as drained`;
	}
	const view = buildMintView({
		machines,
		gate: loadWorkloadGateContext(Object.keys(machines)),
		drained,
		isSick: nodeIsSick,
		probe,
		held: isBackstopHeld,
	});
	return { view, drainProblem };
}

/** Online-runner label census for this tick, or null when the runner check could not run. */
/**
 * Every label carried by these runners, with a count. NOT filtered to the
 * label floor's watched set.
 *
 * That filter is why this check spent its whole life answering one question.
 * The label floor watches DEMANDED capabilities — the ones that page
 * when they hit zero — and it does not contain `self-hosted`, which GitHub
 * stamps on every registration and which `vars.CI_RUNNER`
 * (`["self-hosted","hadoku-builder"]`) puts on every fleet job. So every real
 * fleet job read as "no online runner matches its labels" no matter how much
 * capacity was up, and the busy-pool branch below was unreachable in
 * production. The test that covered it asked for a bare `['hadoku-builder']`,
 * a shape `runs-on` never produces here.
 *
 * A floor is not a census. Coverage has to be answered from what the runners
 * actually carry.
 */
export function countLabels(runners: GhRunner[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const r of runners) for (const l of r.labels ?? []) out[l.name] = (out[l.name] ?? 0) + 1;
	return out;
}
