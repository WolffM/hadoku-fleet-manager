/**
 * label-floor-demand — THE DEMAND, FROM TWO SOURCES (#98): what workflows
 * CAN ask for and what jobs DID ask for, and what that implies about which
 * routing dependencies are mint-only or wholly unoffered.
 *
 * Moved out of `check-label-floor.mjs` (wave shrink-1 lane D), body
 * unchanged.
 *
 * STATIC: every covered repo's workflows, per JOB, through
 * `lib/runs-on-demand.mjs`. Before 2026-10-10 this was three regexes over the
 * whole file, and two live routing labels (`jdk21`, `cargo-bevy`) were
 * invisible to it — see that module's header. A `runs-on` it cannot resolve is
 * a finding here, never zero labels.
 *
 * OBSERVED: the labels GitHub actually requested over job history's retention
 * window. It covers what no static reader can — a `runs-on` taken from a
 * dispatch input, a repo not yet in the roster — and it is the reader that does
 * not read the writer: the workflow is the writer, the job record is what
 * GitHub did with it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './paths.mjs';
import { tryShipped } from './fleet-source.mjs';
import { hubRepoFull } from '../../dist/lib/fleet-config.js';
import { FLEET_VALUE } from '../../dist/lib/ci-runner-values.js';
import { RETENTION_DAYS } from '../../dist/job-history-store.js';
import { isProofRunnerName } from '../../dist/lib/jit-naming.js';
import { mintsJitRunners } from '../../dist/lib/node-role.js';
import { observedDemand, workflowDemand } from './runs-on-demand.mjs';
import { offerersOf } from './label-floor-check.mjs';

/**
 * @param {object} manifest
 * @param {Record<string,string[]>} holdings
 * @param {string[]} coveredRepos
 * @param {(label: string) => boolean} isDemandLabel
 */
export function collectDemand(manifest, holdings, coveredRepos, isDemandLabel) {
	// THE SHIPPED WORKFLOWS, through fleet-source: each repo's default branch,
	// fetched by the reader itself. Never a sibling working tree — on 2026-10-24 a
	// CRLF, 1627-commits-behind clone of secretProject made this gate report a parse
	// failure in a file that was fine on GitHub (fleet-manager#7).
	const repos = [...new Set([hubRepoFull(), ...coveredRepos])];

	const requested = new Set();
	/** label -> where it was asked for: `repo/file:job` (static) and a job count (observed). */
	const demandSources = {};
	function noteDemand(label, where) {
		if (!isDemandLabel(label)) return;
		requested.add(label);
		demandSources[label] ??= { static: [], observed: 0 };
		if (typeof where === 'number') demandSources[label].observed += where;
		else demandSources[label].static.push(where);
	}
	const unread = [];
	/** name -> why it could not be read; printed beside `unread`, which stays names. */
	const unreadWhy = new Map();
	const noWorkflows = [];
	const unresolvable = [];
	for (const slug of repos) {
		const name = slug.split('/').pop();
		const source = tryShipped(slug);
		if ('unreadable' in source) {
			unread.push(name);
			unreadWhy.set(name, source.unreadable);
			continue;
		}
		// A REPO WITH NO WORKFLOWS DIRECTORY CONTRIBUTED NOTHING, silently, and the
		// gate's scope shrank by a whole repo. Every covered repo is covered BECAUSE
		// its workflows run on the fleet, so a missing directory is the same "could
		// not look" as an unreadable repo.
		if (!source.hasWorkflowsDir()) {
			noWorkflows.push(name);
			continue;
		}
		for (const { file: f, text } of source.workflows()) {
			const { jobs, unresolved } = workflowDemand(text, { fleetValue: FLEET_VALUE });
			for (const u of unresolved) unresolvable.push(`${name}/${f}: ${u}`);
			for (const j of jobs) for (const l of j.labels) noteDemand(l, `${name}/${f}:${j.id}`);
		}
	}

	const HISTORY_PATH = join(stateDir(), 'job-history.jsonl');
	const observedSince = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
	let observed = null;
	let observedError = null;
	let malformed = null;
	try {
		const nodes = Object.keys(manifest.machines ?? {});
		observed = observedDemand(readFileSync(HISTORY_PATH, 'utf8'), {
			sinceIso: observedSince,
			isProof: (runner) => nodes.some((n) => isProofRunnerName(runner, n)),
		});
		// A HISTORY WITH NOTHING IN THE WINDOW IS NOT "NOTHING WAS ASKED FOR". The
		// fleet runs hundreds of jobs a day; zero rows means the recorder stopped.
		if (observed.rows === 0) {
			observedError =
				`${HISTORY_PATH} holds no job that started since ${observedSince} — the recorder is not ` +
				`running, so the observed half of the demand is empty, not small`;
		}
	} catch (err) {
		observedError =
			err.code === 'ENOENT'
				? `no job history at ${HISTORY_PATH}`
				: `could not read ${HISTORY_PATH}: ${err.message}`;
	}
	if (observed) for (const [l, n] of observed.labels) noteDemand(l, n);
	if (observed?.malformed) {
		malformed = observed.malformed;
		console.error(
			`! ${observed.malformed} malformed line(s) in ${HISTORY_PATH} were skipped — an append killed ` +
				`mid-write leaves one; more than that is a corrupt file worth a look.`
		);
	}

	// A LABEL IS A ROUTING DEPENDENCY BECAUSE SOMETHING ASKS FOR IT. Full stop —
	// the fleet's obligations are set by its workflows, not by what the manifest
	// happens to admit to. See the header for what the old intersection cost.
	//
	// A requested label that NOTHING offers used to vanish here, on the grounds
	// that it is check:worker-routes' bug rather than this gate's. It no longer
	// vanishes: with declarations going away, "nothing offers it" is exactly what
	// an accidentally-deleted capability looks like, and silently narrowing the
	// dependency set is how this gate would report green on a fleet that can no
	// longer serve a label at all. It is reported as `unoffered` by the caller.
	const dependencies = [...requested].sort();

	/**
	 * Labels offered ONLY by nodes that mint — an ephemeral claw or the on-demand
	 * backstop.
	 *
	 * REPORTED, NOT FAILED, since 2026-10-19 (#120). From 2026-09-01 a routing
	 * label here failed the gate ("stranded on ephemeral"), on the argument that a
	 * label needs an answer that does not wait for the dispatcher, and the answer
	 * it pointed at was hokon's ~30 standing runners. The operator retired those:
	 * "the runners get brought online the same way the JIT process does. not
	 * having standing runners squatting on ram." With every claw JIT, that makes
	 * every routing label mint-only by decision, so the rule could only ever fail.
	 *
	 * What the rule protected is still guarded, by the things that can actually
	 * act on it:
	 *   - SERVED: the runtime floor watches every demanded label through its
	 *     minting arm (`label-floor.ts`), and pages when no eligible minting node
	 *     is live. That is the alert the 2026-09-01 state switched off.
	 *   - THE DISPATCHER ITSELF: `jit-canary.yml` goes red when minting stops, and
	 *     `ci:queue-health` when queues grow.
	 *   - FIXING A BROKEN DISPATCHER: the resident floor keeps this repo's
	 *     CI on two standing holders, and hokon keeps hadoku_site's deploy runner
	 *     standing (`standingRepos`), so neither the fix nor its deploy waits on
	 *     the thing it fixes.
	 * The hokon runners never answered for a dead dispatcher anyway: they offered
	 * `hadoku-builder` only while runner-health promoted them, and runner-health
	 * runs in the same mgmt-api process as the dispatcher.
	 */
	const servedByMintOnly = new Set(
		dependencies.filter((l) => {
			const offerers = offerersOf(manifest, holdings, l);
			return offerers.length > 0 && offerers.every((n) => mintsJitRunners(manifest.machines?.[n]));
		})
	);

	/**
	 * A routing dependency NOTHING in the fleet offers.
	 *
	 * Jobs on such a label queue forever — hadoku-games-host sat 854 minutes that
	 * way for 32 seconds of work. It is reported here rather than dropped because
	 * dropping it is what would let this gate get EASIER to pass the worse the
	 * failure gets: the more capabilities the fleet loses, the fewer dependencies
	 * it would have had to floor.
	 */
	const nothingOffers = dependencies.filter((l) => offerersOf(manifest, holdings, l).length === 0);

	return {
		demandSources,
		unread,
		unreadWhy,
		noWorkflows,
		unresolvable,
		observed,
		observedError,
		observedMalformed: malformed,
		dependencies,
		servedByMintOnly,
		nothingOffers,
	};
}
