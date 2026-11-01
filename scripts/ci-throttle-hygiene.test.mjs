/**
 * Fixture-discipline guards for ci-throttle's split test suite (wave 5p lane
 * C): every spawn of the real hook must go through `hookEnv()`, and every
 * temp directory any of these files creates directly under `os.tmpdir()`
 * must carry `FIXTURE_PREFIX` — the leak gate each file installs
 * (`installLeakGate()`, see `lib/ci-throttle-fixtures.mjs`) can only catch
 * what it can recognise.
 *
 * Split out of ci-throttle.test.mjs (1,993 lines) across eight files plus
 * the shared `lib/ci-throttle-fixtures.mjs`; see that module's header. These
 * two tests used to read only their OWN file's source (`import.meta.url`),
 * which was correct when the whole suite WAS one file. Now that the spawn
 * sites and creation sites are spread across the family, each test reads
 * EVERY `ci-throttle-*.test.mjs` file plus the fixtures module itself — the
 * union is exactly what the single file used to be, and a NEW split file is
 * picked up automatically (it is named `ci-throttle-*.test.mjs` too) without
 * anyone having to extend a list by hand — the same reasoning
 * `fixture-clock-guard.test.mjs` uses to enumerate `scripts/**` instead of
 * naming files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { SCRIPTS, installCiThrottleRig, installLeakGate } from './lib/ci-throttle-fixtures.mjs';

installCiThrottleRig();

/** Every file in ci-throttle's split family: the shared fixtures module plus
 * every `ci-throttle-*.test.mjs` sibling (this file included). */
function familyFiles() {
	const lib = join(SCRIPTS, 'lib', 'ci-throttle-fixtures.mjs');
	const tests = readdirSync(SCRIPTS)
		.filter((name) => name.startsWith('ci-throttle-') && name.endsWith('.test.mjs'))
		.map((name) => join(SCRIPTS, name));
	return [lib, ...tests];
}

test('static: every spawn of the hook passes through hookEnv() — no bypass', () => {
	// Reads every file in the family's source and counts, on code lines only
	// (blank comment-only lines first, so prose mentioning `[HOOK]` or
	// `hookEnv(` — including this test's own strings — cannot move either
	// count): (a) lines that spawn a child process with `[HOOK]` as the
	// script argument, i.e. an actual spawn SITE; (b) lines of the literal
	// shape `env: hookEnv(` — the one way this family passes an env into a
	// spawn options object through the door. A new spawn added later that
	// builds its env inline (`env: {...}` or `env: fx.env`) instead of going
	// through the door raises (a) without raising (b), and this goes red.
	const codeLines = familyFiles().flatMap((f) =>
		readFileSync(f, 'utf8')
			.split('\n')
			.filter((l) => !/^\s*\*/.test(l) && !/^\s*\/\//.test(l))
	);
	const spawnMarker = 'spawn';
	const doorMarker = ['env', ':', ' hookE', 'nv('].join('');
	const spawnSites = codeLines.filter(
		(l) => l.includes(spawnMarker) && /\(/.test(l) && /\bHOOK\b/.test(l)
	).length;
	const doorCalls = codeLines.filter((l) => l.includes(doorMarker)).length;
	assert.equal(
		spawnSites,
		doorCalls,
		`found ${spawnSites} hook-spawning line(s) but ${doorCalls} door call(s) across the ` +
			'ci-throttle family — a spawn is bypassing hookEnv()'
	);
	assert.equal(
		spawnSites,
		5,
		'expected exactly the 5 known spawn sites across the whole family (update this if one ' +
			'is added deliberately, through the door)'
	);
});

test('static: every temp dir the ci-throttle family creates under tmpdir() carries FIXTURE_PREFIX', () => {
	// Built, not written, so this case's own lines are not creation sites.
	const sites = ['tempDir' + '(', 'mkdtempSync(join(' + 'tmpdir()'];
	const creations = familyFiles()
		.flatMap((f) => readFileSync(f, 'utf8').split('\n'))
		.filter((l) => !/^\s*(\*|\/\/)/.test(l) && sites.some((s) => l.includes(s)));
	assert.ok(
		creations.length >= 10,
		`expected the family's creation sites, found ${creations.length}`
	);
	assert.deepEqual(
		creations.filter((l) => !l.includes('${FIXTURE_PREFIX}')),
		[],
		'a temp dir without FIXTURE_PREFIX is invisible to the leak gate each file installs'
	);
});

installLeakGate();
