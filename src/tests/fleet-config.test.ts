/**
 * The ecosystem's identity, and the proof that it actually flows.
 *
 * A config module is the easiest kind of thing to test vacuously: assert the
 * default equals the value you just typed into the default, and the suite is
 * green while nothing downstream reads it. This repo has shipped exactly that
 * shape before (`|| true` over an inert hysteresis term), so the tests below are
 * built the other way round — the ones that matter set a DIFFERENT owner and
 * then observe the four call sites, because a refactor that left one literal
 * behind passes every "the default is still WolffM" assertion ever written.
 *
 * THE FOUR OWNER CALL SITES, and how each is observed:
 *
 *   1. `ci-runner-fallback#coveredRepos` — the degraded roster. Observed by
 *      pointing the host's manifest dir at a directory with no coverage file and
 *      reading what comes back.
 *   2. `ci-alerts` — a watched target with no `owner`. Observed end to end
 *      through `runCiAlerts`, by capturing the repo every GitHub call is made
 *      against.
 *   3. `reconcile-fleet-runners#gh repo list` — the owner whose repos are the
 *      universe. It shells out to `gh`, so it is observed in two halves: the
 *      resolver responds to the environment (behaviour, below) and the script
 *      is wired to exactly that resolver with no literal left (structure).
 *   4. `reconcile-fleet-runners#loadMountedApps` — qualifying a bare repo name
 *      from operator config. Same two halves.
 *
 * Sites 3 and 4 have a third, independent guard: `ecosystem-literals.test.mjs`
 * is a CEILING, and this lane lowered it, so putting either literal back makes
 * that count rise and fails the build on its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmpdir.js';
import { fileURLToPath } from 'node:url';

import {
	FLEET_HUB_REPO_ENV,
	FLEET_OWNER_ENV,
	FLEET_PACKAGE_NAME_ENV,
	fleetIdentity,
	fleetOwner,
	hubRepo,
	hubRepoFull,
	packageName,
	qualifyRepo,
	userAgent,
} from '../lib/fleet-config.js';
import { siteRoot } from '../lib/fleet-paths.js';
import { __setHostForTesting } from '../host.js';
import { coveredRepos } from '../ci-runner-fallback.js';
import { runCiAlerts, stateKey, targetOwner } from '../ci-alerts.js';
import { testHost } from './install-test-host.js';

/** dist/tests/ -> dist/ -> the package root. */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Set env vars, run, restore exactly what was there — including "unset". */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
	const before: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(vars)) {
		before[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		return fn();
	} finally {
		for (const [k, v] of Object.entries(before)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

/** Every identity variable cleared — the shape an unconfigured install runs in. */
const UNSET = {
	[FLEET_OWNER_ENV]: undefined,
	[FLEET_HUB_REPO_ENV]: undefined,
	[FLEET_PACKAGE_NAME_ENV]: undefined,
};

/**
 * The async twin of `withEnv`.
 *
 * A sync `finally` around a call that RETURNS a promise restores the
 * environment before the awaited work has run — the body would then observe
 * whatever the process had before, and the test would pass for the wrong
 * reason. Both wrappers here have an async form for exactly that.
 */
async function withEnvAsync<T>(
	vars: Record<string, string | undefined>,
	fn: () => Promise<T>
): Promise<T> {
	const before: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(vars)) {
		before[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		return await fn();
	} finally {
		for (const [k, v] of Object.entries(before)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

/** A STRANGER's fleet. Nothing in this repo spells any of these. */
const STRANGER = {
	[FLEET_OWNER_ENV]: 'acme-ci',
	[FLEET_HUB_REPO_ENV]: 'control-plane',
};

/**
 * Point the host's manifest dir somewhere empty for the body of `fn`.
 *
 * The real manifests are a live fixture every other suite depends on, so this
 * swaps the whole host and puts it back — `manifestDir()` is read on the call in
 * both consumers, so the swap is visible without reloading any module.
 */
function withEmptyManifests<T>(fn: (dir: string) => T): T {
	const dir = tempDir('fleet-config-test-');
	__setHostForTesting({ ...testHost, manifestDir: dir });
	try {
		return fn(dir);
	} finally {
		__setHostForTesting(testHost);
	}
}

/** The async twin — see `withEnvAsync` for why a sync `finally` is not enough. */
async function withEmptyManifestsAsync<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = tempDir('fleet-config-test-');
	__setHostForTesting({ ...testHost, manifestDir: dir });
	try {
		return await fn(dir);
	} finally {
		__setHostForTesting(testHost);
	}
}

test('unconfigured, it resolves what this fleet runs on today', () => {
	withEnv(UNSET, () => {
		assert.equal(fleetOwner(), 'WolffM');
		assert.equal(hubRepo(), 'hadoku_site');
		assert.equal(hubRepoFull(), 'WolffM/hadoku_site');
		// Anchored to the real manifest rather than restated: a rename that
		// changed package.json and forgot this default would otherwise pass.
		const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { name: string };
		assert.equal(packageName(), pkg.name);
	});
});

test('each fact comes from its own variable', () => {
	withEnv({ ...UNSET, ...STRANGER, [FLEET_PACKAGE_NAME_ENV]: '@acme/ci-fleet' }, () => {
		assert.equal(fleetOwner(), 'acme-ci');
		assert.equal(hubRepo(), 'control-plane');
		assert.equal(hubRepoFull(), 'acme-ci/control-plane');
		assert.equal(packageName(), '@acme/ci-fleet');
	});
});

test('a BLANK variable is unset, not an empty owner', () => {
	// A systemd unit or `docker run -e FLEET_OWNER` exports the variable empty
	// when the surrounding shell has nothing for it. Reading that as the owner
	// yields `/hadoku_site`, which 404s with nothing naming the cause.
	withEnv({ ...UNSET, [FLEET_OWNER_ENV]: '   ' }, () => {
		assert.equal(fleetOwner(), 'WolffM');
		assert.equal(qualifyRepo('a-repo'), 'WolffM/a-repo');
	});
});

test('resolution is not cached — two environments in one process give two answers', () => {
	// The 17th module-level singleton is the one this file exists to prevent.
	// A `const` resolved at import time would be fixed before any test ran, and
	// the FIRST suite in a process would decide the answer for every later one.
	const first = withEnv({ ...UNSET, [FLEET_OWNER_ENV]: 'first-owner' }, () => fleetIdentity());
	const second = withEnv({ ...UNSET, [FLEET_OWNER_ENV]: 'second-owner' }, () => fleetIdentity());
	const back = withEnv(UNSET, () => fleetIdentity());
	assert.equal(first.owner, 'first-owner');
	assert.equal(second.owner, 'second-owner');
	assert.equal(back.owner, 'WolffM');
});

test('qualifyRepo adds the owner once and only when it is missing', () => {
	withEnv({ ...UNSET, ...STRANGER }, () => {
		assert.equal(qualifyRepo('vibecheck'), 'acme-ci/vibecheck');
		// Already qualified — re-qualifying yields owner/owner/repo, which GitHub
		// answers with a 404 rather than an error.
		assert.equal(qualifyRepo('someone-else/vibecheck'), 'someone-else/vibecheck');
	});
});

test('the User-Agent names the package and is a legal product token', () => {
	withEnv({ ...UNSET, [FLEET_PACKAGE_NAME_ENV]: '@acme/ci-fleet' }, () => {
		const ua = userAgent('ci-runner-fallback');
		assert.equal(ua, 'ci-fleet/ci-runner-fallback');
		// `@` and `/` are not HTTP token characters (RFC 9110 §5.6.2), so the
		// product half must carry neither.
		assert.ok(!ua.split('/')[0].includes('@'), 'the scope must be stripped');
		assert.equal(ua.split('/').length, 2, 'product/component, nothing more');
	});
});

test('fleetIdentity carries the state dir and cannot drift from the accessors', () => {
	withEnv({ ...UNSET, ...STRANGER, HADOKU_STATE_DIR: '/var/lib/acme-fleet' }, () => {
		assert.deepEqual(fleetIdentity(), {
			owner: fleetOwner(),
			hubRepo: hubRepo(),
			packageName: packageName(),
			stateDir: '/var/lib/acme-fleet',
		});
	});
});

// ---- site 1: ci-runner-fallback's degraded roster ------------------------

test('site 1 — an unreadable coverage file degrades to the CONFIGURED hub repo', () => {
	withEmptyManifests(() => {
		assert.deepEqual(
			withEnv(UNSET, () => coveredRepos()),
			['WolffM/hadoku_site'],
			'unconfigured, the degraded roster is this fleet, unchanged'
		);
		assert.deepEqual(
			withEnv({ ...UNSET, ...STRANGER }, () => coveredRepos()),
			['acme-ci/control-plane'],
			'a stranger installing this package must not have CI_RUNNER steered at WolffM'
		);
	});
});

// ---- site 2: ci-alerts' watched targets ----------------------------------

test('site 2 — a target with no owner is watched under the CONFIGURED owner', async () => {
	const target = { repo: 'control-plane', workflow: 'ci.yml', label: 'control-plane / ci' };
	assert.equal(
		withEnv({ ...UNSET, ...STRANGER }, () => targetOwner(target)),
		'acme-ci'
	);
	assert.equal(
		withEnv({ ...UNSET, ...STRANGER }, () => stateKey(target)),
		'acme-ci/control-plane/ci.yml'
	);

	// End to end: the repo every GitHub call is made against is the one the
	// alerter would 404 on forever if the owner were `undefined`.
	const asked: string[] = [];
	await withEmptyManifestsAsync(async (dir) => {
		writeFileSync(join(dir, 'ci-watch.generated.json'), JSON.stringify({ targets: [target] }));
		const ghGet = async <T>(_path: string, _token: string, repo?: string): Promise<T | null> => {
			asked.push(repo ?? '<none>');
			// "I could not look" — leaves state untouched, so this asserts on the
			// call without the state machine or Discord being involved.
			return await Promise.resolve(null);
		};
		await withEnvAsync({ ...UNSET, ...STRANGER }, () => runCiAlerts('tok', ghGet));
	});
	assert.deepEqual(asked, ['acme-ci/control-plane']);
});

// ---- sites 3 and 4: reconcile-fleet-runners ------------------------------

test('sites 3 and 4 — reconcile reads the resolver and spells no owner of its own', () => {
	const src = readFileSync(join(ROOT, 'scripts', 'reconcile-fleet-runners.mjs'), 'utf8');

	assert.ok(
		src.includes("from '../dist/lib/fleet-config.js'"),
		'reconcile must import the resolver rather than reimplement it'
	);
	// Site 3: the owner whose repos are the universe. The manifest's own
	// `autoInclude.owner` still wins — this is the DEFAULT behind it.
	assert.ok(
		src.includes('ai.owner ?? fleetOwner()'),
		'the gh repo list owner must fall back to fleetOwner()'
	);
	// Site 4: a bare `repoName` from operator config.
	assert.ok(src.includes('qualifyRepo(n)'), 'bare repo names must be qualified by the resolver');
	// The mutation this guards: put either literal back and this fails. Checked
	// as a QUOTED literal, because the prose in that file legitimately names the
	// account in several comments and a bare substring test would score those.
	assert.ok(
		!src.includes("'WolffM'"),
		'the owner may not be spelled as a literal in reconcile any more'
	);
});

// ---- site 5: fleet-paths#siteRoot ----------------------------------------

test('site 5 — siteRoot looks for the CONFIGURED hub repo, not this one', () => {
	// BEHAVIOURAL, not a source grep, because this is the site where getting it
	// wrong is quietest. `siteRoot()` used to `join(reposDir(), 'hadoku_site')`,
	// so a stranger who set FLEET_HUB_REPO got a resolver that ignored them and
	// then THREW about a repo they had never named — and `manifestDir()` sits
	// directly behind it, so the manifests, the allowlists and every fleet gate
	// behind those resolve off this one join.
	//
	// Asserted through the thrown message because `must()` is what runs when the
	// path is absent, and absent is the only outcome available for a fleet that
	// does not exist on this box. That the message NAMES the repo it looked for
	// is the other half: "I could not look" must say what it looked for.
	const err = withEnv({ ...STRANGER, REPOS_DIR: '/nonexistent-fleet-root' }, () => {
		try {
			siteRoot();
			return null;
		} catch (e) {
			return e as Error;
		}
	});
	assert.ok(err, 'siteRoot must throw when the configured checkout is not there');
	assert.match(err.message, /control-plane/, 'the resolver must look for the CONFIGURED hub repo');
	assert.doesNotMatch(
		err.message,
		/hadoku_site/,
		"this fleet's hub repo must not appear in a stranger's resolution"
	);
});

// ---- site 6: runner-health -----------------------------------------------

test('site 6 — runner-health spells neither the owner, the hub repo nor the host service', () => {
	// SELF_REPO is a `const`, resolved at import, because `src/routes/fleet.ts`
	// imports it as one — so a second environment in this process cannot move it
	// and the guard has to be on the SOURCE. Quoted literals only: the prose in
	// that file legitimately names the fleet in several comments, and a bare
	// substring test would score those, which is the mistake this repo has made
	// with a comment four times.
	const src = readFileSync(join(ROOT, 'src', 'runner-health.ts'), 'utf8');

	assert.ok(
		src.includes("from './lib/fleet-config.js'"),
		'runner-health must read the resolver rather than spell the fleet'
	);
	assert.ok(!src.includes("'WolffM/hadoku_site'"), 'SELF_REPO must come from hubRepoFull()');
	assert.ok(!src.includes('/^WolffM\\//'), 'the owner prefix must come from fleetOwner()');
	// The User-Agent named `hadoku-mgmt-api` — the SERVICE that embeds this
	// package, which stops being true the moment anybody else installs it.
	assert.ok(
		!src.includes("'hadoku-mgmt-api/runner-health'"),
		'the User-Agent must name this package, via userAgent()'
	);
	assert.equal(userAgent('runner-health'), 'fleet-manager/runner-health');
});
