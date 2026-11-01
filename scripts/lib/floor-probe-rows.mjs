/**
 * floor-probe's two read-only tables — `unitTable` (one `(repo, job)`) and
 * `nodeZoneTable` (every node, every repo) — split out of `floor-probe.mjs`
 * (wave 5q lane A, pure move) so that file reaches the 800-line ceiling. No IO
 * here either; see that file's own header for why the split exists at all.
 */
import { median, percentile } from './floor-probe-ranking.mjs';
import { zoneOf } from './floor-probe.mjs';

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * Rows for the per-node table this harness exists to produce.
 *
 * `manufactured` is broken out from `organic` because the two populations are
 * not interchangeable: a `forced-rerun` sample exists BECAUSE something already
 * failed, so its failure rate is conditioned on failure and means nothing on its
 * own. A table that summed them would report a fleet getting worse the more
 * carefully it was measured.
 *
 * NO GATE MAY GET EASIER TO PASS THE WORSE THE FAILURE GETS. A node so broken it
 * produces NO samples does not vanish from this table — it appears with
 * `samples: 0` and `measured: false`, because a row that disappears is a row
 * nobody notices. That is the `queue-health` p95-exclusion lesson: if you
 * exclude a category, check what happens when a real failure manufactures it.
 */
export function unitTable({ key, samples = [], roster = [] }) {
	const byNode = new Map(roster.map((n) => [n, []]));
	for (const s of samples) {
		if (!byNode.has(s.node)) byNode.set(s.node, []);
		byNode.get(s.node).push(s);
	}
	const rows = [];
	for (const [node, rs] of byNode) {
		const durations = rs
			.map((r) => r.durationSec)
			.filter((d) => typeof d === 'number' && Number.isFinite(d));
		// CANCELLED IS NOT FAILED, and counting them together makes this table
		// unreadable: 420 of the 639 non-success records in the live window are
		// cancellations, mostly `cancel-in-progress` supersedes whose step is
		// arbitrary. A `failures` column that is three-quarters supersede noise
		// would send every reader after the wrong node.
		const failures = rs.filter((r) => r.conclusion === 'failure' || r.conclusion === 'timed_out');
		const cancelled = rs.filter((r) => r.conclusion === 'cancelled').length;
		rows.push({
			node,
			samples: rs.length,
			organic: rs.filter((r) => !r.probe).length,
			shadow: rs.filter((r) => r.probe === 'shadow').length,
			// `rerun`, not `forced`. The ledger already uses `forced` for a probe
			// that landed on the node it was AIMED at, and one word meaning two
			// things across two files is how a reader draws the wrong conclusion
			// from a correct number. Here it means Control A — the re-dispatch of a
			// job that already failed.
			rerun: rs.filter((r) => r.probe === 'forced-rerun').length,
			// Manufactured samples that landed where they were aimed. This is the
			// only column that is EVIDENCE ABOUT THIS NODE in the §5 sense: a probe
			// aimed at claw-2 and served by claw-1 is a real sample of claw-1 and
			// says nothing whatever about claw-2.
			pinned: rs.filter((r) => r.probe && r.intendedNode === node).length,
			p50Sec: median(durations),
			p95Sec: percentile(durations, 95),
			failures: failures.length,
			cancelled,
			// `zoneOf`, not `classifyZone`: a job the fleet's own unit TTL stopped is
			// counted as `fleet` rather than as `runner`, so a kill the fleet caused
			// is never read as a box that could not start a job. Those are different
			// repairs and the raw three-zone rule cannot tell them apart.
			zones: failures.reduce((acc, r) => {
				const z = zoneOf(r);
				acc[z] = (acc[z] ?? 0) + 1;
				return acc;
			}, {}),
			measured: rs.length >= 1,
		});
	}
	rows.sort((a, b) => (b.p50Sec ?? -1) - (a.p50Sec ?? -1) || a.node.localeCompare(b.node));
	return { key, rows, total: rows.reduce((a, r) => a + r.samples, 0) };
}

// ---------------------------------------------------------------------------
// The REPORT table — every node, every repo, read-only
// ---------------------------------------------------------------------------

/** The zone buckets, in the order the report prints them. */
export const ZONE_NAMES = ['runner', 'seam', 'content', 'fleet'];

/**
 * The per-node zone table over a WHOLE window rather than one unit.
 *
 * `unitTable` above answers "who is slow at this job"; this answers "whose
 * failures are the fleet's". Same classifier, different fold, and it exists
 * because the question issue #3 asks — is claw-2 worse than the other boxes —
 * cannot be asked one unit at a time: claw-2 served 31 pygmalion jobs in
 * fourteen days, and no rate computed on 31 samples separates anything.
 *
 * READ-ONLY BY CONSTRUCTION. It takes records and a roster and returns rows.
 * Nothing here dispatches, re-runs, mints or writes — that is the property the
 * `report` mode exists to have, and it is held by this function taking no
 * callbacks rather than by a promise in a docblock.
 *
 * `samples` must already carry a resolved `node` (`nodeOf` is the caller's, and
 * it lives in `census.ts`). Records outside the roster are NOT discarded: they
 * come back under their own `node` key with `inRoster: false`, because the
 * `github-hosted` rows and any retired box are real jobs that really failed,
 * and a table that silently dropped them would under-report the fleet's own
 * denominator.
 *
 * A NODE WITH NO DATA IS A ROW, NOT AN ABSENCE. Every roster node appears, with
 * `jobs: 0` and `why: 'no records in the window'`. That is the `queue-health`
 * lesson in its general form: a node so broken it produces no samples must not
 * vanish from the table that would have shown it, and "I could not look" must
 * never render as "nothing is wrong".
 *
 * RATES ARE NOT COMPUTED FOR A NODE THAT HAS NO DENOMINATOR. `runnerSeamPct` is
 * `null` at `jobs: 0`, never 0 — the same rule `NodeJobStats.recentMedianSec`
 * follows one level down, and for the same reason: zero-over-zero rendered as
 * 0 % draws a node nobody measured as the healthiest box in the fleet.
 */
export function nodeZoneTable({ samples = [], roster = [] } = {}) {
	const byNode = new Map(roster.map((n) => [n, []]));
	for (const s of samples) {
		const n = s.node ?? '(unattributed)';
		if (!byNode.has(n)) byNode.set(n, []);
		byNode.get(n).push(s);
	}
	const rows = [];
	for (const [node, rs] of byNode) {
		const durations = rs
			.map((r) => r.durationSec)
			.filter((d) => typeof d === 'number' && Number.isFinite(d));
		const zones = { runner: 0, seam: 0, content: 0, fleet: 0 };
		let cancelled = 0;
		let failures = 0;
		for (const r of rs) {
			if (r.conclusion === 'success') continue;
			if (r.conclusion === 'cancelled') {
				cancelled += 1;
				continue;
			}
			failures += 1;
			zones[zoneOf(r)] += 1;
		}
		const runnerSeam = zones.runner + zones.seam;
		rows.push({
			node,
			inRoster: roster.includes(node),
			jobs: rs.length,
			failures,
			cancelled,
			zones,
			// THE FIGURE THE VERDICT IS MADE ON, named rather than left to a reader
			// to add up: §5.5's two fleet-origin zones, with the fleet's own TTL
			// kills EXCLUDED because those are the fleet stopping a job, not a box
			// failing to run one.
			runnerSeam,
			runnerSeamPct: rs.length ? Number(((100 * runnerSeam) / rs.length).toFixed(3)) : null,
			repos: new Set(rs.map((r) => r.repo)).size,
			p50Sec: median(durations),
			p95Sec: percentile(durations, 95),
			why: rs.length ? null : 'no records in the window',
		});
	}
	rows.sort((a, b) => b.jobs - a.jobs || a.node.localeCompare(b.node));
	const totals = { jobs: 0, failures: 0, cancelled: 0, runner: 0, seam: 0, content: 0, fleet: 0 };
	for (const r of rows) {
		totals.jobs += r.jobs;
		totals.failures += r.failures;
		totals.cancelled += r.cancelled;
		for (const z of ZONE_NAMES) totals[z] += r.zones[z];
	}
	return { rows, totals, nodesWithNoData: rows.filter((r) => r.jobs === 0).map((r) => r.node) };
}
