/**
 * `fleet-runner-coverage.json`: build it, write it (or refuse), and compare
 * it against disk for `--check-coverage` — reconcile-fleet-runners.mjs's
 * three coverage-file concerns, split off the 800-line ceiling (wave 5q lane
 * B, ctx restructure).
 *
 * `readJobReserves` stays DEFINED in the CLI file (it calls `runOnSync`, and
 * `expected-down-guard.test.mjs` only scans top-level `scripts/*.mjs` for the
 * ssh import+call it is one of — see that file's header and the 5g-C commit
 * that first split this CLI). It is passed in on `ctx.readJobReserves` rather
 * than imported, so this lib never reaches back into the CLI.
 *
 * `--json`'s emit-and-exit stays in the CLI for the same reason
 * `label-floor-gate.mjs` keeps it in its CLI: `checkCoverageVerdict` below
 * RETURNS `{ok, jsonBody}` rather than calling `emitter.emit`/`process.exit`
 * itself, so the `if (JSON_OUT) emitter.emit(...)` branch
 * `scripts/lib/json-contract.mjs` scans for is real code in
 * reconcile-fleet-runners.mjs, not here.
 */
import { writeFileAtomic } from '../../dist/lib/atomic-json.js';
import { manifest as manifestFile } from './paths.mjs';
import { RESERVE_DRIFT_PCT, reserveDrift, shrinkRefusal } from './demand-derive.mjs';
import { loadMountedApps, deriveFacets } from './reconcile-apply.mjs';
import { describeCoverageDrift, withoutReserves, reservesOf } from './reconcile-plan.mjs';

const COVERAGE = manifestFile('fleet-runner-coverage.json');

/**
 * Build the `coverage` document: always `{$comment, repos}`, plus `facets`
 * when `ctx.WRITE_COVERAGE` or `ctx.CHECK_COVERAGE` asked for them — facets
 * cost one tree call per repo plus a package.json read, so a plain
 * reconcile run must not pay for them.
 *
 * `ctx.fail` refuses (and does not return) on an unreadable node or an
 * unreadable facet read, exactly as the inline version did — it is the CLI's
 * `failEarly`, so that refusal still reaches `--json`/stdout the one way this
 * package does it.
 */
export function buildCoverageDoc(ctx) {
	const {
		manifest,
		repoList,
		onDiskCoverage,
		log,
		fail,
		readJobReserves,
		WRITE_COVERAGE,
		CHECK_COVERAGE,
	} = ctx;
	let facets;
	if (WRITE_COVERAGE || CHECK_COVERAGE) {
		const { mounted, reason: mountedReason } = loadMountedApps();
		// A failed registry read is not "zero apps mounted" — it is "I could not
		// look", and it taints EVERY repo's `microFrontend` facet at once (send-back,
		// 2026-10-04), so it is collected into the same refusal `deriveFacets`'s own
		// per-repo failures feed below, rather than silently defaulting to an empty
		// Set.
		const unreadableFacets = mountedReason
			? [`scripts/child-apps.json unreadable — ${mountedReason}`]
			: [];
		// The COMMITTED reserve map, read once above — the evidence #88 needs to
		// tell "never measured" (fall to the fleet p95) from "measured before,
		// quiet now" (keep the last figure).
		const previousReserves = reservesOf(onDiskCoverage?.facets);
		// Read BEFORE the tree calls: an unreadable node refuses the whole write
		// or check, and there is no point spending a GitHub call per repo first.
		const reserves = readJobReserves(manifest, repoList, previousReserves);
		if (reserves.unreadable.length) {
			fail(
				`fleet-runner-coverage.json: cannot derive jobP95Mb — ${reserves.unreadable.length} ` +
					`node(s) unreadable, and a p95 without their jobs is not the fleet's: ` +
					reserves.unreadable.map((u) => `${u.node}: ${u.why}`).join('; ')
			);
		}
		if (!reserves.byRepo) fail(`fleet-runner-coverage.json: ${reserves.reason}`);
		const reserveEntries = Object.entries(reserves.byRepo);
		const measured = reserveEntries.filter(([, r]) => r.basis === 'measured');
		const kept = reserveEntries.filter(([, r]) => r.basis === 'kept-last-measured');
		// NEVER MEASURED, not merely quiet — #88's whole point is that these two
		// are different repos. A repo with its OWN evidence (a true percentile, or
		// a capped floor) never lands here even on a 0-run night; see `kept` below.
		const neverMeasured = reserveEntries
			.filter(([, r]) => r.basis === 'fleet-p95')
			.map(([repo, r]) => `${repo} (${r.runs} run${r.runs === 1 ? '' : 's'})`);
		log(
			`jobP95Mb: ${measured.length} repo(s) measured, ${kept.length} kept from last ` +
				`measurement, fleet p95 ${reserves.fleetP95Mb}MB over ${reserves.fleetRuns} ` +
				`per-job peaks from ${reserves.nodesRead} node(s), last ${reserves.windowDays} ` +
				`days, min ${reserves.minRuns} runs` +
				(reserves.undated ? `, ${reserves.undated} undated row(s) excluded` : '')
		);
		// SAID PER REPO, as the brief asks: a fallback figure is the fleet's, not
		// the repo's, and a reader of the roster must be able to tell which.
		if (neverMeasured.length) {
			log(`jobP95Mb: on the fleet p95, never measured: ${neverMeasured.join(', ')}`);
		}
		// #88's exact report line: a repo under the min-runs floor that HAS a
		// measurement of its own keeps it rather than falling to the fleet figure.
		for (const [repo, r] of kept) {
			log(
				`jobP95Mb: ${repo}: kept last measured ${r.measuredMb}MB` +
					(r.measuredAt ? ` from ${r.measuredAt}` : ' (measured-at date not on record)') +
					`; ${r.runs} run${r.runs === 1 ? '' : 's'} in ${reserves.windowDays}d`
			);
		}
		// A RESERVATION BUILT FROM CAPPED RUNS IS A LOWER BOUND (#76). Named here
		// for the same reason the fallback list is: `deriveJobReserves` already
		// raised `mb` to the highest cap the repo's own runs hit and set
		// `lowerBound: true`, but that number still LOOKS like an ordinary measured
		// figure in the roster unless a reader is told it is a floor, not a
		// ceiling — which is exactly how brave-quartet's 3,091 MB read as exact
		// before this.
		const lowered = reserveEntries
			.filter(([, r]) => r.lowerBound === true)
			.map(([repo, r]) => `${repo} (${r.mb}MB)`);
		if (lowered.length) log(`jobP95Mb: lower bound only (a run hit a cap): ${lowered.join(', ')}`);
		facets = {};
		for (const repo of repoList) {
			const { facets: repoFacets, unreadable } = deriveFacets(repo, mounted);
			if (unreadable) unreadableFacets.push(unreadable);
			facets[repo] = { ...repoFacets, jobP95Mb: reserves.byRepo[repo] };
		}
		// REFUSE BEFORE EITHER BRANCH READS `facets`, not just before the write:
		// `--check-coverage` against a degraded live derivation would report a
		// MISSING content facet as structural drift — a false finding caused by
		// this run's own read failure, not by anything that actually changed
		// (send-back, 2026-10-04). "Compute fully, check completeness, THEN act"
		// applies to a check exactly as much as to a write.
		if (unreadableFacets.length) {
			fail(
				`fleet-runner-coverage.json: cannot derive facets — ${unreadableFacets.length} ` +
					`read(s) failed, and a roster missing their content facets is not the fleet's: ` +
					unreadableFacets.join('; ')
			);
		}
	}

	return {
		$comment:
			'GENERATED by reconcile-fleet-runners.mjs --write-coverage. Do not hand-edit. ' +
			'`repos` is consumed by mgmt-api runner-health (CI_RUNNER hosted fallback) and the ' +
			'repo-policy reconciler. `facets` is what each repo IS, so fleet checkers ' +
			'(check-header-fleet, check-tier-fleet, check-mf-externals) filter this ONE roster ' +
			'instead of keeping their own membership arrays — which had already drifted apart. ' +
			"`facets[repo].jobP95Mb` is the p95 of that repo's per-job peak memory over the " +
			"job-metrics window, read by JIT admission. `basis` is `measured` (this repo's own " +
			'percentile this run), `kept-last-measured` (under the min runs THIS run, but ' +
			'measured before — #88 — with `measuredMb`/`measuredAt` carrying the original figure ' +
			"and `mb` never lower than today's fleet p95), or `fleet-p95` (never measured; `mb` " +
			'is the fleet figure). `lowerBound: true` (additive; absent means false) means at ' +
			'least one contributing run was itself capped — OOM-killed, or pinned at a node ' +
			'ceiling — so `mb` is a FLOOR raised to the highest cap seen, never an exact ' +
			'measurement; admission must not treat it as a number the job will stay under (#76).',
		repos: repoList,
		...(facets ? { facets } : {}),
	};
}

/**
 * `--check-coverage`'s verdict: is `fleet-runner-coverage.json` still
 * current? Does every human-readable print the inline version did; returns
 * `{ok, jsonBody}` rather than emitting/exiting itself — see the module
 * header.
 */
export function checkCoverageVerdict(ctx) {
	const { onDiskCoverage: onDisk, coverage, log } = ctx;
	// FACETS are compared too, not just the repo list. Three fleet checkers
	// now derive their membership from them, so a stale facet map silently
	// drops a repo out of scope — which is the exact failure this whole
	// roster replaced. Checking only `repos` would have left that hole open
	// one layer down.
	const sameRepos = JSON.stringify(onDisk?.repos ?? null) === JSON.stringify(coverage.repos);
	// Two comparisons, because the facets are two kinds of fact. The ones
	// derived from a repo's CONTENTS change with a commit and compare exactly;
	// `jobP95Mb` changes with the calendar — see `RESERVE_DRIFT_PCT` — and is
	// handled entirely separately, below, as an ADVISORY (#86).
	const diskFacets = onDisk?.facets ? withoutReserves(onDisk.facets) : null;
	const sameFacets =
		JSON.stringify(diskFacets) === JSON.stringify(withoutReserves(coverage.facets));

	// STRUCTURAL drift (#86 ask 1): a repo joined or left the roster, or a
	// content facet (`wolffmConsumer`, `uiApp`, `microFrontend`) changed. A
	// daily `--write-coverage` cannot be assumed to be pending for this —
	// it is real, and still fails the gate.
	const structuralLines = [];
	if (!sameRepos || !sameFacets) {
		// Name WHAT differs, never just how many. This message used to print
		// `repos on disk: 26  live: 26  <-- DIFFERS`, which is a count telling
		// you the counts match while the sets do not — the reader is left with
		// nothing to act on and no way to judge whether the drift is expected.
		// Both real cases here (two repos picking up @wolffm/cdn-client, and a
		// mis-sorted repo list) are invisible at that resolution.
		const described = describeCoverageDrift(onDisk && { ...onDisk, facets: diskFacets ?? {} }, {
			...coverage,
			facets: withoutReserves(coverage.facets),
		});
		if (described) structuralLines.push(described);
	}

	// MEASURED drift (#86 ask 2/3): `jobP95Mb` only. `reserveDrift` already
	// skips any repo under the min-runs floor on either side — "I could not
	// look" never reads as drift — so what is left here is a REAL measured
	// repo whose figure moved, which a daily `--write-coverage` repairs on its
	// own. Always advisory, never a reason to fail this gate.
	const advisories = reserveDrift(reservesOf(onDisk?.facets), reservesOf(coverage.facets)).map(
		(l) => l.trim()
	);

	if (structuralLines.length) {
		console.error(`fleet-runner-coverage.json is stale.\n${structuralLines.join('\n')}`);
		console.error(`  fix: fleet reconcile --write-coverage`);
		for (const a of advisories) console.error(`  (advisory, stale-but-self-healing) ${a}`);
		return { ok: false, jsonBody: { ok: false, structuralDrift: structuralLines, advisories } };
	}
	for (const a of advisories) {
		log(`fleet-runner-coverage.json: stale-but-self-healing (advisory): ${a}`);
	}
	log(
		`fleet-runner-coverage.json is current (${coverage.repos.length} repos, ` +
			`${Object.keys(withoutReserves(coverage.facets)).length} with content facets` +
			(advisories.length
				? `, ${advisories.length} measured advisory(ies) — ${RESERVE_DRIFT_PCT}% band)`
				: `, jobP95Mb within ${RESERVE_DRIFT_PCT}% for all ${Object.keys(reservesOf(coverage.facets)).length})`)
	);
	return { ok: true, jsonBody: { ok: true, structuralDrift: [], advisories } };
}

/**
 * `--write-coverage`: refuse on a drastic shrink (#84 part 2), else write the
 * file and say so. `ctx.fail` is the CLI's `failEarly` — same reasoning as
 * {@link buildCoverageDoc}.
 */
export function writeCoverageOrRefuse(ctx) {
	const { committedRoster, coverage, ALLOW_SHRINK, fail, log } = ctx;
	// THE SHRINK FLOOR (#84 part 3). Computed and checked BEFORE the write,
	// same discipline as the unreadable-node and no-data refusals above —
	// "wrote a degraded file, then failed" must stay unreachable here too.
	const shrink = shrinkRefusal(committedRoster.length, coverage.repos.length, {
		allowShrink: ALLOW_SHRINK,
	});
	if (shrink) fail(`fleet-runner-coverage.json: ${shrink}`);
	// Two spaces, not a tab: .prettierrc overrides *.json to `useTabs: false`,
	// so tab-indented output is valid but non-conforming — auto-format.yml
	// rewrites it on main as hadoku-format-bot, and every regeneration then
	// shows up as a whole-file diff. Matching prettier here keeps the only
	// real diff the one that matters: which repos are covered.
	writeFileAtomic(COVERAGE, `${JSON.stringify(coverage, null, 2)}\n`);
	log(`wrote ${COVERAGE} (${coverage.repos.length} repos)`);
}
