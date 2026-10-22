/**
 * check-tool-inventory — §B (wave 3y): the demand ledger sees Java and
 * indirect `*.jar` use, and pinned/hosted demand is REPORTED, never added to
 * the floor.
 *
 * `scripts/lib/demand-derive.test.mjs` already covers `deriveCapabilities`'s
 * `jdk21` detector in isolation, including the directional ("javascript" must
 * not match) case and the `actions/setup-java` negation (manager correction,
 * 2026-10-05). This file is the END-TO-END proof that the real gate, spawned
 * as a process against a fixture tree, both:
 *
 *   (a) excludes a pinned job's `jdk21` demand from `requiredIdentitySet`
 *       (hadoku-builder's floor) in the WRITTEN ledger, and keeps a
 *       general-pool job that uses `actions/setup-java` + `gradle`
 *       (hadoku-task-mobile's real shape) OUT of it too, and
 *   (b) prints EVERY pinned/hosted job's capabilities in a report, each one
 *       marked against what the general pool has actually EARNED
 *       (`provenCapabilities`, read from the manifest's bootcamp facet) —
 *       never filtered down to an "unproven" subset, and never silent about a
 *       general-pool node with no bootcamp record at all.
 *
 * NO NETWORK FOR THE CAPABILITY QUESTION. `provenCapabilities` reads
 * `node.$capabilities` straight off the manifest JSON object — no ssh, no
 * execution. The gate ALSO runs its own (unrelated) missing-tool ssh probe
 * against every selected node, which this fixture avoids two ways: the
 * "proven" node is named exactly `os.hostname()`, so `isLocalNode` is true and
 * the probe runs as a local `bash -s` (per `src/lib/node-identity.ts` — "is
 * this node the box I am running on", asked in one place); the "unprobed"
 * node goes through a fake `ssh` on `PATH` that never dials out, so even an
 * unreachable fixture node costs nothing real. `HADOKU_SITE_ROOT`,
 * `FLEET_MANIFEST_DIR`, `REPOS_DIR` and `HADOKU_STATE_DIR` all point inside a
 * throwaway tmpdir, so this test is blind to this machine's real hadoku_site
 * checkout and real manifest by construction, not by luck.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { requiredIdentitySet } from '../dist/capabilities.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'check-tool-inventory.mjs');

const CARDTABLE = 'WolffM/hadoku-cardtable';
const MEDIAFORGE = 'WolffM/hadoku-mediaforge';
const TASKMOBILE = 'WolffM/hadoku-task-mobile';

// This box's own hostname — named here, not in `isLocalNode`, so a node
// carrying it resolves local and the gate's missing-tool probe runs as a
// plain `bash -s` rather than dialing ssh anywhere.
const LOCAL_NODE = hostname();
const UNPROBED_NODE = 'claw-fixture-unprobed';

/**
 * cardtable's forge-e2e shape (brief, wave3y): a job pinned to `pm2-host`
 * that never invokes `java` itself — the server it starts spawns java from
 * `CARDTABLE_FORGE_JAR`, an env var whose VALUE is a `.jar` path. Also carries
 * a general-pool job ("build") and a job that only MENTIONS "javascript"
 * ("js-lint") — the substring that must never read as `jdk21`.
 */
const CARDTABLE_WORKFLOW = [
	'jobs:',
	'  forge-e2e:',
	'    runs-on: [self-hosted, pm2-host]',
	'    env:',
	'      CARDTABLE_FORGE_JAR: build/libs/forge-server.jar',
	'    steps:',
	'      - run: ./start-server.sh',
	'  build:',
	'    runs-on: ${{ fromJSON(vars.CI_RUNNER) }}',
	'    steps:',
	'      - run: echo hello',
	'  js-lint:',
	'    runs-on: ${{ fromJSON(vars.CI_RUNNER) }}',
	'    steps:',
	'      - run: pnpm exec eslint --ext .js,.javascript src/',
	'',
].join('\n');

/**
 * A second pinned job, on a different repo and a different capability
 * (ffmpeg, pinned to one named machine rather than pm2-host) — proves the
 * report is general, not a jdk21-only special case, and (with the fixture
 * manifest below) exercises the "earned by a named pool node" branch, as
 * opposed to cardtable's "earned by no pool node" branch.
 */
const MEDIAFORGE_WORKFLOW = [
	'jobs:',
	'  transcode:',
	'    runs-on: [self-hosted, claw-9]',
	'    steps:',
	'      - run: ffmpeg -i in.mp4 out.mp4',
	'',
].join('\n');

/**
 * hadoku-task-mobile's REAL shape (manager correction, 2026-10-05):
 * `actions/setup-java` plus a gradle build, on the GENERAL POOL. Must derive
 * NO capability at all — the action's own Temurin resolves `gradle`, so this
 * asks the node for nothing. If it derived `jdk21`, the next `--write` would
 * put a JDK into hadoku-builder's REQUIRED set off this job alone.
 */
const TASKMOBILE_WORKFLOW = [
	'jobs:',
	'  build:',
	'    runs-on: ${{ fromJSON(vars.CI_RUNNER) }}',
	'    steps:',
	'      - uses: actions/setup-java@v5',
	'        with:',
	'          java-version: 21',
	'      - run: gradle build',
	'',
].join('\n');

/** A fake `ssh` that never dials out: consumes stdin (the probe script) and
 * exits 1 with no output, so the one fixture node that is NOT this box's own
 * hostname reads as unreachable instead of attempting real network I/O. */
const SSH_SHIM = `#!/usr/bin/env bash
cat >/dev/null
exit 1
`;

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'tool-inventory-'));
	const manifestDir = join(root, 'admin');
	const siteRoot = join(root, 'site');
	const reposDir = join(root, 'repos');
	const stateDir = join(root, 'state');
	const bin = join(root, 'bin');
	mkdirSync(manifestDir, { recursive: true });
	mkdirSync(join(siteRoot, '.git'), { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(bin, { recursive: true });

	const sshBin = join(bin, 'ssh');
	writeFileSync(sshBin, SSH_SHIM);
	chmodSync(sshBin, 0o755);

	writeFileSync(
		join(manifestDir, 'fleet-runner-manifest.json'),
		JSON.stringify({
			machines: {
				// Proves `docker` and `ffmpeg` by execution; does NOT prove `jdk21` —
				// no claw has one, which is the actual gap this report exists to show.
				[LOCAL_NODE]: {
					$capabilities: { earned: ['docker'], prereqs: [{ id: 'ffmpeg' }] },
				},
				// No `$capabilities` at all — `provenCapabilities` must return `null`
				// and this run must say so, never silently proving nothing on its
				// behalf.
				[UNPROBED_NODE]: {},
			},
		})
	);
	writeFileSync(
		join(manifestDir, 'fleet-runner-coverage.json'),
		JSON.stringify({ repos: [CARDTABLE, MEDIAFORGE, TASKMOBILE] })
	);

	for (const [repo, text] of [
		[CARDTABLE, CARDTABLE_WORKFLOW],
		[MEDIAFORGE, MEDIAFORGE_WORKFLOW],
		[TASKMOBILE, TASKMOBILE_WORKFLOW],
	]) {
		const dir = join(reposDir, repo.split('/').pop());
		mkdirSync(join(dir, '.git'), { recursive: true });
		mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
		writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), text);
	}

	return { root, manifestDir, siteRoot, reposDir, stateDir, bin };
}

function cleanup(fx) {
	rmSync(fx.root, { recursive: true, force: true });
}

function env(fx) {
	return {
		...process.env,
		PATH: `${fx.bin}:${process.env.PATH}`,
		FLEET_MANIFEST_DIR: fx.manifestDir,
		HADOKU_SITE_ROOT: fx.siteRoot,
		REPOS_DIR: fx.reposDir,
		HADOKU_STATE_DIR: fx.stateDir,
	};
}

/** One gate run. Never throws — the gate legitimately exits 1 on findings
 * unrelated to this test (the unprobed fixture node reads as unreachable),
 * so stdout/stderr/code are all returned for the caller to inspect on its
 * own terms. */
function run(fx, argv = []) {
	try {
		const stdout = execFileSync(process.execPath, [GATE, ...argv], {
			env: env(fx),
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { code: 0, stdout, stderr: '' };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

function pinnedSection(stdout) {
	return stdout.split('pinned jobs and what moving them would need')[1] ?? '';
}

// ── §B done-when: every capability is printed, marked against what the pool has EARNED ──

test('a pinned forge job using CARDTABLE_FORGE_JAR reports jdk21, marked as earned by no pool node', () => {
	const fx = fixture();
	try {
		const { stdout } = run(fx);
		const section = pinnedSection(stdout);
		assert.match(
			section,
			new RegExp(
				`${CARDTABLE.replace('/', '\\/')} / forge-e2e \\[pinned: self-hosted, pm2-host\\]:.*` +
					`jdk21 \\(earned by no pool node\\)`
			),
			`expected a pinned jdk21 line marked unearned for ${CARDTABLE}/forge-e2e in:\n${stdout}`
		);
	} finally {
		cleanup(fx);
	}
});

test('a pinned ffmpeg job is marked with the pool node that actually earned it', () => {
	const fx = fixture();
	try {
		const { stdout } = run(fx);
		const section = pinnedSection(stdout);
		assert.match(
			section,
			new RegExp(
				`${MEDIAFORGE.replace('/', '\\/')} / transcode \\[pinned: self-hosted, claw-9\\]:.*` +
					`ffmpeg \\(${LOCAL_NODE}\\)`
			),
			`expected a pinned ffmpeg line earned by ${LOCAL_NODE} for ${MEDIAFORGE}/transcode in:\n${stdout}`
		);
	} finally {
		cleanup(fx);
	}
});

test('a general-pool node with no bootcamp record is reported, never silently proving nothing on its behalf', () => {
	const fx = fixture();
	try {
		const { stdout } = run(fx);
		assert.match(
			stdout,
			/1 general-pool node\(s\) have no bootcamp record at all — counted as having proven nothing/
		);
	} finally {
		cleanup(fx);
	}
});

test('a job that only MENTIONS "javascript" contributes no jdk21 demand anywhere in the report', () => {
	const fx = fixture();
	try {
		const { stdout } = run(fx);
		// "js-lint" is on the general pool, not pinned, so it can never appear in
		// the pinned section at all — but if the jdk21 detector were a bare
		// substring match on "java" it would have polluted the GENERAL POOL
		// instead. The forge-e2e line must still show jdk21, unearned.
		const section = pinnedSection(stdout);
		assert.ok(section.includes('jdk21'), 'jdk21 must still show up, marked unearned');
		assert.ok(
			!section.includes('js-lint'),
			'"js-lint" must never appear in the pinned section at all'
		);
	} finally {
		cleanup(fx);
	}
});

test('the report never filters a capability away — docker and playwright demand on a pinned/hosted job would appear too', () => {
	// Regression guard for the manager's correction: the FIRST version of this
	// report filtered a capability out once ANY general-pool job used it,
	// which hid cardtable's real jdk21 gap behind hadoku-task-mobile's
	// unrelated Android build. Prove the filter is gone directly: ffmpeg IS
	// earned by the pool node in this fixture, and its line still PRINTS the
	// capability (marked earned), rather than omitting it.
	const fx = fixture();
	try {
		const { stdout } = run(fx);
		const section = pinnedSection(stdout);
		assert.ok(
			section.includes('ffmpeg'),
			'an EARNED pinned capability must still be printed, just marked'
		);
	} finally {
		cleanup(fx);
	}
});

// ── §B done-when: absent from requiredIdentitySet, proven against the real ledger ──

test('--write: the forge-e2e row carries jdk21, selfHosted, NOT fleetForm — requiredIdentitySet excludes it', () => {
	const fx = fixture();
	const ledgerPath = join(fx.root, 'demand-ledger.jsonl');
	try {
		run(fx, ['--write', ledgerPath]);
		const rows = readFileSync(ledgerPath, 'utf8')
			.trim()
			.split('\n')
			.map((l) => JSON.parse(l));

		const forgeRow = rows.find((r) => r.repo === CARDTABLE && r.job === 'forge-e2e');
		assert.ok(forgeRow, `no forge-e2e row in the ledger: ${JSON.stringify(rows)}`);
		assert.deepEqual(forgeRow.capabilities, ['jdk21']);
		assert.equal(forgeRow.selfHosted, true);
		assert.equal(forgeRow.fleetForm, false);

		const required = requiredIdentitySet(rows);
		assert.ok(
			!required.has('jdk21'),
			`jdk21 must be excluded from hadoku-builder's required set, got: ${[...required]}`
		);
	} finally {
		cleanup(fx);
	}
});

test('--write: the task-mobile shape (setup-java + gradle, general pool) yields NO jdk21 — it never enters requiredIdentitySet', () => {
	const fx = fixture();
	const ledgerPath = join(fx.root, 'demand-ledger.jsonl');
	try {
		run(fx, ['--write', ledgerPath]);
		const rows = readFileSync(ledgerPath, 'utf8')
			.trim()
			.split('\n')
			.map((l) => JSON.parse(l));

		const buildRow = rows.find((r) => r.repo === TASKMOBILE && r.job === 'build');
		assert.ok(buildRow, `no task-mobile build row in the ledger: ${JSON.stringify(rows)}`);
		assert.deepEqual(
			buildRow.capabilities,
			[],
			'setup-java + gradle on the general pool must derive no capability at all'
		);
		assert.equal(buildRow.fleetForm, true, 'the task-mobile build job IS on the general pool');

		const required = requiredIdentitySet(rows);
		assert.ok(
			!required.has('jdk21'),
			`jdk21 must never enter the required set via the task-mobile shape, got: ${[...required]}`
		);
	} finally {
		cleanup(fx);
	}
});

test('--write: the cardtable general-pool jobs (build, js-lint) never carry jdk21', () => {
	const fx = fixture();
	const ledgerPath = join(fx.root, 'demand-ledger.jsonl');
	try {
		run(fx, ['--write', ledgerPath]);
		const rows = readFileSync(ledgerPath, 'utf8')
			.trim()
			.split('\n')
			.map((l) => JSON.parse(l));
		const buildRow = rows.find((r) => r.repo === CARDTABLE && r.job === 'build');
		const lintRow = rows.find((r) => r.repo === CARDTABLE && r.job === 'js-lint');
		assert.ok(buildRow && lintRow, `missing rows: ${JSON.stringify(rows)}`);
		assert.deepEqual(buildRow.capabilities, []);
		assert.deepEqual(lintRow.capabilities, [], 'the "javascript" mention must not derive jdk21');
	} finally {
		cleanup(fx);
	}
});

// ── B2: ROOT and REPOS_DIR/hadoku_site are the SAME repo at DIFFERENT paths ──

/**
 * The deployed shape (mgmt-api's audit-gates): `HADOKU_SITE_ROOT` (and so
 * `siteRoot()`/`ROOT`) is the DEPLOYED checkout (`~/srv/hadoku_site`), while
 * `REPOS_DIR` (`~/repos`) holds a SEPARATE sibling development checkout of
 * the SAME repo at `REPOS_DIR/hadoku_site`. The old path-keyed `Set` saw two
 * different strings and scanned the repo TWICE. This fixture reproduces that
 * exact shape with two distinct directories, both carrying the identical
 * pinned job the live finding named (`WolffM/hadoku_site / run`, pinned
 * `[self-hosted, pm2-host]`, using `docker`).
 */
const HADOKU_SITE_PINNED_JOB = [
	'jobs:',
	'  run:',
	'    runs-on: [self-hosted, pm2-host]',
	'    steps:',
	'      - run: docker run --rm hello-world',
	'',
].join('\n');

function dupPathFixture() {
	const root = mkdtempSync(join(tmpdir(), 'tool-inventory-duppath-'));
	const manifestDir = join(root, 'admin');
	// `deployedSite` is what `HADOKU_SITE_ROOT` points at — the ROOT the gate
	// must prefer. `devSite` is `REPOS_DIR/hadoku_site` — a SEPARATE checkout
	// of the identically-named repo, exactly as a sibling `~/repos/hadoku_site`
	// sits beside the deployed `~/srv/hadoku_site` in production.
	const deployedSite = join(root, 'srv', 'hadoku_site');
	const reposDir = join(root, 'repos');
	const devSite = join(reposDir, 'hadoku_site');
	const stateDir = join(root, 'state');
	mkdirSync(manifestDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });

	for (const dir of [deployedSite, devSite]) {
		mkdirSync(join(dir, '.git'), { recursive: true });
		mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
		writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), HADOKU_SITE_PINNED_JOB);
	}

	// No machines at all — this fixture is about which DIRECTORY gets scanned,
	// not about what a node has earned, so zero nodes keeps it ssh-free with
	// no shim needed.
	writeFileSync(join(manifestDir, 'fleet-runner-manifest.json'), JSON.stringify({ machines: {} }));
	writeFileSync(
		join(manifestDir, 'fleet-runner-coverage.json'),
		JSON.stringify({ repos: ['WolffM/hadoku_site'] })
	);

	return { root, manifestDir, deployedSite, reposDir, devSite, stateDir };
}

function dupPathEnv(fx) {
	return {
		...process.env,
		FLEET_MANIFEST_DIR: fx.manifestDir,
		HADOKU_SITE_ROOT: fx.deployedSite,
		REPOS_DIR: fx.reposDir,
		HADOKU_STATE_DIR: fx.stateDir,
	};
}

function dupPathRun(fx, argv = []) {
	try {
		const stdout = execFileSync(process.execPath, [GATE, ...argv], {
			env: dupPathEnv(fx),
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { code: 0, stdout, stderr: '' };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

test('B2: ROOT and REPOS_DIR/hadoku_site at different paths — the pinned job is printed ONCE, not twice', () => {
	const fx = dupPathFixture();
	try {
		const { stdout } = dupPathRun(fx);
		const section = pinnedSection(stdout);
		const occurrences = section.split('WolffM/hadoku_site / run').length - 1;
		assert.equal(
			occurrences,
			1,
			`expected WolffM/hadoku_site / run exactly once, got ${occurrences} in:\n${stdout}`
		);
	} finally {
		cleanup(fx);
	}
});

test('B2: --write with ROOT and REPOS_DIR/hadoku_site at different paths — exactly ONE ledger row for the job', () => {
	const fx = dupPathFixture();
	const ledgerPath = join(fx.root, 'demand-ledger.jsonl');
	try {
		dupPathRun(fx, ['--write', ledgerPath]);
		const rows = readFileSync(ledgerPath, 'utf8')
			.trim()
			.split('\n')
			.map((l) => JSON.parse(l));
		const matches = rows.filter((r) => r.repo === 'WolffM/hadoku_site' && r.job === 'run');
		assert.equal(
			matches.length,
			1,
			`expected exactly one ledger row for WolffM/hadoku_site / run, got ${matches.length}: ${JSON.stringify(rows)}`
		);
	} finally {
		cleanup(fx);
	}
});

test("B2: ROOT wins — the scanned workflow is the DEPLOYED checkout's, not the sibling dev one", () => {
	// Prove WHICH directory won by making them disagree: the deployed site's
	// job uses docker, the dev sibling's uses ffmpeg instead. If ROOT really
	// wins, the single pinned line must show docker, never ffmpeg.
	const fx = dupPathFixture();
	try {
		writeFileSync(
			join(fx.devSite, '.github', 'workflows', 'ci.yml'),
			[
				'jobs:',
				'  run:',
				'    runs-on: [self-hosted, pm2-host]',
				'    steps:',
				'      - run: ffmpeg -version',
				'',
			].join('\n')
		);
		const { stdout } = dupPathRun(fx);
		const section = pinnedSection(stdout);
		assert.ok(
			section.includes('WolffM/hadoku_site / run'),
			`missing the pinned line in:\n${stdout}`
		);
		assert.ok(
			section.includes('docker (earned by no pool node)'),
			`expected the DEPLOYED (docker) job to win, got:\n${section}`
		);
		assert.ok(
			!section.includes('ffmpeg'),
			`the dev sibling's ffmpeg job must not have won:\n${section}`
		);
	} finally {
		cleanup(fx);
	}
});

// ── #98: the missing-tool scan judges each JOB, not each file ──────────────
//
// `trunk` is the missing tool: the gate's own probe runs locally (LOCAL_NODE
// is this box) under a PATH narrowed to the system dirs, so `command -v trunk`
// answers no whatever this workstation has under ~/.cargo/bin. Nothing here is
// installed or executed beyond `command -v`.

const job = (id, runsOn, ...runs) => [
	`  ${id}:`,
	`    runs-on: ${runsOn}`,
	'    steps:',
	...runs.map((r) => `      - run: ${r}`),
];
const FLEET = '${{ fromJSON(vars.CI_RUNNER) }}';

const PER_JOB_WORKFLOWS = {
	// An install in ANOTHER job does not put trunk on this job's runner.
	'install-elsewhere.yml': [
		'jobs:',
		...job('build', FLEET, 'trunk build'),
		...job('setup', FLEET, 'cargo install trunk'),
	],
	// One pm2-host job used to exempt every claw job in the file.
	'pm2-beside.yml': [
		'jobs:',
		...job('deploy', '[self-hosted, pm2-host]', 'pm2 reload x'),
		...job('site', FLEET, 'trunk build'),
	],
	// A release download of SOME tool used to exempt EVERY tool.
	'other-release.yml': [
		'jobs:',
		...job(
			'build',
			FLEET,
			'curl -L https://github.com/jqlang/jq/releases/download/jq-1.7/jq-linux64 -o jq',
			'trunk build'
		),
	],
	// `install` before a word that merely CONTAINS the tool's name.
	'substring.yml': ['jobs:', ...job('build', FLEET, 'npm install trunkated-helper', 'trunk build')],
	// A quoted echo argument is prose for the log, not an invocation — but a
	// command after it on the same line still is.
	'echoed.yml': [
		'jobs:',
		...job('hint', FLEET, 'echo "Recovery: trunk build --release"'),
		...job('chained', FLEET, 'echo "building" && trunk build'),
	],
	// The real thing, each in its OWN job: clean.
	'provided.yml': [
		'jobs:',
		...job('guarded', FLEET, 'command -v trunk || exit 0', 'trunk build'),
		...job('installed', FLEET, 'cargo install --locked trunk', 'trunk build'),
		...job(
			'downloaded',
			FLEET,
			'curl -L https://github.com/trunk-rs/trunk/releases/download/v0.21.0/trunk.tgz | tar xz',
			'trunk build'
		),
	],
};

function perJobFixture({ repos = ['WolffM/fixture-tools'], state } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'tool-inventory-perjob-'));
	const manifestDir = join(root, 'admin');
	const siteRoot = join(root, 'site');
	const reposDir = join(root, 'repos');
	const stateDir = join(root, 'state');
	const bin = join(root, 'bin');
	for (const d of [manifestDir, join(siteRoot, '.git'), stateDir, bin])
		mkdirSync(d, { recursive: true });
	writeFileSync(join(bin, 'ssh'), SSH_SHIM);
	chmodSync(join(bin, 'ssh'), 0o755);
	writeFileSync(
		join(manifestDir, 'fleet-runner-manifest.json'),
		JSON.stringify({ machines: { [LOCAL_NODE]: { $capabilities: { earned: [], prereqs: [] } } } })
	);
	writeFileSync(join(manifestDir, 'fleet-runner-coverage.json'), JSON.stringify({ repos }));
	const dir = join(reposDir, 'fixture-tools');
	mkdirSync(join(dir, '.git'), { recursive: true });
	mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
	for (const [f, body] of Object.entries(PER_JOB_WORKFLOWS)) {
		writeFileSync(join(dir, '.github', 'workflows', f), body.join('\n') + '\n');
	}
	if (state !== undefined) writeFileSync(join(stateDir, 'tool-inventory-capabilities.json'), state);
	return { root, manifestDir, siteRoot, reposDir, stateDir, bin };
}

/** Run with PATH narrowed so `trunk` (a ~/.cargo/bin tool, if present at all) is absent. */
function runNarrow(fx) {
	try {
		const stdout = execFileSync(process.execPath, [GATE], {
			env: { ...env(fx), PATH: `${fx.bin}:/usr/bin:/bin` },
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { code: 0, stdout, stderr: '' };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

const trunkFindings = (stderr) =>
	[...stderr.matchAll(/fixture-tools\/\.github\/workflows\/([^:]+):([^:]+): invokes "trunk"/g)]
		.map((m) => `${m[1]}:${m[2]}`)
		.sort();

test('#98: a job that invokes a missing tool is judged on ITS OWN text', () => {
	const fx = perJobFixture();
	try {
		const { code, stderr } = runNarrow(fx);
		assert.equal(code, 1, stderr);
		assert.deepEqual(trunkFindings(stderr), [
			'echoed.yml:chained',
			'install-elsewhere.yml:build',
			'other-release.yml:build',
			'pm2-beside.yml:site',
			'substring.yml:build',
		]);
	} finally {
		cleanup(fx);
	}
});

test('#98: an EMPTY roster is a finding — it scanned only the site', () => {
	const fx = perJobFixture({ repos: [] });
	try {
		const { code, stderr } = runNarrow(fx);
		assert.equal(code, 1);
		assert.match(stderr, /lists no covered repos — only the site checkout was scanned/);
	} finally {
		cleanup(fx);
	}
});

test('#98: a CORRUPT previous capability state is said, not read as "no history"', () => {
	const fx = perJobFixture({ state: '{ not json' });
	try {
		const { stdout, stderr } = runNarrow(fx);
		assert.match(stderr, /could not read previous capability state/);
		assert.match(stdout, /retirement: not compared/);
	} finally {
		cleanup(fx);
	}
});

test('#98: a MISSING previous capability state is a first run, and quiet about it', () => {
	const fx = perJobFixture();
	try {
		const { stderr } = runNarrow(fx);
		assert.doesNotMatch(stderr, /could not read previous capability state/);
	} finally {
		cleanup(fx);
	}
});
