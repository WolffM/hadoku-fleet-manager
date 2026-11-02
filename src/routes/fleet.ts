/**
 * Fleet route — one read-only view of the CI fleet for the command station.
 *
 * `GET /api/fleet` rides the general `/mgmt/*` proxy in edge-router, so it needs
 * no scoped edge mount: the cookie resolves to a key, the key is stamped as a
 * tier, and the edgeOriginGuard in index.ts covers all of `/api/*`. Same shape
 * as GET /api/local-sitrep.
 *
 * WHY IT PROBES NOTHING
 * ---------------------
 * Every number here is already in memory. The fast loop ssh's each node once
 * a minute and now keeps the raw probe (fleet-loop.getFleetProbeSnapshot);
 * runner-health polls GitHub every ten and keeps its own snapshot. A dashboard
 * that opened its own ssh or GitHub call per HTTP request would add fleet load
 * proportional to how often someone is WATCHING the fleet, which is exactly
 * backwards — the operator is most likely to be watching during an incident.
 *
 * So this endpoint is a join, not a collector. It is cheap enough to poll, and
 * its staleness is bounded by the two loops (60s / 10m) rather than by itself.
 * `null` for either half means "that loop has not ticked since the last restart"
 * — reported as such rather than rendered as zeroes, because a fleet showing 0
 * free slots and a fleet we have not looked at yet must not look identical.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';

import { backfillFailedSteps } from '../job-history-backfill.js';
import { type GhJob } from '../job-history-phases.js';
import { githubToken, logger, stateDir } from '../host.js';
import { packageVersion } from '../lib/provenance.js';
import { recordRouteHit } from '../lib/usage-log.js';
import { withGhCaller } from '../gh-budget.js';
import { ghFetchRaw } from '../lib/github-client.js';
import { userAgent } from '../lib/fleet-config.js';
import { loadTargets, stateKey } from '../ci-alerts.js';
import { readStates } from '../ci-alerts-state.js';
import { ManifestUnreadableError } from './fleet-manifest.js';

import { buildFleetReport } from './fleet-report.js';

// Annotated explicitly: this package emits declarations (mgmt-api did not), and
// the inferred Router type cannot be named without reaching into a pnpm-internal
// @types path — which would make the .d.ts unportable for consumers.
export const router: Router = Router();

/**
 * FIRST HANDLER ON EVERY ROUTE: count the hit into the invocation log
 * (`lib/usage-log.ts`) once the response is sent. By the route's PATTERN, not
 * the raw path. Per route rather than `router.use`, because mgmt-api mounts
 * this router on all of `/api` and a router-wide middleware would count every
 * other service's requests too. `FLEET_ROUTES` must name every route below;
 * the router test holds the two equal.
 */
function countHit(req: Request, res: Response, next: NextFunction): void {
	const start = performance.now();
	const route = (req.route as { path?: unknown } | undefined)?.path;
	res.on('finish', () => {
		try {
			recordRouteHit(
				{
					method: req.method,
					route: typeof route === 'string' ? route : '(unknown)',
					status: res.statusCode,
					ms: performance.now() - start,
				},
				{ stateDir, version: packageVersion }
			);
		} catch (err) {
			logger.error(`[fleet] usage log: ${err instanceof Error ? err.message : String(err)}`);
		}
	});
	next();
}

router.get('/fleet', countHit, (_req: Request, res: Response) => {
	try {
		res.json({ success: true, ...buildFleetReport() });
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Unknown error';
		// "I could not look" is not "nothing is wrong" — a 503, never the same
		// 500 an unrelated bug would also raise, so a dashboard or a monitor can
		// tell "the manifest is unreadable right now" from "this route broke".
		if (err instanceof ManifestUnreadableError) {
			logger.error(`[fleet] GET /fleet → 503 ${msg}`);
			res.status(503).json({ success: false, error: msg });
			return;
		}
		logger.error(`[fleet] GET /fleet → 500 ${msg}`);
		res.status(500).json({ success: false, error: msg });
	}
});

/**
 * The CI state this package's alerter maintains, for monitoring-api's sitrep.
 *
 * WHY IT IS SERVED RATHER THAN SHARED. The sitrep's `ci` domain used to read
 * monitoring-api's own KV, written by the ci-check poller that lived there.
 * That poller moved here with the rest of "did a GitHub Action work", so the
 * panel has to read the state from its new owner — and one owner for both the
 * data and the paging is the whole point of the move. Reported, never
 * re-derived: this returns exactly what the alerter decided from, so the panel
 * and the alert can never disagree about what is red.
 *
 * `lastSeen` is per-row and deliberately exposed. A row whose lastSeen is old
 * means the poll has not reached that workflow lately, which is a DIFFERENT
 * condition from "green" and the consumer must be able to tell them apart.
 *
 * GET /api/fleet/ci-state
 * Loopback/edge-gated like the rest of `/api` by mgmt-api's edgeOriginGuard.
 */
router.get('/fleet/ci-state', countHit, (_req: Request, res: Response) => {
	try {
		const states = readStates();
		const targets = loadTargets();
		// Driven by the TARGET list, not by the state file, so a watched
		// workflow that has never been polled appears as `null` rather than
		// vanishing. A missing row and a green row are not the same answer, and
		// the sitrep already renders "not yet polled" separately.
		const workflows = targets.map((t) => {
			const row = states[stateKey(t)];
			return {
				label: t.label,
				repo: `${t.owner}/${t.repo}`,
				workflow: t.workflow,
				conclusion: row?.lastConclusion ?? null,
				lastSeen: row?.lastSeen ?? null,
			};
		});
		res.json({ success: true, workflows });
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Unknown error';
		logger.error(`[fleet] GET /fleet/ci-state → 500 ${msg}`);
		res.status(500).json({ success: false, error: msg });
	}
});

/**
 * One job read for {@link backfillFailedSteps} below. Deliberately NOT
 * runner-health's `ghGet`: that one folds every failure into a single
 * `null`, and this caller must tell an aged-out job (gone forever, stop
 * asking) from a timeout (worth another pass) — `expired` carries that.
 *
 * Extracted to a named export (plan §4.1 F2b) so its own behaviour —
 * especially "a network failure never reports `expired: true`" — can be
 * pinned without standing up the whole Express route.
 *
 * The raw `fetch` moved onto `github-client.ts`'s `ghFetchRaw`: a pure move
 * except for the `User-Agent`, normalized from a hand-written literal
 * (`hadoku-mgmt-api/job-history-backfill`, a leftover from before the
 * 2026-08-30 extraction — the exact bug `ci-runner-fallback.ts`'s own
 * docstring already names and fixes for itself) to `userAgent(...)`, and the
 * timeout, normalized from NONE AT ALL to this module's 10s default — a read
 * that never finishes used to never report, on a route meant to run once
 * over many job ids.
 */
export async function fetchJobForBackfill(
	repo: string,
	jobId: number,
	token: string
): Promise<{ job: GhJob | null; expired: boolean }> {
	const { resp } = await ghFetchRaw(
		'GET',
		`https://api.github.com/repos/${repo}/actions/jobs/${jobId}`,
		token,
		{
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				'User-Agent': userAgent('job-history-backfill'),
			},
		}
	);
	if (!resp) return { job: null, expired: false };
	if (!resp.ok) return { job: null, expired: resp.status === 404 };
	try {
		return { job: (await resp.json()) as GhJob, expired: false };
	} catch {
		return { job: null, expired: false };
	}
}

/**
 * Backfill `failedStep` onto pre-0.22.24 records — INSIDE the process that owns
 * the file.
 *
 * This is a route rather than a script because it has to be. `job-history.jsonl`
 * has exactly one writer, this process, and that writer never re-reads the file
 * after boot; a one-shot script that patches the file is overwritten by the next
 * compaction without an error anywhere, which is what happened to 502 records on
 * 2026-09-07. See `backfillFailedSteps`.
 *
 * A route, not a startup step: it costs one GitHub call per record and the whole
 * point is that it is ONE-TIME. It also lives here rather than in mgmt-api so it
 * ships with the function it calls — the two cannot drift apart across repos.
 *
 * POST /api/fleet/job-history/backfill?max=600&concurrency=5
 * Loopback-only in practice: mgmt-api's `edgeOriginGuard` gates all of `/api`.
 */
router.post('/fleet/job-history/backfill', countHit, (req: Request, res: Response) => {
	const num = (v: unknown, fallback: number): number => {
		const n = Number(v);
		return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
	};
	const max = num(req.query.max, 2000);
	const concurrency = Math.min(10, num(req.query.concurrency, 5));
	const token = githubToken();
	if (!token) {
		// "I could not look" is not "nothing to do" — 503, never an empty success.
		logger.error('[fleet] POST /fleet/job-history/backfill → 503 no GitHub token');
		res.status(503).json({ success: false, error: 'no GitHub token configured' });
		return;
	}
	withGhCaller('route', () =>
		backfillFailedSteps((repo, jobId) => fetchJobForBackfill(repo, jobId, token), {
			max,
			concurrency,
		})
	)
		.then((report) => {
			res.json({ success: true, ...report });
		})
		.catch((err: unknown) => {
			const msg = err instanceof Error ? err.message : 'Unknown error';
			logger.error(`[fleet] POST /fleet/job-history/backfill → 500 ${msg}`);
			res.status(500).json({ success: false, error: msg });
		});
});
