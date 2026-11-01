/**
 * `fleet floor-probe report` — split out of `scripts/floor-probe.mjs` (wave 5q
 * lane A, ctx restructure) so that file reaches the 800-line ceiling. Takes
 * the CLI's flags and run-scoped state through `ctx`, built once there; never
 * imports the CLI.
 */
import { nodeOf } from '../../dist/runners/census.js';
import { RETENTION_DAYS } from '../../dist/job-history-store.js';
import { nodeRole } from '../../dist/lib/node-role.js';
import { ZONE_NAMES, nodeZoneTable } from './floor-probe-rows.mjs';

/**
 * The read-only report: every node, every repo, the whole retention window.
 *
 * WHY THIS IS A MODE AND NOT A `--report` FLAG. The wave file asked for
 * `--report`. This command's argv is a MODE plus that mode's flags
 * (`parseMode`, `MODE_FLAGS`, `foreignFlags`), and every one of those three
 * exists because an argument silently read as something else has already cost
 * this file twice — `--unit 'x#y'` parsed as a mode, `--onto claw-6` parsed as
 * a mode, and `bootcamp`'s identical parser turning `--machine=claw-7 --write`
 * into every node including the production host. A flag that changes what the
 * command DOES is a mode wearing a flag's clothes; `--report` would have to be
 * accepted by every mode and then refused by four of them. So: `report`.
 *
 * READ-ONLY IS A STRUCTURAL PROPERTY HERE, not a promise. The function touches
 * `loadHistory` and the manifest and nothing else — no `meteredGh`, no `sh`, no
 * `appendLedger`, no `declareProbeIntent`, no `mintEphemeralRunner`. hokon's
 * rows are READ out of history like every other node's, and nothing is run
 * against any node.
 *
 * ZERO IS A FAILURE. An empty window, a `--repo` that matches nothing, a
 * history that will not parse — each exits 1 and says which, because "I could
 * not look" must never render as "nothing is wrong". A roster node with no
 * records is NOT that case: it is a row, with `jobs: 0` and a `why`.
 */
export function modeReport(ctx, rows) {
	const { flag, fail, JSON_OUT, emitter, log, NODES, machines } = ctx;
	const days = flag('days') === null ? RETENTION_DAYS : Number(flag('days'));
	if (!Number.isFinite(days) || days <= 0) {
		fail(`--days must be a positive number, got ${JSON.stringify(flag('days'))}`);
	}
	const repoFilter = flag('repo');
	const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;

	const inWindow = rows.filter((r) => Date.parse(r.startedAt ?? '') >= cutoffMs);
	if (!inWindow.length) {
		fail(
			`job history holds ${rows.length} record(s) but NONE in the last ${days} day(s) — ` +
				'nothing was scanned, so nothing can be concluded',
			{ days, historyRecords: rows.length }
		);
	}
	const scoped = repoFilter ? inWindow.filter((r) => r.repo === repoFilter) : inWindow;
	if (repoFilter && !scoped.length) {
		fail(
			`no records for ${repoFilter} in the last ${days} day(s) — a table of zero is not a table`,
			{
				days,
				repo: repoFilter,
				// The repos that ARE there, so a typo is one line away from being obvious
				// rather than indistinguishable from a quiet repo.
				detail: [
					`repos in the window: ${[...new Set(inWindow.map((r) => r.repo))].sort().join(', ')}`,
				],
			}
		);
	}

	const samples = scoped.map((r) => ({ ...r, node: nodeOf(r.runner, NODES) }));
	const t = nodeZoneTable({ samples, roster: NODES });
	const since = new Date(cutoffMs).toISOString();
	// The ROLE, from the manifest, never the name. A reader comparing boxes has
	// to know which row is not a claw: the backstop is minted for only when it
	// is the right home, so it serves a different population of work than any claw.
	const roles = Object.fromEntries(NODES.map((n) => [n, nodeRole(machines[n])]));
	const payload = {
		mode: 'report',
		days,
		since,
		repo: repoFilter ?? null,
		historyRecords: rows.length,
		scanned: scoped.length,
		roles,
		...t,
	};

	if (JSON_OUT) {
		emitter.emit({ ok: true, ...payload });
	} else {
		log(
			`Failures by node — ${repoFilter ?? 'all repos'}, ${days} d since ${since}   ` +
				`(${payload.scanned} of ${rows.length} records)`
		);
		log('');
		log(
			'  node      role      jobs  repos  fails   cxl  runner  seam  content  fleet   r+s    r+s%'
		);
		for (const r of t.rows) {
			const z = r.zones;
			log(
				`  ${r.node.padEnd(9)} ${(roles[r.node] ?? '—').padEnd(8)} ` +
					`${String(r.jobs).padStart(5)} ${String(r.repos).padStart(6)} ` +
					`${String(r.failures).padStart(6)} ${String(r.cancelled).padStart(5)} ` +
					`${String(z.runner).padStart(7)} ${String(z.seam).padStart(5)} ` +
					`${String(z.content).padStart(8)} ${String(z.fleet).padStart(6)} ` +
					`${String(r.runnerSeam).padStart(5)}  ${r.runnerSeamPct === null ? '   —' : `${r.runnerSeamPct.toFixed(2)}%`.padStart(6)}` +
					`${r.why ? `   ${r.why}` : ''}${r.inRoster ? '' : '   (not in the roster)'}`
			);
		}
		log('');
		log(
			`  totals: ${t.totals.jobs} jobs, ${t.totals.failures} failures, ${t.totals.cancelled} cancelled, ` +
				ZONE_NAMES.map((z) => `${z}:${t.totals[z]}`).join(' ')
		);
		if (t.nodesWithNoData.length) {
			log(`  NO RECORDS in the window: ${t.nodesWithNoData.join(', ')} — a row, not an absence.`);
		}
		log('');
		log(
			"  r+s is the FLEET-ORIGIN pair: `runner` (GitHub's own synthetic steps, or no\n" +
				'  step record) plus `seam` (steps the workflow named but did not write).\n' +
				"  `fleet` is separate and is NOT in r+s: those are jobs the fleet's own unit\n" +
				'  TTL stopped (#22) — the fleet ending a job, not a box failing to run one.\n' +
				'  `cxl` is cancelled and is deliberately unclassified: most cancellations are\n' +
				'  `cancel-in-progress` supersedes and the step one lands on is arbitrary.\n' +
				'  A ZONE IS A PRIOR, NOT A VERDICT. And read the denominator: the fleet-wide\n' +
				"  r+s rate is around 0.15%, so at one node's volume a single event moves the\n" +
				'  percentage by more than any real difference between boxes.'
		);
	}
	return 0;
}
