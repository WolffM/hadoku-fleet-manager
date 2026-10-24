/**
 * fleet-manager#7 — `fleet floor-probe` reads the fleet's SHIPPED workflows,
 * never a sibling checkout under REPOS_DIR.
 *
 * Two reads: `window`'s daily-cron schedules (is the fleet about to fan out?)
 * and `probe`'s shadow-dispatch safety check (will this workflow redeploy
 * production?). Both are run as the CLI against fixture REMOTES
 * (lib/fleet-source-fixture.mjs), whose git children run with every GIT_*
 * stripped — see lib/hook-safe-tests.test.mjs. The rules themselves are pinned
 * in lib/floor-probe.test.mjs.
 *
 * NOTHING HERE REACHES GITHUB. Every probe case is refused before the GitHub
 * step, and the roster always holds a never-pushed repo, so even a reverted
 * gate reading disk finds the window closed (could-not-tell) and stops there.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixtureRemotes, poisonedClone } from './lib/fleet-source-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'floor-probe.mjs');

const REPO = 'WolffM/fixture-crons';
const MISSING = 'WolffM/never-pushed';

const NIGHTLY = [
	'on:',
	'  workflow_dispatch:',
	'  schedule:',
	"    - cron: '3 6 * * *'",
	'jobs:',
	'  test:',
	'    runs-on: ${{ fromJSON(vars.CI_RUNNER) }}',
	'    steps:',
	'      - run: pnpm test',
	'',
].join('\n');

/** A workflow that ends in a production deploy step — `shadowSafety` refuses it. */
const REDEPLOYS = [
	'on:',
	'  workflow_dispatch:',
	'jobs:',
	'  test:',
	'    runs-on: ${{ fromJSON(vars.CI_RUNNER) }}',
	'    steps:',
	'      - run: pnpm test',
	'      - run: pm2 restart hadoku-pygmalion',
	'',
].join('\n');

const SAFE = REDEPLOYS.replace('      - run: pm2 restart hadoku-pygmalion\n', '');

function fixture({ roster = [REPO], shipped = { 'nightly.yml': NIGHTLY } } = {}) {
	const remotes = fixtureRemotes('floor-probe-');
	const root = remotes.root;
	const manifestDir = join(root, 'admin');
	const siteRoot = join(root, 'site');
	const stateDir = join(root, 'state');
	const reposDir = join(root, 'repos');
	for (const d of [manifestDir, join(siteRoot, 'services', 'cron-worker'), stateDir, reposDir]) {
		mkdirSync(d, { recursive: true });
	}
	writeFileSync(
		join(manifestDir, 'fleet-runner-manifest.json'),
		JSON.stringify({ machines: { 'claw-1': { ephemeral: true } } })
	);
	writeFileSync(join(manifestDir, 'fleet-runner-coverage.json'), JSON.stringify({ repos: roster }));
	// The library's host-path check refuses to load without these.
	mkdirSync(join(siteRoot, 'scripts', 'ci'), { recursive: true });
	writeFileSync(join(siteRoot, 'scripts', 'ci', 'pnpm-store-doctor.sh'), '#!/bin/sh\n');
	writeFileSync(
		join(siteRoot, 'services', 'cron-worker', 'profiles.json'),
		JSON.stringify({ profiles: [] })
	);
	const files = Object.fromEntries(
		Object.entries(shipped).map(([f, b]) => [`.github/workflows/${f}`, b])
	);
	remotes.push(REPO, files);
	return {
		root,
		remotes,
		reposDir,
		files,
		env: envOf(remotes, manifestDir, siteRoot, stateDir, reposDir),
	};
}

function envOf(remotes, manifestDir, siteRoot, stateDir, reposDir) {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
	);
	return {
		...env,
		...remotes.env,
		FLEET_MANIFEST_DIR: manifestDir,
		HADOKU_SITE_ROOT: siteRoot,
		HADOKU_STATE_DIR: stateDir,
		REPOS_DIR: reposDir,
		// No credential reaches GitHub from here, whatever the code path.
		HADOKU_SITE_TOKEN: '',
		GITHUB_TOKEN: '',
		GH_TOKEN: 'fixture-no-network',
	};
}

function run(fx, argv) {
	try {
		const stdout = execFileSync(process.execPath, [GATE, ...argv], {
			env: fx.env,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 60_000,
		});
		return { code: 0, stdout, stderr: '' };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

const json = (r) => JSON.parse(r.stdout);

test('window: the daily crons are read off the shipped branch', () => {
	const fx = fixture();
	try {
		const doc = json(run(fx, ['window', '--json']));
		assert.equal(doc.schedulesSeen, 1, JSON.stringify(doc));
		assert.deepEqual(doc.unreadable, []);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test('window: an unreadable covered repo closes the window, carrying the reason', () => {
	const fx = fixture({ roster: [REPO, MISSING] });
	try {
		const r = run(fx, ['window', '--json']);
		const doc = json(r);
		assert.equal(r.code, 1);
		assert.equal(doc.why, 'could-not-tell');
		assert.equal(doc.unreadable.length, 1);
		assert.match(
			doc.unreadable[0],
			/never-pushed: shipped workflows unreadable \(fetch from .* failed/
		);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

/**
 * fleet-manager#7: A LOCAL CLONE CANNOT CHANGE THE WINDOW. The baseline has a
 * clone under REPOS_DIR that MATCHES the shipped branch. Then it goes CRLF,
 * keeps a nightly the remote never had, and carries an uncommitted cron edit —
 * each of which changes the schedules a disk reader sees. Revert the gate to
 * reading REPOS_DIR and the second document differs.
 */
test('#7: window — a CRLF, stale, dirty clone under REPOS_DIR does not change the verdict', () => {
	const fx = fixture();
	try {
		poisonedClone(fx.reposDir, REPO, fx.files);
		const baseline = run(fx, ['window', '--json']);
		const before = json(baseline);
		assert.equal(before.schedulesSeen, 1);

		rmSync(join(fx.reposDir, 'fixture-crons'), { recursive: true, force: true });
		poisonedClone(
			fx.reposDir,
			REPO,
			{
				...fx.files,
				'.github/workflows/old-nightly.yml': NIGHTLY.replace("'3 6 * * *'", "'30 12 * * *'"),
			},
			{
				crlf: true,
				edit: { '.github/workflows/nightly.yml': NIGHTLY.replace("'3 6 * * *'", "'0 0 * * *'") },
			}
		);
		const poisoned = run(fx, ['window', '--json']);
		assert.equal(poisoned.code, baseline.code);
		assert.deepEqual(json(poisoned), before);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

const PROBE = [
	'probe',
	'--repo',
	REPO,
	'--workflow',
	'ci.yml',
	'--job',
	'test',
	'--node',
	'claw-1',
];

test('probe: a shipped workflow that redeploys production is refused', () => {
	const fx = fixture({ roster: [REPO, MISSING], shipped: { 'ci.yml': REDEPLOYS } });
	try {
		const r = run(fx, [...PROBE, '--json']);
		assert.equal(r.code, 1);
		assert.match(r.stdout + r.stderr, /is not safe to shadow-dispatch/);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test('probe: a --ref other than main is refused — the safety read would be about another file', () => {
	const fx = fixture({ roster: [REPO, MISSING], shipped: { 'ci.yml': SAFE } });
	try {
		const r = run(fx, [...PROBE, '--ref', 'feature', '--json']);
		assert.equal(r.code, 1);
		assert.match(
			r.stdout + r.stderr,
			/refusing to dispatch a workflow I cannot inspect at feature/
		);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test('probe: a workflow the default branch does not ship is refused', () => {
	const fx = fixture({ roster: [REPO, MISSING], shipped: { 'other.yml': SAFE } });
	try {
		const r = run(fx, [...PROBE, '--json']);
		assert.equal(r.code, 1);
		assert.match(r.stdout + r.stderr, /ships no \.github\/workflows\/ci\.yml/);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

/**
 * fleet-manager#7: the safety read is the SHIPPED file. The shipped `ci.yml`
 * redeploys production; a clone under REPOS_DIR holds a SAFE, uncommitted copy.
 * The refusal must stand. A gate that read the clone would pass safety and
 * stop later, at the closed window, with a different message.
 */
test('#7: probe — a safe-looking clone under REPOS_DIR cannot clear an unsafe shipped workflow', () => {
	const fx = fixture({ roster: [REPO, MISSING], shipped: { 'ci.yml': REDEPLOYS } });
	try {
		poisonedClone(
			fx.reposDir,
			REPO,
			{ '.github/workflows/ci.yml': REDEPLOYS },
			{
				crlf: true,
				edit: { '.github/workflows/ci.yml': SAFE },
			}
		);
		const r = run(fx, [...PROBE, '--json']);
		assert.equal(r.code, 1);
		assert.match(r.stdout + r.stderr, /is not safe to shadow-dispatch/);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});
