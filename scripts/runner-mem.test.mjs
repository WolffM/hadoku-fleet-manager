/**
 * The memory pipeline's own regressions — #46 and #47, the two halves lane M
 * of wave 3l owns.
 *
 *   #47  the harvester matched zero runner cgroups under all-JIT naming while
 *        staying `active` on three claws, and was absent from five more. The
 *        tests below pin the unit-name STEMS to the jit-/warm- shapes, and pin
 *        the `--check` gate to the OUTPUT files: a node whose newest completed
 *        job postdates its newest window is a FINDING even though the unit is
 *        green — today's claw-1 shape, by construction.
 *   #46  `fleet mem-report` resolved its manifest through the package's own
 *        library instead of reading the 4-machine fixture packaged with the
 *        repo. The tests pin both halves: it READS the tree the library
 *        resolved, and it REFUSES (never falls back) when the library refuses.
 *
 * Everything runs against FIXTURES: a scratch cgroup tree, a scratch site
 * checkout, a scratch HOME. The one live thing the --check tests touch is this
 * box's own `bash`/`stat`/`date` — the same commands the probe uses on a node —
 * and `.invalid` ssh targets, which cannot resolve by design.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const HARVEST = join(SCRIPTS, 'runner-mem-harvest.py');
const REPORT = join(SCRIPTS, 'runner-mem-report.py');
/** The manifest name this box answers to — spelled the raw `os.hostname()` way
 * so the library's normalising compare is exercised, not bypassed. */
const ME = hostname();

const run = (cmd, args, opts = {}) =>
	spawnSync(cmd, args, { encoding: 'utf8', timeout: 180_000, ...opts });

/** Import a python module and print one expression — the driven-test seam
 * `slice-placement-guard.test.mjs` established for these two scripts. */
function pyExpr(module, expr, env = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'mem-py-'));
	try {
		const driver = join(dir, 'drive.py');
		writeFileSync(
			driver,
			[
				'import importlib.util, json, os, sys',
				`spec = importlib.util.spec_from_file_location("m", ${JSON.stringify(module)})`,
				'm = importlib.util.module_from_spec(spec)',
				'spec.loader.exec_module(m)',
				`print(json.dumps(${expr}))`,
			].join('\n')
		);
		const r = run('python3', [driver], { env: { ...process.env, ...env } });
		assert.equal(r.status, 0, `driver failed: ${r.stderr}`);
		return JSON.parse(r.stdout);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── #47: the stems see the all-JIT unit shapes ───────────────────────────────

test('unit_cgroups matches jit-* and warm-* — the shapes every job has run in since 2026-09-07', () => {
	const root = mkdtempSync(join(tmpdir(), 'mem-cg-'));
	try {
		const mk = (rel) => mkdirSync(join(root, rel), { recursive: true });
		// The five live shapes across the fleet's history, at three depths.
		mk(
			'user.slice/user-1000.slice/user@1000.service/app.slice/jit-claw-1-hadoku-scraper-j101139462953-r33908618175-1788548255.service'
		);
		mk(
			'user.slice/user-1000.slice/user@1000.service/runners.slice/warm-claw-1-hadoku_site.service'
		);
		mk('system.slice/actions.runner.WolffM-hadoku_site.claw-4.service');
		mk('user.slice/user-1000.slice/user@1000.service/app.slice/actions-runner-hadoku_site.service');
		mk('ci.slice/ci-runner.slice/github-runner.service');
		// Decoys: the harvester's OWN unit, a directory without the .service
		// suffix, and a FILE shaped like a unit (rglob must not return it).
		mk('user.slice/user-1000.slice/user@1000.service/app.slice/runner-mem-harvest.service');
		mk('user.slice/user-1000.slice/user@1000.service/app.slice/jit-not-a-unit');
		writeFileSync(
			join(root, 'user.slice/user-1000.slice/user@1000.service/app.slice/warm-file.service'),
			''
		);
		const got = pyExpr(HARVEST, 'sorted(m.unit_cgroups().keys())', {
			HARVEST_CG_ROOT: root,
			HARVEST_INTERVAL: '3',
		});
		assert.deepEqual(got, [
			'actions-runner-hadoku_site.service',
			'actions.runner.WolffM-hadoku_site.claw-4.service',
			'github-runner.service',
			'jit-claw-1-hadoku-scraper-j101139462953-r33908618175-1788548255.service',
			'warm-claw-1-hadoku_site.service',
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

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

/** A scratch site checkout whose scripts/admin holds a manifest. */
function siteFixture(machines) {
	const dir = mkdtempSync(join(tmpdir(), 'mem-site-'));
	const admin = join(dir, 'site', 'scripts', 'admin');
	mkdirSync(admin, { recursive: true });
	writeFileSync(join(admin, 'fleet-runner-manifest.json'), JSON.stringify({ machines }, null, 2));
	return { dir, admin };
}

/** A scratch HOME carrying whatever harvester/job outputs the caller seeds. */
function homeFixture({ samples, inflight, jobs }) {
	const home = mkdtempSync(join(tmpdir(), 'mem-home-'));
	const state = join(home, '.local/state/hadoku/runner-mem');
	mkdirSync(state, { recursive: true });
	mkdirSync(join(home, '.hadoku'), { recursive: true });
	if (samples != null) writeFileSync(join(state, 'samples.jsonl'), samples);
	if (inflight != null) writeFileSync(join(state, 'inflight.json'), inflight);
	if (jobs != null) writeFileSync(join(home, '.hadoku/job-metrics.jsonl'), jobs);
	return home;
}

const iso = (epoch) => new Date(epoch * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
const sampleRow = (end) =>
	JSON.stringify({
		host: ME,
		unit: 'jit-claw-1-fx-j1-r2-3.service',
		start: end - 60,
		end,
		dur_s: 60,
		clipped: false,
		peak_unreclaimable_mb: 900,
		peak_current_mb: 1800,
	});
const jobRow = (ts) =>
	JSON.stringify({
		ts: iso(ts),
		node: ME,
		kind: 'jit',
		repo: 'WolffM/fx',
		peakBytes: 1,
		peakBasis: 'job',
	});

/** A job-metrics.jsonl row for a JIT job, carrying the `jobId` the
 * CONTROLLER's job-history is keyed on. `_parse_job_record` no longer reads a
 * duration from this row's `runner` name — a runner's name says who it was
 * MINTED for, not necessarily who it ended up serving (GitHub can reassign),
 * and even a matching name's mint-to-completion span includes the wait for
 * assignment, which is not sample-able time either. The actual duration this
 * fixture's test expects comes from a SEPARATE job-history fixture, keyed on
 * `jobId` — see `jobHistoryFixture`. */
const jitJobRow = (completedAt, jobId, { runId = 2 } = {}) =>
	JSON.stringify({
		ts: iso(completedAt),
		node: ME,
		kind: 'jit',
		repo: 'WolffM/fx',
		runId,
		jobId,
		job: 'ci',
		runner: `jit-${ME}-fx-j${jobId}-r${runId}-${Math.round(completedAt)}`,
		status: '',
		peakBytes: 1,
		peakBasis: 'job',
	});

/** A job-metrics.jsonl row for a STANDING/`warm-*` job — `jobId` is always
 * `null` on this shape (the hook has no per-job id for a long-lived unit), so
 * its duration is structurally unknowable from job-history no matter what
 * that file holds. */
const warmJobRow = (completedAt) =>
	JSON.stringify({
		ts: iso(completedAt),
		node: ME,
		kind: 'standing',
		repo: 'WolffM/fx',
		runId: 99,
		jobId: null,
		job: 'ci',
		runner: `warm-${ME}-fx`,
		status: '',
		peakBytes: 1,
		peakBasis: 'job',
	});

/** A scratch `job-history.jsonl` — the CONTROLLER's ground truth for how long
 * a job actually ran, keyed on `jobId`. Read locally, from `HADOKU_STATE_DIR`
 * (mirroring `stateDir()`, `src/lib/fleet-paths.ts:228`), never over ssh. */
function jobHistoryFixture(entries) {
	const dir = mkdtempSync(join(tmpdir(), 'mem-history-'));
	const rows = entries.map(({ jobId, durationSec }) =>
		JSON.stringify({
			repo: 'WolffM/fx',
			runId: 1,
			jobId,
			name: 'ci',
			runner: ME,
			labels: ['self-hosted'],
			startedAt: iso(Date.now() / 1000 - durationSec),
			durationSec,
		})
	);
	writeFileSync(join(dir, 'job-history.jsonl'), rows.join('\n') + (rows.length ? '\n' : ''));
	return dir;
}

/** Runs `--check` with BOTH the harvest-output fixture AND a job-history
 * fixture in scope, the shape the real check runs in: harvest output over
 * ssh (here, read locally since this box is "local"), job-history read
 * locally from `HADOKU_STATE_DIR` — never ssh for either, in production. */
function runCheckWithHistory(fx, historyDir, args = [], extraEnv = {}) {
	return run('python3', [REPORT, '--check', ...args], {
		cwd: fx.dir,
		env: {
			...process.env,
			HOME: fx.home,
			FLEET_MANIFEST_DIR: fx.admin,
			FLEET_NO_BANNER: '1',
			HADOKU_STATE_DIR: historyDir,
			...extraEnv,
		},
	});
}

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

// ── #47: `--check` reads the OUTPUT, not the unit ────────────────────────────

function checkFixture({ samples, inflight, jobs, machines }) {
	const home = homeFixture({ samples, inflight, jobs });
	const { dir, admin } = siteFixture(machines ?? { [ME]: { ramGb: 16, maxConcurrent: 2 } });
	return { home, dir, admin };
}

function runCheck(fx, args = []) {
	return run('python3', [REPORT, '--check', ...args], {
		cwd: fx.dir,
		env: {
			...process.env,
			HOME: fx.home,
			FLEET_MANIFEST_DIR: fx.admin,
			FLEET_NO_BANNER: '1',
		},
	});
}

function runReport(fx, args = []) {
	return run('python3', [REPORT, ...args], {
		cwd: fx.dir,
		env: {
			...process.env,
			HOME: fx.home,
			FLEET_MANIFEST_DIR: fx.admin,
			FLEET_NO_BANNER: '1',
		},
	});
}

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

/** A pre-#44-schema record: no `clipped` key at all. */
const unmarkedRow = (end, mb, unit = 'actions-runner-brave-quartet.service') =>
	JSON.stringify({
		host: ME,
		unit,
		start: end - 180,
		end,
		dur_s: 180,
		peak_unreclaimable_mb: mb,
		peak_current_mb: mb + 500,
	});

/** A confirmed-clipped record: the cap and the kill both present. */
const clippedRow = (
	end,
	{ unit = 'actions-runner-fx.service', capMb = 4096, oomKills = 2, mb = 4096 } = {}
) =>
	JSON.stringify({
		host: ME,
		unit,
		start: end - 60,
		end,
		dur_s: 60,
		clipped: true,
		oom_kills: oomKills,
		cgroup_reset: false,
		cap_mb: capMb,
		peak_unreclaimable_mb: mb,
		peak_current_mb: mb + 200,
	});

/** A confirmed-CLEAN record (post-#44-schema, `clipped: false`). */
const cleanRow = (end, mb, unit = 'actions-runner-fx.service') =>
	JSON.stringify({
		host: ME,
		unit,
		start: end - 60,
		end,
		dur_s: 60,
		clipped: false,
		peak_unreclaimable_mb: mb,
		peak_current_mb: mb + 200,
	});

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

test('--check annotates a guest finding as manual-remedy', () => {
	// hokon is covered by the report but never deployed to; its findings must
	// say so, or a red gate points at a box the fleet has decided not to touch.
	const now = Date.now() / 1000;
	const fx = checkFixture({
		samples: sampleRow(now - 3 * 86400) + '\n',
		inflight: JSON.stringify({ host: ME, at: now - 3600, windows: [] }),
		jobs: jobRow(now - 120) + '\n',
		machines: { [ME]: { ramGb: 61, maxConcurrent: 4, role: 'guest' } },
	});
	try {
		const r = runCheck(fx);
		assert.notEqual(r.status, 0);
		assert.match(r.stdout, /\[guest/);
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

/** Force the probe's sampler-start answer without touching a real unit. */
function withSamplerStart(fx, epochOrNull) {
	const bin = join(fx.home, 'bin');
	mkdirSync(bin, { recursive: true });
	// `systemctl` is what the probe asks; a stub on PATH answers for it. The
	// probe pipes the answer through `date -d`, so the stub emits a timestamp
	// in the format systemd itself prints.
	writeFileSync(
		join(bin, 'systemctl'),
		epochOrNull === null
			? '#!/bin/sh\nexit 1\n'
			: `#!/bin/sh\ndate -u -d @${Math.floor(epochOrNull)} "+%a %Y-%m-%d %H:%M:%S UTC"\n`,
		{ mode: 0o755 }
	);
	return bin;
}

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

// ── #99: a window closes when its unit's cgroup is GONE, and survives a restart ──

/**
 * Drive the harvester's sweep and recovery against a fake cgroup tree. `body`
 * is Python run with the module loaded as `m`, `CG` pointing at the tree and
 * `RUN` the set of unit names that "have a Runner.Worker" (the real check
 * reads /proc, which a test cannot fake). Whatever it assigns to `out` is
 * returned as JSON.
 */
function pyHarvest(body, { samplesTail = '' } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'mem-step-'));
	const cg = join(root, 'cg');
	mkdirSync(cg);
	const out = join(root, 'samples.jsonl');
	writeFileSync(out, samplesTail);
	const driver = join(root, 'drive.py');
	writeFileSync(
		driver,
		[
			'import importlib.util, json, os, shutil',
			'from pathlib import Path',
			`spec = importlib.util.spec_from_file_location("m", ${JSON.stringify(HARVEST)})`,
			'm = importlib.util.module_from_spec(spec)',
			'spec.loader.exec_module(m)',
			`CG = Path(${JSON.stringify(cg)})`,
			'RUN = set()',
			'm.has_worker = lambda d: d.name in RUN',
			'def mkunit(rel, anon_mb=100, oom=0):',
			'    d = CG / rel',
			'    d.mkdir(parents=True, exist_ok=True)',
			'    (d / "memory.stat").write_text(f"anon {anon_mb * 1048576}\\nshmem 0\\nfile 0\\nslab 0\\n")',
			'    (d / "memory.events").write_text(f"oom_kill {oom}\\n")',
			'    (d / "memory.max").write_text("max\\n")',
			'    (d / "memory.current").write_text(f"{anon_mb * 1048576}\\n")',
			'    return d',
			'out = None',
			body,
			'print(json.dumps(out))',
		].join('\n')
	);
	try {
		const r = run('python3', [driver], {
			env: {
				...process.env,
				HARVEST_CG_ROOT: cg,
				HARVEST_OUT: out,
				HARVEST_INFLIGHT: join(root, 'inflight.json'),
				HARVEST_INTERVAL: '3',
			},
		});
		assert.equal(r.status, 0, `driver failed: ${r.stderr}`);
		return JSON.parse(r.stdout);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

const JIT = 'jit-claw-8-hadoku-cardtabl-j114270089448-r38071622195-1791653118.service';

test('a JIT window whose cgroup is gone is closed as vanished, ending at the last sweep that saw the worker', () => {
	const rec = pyHarvest(`
d = mkunit("user.slice/app.slice/${JIT}", anon_mb=700)
RUN.add("${JIT}")
ow = {}
assert m.step(ow, m.unit_cgroups(), 100.0) == []
assert m.step(ow, m.unit_cgroups(), 103.0) == []
shutil.rmtree(d)
done = m.step(ow, m.unit_cgroups(), 106.0)
out = {"done": done, "open": list(ow)}
`);
	assert.deepEqual(rec.open, [], 'the window must not stay open');
	assert.equal(rec.done.length, 1);
	const r = rec.done[0];
	assert.equal(r.closed_by, 'vanished');
	assert.equal(
		r.end,
		103,
		'end is the last sweep that SAW the worker, not the one that found it gone'
	);
	assert.equal(r.vanished_at, 106);
	assert.equal(r.samples, 2);
	assert.equal(r.peak_unreclaimable_mb, 700);
	assert.equal(r.clipped, false, 'a JIT unit ending is how a JIT job ends');
});

test('a unit missing from one scan but whose cgroup still exists is NOT closed — one job, one window', () => {
	const rec = pyHarvest(`
d = mkunit("user.slice/app.slice/${JIT}")
RUN.add("${JIT}")
ow = {}
m.step(ow, m.unit_cgroups(), 100.0)
miss = m.step(ow, {}, 103.0)
m.step(ow, m.unit_cgroups(), 106.0)
RUN.clear()
done = m.step(ow, m.unit_cgroups(), 109.0)
out = {"miss": miss, "done": done}
`);
	assert.deepEqual(rec.miss, [], 'a scan miss is not a vanish');
	assert.equal(rec.done.length, 1);
	assert.equal(rec.done[0].closed_by, 'exit');
	assert.equal(rec.done[0].start, 100);
	assert.equal(rec.done[0].samples, 2);
});

test('a STANDING unit whose cgroup vanishes mid-job is marked torn down, so it never sizes', () => {
	const rec = pyHarvest(`
d = mkunit("ci.slice/ci-runner.slice/actions-runner-hadoku-cardtable.service", anon_mb=4000)
RUN.add("actions-runner-hadoku-cardtable.service")
ow = {}
m.step(ow, m.unit_cgroups(), 100.0)
shutil.rmtree(d)
out = m.step(ow, m.unit_cgroups(), 103.0)
`);
	assert.equal(rec.length, 1);
	assert.equal(rec[0].closed_by, 'vanished');
	assert.equal(rec[0].cgroup_reset, true);
	assert.equal(rec[0].clipped, true);
});

test('the ordinary exit still closes as before, and says so', () => {
	const rec = pyHarvest(`
mkunit("system.slice/warm-claw-4-hadoku_site.service", anon_mb=300)
RUN.add("warm-claw-4-hadoku_site.service")
ow = {}
m.step(ow, m.unit_cgroups(), 100.0)
RUN.clear()
out = m.step(ow, m.unit_cgroups(), 103.0)
`);
	assert.equal(rec.length, 1);
	assert.equal(rec[0].closed_by, 'exit');
	assert.equal(rec[0].end, 103);
	assert.equal(rec[0].peak_anon_mb, 300);
});

test('a restart RESUMES a job still running and WRITES OUT one that finished while it was down', () => {
	const rec = pyHarvest(`
a = mkunit("app.slice/${JIT}", anon_mb=500)
b = mkunit("app.slice/jit-claw-8-hadoku_site-j1-r2-3.service", anon_mb=900)
RUN.update(["${JIT}", "jit-claw-8-hadoku_site-j1-r2-3.service"])
ow = {}
m.step(ow, m.unit_cgroups(), 100.0)
m.step(ow, m.unit_cgroups(), 103.0)
snap = json.loads(json.dumps(m.snapshot(ow, 103.0)))
# the process dies here; b's job ends and its unit goes while nothing watches
shutil.rmtree(b)
RUN.discard("jit-claw-8-hadoku_site-j1-r2-3.service")
ow2, done = m.recover(snap, m.unit_cgroups(), 200.0, set())
m.step(ow2, m.unit_cgroups(), 203.0)
RUN.clear()
fin = m.step(ow2, m.unit_cgroups(), 206.0)
out = {"recovered": done, "resumed": fin}
`);
	assert.equal(rec.recovered.length, 1);
	const r = rec.recovered[0];
	assert.equal(r.unit, 'jit-claw-8-hadoku_site-j1-r2-3.service');
	assert.equal(r.closed_by, 'recovered');
	assert.equal(r.end, 103, 'ends at the last sweep that saw its worker');
	assert.equal(r.peak_anon_mb, 900, 'a new-format snapshot carries the full peak');
	assert.equal(r.dur_approx, undefined);
	assert.equal(rec.resumed.length, 1);
	assert.equal(rec.resumed[0].unit, JIT);
	assert.equal(rec.resumed[0].start, 100, 'the resumed window keeps its original start');
	assert.equal(rec.resumed[0].samples, 3);
});

test('an OLD snapshot (no state) recovers what it knows and omits what it never measured', () => {
	const rec = pyHarvest(`
snap = {"host": m.HOST, "at": 5000.0, "windows": [
  {"unit": "${JIT}", "start": 1000.0, "elapsed_s": 4000.0, "samples": 10,
   "peak_unreclaimable_mb": 812.5, "peak_current_mb": 1500.0, "oom_kills": 0, "cap_mb": 6000.0}]}
ow, done = m.recover(snap, m.unit_cgroups(), 9000.0, set())
out = {"open": list(ow), "done": done}
`);
	assert.deepEqual(rec.open, []);
	const r = rec.done[0];
	assert.equal(r.closed_by, 'recovered');
	assert.equal(r.dur_approx, true);
	assert.equal(r.end, 1030, 'start + samples x INTERVAL, not the snapshot time');
	assert.equal(r.peak_unreclaimable_mb, 812.5);
	assert.equal(r.peak_current_mb, 1500);
	assert.equal('peak_anon_mb' in r, false, 'never measured is omitted, not 0');
	assert.equal(r.clipped, false);
});

test('recovery skips a window already in samples.jsonl, ignores another host, and closes a finished one whose unit lingers', () => {
	const rec = pyHarvest(
		`
mkunit("app.slice/warm-claw-8-hadoku_site.service")
snap = {"host": m.HOST, "at": 50.0, "windows": [
  {"unit": "${JIT}", "start": 10.0, "samples": 3, "peak_unreclaimable_mb": 1.0},
  {"unit": "warm-claw-8-hadoku_site.service", "start": 20.0, "samples": 2, "peak_unreclaimable_mb": 2.0}]}
ow, done = m.recover(snap, m.unit_cgroups(), 60.0, m.recently_written())
other = m.recover(dict(snap, host="somewhere-else"), m.unit_cgroups(), 60.0, set())
out = {"open": list(ow), "units": [r["unit"] for r in done], "by": [r["closed_by"] for r in done], "other": other}
`,
		{ samplesTail: JSON.stringify({ unit: JIT, start: 10.0, end: 19.0 }) + '\n' }
	);
	assert.deepEqual(
		rec.units,
		['warm-claw-8-hadoku_site.service'],
		'the JIT one was already written'
	);
	assert.deepEqual(rec.by, ['recovered']);
	assert.deepEqual(rec.open, [], 'a lingering unit with no worker is not resumed');
	assert.deepEqual(rec.other, [{}, []], "another host's snapshot is ignored whole");
});
