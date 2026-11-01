/**
 * `runner-mem-report.py`'s own regressions — #46, #47's `--check` gate, #44
 * and #94. Split out of `runner-mem.test.mjs` (wave 5q lane D, which crossed
 * the 1,000-line test ceiling) by CONCERN: `runner-mem-harvest.test.mjs`
 * holds the other half (#47's unit-shape stems and #99), which never
 * touches this script. The shared fixture helpers live in
 * `scripts/lib/runner-mem-fixtures.mjs`, used by both halves.
 *
 *   #47  the harvester matched zero runner cgroups under all-JIT naming while
 *        staying `active` on three claws, and was absent from five more. The
 *        tests below pin the `--check` gate to the OUTPUT files: a node whose
 *        newest completed job postdates its newest window is a FINDING even
 *        though the unit is green — today's claw-1 shape, by construction.
 *   #46  `fleet mem-report` resolved its manifest through the package's own
 *        library instead of reading the 4-machine fixture packaged with the
 *        repo. The tests pin both halves: it READS the tree the library
 *        resolved, and it REFUSES (never falls back) when the library refuses.
 *
 * Everything runs against FIXTURES: a scratch site checkout, a scratch HOME.
 * The one live thing the --check tests touch is this box's own
 * `bash`/`stat`/`date` — the same commands the probe uses on a node — and
 * `.invalid` ssh targets, which cannot resolve by design.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	ME,
	REPORT,
	run,
	pyExpr,
	checkFixture,
	cleanRow,
	clippedRow,
	jitJobRow,
	jobHistoryFixture,
	jobRow,
	runCheck,
	runCheckWithHistory,
	runReport,
	siteFixture,
	homeFixture,
	sampleRow,
	unmarkedRow,
	warmJobRow,
	withSamplerStart,
} from './lib/runner-mem-fixtures.mjs';

// ── #47: repo_of speaks the all-JIT shapes ───────────────────────────────────

const NODES = [
	'claw-1',
	'claw-2',
	'claw-3',
	'claw-4',
	'claw-5',
	'claw-6',
	'claw-8',
	'claw-9',
	'hokon',
];

test('repo_of strips the LEADING node from warm-* and jit-* units', () => {
	const cases = [
		['warm-claw-1-hadoku_site.service', 'hadoku_site'],
		['warm-claw-9-brave-quartet.service', 'brave-quartet'],
		// A hyphenated repo must survive: the node strip is anchored on the
		// manifest's own node names, longest first.
		['jit-claw-3-hadoku-contact-ui-j9-r8-1788548255.service', 'hadoku-contact-ui'],
		// A TRUNCATED repo name (GitHub's 64-char unit ceiling) is kept
		// verbatim — completing it would invent a join the name cannot support.
		['jit-claw-1-hadoku-promptsm-j106894395143-r35771601155-1790103913.service', 'hadoku-promptsm'],
	];
	for (const [unit, want] of cases) {
		assert.equal(
			pyExpr(REPORT, `m.repo_of(${JSON.stringify(unit)}, ${JSON.stringify(NODES)})`),
			want
		);
	}
});

test('repo_of still handles the standing shapes it always did', () => {
	// The regression guard for the guard: the new branches must not have eaten
	// the old ones. `actions.runner.WolffM-hadoku-craft.claw-4.service` is the
	// greedy-hyphen case from the original bug: a GREEDY quantifier stripped
	// `WolffM-hadoku-` and reported the repo as "craft"; the lazy one keeps the
	// segment, which shows up as a name a reader questions rather than two
	// repos silently merged.
	const N = JSON.stringify(NODES);
	assert.equal(
		pyExpr(REPORT, `m.repo_of("actions.runner.WolffM-hadoku-craft.claw-4.service", ${N})`),
		'hadoku-craft'
	);
	assert.equal(
		pyExpr(REPORT, `m.repo_of("actions-runner-hadoku_site.service", ${N})`),
		'hadoku_site'
	);
	// hokon's backstop unit spells the site repo with a DASH; its Description
	// names WolffM/hadoku_site, so it must fold into the same repo or the
	// site's distribution splits in two.
	assert.equal(
		pyExpr(REPORT, `m.repo_of("actions-runner-hadoku-site.service", ${N})`),
		'hadoku_site'
	);
	assert.equal(pyExpr(REPORT, `m.repo_of("github-runner.service", ${N})`), 'hadoku_site');
});

// ── #46: the manifest the report reads is the one the CLI resolved ──────────

test('the report reads the tree the library resolved — not the packaged fixture (#46)', () => {
	const { dir, admin } = siteFixture({ [ME]: { ramGb: 16, maxConcurrent: 2 } });
	const home = homeFixture({ samples: sampleRow(Date.now() / 1000 - 60) + '\n' });
	try {
		const r = run('python3', [REPORT, '--json', '--min-dur', '5'], {
			cwd: dir,
			env: {
				...process.env,
				HOME: home,
				HADOKU_SITE_ROOT: join(dir, 'site'),
				FLEET_MANIFEST_DIR: '',
				FLEET_NO_BANNER: '1',
			},
		});
		assert.equal(r.status, 0, r.stderr);
		// stderr names the RESOLVED tree — the line the CLI banner printed.
		assert.match(
			r.stderr,
			new RegExp(`manifest: ${admin}/fleet-runner-manifest.json \\(1 machine\\(s\\)\\)`)
		);
		const out = JSON.parse(r.stdout);
		assert.equal(out.machinesDeclared, 1);
		assert.equal(out.unreachable.length, 0);
		assert.equal(out.windows, 1, 'the local node was read locally, not over ssh');
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
});

test('no resolvable manifest → the report REFUSES; it never reads the packaged fixture (#46)', () => {
	const dir = mkdtempSync(join(tmpdir(), 'mem-nosite-'));
	const repos = join(dir, 'repos'); // deliberately holds NO hadoku_site
	mkdirSync(repos, { recursive: true });
	try {
		const r = run('python3', [REPORT, '--json'], {
			cwd: dir, // not a git repo; REPOS_DIR points at the empty scratch
			env: {
				...process.env,
				HOME: dir,
				REPOS_DIR: repos,
				HADOKU_SITE_ROOT: '',
				FLEET_MANIFEST_DIR: '',
				FLEET_NO_BANNER: '1',
			},
		});
		// THE regression: the packaged fixture lives in this very checkout at
		// manifests/fleet-runner-manifest.json and names 4 machines. Reading it
		// produced `machinesDeclared: 4, unreachable: [], exit 0` — five claws
		// silently absent. Refusing is the only correct behavior, and the
		// refusal must come BEFORE any tree is claimed: a `manifest:` line on
		// stderr means the report already read a manifest and is answering with
		// it, whatever fails later in the run.
		assert.notEqual(r.status, 0, 'an unresolvable manifest must fail the report');
		assert.ok(!(r.stdout || '').trim().startsWith('{'), 'no JSON was presented as the fleet');
		assert.doesNotMatch(r.stderr || '', /^manifest:/m, 'no tree was claimed before the refusal');
		const err = (r.stderr || '') + (r.stdout || '');
		assert.match(
			err,
			/hadoku_site checkout does not exist|refused to resolve/,
			'the refusal names its reason'
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── #44: an UNMARKED window still sizes, but every number built from one is a
//    LOWER BOUND, and a clipped window is a named finding ───────────────────
//
// Live on 2026-10-01: brave-quartet's only two windows on the real fleet are
// its original two 2026-09-19 OOM kills (`actions-runner-brave-quartet.
// service`, host hokon), written by a harvester old enough to predate the
// `clipped` field entirely. `usable` (sizing input) stays "not explicitly
// clipped", same as it always was — throwing unmarked rows away would be the
// opposite error, and the fleet-wide gate in `slice-placement-guard.test.mjs`
// already pins that it still sizes. What was missing is the CAVEAT: a number
// built from an unmarked row can only be a floor on the truth, because the row
// could have been clipped and simply predates saying so. These pin the two
// additive signals that carry that caveat: `lowerBound`/`unmarkedInStat` in
// `--json`, a `≥` prefix in text — brave-quartet must read `≥3739`, never a
// bare 3739 — and the unrelated, still-working clipped-finding feature (repo,
// job, cap, kill) for an explicitly clipped window.

test('an UNMARKED-only repo still sizes, but reads ≥3739 — never a bare 3739 (#44)', () => {
	const now = Date.now() / 1000;
	const fx = checkFixture({
		samples: [unmarkedRow(now - 60, 3739.3), unmarkedRow(now - 300, 3444.4)].join('\n') + '\n',
	});
	try {
		const r = runReport(fx, ['--json', '--min-dur', '5']);
		assert.equal(r.status, 0, r.stderr);
		const out = JSON.parse(r.stdout);
		const repo = out.repos['brave-quartet'];
		assert.ok(repo, 'brave-quartet must still be attributed to a repo');
		// STILL SIZES: dropping these would be the opposite error.
		assert.equal(repo.usable, 2);
		assert.equal(repo.unmarked, 2);
		assert.equal(repo.clipped, 0);
		assert.equal(repo.p95, 3739.3);
		assert.equal(repo.max, 3739.3);
		assert.notEqual(repo.suggestedMemoryMaxMb, null);
		// The caveat is additive, not a null-out.
		assert.equal(repo.lowerBound, true);
		assert.equal(repo.unmarkedInStat, 2);
		assert.equal(out.findings.length, 0, 'unmarked is not a clipped finding — it is unknowable');
		// Text mode must print p95 AND max with the ≥ prefix once lowerBound is
		// true — p50 is not in scope (it is not claimed as a lower bound) and
		// may legitimately print bare with only two data points.
		const human = runReport(fx, ['--min-dur', '5']);
		assert.match(human.stdout, /brave-quartet[^\n]*≥3739[^\n]*≥3739/);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test('a mix of unmarked and confirmed-clean windows still sizes from BOTH — the unmarked one as a lower bound', () => {
	const now = Date.now() / 1000;
	// Both unit names resolve to the SAME repo ("fx") independent of this
	// box's hostname — `actions-runner-<repo>` needs no node-stripping at
	// all, which is also why brave-quartet's real unit was chosen that shape
	// above.
	const fx = checkFixture({
		samples:
			[unmarkedRow(now - 500, 9999, 'actions-runner-fx.service'), cleanRow(now - 60, 900)].join(
				'\n'
			) + '\n',
	});
	try {
		const r = runReport(fx, ['--json', '--min-dur', '5']);
		assert.equal(r.status, 0, r.stderr);
		const out = JSON.parse(r.stdout);
		const repo = out.repos.fx;
		assert.equal(repo.usable, 2, 'both rows size — unmarked is not discarded');
		assert.equal(repo.unmarked, 1);
		// 9999 (the unmarked row) is the larger value and correctly WINS the
		// max/p95 — a real figure could sit even higher, never lower, which is
		// exactly why it must carry lowerBound rather than being excluded or
		// silently trusted.
		assert.equal(repo.p95, 9999);
		assert.equal(repo.max, 9999);
		assert.equal(repo.lowerBound, true);
		assert.equal(repo.unmarkedInStat, 1);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test('a repo with ONLY confirmed-clean windows never carries the lower-bound flag', () => {
	const now = Date.now() / 1000;
	const fx = checkFixture({
		samples: [cleanRow(now - 60, 900, 'actions-runner-fy.service')].join('\n') + '\n',
	});
	try {
		const r = runReport(fx, ['--json', '--min-dur', '5']);
		assert.equal(r.status, 0, r.stderr);
		const repo = JSON.parse(r.stdout).repos.fy;
		assert.equal(repo.unmarked, 0);
		assert.equal(repo.lowerBound, false);
		assert.equal(repo.unmarkedInStat, 0);
		const human = runReport(fx, ['--min-dur', '5']);
		assert.doesNotMatch(human.stdout, /≥/, 'a confirmed-clean-only repo never gets the ≥ prefix');
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test('a max sitting at a known cap is flagged atCap even with no `clipped` row in the population', () => {
	const now = Date.now() / 1000;
	// An unmarked row cannot itself carry `cap_mb` (it predates that field
	// too) — the cap reference here comes from a SEPARATE clipped window on
	// the same repo elsewhere in its history, which is how a real fleet
	// accumulates both shapes over time.
	const fx = checkFixture({
		samples:
			[
				unmarkedRow(now - 500, 4090, 'actions-runner-fz.service'),
				clippedRow(now - 60, { unit: 'actions-runner-fz.service', capMb: 4096, mb: 4096 }),
			].join('\n') + '\n',
	});
	try {
		const r = runReport(fx, ['--json', '--min-dur', '5']);
		assert.equal(r.status, 0, r.stderr);
		const repo = JSON.parse(r.stdout).repos.fz;
		// The clipped row is excluded from usable (as always); the unmarked
		// 4090 is what sizes, and it sits within 2% of the repo's known 4096
		// cap — the shape #44 is named for.
		assert.equal(repo.usable, 1);
		assert.equal(repo.max, 4090);
		assert.equal(repo.nearCapMb, 4096);
		assert.equal(repo.atCap, true);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test('a clipped window is a named finding: the repo, the job, the cap and the kill (#44)', () => {
	const now = Date.now() / 1000;
	const fx = checkFixture({
		samples:
			clippedRow(now - 60, {
				unit: 'jit-' + ME + '-fx-j555-r777-123.service',
				capMb: 4096,
				oomKills: 2,
				mb: 4096,
			}) + '\n',
	});
	try {
		const r = runReport(fx, ['--json', '--min-dur', '5']);
		assert.equal(r.status, 0, r.stderr);
		const out = JSON.parse(r.stdout);
		assert.equal(out.findings.length, 1);
		const f = out.findings[0];
		assert.equal(f.repo, 'fx');
		assert.equal(f.unit, 'jit-' + ME + '-fx-j555-r777-123.service');
		assert.equal(f.host, ME);
		assert.equal(f.capMb, 4096);
		assert.equal(f.oomKills, 2);
		assert.equal(f.cgroupReset, false);
		assert.equal(f.peakUnreclaimableMb, 4096);
		// The repo-level rollup still says so, and never prints the floor as a
		// plain number.
		const repo = out.repos.fx;
		assert.equal(repo.usable, 0);
		assert.equal(repo.clipped, 1);
		assert.equal(repo.p95, null);
		assert.equal(repo.floorMb, 4096);
		assert.match(repo.why, /truncated by a cgroup OOM kill/);
		// Human output names it too, not just the JSON.
		const human = runReport(fx, ['--min-dur', '5']);
		assert.match(human.stdout, /clipped: fx/);
		assert.match(human.stdout, /cap 4096 MB/);
		assert.match(human.stdout, /2 oom kill/);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test('--check passes when the heartbeat is fresh and the newest window covers the newest job', () => {
	const now = Date.now() / 1000;
	const fx = checkFixture({
		samples: sampleRow(now - 120) + '\n',
		inflight: JSON.stringify({ host: ME, at: now - 3, windows: [] }),
		jobs: jobRow(now - 180) + '\n',
	});
	try {
		const r = runCheck(fx);
		assert.equal(r.status, 0, (r.stderr || '') + (r.stdout || ''));
		assert.match(r.stdout, /alive on all 1 node/);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test("--check FAILS on today's claw-1: unit green, jobs streaming, windows stopped (#47)", () => {
	// claw-1 as measured 2026-09-22: the sampler process alive (heartbeat
	// current), 399 jobs completed since the last harvested window. is-active
	// says nothing is wrong; the output files say otherwise.
	const now = Date.now() / 1000;
	const fx = checkFixture({
		samples: sampleRow(now - 3 * 86400) + '\n',
		inflight: JSON.stringify({ host: ME, at: now - 3, windows: [] }),
		jobs: jobRow(now - 120) + '\n',
	});
	try {
		const r = runCheck(fx, ['--json']);
		assert.notEqual(r.status, 0, 'active-but-silent is a FINDING');
		const out = JSON.parse(r.stdout);
		assert.equal(out.ok, false);
		assert.match(out.findings.join('\n'), /active but silent/);
		assert.match(out.findings.join('\n'), /postdates the newest harvested window/);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

// ── #94: a job shorter than the sampler's interval is evidence of NOTHING ───
//
// claw-5's own #94 incident turned out NOT to be this shape (see the lane
// report), but the underlying bug is real: a job whose CONTROLLER-measured
// `durationSec` never reached the sampler's interval was never going to be
// caught, and reading that as "jobs streaming past unmeasured" pages for
// nothing. The duration comes from `~/.hadoku-mgmt/job-history.jsonl`, keyed
// on the job-metrics row's own `jobId` — never the runner's NAME: a JIT
// runner's name is who it was MINTED for, not necessarily who it ended up
// serving (GitHub can reassign jobs across runners of the same labels), and
// even a matching name's mint-to-completion span includes the wait for
// assignment, which the harvester's sampler was never going to see either
// way. These pin the shapes the fix must hold: too-short is not flagged,
// long-enough still is, a short ping never CLEARS a finding a longer
// unmeasured job already earned, and an UNKNOWN duration (no jobId, or no
// matching history row) is never treated as too short.

test('a node whose newest job is 4s (per job-history) and whose window predates it is NOT flagged (#94)', () => {
	const now = Date.now() / 1000;
	const fx = checkFixture({
		samples: sampleRow(now - 3 * 86400) + '\n',
		inflight: JSON.stringify({ host: ME, at: now - 3, windows: [] }),
		jobs: jitJobRow(now - 120, 501) + '\n',
	});
	const historyDir = jobHistoryFixture([{ jobId: 501, durationSec: 4 }]);
	try {
		const r = runCheckWithHistory(fx, historyDir, ['--json']);
		assert.equal(r.status, 0, (r.stderr || '') + (r.stdout || ''));
		const out = JSON.parse(r.stdout);
		assert.doesNotMatch(out.findings.join('\n'), /active but silent/);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
		rmSync(fx.dir, { recursive: true, force: true });
		rmSync(historyDir, { recursive: true, force: true });
	}
});

test('the SAME shape with a 120s job (per job-history) IS flagged (#94)', () => {
	const now = Date.now() / 1000;
	const fx = checkFixture({
		samples: sampleRow(now - 3 * 86400) + '\n',
		inflight: JSON.stringify({ host: ME, at: now - 3, windows: [] }),
		jobs: jitJobRow(now - 120, 502) + '\n',
	});
	const historyDir = jobHistoryFixture([{ jobId: 502, durationSec: 120 }]);
	try {
		const r = runCheckWithHistory(fx, historyDir, ['--json']);
		assert.notEqual(r.status, 0, (r.stderr || '') + (r.stdout || ''));
		const out = JSON.parse(r.stdout);
		assert.match(out.findings.join('\n'), /active but silent/);
		assert.match(out.findings.join('\n'), /postdates the newest harvested window/);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
		rmSync(fx.dir, { recursive: true, force: true });
		rmSync(historyDir, { recursive: true, force: true });
	}
});

test('a mixed history — a long unmeasured job then a short one — is STILL flagged (#94)', () => {
	const now = Date.now() / 1000;
	const fx = checkFixture({
		samples: sampleRow(now - 3 * 86400) + '\n',
		inflight: JSON.stringify({ host: ME, at: now - 3, windows: [] }),
		// oldest first, as the harvest's own hook writes them (append-only) and
		// as `tail -n N` hands them back.
		jobs:
			[jitJobRow(now - 300, 503, { runId: 10 }), jitJobRow(now - 10, 504, { runId: 11 })].join(
				'\n'
			) + '\n',
	});
	const historyDir = jobHistoryFixture([
		{ jobId: 503, durationSec: 120 },
		{ jobId: 504, durationSec: 4 },
	]);
	try {
		const r = runCheckWithHistory(fx, historyDir, ['--json']);
		assert.notEqual(r.status, 0, 'the short ping must not clear the earlier long unmeasured job');
		const out = JSON.parse(r.stdout);
		assert.match(out.findings.join('\n'), /active but silent/);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
		rmSync(fx.dir, { recursive: true, force: true });
		rmSync(historyDir, { recursive: true, force: true });
	}
});

test('the too-short threshold is read from HARVEST_INTERVAL, not a second literal (#94)', () => {
	const now = Date.now() / 1000;
	const fx = checkFixture({
		samples: sampleRow(now - 3 * 86400) + '\n',
		inflight: JSON.stringify({ host: ME, at: now - 3, windows: [] }),
		jobs: jitJobRow(now - 120, 505) + '\n',
	});
	const historyDir = jobHistoryFixture([{ jobId: 505, durationSec: 4 }]);
	try {
		// Default HARVEST_INTERVAL=3 makes a 4s job too short (2*3=6 > 4) — the
		// negative control above. Shrinking the interval to 1s (2*1=2 <= 4)
		// must flip that SAME 4s job to qualifying, which only happens if the
		// threshold is read from the harvester's own constant/env at check
		// time rather than copied in as a fixed number.
		const r = runCheckWithHistory(fx, historyDir, ['--json'], { HARVEST_INTERVAL: '1' });
		assert.notEqual(r.status, 0, (r.stderr || '') + (r.stdout || ''));
		const out = JSON.parse(r.stdout);
		assert.match(out.findings.join('\n'), /active but silent/);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
		rmSync(fx.dir, { recursive: true, force: true });
		rmSync(historyDir, { recursive: true, force: true });
	}
});

test('an UNKNOWN duration (no jobId, the standing/warm shape) is never treated as too short (#94)', () => {
	// A job-metrics row with no jobId at all (every standing/`warm-*` row,
	// verified live on claw-5 and claw-8) has NOTHING to look up in
	// job-history, so its duration is unknowable — not short, not long. The
	// cross-check must still fire on it exactly as it did before this fix:
	// "could not tell" is judged the strict way, same as an undateable
	// sampler.
	const now = Date.now() / 1000;
	const fx = checkFixture({
		samples: sampleRow(now - 3 * 86400) + '\n',
		inflight: JSON.stringify({ host: ME, at: now - 3, windows: [] }),
		jobs: warmJobRow(now - 120) + '\n',
	});
	const historyDir = jobHistoryFixture([]); // empty — nothing to match anyway
	try {
		const r = runCheckWithHistory(fx, historyDir, ['--json']);
		assert.notEqual(r.status, 0, (r.stderr || '') + (r.stdout || ''));
		const out = JSON.parse(r.stdout);
		assert.match(out.findings.join('\n'), /active but silent/);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
		rmSync(fx.dir, { recursive: true, force: true });
		rmSync(historyDir, { recursive: true, force: true });
	}
});

test('--check FAILS when jobs complete and samples.jsonl does not exist at all', () => {
	const now = Date.now() / 1000;
	const fx = checkFixture({
		samples: null,
		inflight: JSON.stringify({ host: ME, at: now - 3, windows: [] }),
		jobs: jobRow(now - 120) + '\n',
	});
	try {
		const r = runCheck(fx);
		assert.notEqual(r.status, 0);
		assert.match(r.stdout, /active but silent/);
		assert.match(r.stdout, /collecting nothing/);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test('--check FAILS on a stale heartbeat even with no recent jobs — the unit may be lying', () => {
	const now = Date.now() / 1000;
	const fx = checkFixture({
		samples: sampleRow(now - 30 * 86400) + '\n',
		inflight: JSON.stringify({ host: ME, at: now - 3600, windows: [] }),
		jobs: jobRow(now - 30 * 86400) + '\n',
	});
	try {
		const r = runCheck(fx);
		assert.notEqual(r.status, 0);
		assert.match(r.stdout, /heartbeat stale/);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test('--check does NOT fail an idle node: old windows with no recent jobs are not a finding', () => {
	// The negative control that keeps the gate honest: the heartbeat is fresh
	// (somebody IS sampling) and no job has completed in days (nothing to
	// harvest). Redding here would make the gate cry wolf on a quiet fleet and
	// get turned off.
	const now = Date.now() / 1000;
	const fx = checkFixture({
		samples: sampleRow(now - 3 * 86400) + '\n',
		inflight: JSON.stringify({ host: ME, at: now - 3, windows: [] }),
		jobs: jobRow(now - 3 * 86400 - 60) + '\n',
	});
	try {
		const r = runCheck(fx);
		assert.equal(r.status, 0, (r.stderr || '') + (r.stdout || ''));
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test('--check FAILS on a node it cannot reach — unreachable is a finding, never an absence', () => {
	const now = Date.now() / 1000;
	const fx = checkFixture({
		samples: sampleRow(now - 120) + '\n',
		inflight: JSON.stringify({ host: ME, at: now - 3, windows: [] }),
		jobs: jobRow(now - 180) + '\n',
		machines: {
			[ME]: { ramGb: 16, maxConcurrent: 2 },
			'gate-fx.invalid': { ramGb: 16, maxConcurrent: 2 },
		},
	});
	try {
		const r = runCheck(fx, ['--json']);
		assert.notEqual(r.status, 0, 'a node that could not be looked at is a finding');
		const out = JSON.parse(r.stdout);
		assert.match(out.findings.join('\n'), /gate-fx\.invalid: unreachable/);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test('a BUSY node whose inflight snapshot is truncated is not reported unreadable', () => {
	// Found by running the gate live on 2026-09-23: `inflight.json` grows with
	// every OPEN window, so the probe's byte budget is exceeded exactly when the
	// sampler is busiest. claw-1 and claw-5 were mid-window, the snapshot was
	// cut, `json.loads` failed, and the gate called the heartbeat unreadable on
	// the two nodes that were demonstrably sampling. A gate must not redden
	// BECAUSE the thing it checks is working.
	const now = Date.now() / 1000;
	const windows = Array.from({ length: 400 }, (_, i) => ({
		unit: `jit-claw-1-hadoku-some-long-repo-name-j10740593762${i}-r35927492201-1790201850.service`,
		start: now - 90,
		elapsed_s: 90,
		samples: 30,
		peak_unreclaimable_mb: 1234.5,
		peak_current_mb: 2345.6,
		oom_kills: 0,
		cap_mb: 9837,
	}));
	const snapshot = JSON.stringify({ host: ME, at: now - 3, windows });
	assert.ok(
		snapshot.length > 8000,
		'the fixture must exceed the probe byte budget to mean anything'
	);
	const fx = checkFixture({
		samples: sampleRow(now - 120) + '\n',
		inflight: snapshot,
		jobs: jobRow(now - 180) + '\n',
	});
	try {
		const r = runCheck(fx, ['--json']);
		const out = JSON.parse(r.stdout);
		assert.doesNotMatch(out.findings.join('\n'), /heartbeat is unparseable/);
		assert.equal(r.status, 0, `a busy node is healthy: ${out.findings.join('; ')}`);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test('a truncated sample record still yields its end timestamp, so the cross-check still fires', () => {
	// The same truncation on the OTHER file. A window record carries ~20 fields;
	// if the cut lost `end`, the gate would say "unparseable" instead of naming
	// the real problem, or — worse — miss an active-but-silent node entirely.
	const now = Date.now() / 1000;
	const fat = JSON.stringify({
		host: ME,
		unit: 'jit-claw-1-fx-j1-r2-3.service',
		start: now - 3 * 86400 - 60,
		end: now - 3 * 86400,
		note: 'x'.repeat(6000),
		peak_unreclaimable_mb: 900,
		peak_current_mb: 1800,
		clipped: false,
	});
	const fx = checkFixture({
		samples: fat + '\n',
		inflight: JSON.stringify({ host: ME, at: now - 3, windows: [] }),
		jobs: jobRow(now - 120) + '\n',
	});
	try {
		const r = runCheck(fx, ['--json']);
		const out = JSON.parse(r.stdout);
		assert.notEqual(r.status, 0);
		const all = out.findings.join('\n');
		assert.match(
			all,
			/postdates the newest harvested window/,
			'the end timestamp survived the cut'
		);
		assert.doesNotMatch(all, /unparseable/);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

// ── "stale because broken" vs "stale because nothing has run yet" ────────────
//
// Both look identical from the two output files alone, and they want opposite
// responses. Measured 2026-09-23: claw-8's last job ended 83 seconds BEFORE its
// harvester was installed, so a cross-check that ignored the sampler's start
// called a brand-new working node broken. These two pin each side.

test("a job that ended BEFORE the sampler started is not the sampler's to catch", () => {
	// claw-6 / claw-8 on deploy day: installed and working, last job long past.
	const now = Date.now() / 1000;
	const fx = checkFixture({
		samples: null,
		inflight: JSON.stringify({ host: ME, at: now - 3, windows: [] }),
		jobs: jobRow(now - 3600) + '\n',
	});
	const bin = withSamplerStart(fx, now - 600);
	try {
		const r = run('python3', [REPORT, '--check', '--json'], {
			cwd: fx.dir,
			env: {
				...process.env,
				HOME: fx.home,
				PATH: `${bin}:${process.env.PATH}`,
				FLEET_MANIFEST_DIR: fx.admin,
				FLEET_NO_BANNER: '1',
			},
		});
		const out = JSON.parse(r.stdout);
		assert.doesNotMatch(out.findings.join('\n'), /active but silent/);
		assert.equal(r.status, 0, `a new-and-quiet node is healthy: ${out.findings.join('; ')}`);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test('a job that ended AFTER the sampler started and was never harvested IS a finding', () => {
	// THE CONTROL, and the shape of the original defect: the sampler has been up
	// for days, jobs have completed on it since, and the output has not moved.
	// Bounding by the start must not blunt this.
	const now = Date.now() / 1000;
	const fx = checkFixture({
		samples: sampleRow(now - 10 * 86400) + '\n',
		inflight: JSON.stringify({ host: ME, at: now - 3, windows: [] }),
		jobs: jobRow(now - 600) + '\n',
	});
	const bin = withSamplerStart(fx, now - 4 * 86400);
	try {
		const r = run('python3', [REPORT, '--check', '--json'], {
			cwd: fx.dir,
			env: {
				...process.env,
				HOME: fx.home,
				PATH: `${bin}:${process.env.PATH}`,
				FLEET_MANIFEST_DIR: fx.admin,
				FLEET_NO_BANNER: '1',
			},
		});
		assert.notEqual(r.status, 0);
		assert.match(JSON.parse(r.stdout).findings.join('\n'), /active but silent/);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test('a sampler whose start cannot be read is judged WITHOUT the bound — the strict direction', () => {
	// "I could not look" must not become "nothing is wrong": an undateable
	// sampler falls back to the harsher reading rather than the kinder one.
	const now = Date.now() / 1000;
	const fx = checkFixture({
		samples: sampleRow(now - 10 * 86400) + '\n',
		inflight: JSON.stringify({ host: ME, at: now - 3, windows: [] }),
		jobs: jobRow(now - 600) + '\n',
	});
	const bin = withSamplerStart(fx, null);
	try {
		const r = run('python3', [REPORT, '--check', '--json'], {
			cwd: fx.dir,
			env: {
				...process.env,
				HOME: fx.home,
				PATH: `${bin}:${process.env.PATH}`,
				FLEET_MANIFEST_DIR: fx.admin,
				FLEET_NO_BANNER: '1',
			},
		});
		assert.notEqual(r.status, 0);
		assert.match(JSON.parse(r.stdout).findings.join('\n'), /active but silent/);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
		rmSync(fx.dir, { recursive: true, force: true });
	}
});
