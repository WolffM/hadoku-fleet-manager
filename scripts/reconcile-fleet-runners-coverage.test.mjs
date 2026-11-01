/**
 * `--write-coverage` / `--check-coverage` / `--allow-shrink` (#88, #86, #84
 * pt.2), split off `reconcile-fleet-runners.test.mjs` (wave 5q lane B,
 * whole-block split by concern over the shared rig in
 * `lib/reconcile-fleet-runners-rig.mjs`). `reconcile-fleet-runners-core.test.mjs`
 * holds the other half (offline/retry/mint/header).
 *
 * A SEPARATE fixture from the core half's: `--check-coverage` exits (0 or 1)
 * before the runner-registration flow ever starts, and `--write-coverage`
 * still reaches it afterward — these tests care about the coverage FILE and
 * the exit/stdout `--check-coverage` produces, not registration state, so the
 * `gh repo list` and job-metrics `ssh` shims are built fresh for a
 * configurable repo list and a configurable set of job-metrics rows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
	chmodSync,
	closeSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SCRIPT, NO_GIT_ENV } from './lib/reconcile-fleet-runners-rig.mjs';

/** One job-metrics JIT row, already past the clock-differencing path. */
const metricsRow = (repo, peakMb, daysAgo = 1) =>
	JSON.stringify({
		repo,
		kind: 'jit',
		ts: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
		peakBytes: peakMb * 1048576,
	});

const GH_SHIM_COVERAGE = `#!/usr/bin/env bash
argv="$*"
case "$argv" in
  "repo list"*) cat "$GH_REPOS" ;;
  *"actions/runners"*) cat "$GH_RUNNERS" ;;
  *"-X POST"*"registration-token"*) echo "fixture-token" ;;
  *"-X POST"*"remove-token"*) echo "fixture-token" ;;
  *"-X POST"*"/labels") echo '{}' ;;
  *"releases/latest"*) echo 'v2.337.0' ;;
  *"trees/HEAD"*)
    # #84 part 2 send-back: a tree read that fails every READ_ATTEMPTS,
    # toggled per-test, so a refusal can be proven without touching the
    # happy-path branch every other coverage test relies on.
    if [ -n "\${GH_TREE_FAIL:-}" ]; then
      echo "gh: 403 API rate limit exceeded" >&2
      exit 1
    fi
    if [ -n "\${GH_TREE_TRUNCATED:-}" ]; then
      echo '{"tree":[],"truncated":true}'
    elif [ -n "\${GH_TREE_PKG_COUNT:-}" ]; then
      # #98: N manifests at p01/package.json ... pNN/package.json — a monorepo
      # past the old 12-read slice.
      printf '{"tree":['
      i=1
      while [ "$i" -le "$GH_TREE_PKG_COUNT" ]; do
        [ "$i" -gt 1 ] && printf ','
        printf '{"path":"p%02d/package.json","type":"blob"}' "$i"
        i=$((i + 1))
      done
      printf ']}\\n'
    elif [ -n "\${GH_TREE_MF:-}" ]; then
      # #98: a buildable micro-frontend layout — a vite config with a src/.
      echo '{"tree":[{"path":"vite.config.ts","type":"blob"},{"path":"src/main.ts","type":"blob"}]}'
    elif [ -n "\${GH_TREE_HAS_PKG:-}" ]; then
      echo '{"tree":[{"path":"package.json","type":"blob"}]}'
    else
      echo '{"tree":[]}'
    fi ;;
  *"contents/p"*"/package.json"*)
    # #98: the one manifest named by GH_PKG_UI_PATH declares the header
    # package; every other one declares nothing.
    if [ -n "\${GH_PKG_UI_PATH:-}" ] && [[ "$argv" == *"contents/$GH_PKG_UI_PATH"* ]]; then
      printf '{"content":"%s"}\\n' "$(printf '{"dependencies":{"@wolffm/task-ui-components":"^1.0.0"}}' | base64 -w0)"
    else
      printf '{"content":"%s"}\\n' "$(printf '{"dependencies":{}}' | base64 -w0)"
    fi ;;
  *"contents/package.json"*)
    # The package.json READ, separate from the tree listing above — same
    # failure toggle, same retry-every-attempt shape.
    if [ -n "\${GH_PKG_FAIL:-}" ]; then
      echo "gh: 500 Internal Server Error" >&2
      exit 1
    fi
    printf '{"content":"%s"}\\n' "$(printf '{"dependencies":{}}' | base64 -w0)" ;;
  "api repos/"*)
    # #135: a lookup of ONE repo by name. 404 unless GH_RENAMED ("old=new")
    # says GitHub redirects it; any deeper path keeps the generic answer.
    name="\${argv#api repos/}"
    if [[ "$name" != */*/* && "$name" != *" "* ]]; then
      renamed="\${GH_RENAMED:-}"
      if [ -n "$renamed" ] && [ "\${renamed%%=*}" = "$name" ]; then
        printf '{"full_name":"%s"}\\n' "\${renamed#*=}"
      else
        echo "gh: Not Found (HTTP 404)" >&2
        exit 1
      fi
    else
      echo '{}'
    fi ;;
  *) echo '{}' ;;
esac
`;

/**
 * Drains stdin (the script `runOnSync` sends), and answers the job-metrics
 * read specifically — every other ssh call (none of these tests make one
 * before CHECK_COVERAGE/WRITE_COVERAGE exits or writes) falls back to a
 * generic probe sentinel, matching the shared `SSH_SHIM` above.
 */
const SSH_SHIM_METRICS = `#!/usr/bin/env bash
script="$(cat)"
if [[ "$script" == *"job-metrics.jsonl"* ]]; then
  cat "$METRICS_ROWS" 2>/dev/null
  n=$(wc -l < "$METRICS_ROWS" 2>/dev/null | tr -d ' ')
  echo "#job-metrics-read-end kept=\${n:-0} older=0 files=1"
else
  echo "PROBE-END \${5##*@} 0 0"
fi
`;

/**
 * `repos`: what `gh repo list` returns this run (becomes the LIVE roster,
 * given each also gets an explicit `manifest.repos` entry so resolution skips
 * autoInclude's own API calls entirely). `committedRepos`/`committedFacets`:
 * what is already on disk, the OTHER half of every comparison here.
 * `metricsRows`: raw job-metrics.jsonl lines every node's ssh read answers
 * with verbatim (one shared feed is enough — these tests are about the
 * roster/reserve LOGIC, not about telling nodes apart). `runners`: what
 * `actions/runners` answers for EVERY repo probed (one shared feed again) —
 * default empty, so a test that cares only about the coverage FILE need not
 * also satisfy the registration phase; a test that wants a clean exit code
 * passes one covering every (repo, claw) pair.
 */
function coverageFixture({
	repos,
	committedRepos,
	committedFacets,
	metricsRows,
	runners,
	skipRepos,
}) {
	const root = mkdtempSync(join(tmpdir(), 'reconcile-coverage-'));
	writeFileSync(
		join(root, 'fleet-runner-manifest.json'),
		JSON.stringify({
			machines: { 'cov-claw-1': { labels: ['hadoku-builder'], maxConcurrent: 2 } },
			repos: Object.fromEntries([
				...(repos ?? []).map((r) => [r, {}]),
				...(skipRepos ?? []).map((r) => [r, { skip: true }]),
			]),
		})
	);
	writeFileSync(
		join(root, 'fleet-runner-coverage.json'),
		`${JSON.stringify({ repos: committedRepos ?? [], facets: committedFacets ?? {} }, null, 2)}\n`
	);
	const bin = join(root, 'bin');
	mkdirSync(bin, { recursive: true });
	for (const [name, src] of [
		['gh', GH_SHIM_COVERAGE],
		['ssh', SSH_SHIM_METRICS],
	]) {
		const p = join(bin, name);
		writeFileSync(p, src);
		chmodSync(p, 0o755);
	}
	const ghRepos = join(root, 'gh-repos.json');
	writeFileSync(
		ghRepos,
		JSON.stringify(
			(repos ?? []).map((r) => ({
				nameWithOwner: r,
				isFork: false,
				isArchived: false,
				pushedAt: new Date().toISOString(),
			}))
		)
	);
	const ghRunners = join(root, 'gh-runners.json');
	writeFileSync(
		ghRunners,
		JSON.stringify({ total_count: (runners ?? []).length, runners: runners ?? [] })
	);
	const metricsPath = join(root, 'metrics-rows.jsonl');
	writeFileSync(metricsPath, `${(metricsRows ?? []).join('\n')}\n`);
	// A HERMETIC site root, inside the fixture — `loadMountedApps()` reads
	// `scripts/child-apps.json` off `siteRoot()`, which falls back to the
	// AMBIENT box's own checkout when `HADOKU_SITE_ROOT` is unset (main-1db8a31:
	// every coverage test here silently read the real ~/repos/hadoku_site on a
	// dev box and broke in CI, which has no sibling checkout at all). Every test
	// gets this site root by default via `runCoverage`, so none of them can
	// depend on what happens to exist outside the fixture.
	const siteRoot = join(root, 'site');
	mkdirSync(join(siteRoot, 'scripts'), { recursive: true });
	writeFileSync(join(siteRoot, 'scripts', 'child-apps.json'), JSON.stringify({ apps: [] }));
	return {
		root,
		bin,
		ghRepos,
		ghRunners,
		metricsPath,
		siteRoot,
		coveragePath: join(root, 'fleet-runner-coverage.json'),
	};
}

function runCoverage(fx, argv, extraEnv = {}) {
	const outPath = join(fx.root, 'out.txt');
	const fd = openSync(outPath, 'w');
	let code = 0;
	let stderr = '';
	try {
		execFileSync('node', [SCRIPT, ...argv], {
			env: {
				...NO_GIT_ENV,
				PATH: `${fx.bin}:${process.env.PATH}`,
				// A token the host may not supply: never the App's pool, never a real mint (#9).
				GH_TOKEN: 'fixture',
				FLEET_MANIFEST_DIR: fx.root,
				HADOKU_STATE_DIR: fx.root,
				GH_REPOS: fx.ghRepos,
				GH_RUNNERS: fx.ghRunners,
				METRICS_ROWS: fx.metricsPath,
				GH_PUSHED_AT: new Date().toISOString(),
				// HERMETIC by default — `loadMountedApps()` must read THIS fixture's
				// site root, never whatever happens to sit at the ambient box's own
				// `~/repos/hadoku_site` (or nothing, in CI). A test that specifically
				// wants the read to fail overrides one or both via `extraEnv` below.
				HADOKU_SITE_ROOT: fx.siteRoot,
				REPOS_DIR: fx.root,
				...extraEnv,
			},
			stdio: ['ignore', fd, 'pipe'],
			timeout: 60_000,
		});
	} catch (e) {
		code = e.status ?? -1;
		stderr = String(e.stderr ?? '');
	} finally {
		closeSync(fd);
	}
	return { code, out: readFileSync(outPath, 'utf8'), stderr };
}

test('--check-coverage: a repo leaving the live roster is STRUCTURAL and fails (#86 ask 1)', () => {
	const fx = coverageFixture({
		repos: ['WolffM/cov-alpha'],
		committedRepos: ['WolffM/cov-alpha', 'WolffM/cov-beta'],
		metricsRows: [metricsRow('WolffM/filler', 3215)],
	});
	try {
		const r = runCoverage(fx, ['--check-coverage']);
		assert.equal(r.code, 1, r.out + r.stderr);
		assert.match(r.stderr, /fleet-runner-coverage\.json is stale/);
		assert.match(r.stderr, /cov-beta/);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test('--check-coverage: a measured repo whose jobP95Mb drifted is ADVISORY, not a failure (#86 ask 2)', () => {
	const fx = coverageFixture({
		repos: ['WolffM/cov-alpha'],
		committedRepos: ['WolffM/cov-alpha'],
		committedFacets: {
			'WolffM/cov-alpha': { jobP95Mb: { mb: 1000, basis: 'measured', runs: 40 } },
		},
		// 5 rows meets RESERVE_MIN_RUNS (5), so this repo gets basis `measured`
		// again this run too — a REAL measured drift, not an under-the-floor one.
		metricsRows: [1, 2, 3, 4, 5].map(() => metricsRow('WolffM/cov-alpha', 5000)),
	});
	try {
		const r = runCoverage(fx, ['--check-coverage']);
		assert.equal(r.code, 0, r.out + r.stderr);
		assert.match(r.out, /stale-but-self-healing/);
		assert.match(r.out, /cov-alpha\.jobP95Mb: 1000MB/);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test("--check-coverage: a quiet repo's basis moving from fleet-p95 to kept-last-measured is NOT drift (#86 ask 3, #88)", () => {
	const fx = coverageFixture({
		repos: ['WolffM/cov-alpha'],
		committedRepos: ['WolffM/cov-alpha'],
		// The exact production shape of brave-quartet's PRE-FIX committed entry:
		// basis `fleet-p95` (under min) but `lowerBound: true` — real evidence
		// from its own capped runs, which is what makes it "ever measured".
		committedFacets: {
			'WolffM/cov-alpha': {
				jobP95Mb: { mb: 6313, basis: 'fleet-p95', runs: 0, lowerBound: true },
			},
		},
		// cov-alpha itself has ZERO rows this run (quiet); the fleet p95 comes
		// entirely from an unrelated repo's rows, exactly as a real fleet's does.
		metricsRows: [1, 2, 3, 4, 5].map(() => metricsRow('WolffM/filler', 3215)),
	});
	try {
		const r = runCoverage(fx, ['--check-coverage']);
		assert.equal(r.code, 0, r.out + r.stderr);
		assert.doesNotMatch(r.out + r.stderr, /cov-alpha\.jobP95Mb/, 'no drift line for it at all');
		assert.match(r.out, /kept last measured 6313MB/, "#88's exact report line");
		assert.match(r.out, /0 runs in 14d/);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test("--check-coverage: a NEVER-measured repo's moved fallback is not drift either (#86 ask 3 — vibecheck/games-host shape)", () => {
	// Distinct from the kept-last-measured case above: here the repo has NO
	// evidence of its own, ever (no lowerBound) — it stays on `fleet-p95` both
	// times, and the FLEET figure itself moved a lot (9000 -> 3215, 65%+). This
	// is the exact pre-#86 failure: vibecheck/games-host/task-mobile all read
	// as "stale" purely because the fallback they ride moved with the window.
	const fx = coverageFixture({
		repos: ['WolffM/cov-alpha'],
		committedRepos: ['WolffM/cov-alpha'],
		committedFacets: {
			'WolffM/cov-alpha': { jobP95Mb: { mb: 9000, basis: 'fleet-p95', runs: 0 } },
		},
		metricsRows: [1, 2, 3, 4, 5].map(() => metricsRow('WolffM/filler', 3215)),
	});
	try {
		const r = runCoverage(fx, ['--check-coverage']);
		assert.equal(r.code, 0, r.out + r.stderr);
		assert.doesNotMatch(r.out + r.stderr, /cov-alpha\.jobP95Mb/, 'a moved fallback is not drift');
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test('--write-coverage: a drastic roster shrink refuses the write, file left byte-identical (#84 part 2)', () => {
	const fx = coverageFixture({
		repos: ['WolffM/cov-alpha'],
		committedRepos: ['WolffM/cov-a', 'WolffM/cov-b', 'WolffM/cov-c', 'WolffM/cov-d'],
		metricsRows: [metricsRow('WolffM/filler', 3215)],
	});
	try {
		const before = readFileSync(fx.coveragePath, 'utf8');
		const r = runCoverage(fx, ['--write-coverage']);
		assert.equal(r.code, 1, r.out + r.stderr);
		assert.match(r.stderr, /refusing to write/);
		assert.match(r.stderr, /1 of 4 previous entries/);
		assert.equal(
			readFileSync(fx.coveragePath, 'utf8'),
			before,
			'a refused write must leave the file byte-identical, never degraded'
		);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test('--write-coverage --allow-shrink lands the same drastic shrink on purpose', () => {
	const fx = coverageFixture({
		repos: ['WolffM/cov-alpha'],
		committedRepos: ['WolffM/cov-a', 'WolffM/cov-b', 'WolffM/cov-c', 'WolffM/cov-d'],
		// ON PURPOSE means answered: each dropped repo carries the manifest entry
		// a departure asks for. Without one they vanish unanswered (#135, below).
		skipRepos: ['WolffM/cov-a', 'WolffM/cov-b', 'WolffM/cov-c', 'WolffM/cov-d'],
		metricsRows: [metricsRow('WolffM/filler', 3215)],
		// Every (repo, claw) pair already registered and online, so the exit
		// code reflects the WRITE alone, never the unrelated registration phase
		// that runs after it.
		runners: [
			{
				id: 1,
				name: 'cov-claw-1',
				status: 'online',
				busy: false,
				labels: [{ name: 'hadoku-builder' }],
			},
		],
	});
	try {
		const r = runCoverage(fx, ['--write-coverage', '--allow-shrink']);
		assert.equal(r.code, 0, r.out + r.stderr);
		const onDisk = JSON.parse(readFileSync(fx.coveragePath, 'utf8'));
		assert.deepEqual(onDisk.repos, ['WolffM/cov-alpha']);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

// #135, the 2026-10-22 shape: a covered repo renamed away, with nothing yet
// under the old name and no manifest entry. It used to leave the roster in
// silence and the run exited 0, so the nightly workflow committed the drop.
test('#135: a covered repo renamed away is a departure that fails the run and names the new name', () => {
	const fx = coverageFixture({
		repos: ['WolffM/cov-alpha'],
		committedRepos: ['WolffM/cov-alpha', 'WolffM/cov-renamed'],
		metricsRows: [metricsRow('WolffM/filler', 3215)],
		runners: [
			{
				id: 1,
				name: 'cov-claw-1',
				status: 'online',
				busy: false,
				labels: [{ name: 'hadoku-builder' }],
			},
		],
	});
	try {
		const r = runCoverage(fx, ['--write-coverage'], {
			GH_RENAMED: 'WolffM/cov-renamed=WolffM/cov-renamed-private',
		});
		assert.equal(r.code, 1, r.out + r.stderr);
		assert.match(r.out, /LEFT THE ROSTER \(1\)/);
		assert.match(r.out, /WolffM\/cov-renamed +renamed on GitHub to WolffM\/cov-renamed-private/);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

// ── facet reads must not degrade silently (#84 part 2 send-back, 2026-10-04) ──
//
// `repoTree`/`readJsonFile`/`loadMountedApps` used to swallow a failed read
// into `{}` / an empty Set, so a rate-limited or transient read WROTE a
// coverage file missing that repo's content facets — or, under
// `--check-coverage`, reported a FALSE structural-drift finding caused by this
// run's own read failure rather than anything that actually changed.

test('--write-coverage: a tree read that fails every attempt refuses the write, file byte-identical — and recovers once the read works again', () => {
	const fx = coverageFixture({
		repos: ['WolffM/cov-alpha'],
		committedRepos: ['WolffM/cov-alpha'],
		metricsRows: [metricsRow('WolffM/filler', 3215)],
	});
	try {
		const before = readFileSync(fx.coveragePath, 'utf8');
		const failed = runCoverage(fx, ['--write-coverage'], { GH_TREE_FAIL: '1' });
		assert.equal(failed.code, 1, failed.out + failed.stderr);
		assert.match(failed.stderr, /tree unreadable/);
		assert.match(failed.stderr, /WolffM\/cov-alpha/);
		assert.equal(
			readFileSync(fx.coveragePath, 'utf8'),
			before,
			'a refused write must leave the file byte-identical, never degraded'
		);

		// RESTORE: same fixture, same repo — the read works again, and the
		// write that was refused a moment ago now lands.
		runCoverage(fx, ['--write-coverage']);
		const onDisk = JSON.parse(readFileSync(fx.coveragePath, 'utf8'));
		assert.deepEqual(onDisk.repos, ['WolffM/cov-alpha']);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test('--check-coverage: the same tree-read failure refuses too, and is never reported as structural drift', () => {
	const fx = coverageFixture({
		repos: ['WolffM/cov-alpha'],
		committedRepos: ['WolffM/cov-alpha'],
		metricsRows: [metricsRow('WolffM/filler', 3215)],
	});
	try {
		const r = runCoverage(fx, ['--check-coverage'], { GH_TREE_FAIL: '1' });
		assert.equal(r.code, 1, r.out + r.stderr);
		assert.match(r.stderr, /tree unreadable/);
		assert.doesNotMatch(
			r.stderr,
			/fleet-runner-coverage\.json is stale/,
			'a read failure is "I could not look", never drift'
		);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test('--write-coverage: a package.json read that fails every attempt refuses the write too (readJsonFile)', () => {
	const fx = coverageFixture({
		repos: ['WolffM/cov-alpha'],
		committedRepos: ['WolffM/cov-alpha'],
		metricsRows: [metricsRow('WolffM/filler', 3215)],
	});
	try {
		const before = readFileSync(fx.coveragePath, 'utf8');
		const r = runCoverage(fx, ['--write-coverage'], { GH_TREE_HAS_PKG: '1', GH_PKG_FAIL: '1' });
		assert.equal(r.code, 1, r.out + r.stderr);
		assert.match(r.stderr, /package\.json unreadable/);
		assert.equal(readFileSync(fx.coveragePath, 'utf8'), before);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test('--write-coverage: an unreadable child-apps.json is "could not look", not "no apps mounted" (loadMountedApps)', () => {
	const fx = coverageFixture({
		repos: ['WolffM/cov-alpha'],
		committedRepos: ['WolffM/cov-alpha'],
		metricsRows: [metricsRow('WolffM/filler', 3215)],
	});
	try {
		const before = readFileSync(fx.coveragePath, 'utf8');
		const r = runCoverage(fx, ['--write-coverage'], {
			// A site root that genuinely has no child-apps.json — hermetic,
			// regardless of what the ambient box's own ~/repos/hadoku_site holds.
			HADOKU_SITE_ROOT: fx.root,
		});
		assert.equal(r.code, 1, r.out + r.stderr);
		assert.match(r.stderr, /child-apps\.json unreadable/);
		assert.equal(readFileSync(fx.coveragePath, 'utf8'), before);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

// ── #98: facets come from EVERY manifest, and a partial tree is unreadable ──
//
// All three run `--check-coverage` against a committed roster whose cov-alpha
// has NO content facets, so the question each answers is whether the live
// derivation saw the thing that should change that.

const noFacetsFixture = () =>
	coverageFixture({
		repos: ['WolffM/cov-alpha'],
		committedRepos: ['WolffM/cov-alpha'],
		metricsRows: [metricsRow('WolffM/filler', 3215)],
	});

test('#98: a header dependency in the 13th package.json is seen — the old 12-read slice dropped it', () => {
	const fx = noFacetsFixture();
	try {
		const control = runCoverage(fx, ['--check-coverage'], { GH_TREE_PKG_COUNT: '13' });
		assert.equal(control.code, 0, `13 empty manifests must match no facets: ${control.stderr}`);

		const r = runCoverage(fx, ['--check-coverage'], {
			GH_TREE_PKG_COUNT: '13',
			GH_PKG_UI_PATH: 'p13/package.json',
		});
		assert.equal(r.code, 1, r.out + r.stderr);
		assert.match(r.stderr, /fleet-runner-coverage\.json is stale/);
		assert.match(r.stderr, /facets for WolffM\/cov-alpha/);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test('#98: a repo over the package.json read cap REFUSES rather than reading a subset', () => {
	const fx = noFacetsFixture();
	try {
		const r = runCoverage(fx, ['--check-coverage'], { GH_TREE_PKG_COUNT: '65' });
		assert.equal(r.code, 1, r.out + r.stderr);
		assert.match(r.stderr, /65 package\.json files, over the 64-read cap/);
		assert.doesNotMatch(r.stderr, /is stale/, 'could-not-look is never drift');
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test('#98: a tree GitHub marked `truncated` is unreadable, not a repo with nothing in it', () => {
	const fx = noFacetsFixture();
	try {
		const r = runCoverage(fx, ['--check-coverage'], { GH_TREE_TRUNCATED: '1' });
		assert.equal(r.code, 1, r.out + r.stderr);
		assert.match(r.stderr, /tree unreadable — GitHub returned a truncated tree/);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test('#98: only an app IN the MF registry earns `microFrontend` — includeInRegistry:false is self-serving', () => {
	const fx = noFacetsFixture();
	const childApps = (entry) =>
		writeFileSync(
			join(fx.siteRoot, 'scripts', 'child-apps.json'),
			JSON.stringify({ apps: [{ id: 'alpha', repoName: 'cov-alpha', ...entry }] })
		);
	try {
		// Control: a registry app with a buildable layout gains the facet,
		// which the committed (facet-less) roster does not have.
		childApps({});
		const mounted = runCoverage(fx, ['--check-coverage'], { GH_TREE_MF: '1' });
		assert.equal(mounted.code, 1, mounted.out + mounted.stderr);
		assert.match(mounted.stderr, /facets for WolffM\/cov-alpha/);

		childApps({ includeInRegistry: false, tunnel: { serveOwnUI: true } });
		const own = runCoverage(fx, ['--check-coverage'], { GH_TREE_MF: '1' });
		assert.equal(own.code, 0, `a self-serving app must not be a micro-frontend: ${own.stderr}`);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});
