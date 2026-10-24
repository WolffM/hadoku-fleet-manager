/**
 * demand-derive — P2.2's pure half, exercised without a fleet or a checkout.
 *
 * Fixtures are COMMENT-STRIPPED text, matching what `check-tool-inventory.mjs`
 * actually hands these functions (it strips `#` lines and `name:`/
 * `description:` lines before calling any of these).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	splitJobs,
	deriveCapabilities,
	deriveSetupActions,
	deriveLabels,
	deriveJobName,
	mergeDemandLedger,
	capabilityRetirements,
	deriveJobReserves,
	reserveDrift,
	shrinkRefusal,
	isClippedRow,
	NEAR_CAP_FRACTION,
	RESERVE_MIN_RUNS,
	RESERVE_DRIFT_PCT,
} from './demand-derive.mjs';

// ── splitJobs ────────────────────────────────────────────────────────────

test('splitJobs: two jobs in one file, THE UNIT IS THE JOB', () => {
	const text = [
		'on:',
		'  push:',
		'jobs:',
		'  detect-changes:',
		'    runs-on: ubuntu-latest',
		'    steps:',
		'      - run: echo hi',
		'  deploy:',
		'    runs-on: ${{ fromJSON(vars.CI_RUNNER) }}',
		'    steps:',
		'      - uses: actions/checkout@v6',
	].join('\n');
	const jobs = splitJobs(text);
	assert.deepEqual(
		jobs.map((j) => j.id),
		['detect-changes', 'deploy']
	);
	assert.match(jobs[0].text, /ubuntu-latest/);
	assert.match(jobs[1].text, /vars\.CI_RUNNER/);
	assert.doesNotMatch(jobs[0].text, /vars\.CI_RUNNER/, 'job bodies must not bleed into each other');
});

test('splitJobs: no jobs: key is zero jobs, not a crash', () => {
	assert.deepEqual(splitJobs('on:\n  push:\n'), []);
});

test('splitJobs: CRLF raw text splits like LF (check-tool-inventory passes it unstripped)', () => {
	const text = ['jobs:', '  a:', '    runs-on: x', '  b:', '    runs-on: y', ''].join('\r\n');
	assert.deepEqual(splitJobs(text), [
		{ id: 'a', text: '    runs-on: x' },
		{ id: 'b', text: '    runs-on: y\n' },
	]);
});

test('splitJobs: a workflow with only one job', () => {
	const text = 'jobs:\n  check:\n    runs-on: ubuntu-latest\n';
	assert.deepEqual(
		splitJobs(text).map((j) => j.id),
		['check']
	);
});

test('splitJobs: content after the jobs: block (rare, but legal YAML) does not leak into the last job', () => {
	const text = ['jobs:', '  build:', '    runs-on: ubuntu-latest', 'concurrency: build'].join('\n');
	const jobs = splitJobs(text);
	assert.equal(jobs.length, 1);
	assert.doesNotMatch(jobs[0].text, /concurrency/);
});

test('splitJobs: blank lines left by comment-stripping do not end the jobs: block', () => {
	// check-tool-inventory.mjs strips comment lines to '', leaving blank lines
	// in the middle of a job body — those must not be read as column-0 content.
	const text = [
		'jobs:',
		'  build:',
		'',
		'    runs-on: ubuntu-latest',
		'  test:',
		'    runs-on: ubuntu-latest',
	].join('\n');
	assert.deepEqual(
		splitJobs(text).map((j) => j.id),
		['build', 'test']
	);
});

// ── deriveCapabilities ──────────────────────────────────────────────────────

test('deriveCapabilities: actions/setup-python implies python-toolcache', () => {
	assert.deepEqual(deriveCapabilities('      - uses: actions/setup-python@v6'), [
		'python-toolcache',
	]);
});

test('deriveCapabilities: a bare invocation counts, not just npx — the e2e-canary.yml regression', () => {
	// hadoku_site's e2e-canary.yml carries NO `playwright install` step
	// deliberately and calls it as `pnpm exec playwright test`. A check that
	// only matched `npx playwright` missed this entirely (measured 2026-09-07:
	// 0 repos reported needing playwright while hadoku_site plainly does).
	assert.deepEqual(deriveCapabilities('      run: pnpm exec playwright test --retries=0'), [
		'playwright',
	]);
});

test('deriveCapabilities: npx playwright and a playwright action both count', () => {
	assert.deepEqual(deriveCapabilities('run: npx playwright test'), ['playwright']);
	assert.deepEqual(deriveCapabilities('uses: microsoft/playwright-github-action@v1'), [
		'playwright',
	]);
});

test('deriveCapabilities: ffmpeg and docker are word-boundary invocations, not substring hits', () => {
	assert.deepEqual(deriveCapabilities('run: ffmpeg -i in.mp4 out.mp4'), ['ffmpeg']);
	assert.deepEqual(deriveCapabilities('run: docker run --rm hello-world'), ['docker']);
	assert.deepEqual(deriveCapabilities('uses: docker/build-push-action@v6'), ['docker']);
	// "ffmpegwrapper" must not match a bare ffmpeg word-boundary check.
	assert.deepEqual(deriveCapabilities('run: ffmpegwrapper --version'), []);
});

test('deriveCapabilities: a job with none of the four signals gets an empty list, not undefined', () => {
	assert.deepEqual(deriveCapabilities('runs-on: ubuntu-latest\nsteps:\n  - run: pnpm test'), []);
});

test('deriveCapabilities: a job can ask for more than one capability', () => {
	const text =
		'uses: actions/setup-python@v6\nrun: pnpm exec playwright test\nrun: ffmpeg -version';
	assert.deepEqual(deriveCapabilities(text).sort(), ['ffmpeg', 'playwright', 'python-toolcache']);
});

// ── deriveCapabilities: jdk21 (wave 3y §B) ──────────────────────────────────

test('deriveCapabilities: java, javac, mvn, gradle as commands all imply jdk21', () => {
	assert.deepEqual(deriveCapabilities('run: java -jar app.jar'), ['jdk21']);
	assert.deepEqual(deriveCapabilities('run: javac Main.java'), ['jdk21']);
	assert.deepEqual(deriveCapabilities('run: mvn -B test'), ['jdk21']);
	assert.deepEqual(deriveCapabilities('run: gradle build'), ['jdk21']);
});

test('deriveCapabilities: a bare JAVA_HOME reference implies jdk21', () => {
	assert.deepEqual(deriveCapabilities('run: echo $JAVA_HOME'), ['jdk21']);
	assert.deepEqual(deriveCapabilities('env:\n  JAVA_HOME: /opt/jdk21'), ['jdk21']);
});

test('deriveCapabilities: jdk21 is DIRECTIONAL — "javascript" must not match', () => {
	// The exact trap named in the brief: a substring match on "java" would hit
	// "javascript" too — the engine tries the "java" alternative first, its
	// required trailing whitespace fails against "script", and there is no
	// other alternative ("javac"/"mvn"/"gradle") whose letters agree with
	// "javascript" either, so the whole job correctly reports no capabilities.
	assert.deepEqual(deriveCapabilities('run: npm install --save-dev javascript-obfuscator'), []);
	assert.deepEqual(deriveCapabilities('run: pnpm exec eslint --ext .js,.javascript src/'), []);
});

test('deriveCapabilities: the indirect case — a .jar-ending env VALUE implies jdk21 with no java invocation anywhere', () => {
	// cardtable#5: the job never calls `java` itself. A server process it starts
	// spawns java from an env var whose VALUE is a .jar path. The variable's
	// NAME is not the signal — only the value ending in `.jar` is.
	const text = 'env:\n  CARDTABLE_FORGE_JAR: build/libs/forge-server.jar\nrun: ./start-server.sh';
	assert.deepEqual(deriveCapabilities(text), ['jdk21']);
	// The variable NAME alone, with no .jar-ending value anywhere, must not
	// trigger jdk21 — only the value's extension is the signal.
	assert.deepEqual(deriveCapabilities('env:\n  CARDTABLE_FORGE_JAR: ${{ vars.FORGE_PATH }}'), []);
});

test('deriveCapabilities: jdk21 combines with the other three signals, sorted', () => {
	const text = [
		'uses: actions/setup-python@v6',
		'run: ffmpeg -version',
		'run: java -jar forge.jar',
	].join('\n');
	assert.deepEqual(deriveCapabilities(text).sort(), ['ffmpeg', 'jdk21', 'python-toolcache']);
});

// ── deriveCapabilities: actions/setup-java NEGATES jdk21 (manager correction, 2026-10-05) ──

test('deriveCapabilities: actions/setup-java alone yields no capability at all', () => {
	assert.deepEqual(deriveCapabilities('      - uses: actions/setup-java@v5'), []);
});

test('deriveCapabilities: the task-mobile shape — setup-java plus a gradle command on the fleet form — yields nothing', () => {
	// hadoku-task-mobile/build-apk.yml: actions/setup-java@v5, then a gradle
	// build. The action's own Temurin resolves `gradle`/`java`, so this job
	// must NOT ask the NODE for jdk21 — if it did, the next ledger `--write`
	// would put a JDK into hadoku-builder's REQUIRED set off this one
	// general-pool job, and ci:label-floor would redden every claw fleet-wide
	// demanding a JDK no claw needs to carry.
	const text = [
		'    uses: actions/setup-java@v5',
		'    with:',
		'      java-version: 21',
		'    - run: gradle build',
	].join('\n');
	assert.deepEqual(deriveCapabilities(text), []);
});

test('deriveCapabilities: the cardtable shape — no setup-java, a .jar env value — still yields jdk21', () => {
	const text =
		'env:\n  CARDTABLE_FORGE_JAR: /home/hadoku/.local/share/cardtable/forge.jar\n' +
		'run: test -f "$CARDTABLE_FORGE_JAR"';
	assert.deepEqual(deriveCapabilities(text), ['jdk21']);
});

// ── deriveSetupActions ───────────────────────────────────────────────────────

test('deriveSetupActions: every uses: step, deduped, version kept', () => {
	const text = [
		'  - uses: actions/checkout@v6',
		'  - uses: actions/setup-python@v6',
		'  - uses: actions/checkout@v6', // repeated — a matrix or a second job pass
	].join('\n');
	assert.deepEqual(deriveSetupActions(text), ['actions/checkout@v6', 'actions/setup-python@v6']);
});

test('deriveSetupActions: no uses: steps is an empty array', () => {
	assert.deepEqual(deriveSetupActions('run: pnpm test'), []);
});

// ── deriveLabels ─────────────────────────────────────────────────────────────

test('deriveLabels: the bare fleet form resolves to fleetForm + selfHosted, not hosted', () => {
	const r = deriveLabels('    runs-on: ${{ fromJSON(vars.CI_RUNNER) }}');
	assert.equal(r.fleetForm, true);
	assert.equal(r.selfHosted, true);
	assert.equal(r.hosted, false);
});

test('deriveLabels: ubuntu-latest is hosted, not self-hosted', () => {
	const r = deriveLabels('    runs-on: ubuntu-latest');
	assert.equal(r.hosted, true);
	assert.equal(r.selfHosted, false);
	assert.equal(r.fleetForm, false);
});

test('deriveLabels: an explicit label array is read out, quoted or bare', () => {
	const r = deriveLabels('    runs-on: [self-hosted, "hadoku-builder", "playwright"]');
	assert.equal(r.selfHosted, true);
	assert.deepEqual(r.explicit, ['self-hosted', 'hadoku-builder', 'playwright']);
});

test('deriveLabels: the BARE form (no quotes) is not silently empty — the pm2-host regression', () => {
	// Real usage in this fleet: redeploy-service.yml and cron-schedules-sync.yml
	// both write `runs-on: [self-hosted, pm2-host]` with no quotes. A
	// quoted-only match reported `explicit: []` for every one of these
	// (measured 2026-09-07, before this fix).
	const r = deriveLabels('    runs-on: [self-hosted, pm2-host]');
	assert.deepEqual(r.explicit, ['self-hosted', 'pm2-host']);
});

test('deriveLabels: the fork-PR guard form counts as fleet-targeted', () => {
	// The missing-tool scan already treats this as self-hosted because it lands
	// on a claw for every non-fork push — the demand ledger must agree, or the
	// same job reads as hosted-only to one and fleet-targeted to the other.
	const r = deriveLabels(
		"    runs-on: ${{ (github.event_name == 'pull_request' && github.event.pull_request.head.repo.fork) && fromJSON('[\"ubuntu-latest\"]') || vars.CI_RUNNER }}"
	);
	assert.equal(r.fleetForm, true);
	assert.equal(r.selfHosted, true);
});

test('deriveLabels: pm2-host is self-hosted but not the general pool', () => {
	const r = deriveLabels('    runs-on: [self-hosted, pm2-host]');
	assert.equal(r.selfHosted, true);
	assert.equal(r.fleetForm, false);
});

// ── capabilityRetirements (P3.4 item 3) ─────────────────────────────────────

test('capabilityRetirements: a capability that dropped to zero repos is retired', () => {
	const previous = { ffmpeg: ['WolffM/hadoku-watchparty'] };
	const current = new Map(); // nobody invokes it this run
	assert.deepEqual(capabilityRetirements(previous, current), [
		"capability 'ffmpeg' is no longer needed by any covered repo (last: WolffM/hadoku-watchparty) — retired",
	]);
});

test('capabilityRetirements: still needed by at least one repo is not a retirement', () => {
	const previous = { playwright: ['WolffM/hadoku_site'] };
	const current = new Map([['playwright', new Set(['WolffM/hadoku_site'])]]);
	assert.deepEqual(capabilityRetirements(previous, current), []);
});

test('capabilityRetirements: a capability new to this run (absent from previous) is not a retirement', () => {
	const current = new Map([['docker', new Set(['WolffM/x'])]]);
	assert.deepEqual(capabilityRetirements({}, current), []);
});

test('capabilityRetirements: a previous entry with zero repos names nothing to retire', () => {
	// Defensive only — nothing ever writes an empty array, since a capability
	// with no repo behind it is never added to the map in the first place.
	assert.deepEqual(capabilityRetirements({ ffmpeg: [] }, new Map()), []);
});

test('capabilityRetirements: multiple retirements in one run are all reported', () => {
	const previous = { ffmpeg: ['WolffM/a'], playwright: ['WolffM/b'] };
	assert.equal(capabilityRetirements(previous, new Map()).length, 2);
});

test('capabilityRetirements: no previous state at all (first run) retires nothing', () => {
	assert.deepEqual(
		capabilityRetirements(undefined, new Map([['docker', new Set(['WolffM/x'])]])),
		[]
	);
});

// ── deriveJobName (wave3-prep §K.1) ──────────────────────────────────────
//
// Fixtures here keep their `name:` lines, unlike the ones above: the join key
// is read off a text that lost only its comments, because the tool scan's
// `name:`-stripping would delete the very line this derivation reads.

test('deriveJobName: a literal job-level name is the join key, not the job id', () => {
	const text = [
		'    name: Detect changed workers',
		'    runs-on: x',
		'    steps:',
		'      - run: x',
	].join('\n');
	assert.deepEqual(deriveJobName('detect-changes', text), {
		jobName: 'Detect changed workers',
		jobNameSource: 'literal',
		unjoinable: null,
	});
});

test('deriveJobName: no `name:` at all means GitHub displays the job ID', () => {
	const text = ['    runs-on: x', '    steps:', '      - run: x'].join('\n');
	assert.deepEqual(deriveJobName('lint', text), {
		jobName: 'lint',
		jobNameSource: 'job-id',
		unjoinable: null,
	});
});

test('deriveJobName: an EXPRESSION is never guessed — it is unjoinable WITH a reason', () => {
	// `hadoku_site/deploy-workers.yml`'s matrixed job. It produced the 15
	// `Deploy <worker> / Deploy <worker>` names in job history, and the old
	// jobId key joined every one of them onto whatever else was called `deploy`.
	const text = [
		'    name: Deploy ${{ matrix.worker }}',
		'    uses: ./.github/workflows/_x.yml',
	].join('\n');
	const got = deriveJobName('deploy', text);
	assert.equal(got.jobName, null);
	assert.equal(got.jobNameSource, 'expression');
	assert.match(got.unjoinable, /Deploy \$\{\{ matrix\.worker \}\}/);
	assert.match(got.unjoinable, /resolves at run time/);
});

test('deriveJobName: a step name is 8-space and `- `-prefixed, never the job name', () => {
	// The trap this regex exists to avoid: matching any `name:` would read the
	// first STEP's name as the job's.
	const text = [
		'    runs-on: x',
		'    steps:',
		'      - name: Checkout repository',
		'        uses: a@v1',
	].join('\n');
	assert.equal(deriveJobName('build', text).jobName, 'build');
});

test('deriveJobName: a matrix entry named `name` below the job is not the job name', () => {
	const text = [
		'    runs-on: x',
		'    strategy:',
		'      matrix:',
		'        include:',
		'          - name: variant-a',
	].join('\n');
	assert.equal(deriveJobName('build', text).jobName, 'build');
});

test('deriveJobName: YAML quoting is optional and both forms resolve', () => {
	assert.equal(
		deriveJobName('a', '    name: "Lint, typecheck & test"').jobName,
		'Lint, typecheck & test'
	);
	assert.equal(deriveJobName('a', "    name: 'drain the board'").jobName, 'drain the board');
});

test('deriveJobName: an empty `name:` value falls back to the id rather than to ""', () => {
	assert.deepEqual(deriveJobName('lint', '    name:'), {
		jobName: 'lint',
		jobNameSource: 'job-id',
		unjoinable: null,
	});
});

// ── mergeDemandLedger (wave3-prep §K, lane S's §3 "the one real bug") ────

const RESIDENT = JSON.stringify({
	class: 'resident',
	kind: 'pm2',
	name: 'mgmt-api',
	host: 'hokon',
});
const CI_OLD = JSON.stringify({ class: 'ci', repo: 'WolffM/a', job: 'lint' });
const LEGACY = JSON.stringify({ repo: 'WolffM/a', job: 'lint' });

test('mergeDemandLedger: a resident row survives a CI rewrite', () => {
	// THE BUG: one writeFileSync of this script's own rows deleted measurements
	// taken from another box's kernel.
	const ciRows = [{ class: 'ci', repo: 'WolffM/b', job: 'check' }];
	const got = mergeDemandLedger(`${RESIDENT}\n${CI_OLD}\n`, ciRows);
	assert.equal(got.preserved, 1);
	assert.equal(got.written, 1);
	assert.deepEqual(got.text.trim().split('\n'), [RESIDENT, JSON.stringify(ciRows[0])]);
});

test('mergeDemandLedger: non-ci rows keep their original order, ahead of the CI block', () => {
	const a = JSON.stringify({ class: 'resident', name: 'a' });
	const b = JSON.stringify({ class: 'resident', name: 'b' });
	const got = mergeDemandLedger(`${b}\n${CI_OLD}\n${a}\n`, [{ class: 'ci', repo: 'r', job: 'j' }]);
	assert.deepEqual(got.text.trim().split('\n').slice(0, 2), [b, a]);
});

test('mergeDemandLedger: a row with NO class is a legacy CI row and is replaced', () => {
	// This script was the ledger's only writer until 2026-09-10, so an
	// unlabelled row is one of its own earlier outputs. Preserving it would
	// duplicate every (repo, job) on the first run and grow the file for ever.
	const got = mergeDemandLedger(`${LEGACY}\n`, [{ class: 'ci', repo: 'WolffM/a', job: 'lint' }]);
	assert.equal(got.preserved, 0);
	assert.equal(got.text.trim().split('\n').length, 1);
});

test('mergeDemandLedger: an unparseable line THROWS rather than truncating the file', () => {
	assert.throws(
		() => mergeDemandLedger(`${RESIDENT}\nnot json at all\n`, []),
		/line 2 is not JSON/
	);
});

test('mergeDemandLedger: a first run against no file writes just the CI rows', () => {
	const got = mergeDemandLedger('', [{ class: 'ci', repo: 'r', job: 'j' }]);
	assert.equal(got.preserved, 0);
	assert.equal(got.written, 1);
});

test('mergeDemandLedger: nothing at all writes an EMPTY file, not a bare newline', () => {
	assert.equal(mergeDemandLedger('', []).text, '');
});

// ── deriveJobReserves / reserveDrift (Wave 3g J2) ───────────────────────────
//
// `jobP95Mb` per repo, derived from job-metrics rows. The rows here are what
// `perJobCosts` hands over: a JIT row keeps its `peakBytes`, a standing row's
// is null because it is the unit's high-water mark, not the job's.

const MiB = 1048576;
// Anchored to the clock, not a date: the window is relative to `nowMs`, and an
// absolute fixture date ages out of it (fixture-clock-guard).
const NOW = Date.now();
const TODAY = new Date(NOW).toISOString().slice(0, 10);
const at = (daysAgo) => new Date(NOW - daysAgo * 86_400_000).toISOString();
const job = (repo, peakMb, daysAgo = 1) => ({ repo, ts: at(daysAgo), peakBytes: peakMb * MiB });

test('deriveJobReserves: a repo with min-runs rows gets ITS OWN p95, basis measured, stamped with today', () => {
	const rows = [1000, 1100, 1200, 1300, 5000].map((mb) => job('WolffM/a', mb));
	const r = deriveJobReserves(rows, { repos: ['WolffM/a'], nowMs: NOW, windowDays: 14 });
	assert.equal(RESERVE_MIN_RUNS, 5, "the min is J's --min-runs 5");
	assert.deepEqual(r.byRepo['WolffM/a'], {
		mb: 5000,
		basis: 'measured',
		runs: 5,
		measuredAt: TODAY,
	});
});

test('deriveJobReserves: ONE row under the min is the FLEET p95, and says so per repo', () => {
	// The min-runs boundary, both sides: 5 measured, 4 on the fleet figure.
	const rows = [
		...[1000, 1000, 1000, 1000, 1000].map((mb) => job('WolffM/five', mb)),
		...[9000, 9000, 9000, 9000].map((mb) => job('WolffM/four', mb)),
	];
	const r = deriveJobReserves(rows, {
		repos: ['WolffM/five', 'WolffM/four', 'WolffM/none'],
		nowMs: NOW,
		windowDays: 14,
	});
	assert.equal(r.byRepo['WolffM/five'].basis, 'measured');
	// Four 9,000s are NOT the repo's p95 — they are too few to be one — so the
	// repo carries the fleet's, over all nine rows.
	assert.deepEqual(r.byRepo['WolffM/four'], { mb: r.fleetP95Mb, basis: 'fleet-p95', runs: 4 });
	assert.equal(r.fleetP95Mb, 9000);
	assert.equal(r.fleetRuns, 9);
	assert.deepEqual(
		r.byRepo['WolffM/none'],
		{ mb: 9000, basis: 'fleet-p95', runs: 0 },
		'a covered repo with no rows at all is still in the map, on the fleet figure'
	);
});

test('deriveJobReserves: minRuns is a parameter, not a constant buried in the loop', () => {
	const rows = [1000, 2000].map((mb) => job('WolffM/a', mb));
	const r = deriveJobReserves(rows, {
		repos: ['WolffM/a'],
		nowMs: NOW,
		windowDays: 14,
		minRuns: 2,
	});
	assert.equal(r.byRepo['WolffM/a'].basis, 'measured');
});

test('deriveJobReserves: a standing row (null peak) is NOT a measurement', () => {
	// `perJobCosts` nulls a standing unit's peak because it is the unit's
	// ceiling — warm-claw-7-hadoku_site reported 4,097 MB on every row. Counting
	// it would publish the ceiling as this repo's demand.
	const rows = [
		...[1000, 1000, 1000, 1000].map((mb) => job('WolffM/a', mb)),
		{ repo: 'WolffM/a', ts: at(1), peakBytes: null, peakBytesCumulative: 4097 * MiB },
	];
	const r = deriveJobReserves(rows, { repos: ['WolffM/a'], nowMs: NOW, windowDays: 14 });
	assert.equal(r.byRepo['WolffM/a'].runs, 4);
	assert.equal(r.byRepo['WolffM/a'].basis, 'fleet-p95');
});

test('deriveJobReserves: rows older than the window do not count, undated rows are COUNTED as such', () => {
	const rows = [
		...[1000, 1000, 1000, 1000, 1000].map((mb) => job('WolffM/a', mb, 1)),
		job('WolffM/a', 9000, 15),
		{ repo: 'WolffM/a', ts: 'not-a-date', peakBytes: 9000 * MiB },
	];
	const r = deriveJobReserves(rows, { repos: ['WolffM/a'], nowMs: NOW, windowDays: 14 });
	assert.deepEqual(r.byRepo['WolffM/a'], {
		mb: 1000,
		basis: 'measured',
		runs: 5,
		measuredAt: TODAY,
	});
	assert.equal(r.undated, 1, 'an unplaceable row is reported, not silently dropped');
});

test('deriveJobReserves: NO usable rows is "could not derive", never a fleet of 0 MB jobs', () => {
	const r = deriveJobReserves([], { repos: ['WolffM/a'], nowMs: NOW, windowDays: 14 });
	assert.equal(r.byRepo, null);
	assert.equal(r.fleetP95Mb, null);
	assert.match(r.reason, /no per-job peak/);
});

// ── deriveJobReserves: kept-last-measured (#88) ─────────────────────────────

test('deriveJobReserves: a repo measured before via a capped floor, now 0 runs, keeps its reserve', () => {
	// The exact production shape: brave-quartet's committed entry, pre-fix, is
	// `basis: 'fleet-p95'` with `lowerBound: true` — #76's capped floor, never a
	// real own percentile. #88 says this STILL counts as "ever measured".
	const previousByRepo = {
		'WolffM/brave-quartet': { mb: 6313, basis: 'fleet-p95', runs: 0, lowerBound: true },
	};
	// Fleet p95 today is lower (3215), the exact 2026-10-04 shape.
	const rows = [...[3215, 3215, 3215, 3215, 3215].map((v) => job('WolffM/other', v))];
	const r = deriveJobReserves(rows, {
		repos: ['WolffM/brave-quartet', 'WolffM/other'],
		nowMs: NOW,
		windowDays: 14,
		previousByRepo,
	});
	assert.deepEqual(r.byRepo['WolffM/brave-quartet'], {
		mb: 6313,
		basis: 'kept-last-measured',
		runs: 0,
		measuredMb: 6313,
		lowerBound: true,
	});
});

test('deriveJobReserves: a never-measured repo under the min still falls to the fleet p95, even with a previous entry', () => {
	// games-host/vibecheck's shape: a committed entry exists, but it was ITSELF
	// only ever the fleet fallback — no lowerBound, never `measured`.
	const previousByRepo = {
		'WolffM/games-host': { mb: 9000, basis: 'fleet-p95', runs: 0 },
	};
	const rows = [...[1000, 1000, 1000, 1000, 1000].map((v) => job('WolffM/other', v))];
	const r = deriveJobReserves(rows, {
		repos: ['WolffM/games-host', 'WolffM/other'],
		nowMs: NOW,
		windowDays: 14,
		previousByRepo,
	});
	assert.deepEqual(r.byRepo['WolffM/games-host'], { mb: 1000, basis: 'fleet-p95', runs: 0 });
});

test("deriveJobReserves: kept-last-measured never drops below TODAY's fleet p95 — only more conservative, never lower", () => {
	const previousByRepo = {
		'WolffM/a': { mb: 2000, basis: 'measured', runs: 10, measuredAt: '2026-09-01' },
	};
	// Fleet grew bigger jobs since: today's p95 is now HIGHER than the historical
	// measured figure.
	const rows = [...[5000, 5000, 5000, 5000, 5000].map((v) => job('WolffM/other', v))];
	const r = deriveJobReserves(rows, {
		repos: ['WolffM/a', 'WolffM/other'],
		nowMs: NOW,
		windowDays: 14,
		previousByRepo,
	});
	assert.deepEqual(r.byRepo['WolffM/a'], {
		mb: 5000,
		basis: 'kept-last-measured',
		runs: 0,
		measuredMb: 2000,
		measuredAt: '2026-09-01',
	});
});

test("deriveJobReserves: kept-last-measured carries the ORIGINAL measured figure forward, not the previous night's maxed mb", () => {
	// Night 1 produced { mb: 5000 (maxed against that night's fleet p95),
	// measuredMb: 2000 }. If night 2 read `mb` instead of `measuredMb` as the
	// historical floor, a since-recovered fleet p95 would never shrink back
	// down — the kept figure would erode upward forever.
	const previousByRepo = {
		'WolffM/a': {
			mb: 5000,
			basis: 'kept-last-measured',
			runs: 0,
			measuredMb: 2000,
			measuredAt: '2026-09-01',
		},
	};
	const rows = [...[1000, 1000, 1000, 1000, 1000].map((v) => job('WolffM/other', v))];
	const r = deriveJobReserves(rows, {
		repos: ['WolffM/a', 'WolffM/other'],
		nowMs: NOW,
		windowDays: 14,
		previousByRepo,
	});
	assert.deepEqual(r.byRepo['WolffM/a'], {
		mb: 2000,
		basis: 'kept-last-measured',
		runs: 0,
		measuredMb: 2000,
		measuredAt: '2026-09-01',
	});
});

test('reserveDrift: inside the band is not drift — the nightly gate must not flap', () => {
	const disk = { 'WolffM/a': { mb: 1000, basis: 'measured', runs: 40 } };
	const live = {
		'WolffM/a': { mb: 1000 * (1 + RESERVE_DRIFT_PCT / 100), basis: 'measured', runs: 41 },
	};
	assert.deepEqual(reserveDrift(disk, live), []);
});

test('reserveDrift: past the band is drift, in either direction, and names both numbers', () => {
	const disk = {
		'WolffM/up': { mb: 1000, basis: 'measured', runs: 40 },
		'WolffM/down': { mb: 4000, basis: 'measured', runs: 40 },
	};
	const live = {
		'WolffM/up': { mb: 1300, basis: 'measured', runs: 50 },
		'WolffM/down': { mb: 2000, basis: 'measured', runs: 50 },
	};
	const lines = reserveDrift(disk, live);
	assert.equal(lines.length, 2);
	assert.match(lines.join('\n'), /WolffM\/up\.jobP95Mb: 1000MB .* -> 1300MB/);
	assert.match(lines.join('\n'), /WolffM\/down\.jobP95Mb: 4000MB .* -> 2000MB/);
});

// ── isClippedRow / deriveJobReserves lowerBound (#76) ───────────────────────

test('isClippedRow: a non-zero oomKill is clipped on its own, no limitBytes needed', () => {
	assert.equal(isClippedRow({ peakBytes: 1000 * MiB, oomKill: 1 }), true);
});

test('isClippedRow: a peak within NEAR_CAP_FRACTION of limitBytes is clipped', () => {
	const limitBytes = 4096 * MiB;
	assert.equal(isClippedRow({ peakBytes: limitBytes, limitBytes }), true);
	assert.equal(
		isClippedRow({ peakBytes: Math.ceil(limitBytes * NEAR_CAP_FRACTION), limitBytes }),
		true
	);
	assert.equal(
		isClippedRow({ peakBytes: Math.floor(limitBytes * (NEAR_CAP_FRACTION - 0.1)), limitBytes }),
		false,
		'well under the ceiling is a real measurement, not a cap'
	);
});

test('isClippedRow: no limitBytes and no oomKill is never clipped — including a row with no peak at all', () => {
	assert.equal(isClippedRow({ peakBytes: 1000 * MiB }), false);
	assert.equal(isClippedRow({ peakBytes: null, limitBytes: 100 }), false);
	assert.equal(isClippedRow({}), false);
});

test('deriveJobReserves: brave-quartet — all three runs capped, under minRuns, reserve raised past the fleet p95 anyway', () => {
	// The exact shape #76 names: one OOM-killed at hokon's 4,096 MB, two pinned
	// at claw-2/claw-4's 6,313 MB slice ceiling. Fewer than RESERVE_MIN_RUNS (5)
	// of its own, so basis would ordinarily fall to the fleet p95 — but the
	// known floor from its OWN capped runs must win over that fallback.
	const rows = [
		{ repo: 'WolffM/brave-quartet', ts: at(1), peakBytes: 4096 * MiB, oomKill: 1 },
		{
			repo: 'WolffM/brave-quartet',
			ts: at(2),
			peakBytes: 6313 * MiB,
			limitBytes: 6313 * MiB,
		},
		{
			repo: 'WolffM/brave-quartet',
			ts: at(3),
			peakBytes: 6313 * MiB,
			limitBytes: 6313 * MiB,
		},
		// A fleet of small jobs elsewhere, so there is a real (lower) fleet p95 to
		// contrast against.
		...[1000, 1000, 1000, 1000, 1000].map((v) => job('WolffM/small', v)),
	];
	const r = deriveJobReserves(rows, {
		repos: ['WolffM/brave-quartet', 'WolffM/small'],
		nowMs: NOW,
		windowDays: 14,
	});
	assert.equal(r.byRepo['WolffM/brave-quartet'].basis, 'fleet-p95', 'too few of its own runs');
	assert.equal(r.byRepo['WolffM/brave-quartet'].runs, 3);
	assert.equal(
		r.byRepo['WolffM/brave-quartet'].mb,
		6313,
		'raised to the highest cap its own runs hit, not left at the (lower) fleet p95'
	);
	assert.equal(r.byRepo['WolffM/brave-quartet'].lowerBound, true);
	assert.equal(
		r.byRepo['WolffM/small'].lowerBound,
		undefined,
		'an unclipped repo carries no flag at all'
	);
});

test("deriveJobReserves: a clipped row below the repo's own measured p95 still flags lowerBound, mb unchanged", () => {
	const rows = [
		...[1000, 1100, 1200, 1300, 5000].map((v) => job('WolffM/a', v)),
		// A sixth, clipped run that peaked well under the p95 the other five set —
		// the number is not raised, but the population is still tainted.
		{ repo: 'WolffM/a', ts: at(1), peakBytes: 2000 * MiB, limitBytes: 2000 * MiB },
	];
	const r = deriveJobReserves(rows, { repos: ['WolffM/a'], nowMs: NOW, windowDays: 14 });
	assert.equal(r.byRepo['WolffM/a'].basis, 'measured');
	assert.equal(r.byRepo['WolffM/a'].runs, 6);
	assert.equal(r.byRepo['WolffM/a'].mb, 5000, 'the floor (2000) does not exceed the measured p95');
	assert.equal(r.byRepo['WolffM/a'].lowerBound, true);
});

test('reserveDrift: a repo on one side only is ALWAYS drift — that is a roster change', () => {
	const r = { mb: 1000, basis: 'measured', runs: 5 };
	assert.match(reserveDrift({}, { 'WolffM/a': r })[0], /\+ jobP95Mb for WolffM\/a/);
	assert.match(reserveDrift({ 'WolffM/a': r }, {})[0], /- jobP95Mb for WolffM\/a/);
	// The pre-J2 roster on disk carries NO reserves: every covered repo reads as
	// drift until the first --write-coverage, which is the landing-order cost.
	assert.equal(reserveDrift(undefined, { 'WolffM/a': r, 'WolffM/b': r }).length, 2);
});

// ── reserveDrift: under the min-runs floor is not drift (#86 ask 3) ────────

test('reserveDrift: a repo under the min-runs floor on both sides is skipped entirely, even if basis differs', () => {
	// The exact brave-quartet shape: disk still carries the pre-#88 fleet-p95
	// fallback, live has already moved to kept-last-measured. Same underlying
	// fact (no own measurement this window) — not drift.
	const disk = { 'WolffM/brave-quartet': { mb: 6313, basis: 'fleet-p95', runs: 0 } };
	const live = {
		'WolffM/brave-quartet': {
			mb: 6313,
			basis: 'kept-last-measured',
			runs: 0,
			measuredMb: 6313,
		},
	};
	assert.deepEqual(reserveDrift(disk, live), []);
});

test('reserveDrift: missing entirely on one side, under the min floor on the other, is also skipped', () => {
	const live = { 'WolffM/new-quiet-repo': { mb: 3215, basis: 'fleet-p95', runs: 0 } };
	assert.deepEqual(reserveDrift({}, live), [], 'a brand-new, never-measured repo is not drift');
});

test('reserveDrift: a transition INTO real measurement is still reported, not skipped', () => {
	const disk = { 'WolffM/a': { mb: 3215, basis: 'fleet-p95', runs: 0 } };
	const live = { 'WolffM/a': { mb: 9000, basis: 'measured', runs: 6 } };
	const lines = reserveDrift(disk, live);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /WolffM\/a\.jobP95Mb: 3215MB .* -> 9000MB/);
});

// ── shrinkRefusal (#84 part 2) ───────────────────────────────────────────

test('shrinkRefusal: a drastic shrink (67 -> 0) is refused', () => {
	assert.match(shrinkRefusal(67, 0), /refusing to write/);
});

test('shrinkRefusal: at or above half of the previous count is fine', () => {
	assert.equal(shrinkRefusal(10, 5), null, 'exactly half is the floor, not below it');
	assert.equal(shrinkRefusal(10, 6), null);
});

test('shrinkRefusal: below half is refused', () => {
	assert.match(shrinkRefusal(10, 4), /4 of 10 previous entries \(40%\)/);
});

test('shrinkRefusal: --allow-shrink lifts the refusal', () => {
	assert.equal(shrinkRefusal(67, 0, { allowShrink: true }), null);
});

test('shrinkRefusal: no previous baseline never refuses — nothing to have shrunk from', () => {
	assert.equal(shrinkRefusal(0, 0), null);
	assert.equal(shrinkRefusal(undefined, 5), null);
});

test('shrinkRefusal: growth is always fine', () => {
	assert.equal(shrinkRefusal(10, 50), null);
});
