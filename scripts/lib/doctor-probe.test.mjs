import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	doctorProbe,
	GUEST_CADENCE_NO_LOAD_WHY,
	seedCachePathsFromManifest,
} from './doctor-probe.mjs';

// ═══════════════════════════════════════════════════════════════════════════
// THE PROBE
// ═══════════════════════════════════════════════════════════════════════════

void test('the probe wraps WIFI_MANAGER_PROBE so its `exit 0` cannot end the run', () => {
	const p = doctorProbe();
	// The bug this pins: inlined bare, the shared wifi stanza's trailing `exit 0`
	// terminated the whole probe, every node truncated before DOCTOR-END, and a
	// box that had just answered sixty lines read as UNREACHABLE.
	assert.match(p, /\(\s*r=;[\s\S]*exit 0 \)/, 'the wifi stanza must run in a subshell');
	const afterWifi = p.slice(p.lastIndexOf('exit 0 )'));
	assert.match(afterWifi, /DOCTOR-END/, 'DOCTOR-END must still be reachable after it');
});

void test('the probe emits its own sentinels and a 60s load by default', () => {
	const p = doctorProbe();
	assert.match(p, /DOCTOR-BEGIN v1/);
	assert.match(p, /LOADSECS=60/);
	assert.match(p, /sha512sum \/dev\/zero/);
});

void test('--no-load says WHY there is no reading rather than omitting it', () => {
	const p = doctorProbe({ loadSeconds: 0 });
	assert.doesNotMatch(p, /LOADSECS=/);
	assert.match(p, /unk load "the load phase was disabled with --no-load/);
});

void test('the load phase refuses a busy node unless forced', () => {
	assert.match(doctorProbe().replace(/\n/g, ' '), /BUSY.*-gt 0.*FORCE.*!= 1/);
	assert.match(doctorProbe({ force: true }), /FORCE=1/);
});

void test('sensors() is ONE function, used for idle and for every load sample', () => {
	// If the two halves could enumerate sensors differently, `idle.<key>` and
	// `peak.<key>` would not be the same physical sensor and picking the die
	// sensor on the control side would be worthless.
	const p = doctorProbe();
	assert.equal((p.match(/^sensors\(\) \{$/gm) ?? []).length, 1);
	assert.match(p, /while read -r k v; do printf "D idle\.%s/);
	assert.match(p, /sample\(\) \{ while read -r k v;[\s\S]*< <\(sensors\)/);
});

// ═══════════════════════════════════════════════════════════════════════════
// `doctorProbe`'s `seedCachePaths` — embedded into a remote shell, so validated
// ═══════════════════════════════════════════════════════════════════════════

void test('doctorProbe embeds a well-formed seed cache path, expanded under $HOME', () => {
	const probe = doctorProbe({ loadSeconds: 0, seedCachePaths: ['~/.cache/cardtable-forge'] });
	assert.match(probe, /consumer\.seed\|~\/\.cache\/cardtable-forge/);
	assert.match(probe, /\$HOME\/\.cache\/cardtable-forge/);
});

void test('doctorProbe silently drops a seed cache path that does not match SAFE_CACHE_PATH', () => {
	// Not `~`-rooted, and a path carrying a shell metacharacter — neither may
	// reach the remote command line unvalidated.
	const probe = doctorProbe({
		loadSeconds: 0,
		seedCachePaths: ['/etc/passwd', '~/.cache/evil; rm -rf /', '~/ok/path'],
	});
	assert.doesNotMatch(probe, /\/etc\/passwd/);
	assert.doesNotMatch(probe, /rm -rf/);
	assert.match(
		probe,
		/consumer\.seed\|~\/ok\/path/,
		'a well-formed path alongside bad ones still gets through'
	);
});

// ═══════════════════════════════════════════════════════════════════════════
// `seedCachePathsFromManifest` — wave 4c §E's `$seeds`, read defensively
// ═══════════════════════════════════════════════════════════════════════════

void test('seedCachePathsFromManifest: absent $seeds is "no seed caches", never an error', () => {
	assert.deepEqual(seedCachePathsFromManifest(null), []);
	assert.deepEqual(seedCachePathsFromManifest({}), []);
	assert.deepEqual(seedCachePathsFromManifest({ machines: {} }), []);
});

void test('seedCachePathsFromManifest: shape A — one cache directly on the capability entry', () => {
	const manifest = {
		$seeds: { 'cardtable-forge': { repo: 'WolffM/cardtable', cache: '~/.cache/cardtable-forge' } },
	};
	assert.deepEqual(seedCachePathsFromManifest(manifest), [
		{ capability: 'cardtable-forge', seed: null, cache: '~/.cache/cardtable-forge' },
	]);
});

void test('seedCachePathsFromManifest: shape B — named sub-entries under a capability', () => {
	const manifest = {
		$seeds: {
			'cardtable-forge': {
				bundle: { repo: 'WolffM/cardtable', cache: '~/.cache/cardtable-forge' },
				assets: { repo: 'WolffM/cardtable', cache: '~/.cache/cardtable-assets' },
			},
		},
	};
	assert.deepEqual(
		seedCachePathsFromManifest(manifest).sort((a, b) => a.cache.localeCompare(b.cache)),
		[
			{ capability: 'cardtable-forge', seed: 'assets', cache: '~/.cache/cardtable-assets' },
			{ capability: 'cardtable-forge', seed: 'bundle', cache: '~/.cache/cardtable-forge' },
		]
	);
});

void test('seedCachePathsFromManifest: a malformed cache value is dropped, not guessed at', () => {
	const manifest = {
		$seeds: {
			good: { cache: '~/.cache/good' },
			noCache: { repo: 'WolffM/x' },
			badShape: { cache: '/etc/passwd' },
			badType: { cache: 42 },
		},
	};
	assert.deepEqual(seedCachePathsFromManifest(manifest), [
		{ capability: 'good', seed: null, cache: '~/.cache/good' },
	]);
});

test('a --cadence guest probe never loads the box, and says why in the record', () => {
	const probe = doctorProbe({ loadSeconds: 0, noLoadWhy: GUEST_CADENCE_NO_LOAD_WHY });
	assert.ok(!probe.includes('sha512sum'), 'no load generator may reach a guest');
	assert.ok(probe.includes(GUEST_CADENCE_NO_LOAD_WHY));
	assert.throws(() => doctorProbe({ loadSeconds: 0, noLoadWhy: 'x"; rm -rf ~; "' }), /unsafe/);
});
