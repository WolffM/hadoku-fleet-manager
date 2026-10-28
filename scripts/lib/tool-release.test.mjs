import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	DEFAULT_MIN_AGE_MINUTES,
	parseVersion,
	compareVersions,
	parseRange,
	satisfies,
	parseInstalledVersion,
	newestCleared,
	lookupLatest,
	lookupAdoptiumLatest,
	lookupMavenLatest,
	createReleaseLookup,
	assess,
} from './tool-release.mjs';

// Anchored to the clock: every age below is relative, so the fixture cannot age out.
const NOW = Date.now();
const DAY = 86_400_000;
const ago = (days) => new Date(NOW - days * DAY).toISOString();

// Shaped like the live @anthropic-ai/claude-code `time` map (checked 2026-09-30),
// plus the registry's own non-version keys and a prerelease.
const TIME = {
	created: ago(400),
	modified: ago(0),
	'2.1.283': ago(5),
	'2.1.284': ago(2),
	'2.1.285': ago(1),
	'2.1.286': ago(0.1),
	'2.1.282': ago(9),
	'2.1.281': ago(10),
	'2.2.0-beta.1': ago(30),
};

const okFetch = (body) => async () => ({ ok: true, status: 200, json: async () => body });

test('versions parse strictly and compare numerically, not lexically', () => {
	assert.deepEqual(parseVersion('2.1.286'), [2, 1, 286]);
	assert.equal(parseVersion('2.1'), null);
	assert.equal(parseVersion('2.2.0-beta.1'), null);
	assert.equal(compareVersions('2.1.9', '2.1.10'), -1);
	assert.equal(compareVersions('2.1.286', '2.1.286'), 0);
	assert.equal(compareVersions('3.0.0', '2.9.9'), 1);
	assert.throws(() => compareVersions('2.1.x', '2.1.1'), /cannot compare/);
	assert.equal(parseInstalledVersion('2.1.286 (Claude Code)\n'), '2.1.286');
	assert.equal(parseInstalledVersion(''), null);
	assert.equal(parseInstalledVersion('NOT-ON-PATH'), null);
});

test('the default debounce is seven days in minutes (hadoku_site pnpm-workspace.yaml:36)', () => {
	assert.equal(DEFAULT_MIN_AGE_MINUTES, 7 * 24 * 60);
});

test('newestCleared picks the newest release public for at least minAge', () => {
	const r = newestCleared(TIME, { now: NOW });
	assert.equal(r.status, 'known');
	assert.equal(r.version, '2.1.282', '2.1.283 is 5 days old, inside the window');
	assert.equal(r.minAge, 10080);
});

test('minAge is overridable, and a release exactly minAge old clears', () => {
	assert.equal(newestCleared(TIME, { now: NOW, minAge: 200 }).version, '2.1.285');
	const exact = { '1.0.0': new Date(NOW - 10080 * 60_000).toISOString() };
	assert.equal(newestCleared(exact, { now: NOW }).version, '1.0.0');
});

test('registry bookkeeping keys, prereleases and bad or future stamps are never candidates', () => {
	const r = newestCleared(
		{
			created: ago(99),
			modified: ago(99),
			'9.0.0-rc.1': ago(99),
			'3.0.0': 'garbage',
			'4.0.0': new Date(NOW + DAY).toISOString(),
			'1.0.0': ago(20),
		},
		{ now: NOW }
	);
	assert.equal(r.version, '1.0.0');
});

test('nothing cleared, or no time map at all, is UNKNOWN with a reason', () => {
	for (const t of [{ '1.0.0': ago(1) }, {}, null, undefined, [], 'x']) {
		const r = newestCleared(t, { now: NOW });
		assert.equal(r.status, 'unknown', JSON.stringify(t));
		assert.ok(r.reason.length > 10);
	}
});

test('lookupLatest resolves through an injected fetch and asks the encoded scoped URL', async () => {
	let seen;
	const r = await lookupLatest(
		{ package: '@anthropic-ai/claude-code' },
		{
			now: NOW,
			fetch: async (url) => ((seen = url), { ok: true, json: async () => ({ time: TIME }) }),
		}
	);
	assert.equal(seen, 'https://registry.npmjs.org/@anthropic-ai%2Fclaude-code');
	assert.equal(r.status, 'known');
	assert.equal(r.version, '2.1.282');
});

/**
 * INVARIANT 3. Each of these is a way of not having looked, and every one must
 * come back unknown WITH the reason — never a version, never "current".
 */
test('a failed, rate-limited, slow or malformed lookup is UNKNOWN with the reason carried', async () => {
	const cases = [
		['HTTP 429', async () => ({ ok: false, status: 429 }), /rate limited.*429/],
		['HTTP 503', async () => ({ ok: false, status: 503 }), /HTTP 503/],
		[
			'network error',
			async () => {
				throw new Error('ECONNRESET');
			},
			/ECONNRESET/,
		],
		[
			'timeout',
			async () => {
				const e = new Error('t');
				e.name = 'TimeoutError';
				throw e;
			},
			/timed out/,
		],
		[
			'bad json',
			async () => ({
				ok: true,
				status: 200,
				json: async () => {
					throw new SyntaxError('Unexpected token <');
				},
			}),
			/not JSON/,
		],
		['no time map', okFetch({ name: 'x' }), /no per-version time map/],
	];
	for (const [name, fetch, reason] of cases) {
		const r = await lookupLatest({ package: 'p' }, { fetch, now: NOW, attempts: 2 });
		assert.equal(r.status, 'unknown', name);
		assert.match(r.reason, reason, name);
		assert.equal(r.version, undefined, `${name} must not carry a version`);
	}
});

test('a package-less declaration is unknown, not a crash and not current', async () => {
	assert.equal((await lookupLatest({}, { fetch: okFetch({}) })).status, 'unknown');
	assert.equal((await lookupLatest(undefined, { fetch: okFetch({}) })).status, 'unknown');
});

test('a transient failure is retried and recovers; every attempt failing stays unknown', async () => {
	let n = 0;
	const flaky = async () =>
		++n === 1 ? { ok: false, status: 502 } : { ok: true, json: async () => ({ time: TIME }) };
	const r = await lookupLatest({ package: 'p' }, { fetch: flaky, now: NOW, attempts: 2 });
	assert.equal(r.status, 'known');
	assert.equal(r.attempts, 2);

	n = 0;
	const dead = async () => (n++, { ok: false, status: 502 });
	const d = await lookupLatest({ package: 'p' }, { fetch: dead, now: NOW, attempts: 3 });
	assert.equal(n, 3);
	assert.equal(d.status, 'unknown');
	assert.match(d.reason, /gave up after 3/);
});

test('the per-run lookup asks upstream ONCE per tool however many nodes ask, unknown included', async () => {
	let calls = 0;
	const look = createReleaseLookup({
		now: NOW,
		attempts: 1,
		fetch: async () => (calls++, { ok: true, json: async () => ({ time: TIME }) }),
	});
	const src = { package: '@anthropic-ai/claude-code' };
	const all = await Promise.all([look(src), look(src), look(src)]);
	assert.equal(calls, 1);
	assert.ok(all.every((r) => r.version === '2.1.282'));
	await look(src, { minAge: 200 });
	assert.equal(calls, 2, 'a different minAge is a different question');

	let failing = 0;
	const lookFail = createReleaseLookup({
		attempts: 1,
		fetch: async () => (failing++, { ok: false, status: 429 }),
	});
	await lookFail(src);
	await lookFail(src);
	assert.equal(failing, 1, 'a rate-limited registry must not be asked once per node');
});

test('assess: current, behind, ahead', () => {
	const known = { status: 'known', version: '2.1.285', publishedAt: ago(8) };
	assert.equal(assess('2.1.285 (Claude Code)', known).status, 'current');
	const behind = assess('2.1.284 (Claude Code)', known);
	assert.equal(behind.status, 'behind');
	assert.equal(behind.target, '2.1.285');
	assert.equal(assess('2.1.286 (Claude Code)', known).status, 'ahead');
});

// ── lookupAdoptiumLatest / lookupMavenLatest (cardtable#5, jdk21/maven) ─────
//
// Neither Adoptium nor Maven Central is npm-shaped, so `lookupLatest` above
// cannot read either feed — these are the per-vendor equivalents
// `createReleaseLookup` dispatches to by `source.kind`.

test('lookupAdoptiumLatest: the newest release past minAge wins, by major.minor.security', () => {
	const now = Date.now();
	const old = (days) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
	const body = [
		{ version_data: { major: 21, minor: 0, security: 13 }, timestamp: old(2) }, // too fresh
		{ version_data: { major: 21, minor: 0, security: 12 }, timestamp: old(10) },
		{ version_data: { major: 21, minor: 0, security: 11 }, timestamp: old(40) },
	];
	const fetchStub = async () => ({ ok: true, json: async () => body });
	return lookupAdoptiumLatest({ feature: 21 }, { fetch: fetchStub, now }).then((r) => {
		assert.deepEqual(r, { status: 'known', version: '21.0.12', publishedAt: old(10), attempts: 1 });
	});
});

test('lookupAdoptiumLatest: nothing past minAge is unknown, never a guessed version', () => {
	const now = Date.now();
	const fresh = new Date(now - 60_000).toISOString();
	const body = [{ version_data: { major: 21, minor: 0, security: 13 }, timestamp: fresh }];
	const fetchStub = async () => ({ ok: true, json: async () => body });
	return lookupAdoptiumLatest({}, { fetch: fetchStub, now }).then((r) => {
		assert.equal(r.status, 'unknown');
		assert.equal(r.version, undefined);
	});
});

test('lookupAdoptiumLatest: a non-2xx answer is unknown with the reason, never a fallback', () => {
	const fetchStub = async () => ({ ok: false, status: 429 });
	return lookupAdoptiumLatest({}, { fetch: fetchStub, attempts: 1 }).then((r) => {
		assert.equal(r.status, 'unknown');
		assert.match(r.reason, /429/);
	});
});

test('lookupMavenLatest: picks the newest 3.9.x whose POM Last-Modified clears minAge', () => {
	const now = Date.now();
	const old = (days) => new Date(now - days * 24 * 60 * 60 * 1000).toUTCString();
	const metadataXml =
		'<metadata><versioning><versions>' +
		'<version>3.9.14</version><version>3.9.15</version><version>3.9.16</version>' +
		'<version>3.8.8</version>' +
		'</versions></versioning></metadata>';
	const heads = {
		'3.9.16': old(2), // too fresh
		'3.9.15': old(10),
		'3.9.14': old(40),
	};
	const fetchStub = async (url, opts) => {
		if (url.endsWith('maven-metadata.xml')) return { ok: true, text: async () => metadataXml };
		const v = Object.keys(heads).find((k) => url.includes(`/${k}/`));
		if (opts?.method === 'HEAD' && v) {
			return { ok: true, headers: { get: (h) => (h === 'last-modified' ? heads[v] : null) } };
		}
		return { ok: false, status: 404 };
	};
	return lookupMavenLatest({ majorMinor: '3.9' }, { fetch: fetchStub, now }).then((r) => {
		assert.equal(r.status, 'known');
		assert.equal(r.version, '3.9.15');
	});
});

test('lookupMavenLatest: a release line with nothing old enough is unknown', () => {
	const now = Date.now();
	const metadataXml =
		'<metadata><versioning><versions><version>3.9.16</version></versions></versioning></metadata>';
	const fetchStub = async (url) => {
		if (url.endsWith('maven-metadata.xml')) return { ok: true, text: async () => metadataXml };
		return { ok: true, headers: { get: () => new Date(now - 60_000).toUTCString() } };
	};
	return lookupMavenLatest({ majorMinor: '3.9' }, { fetch: fetchStub, now }).then((r) => {
		assert.equal(r.status, 'unknown');
	});
});

// ── createReleaseLookup's dispatch (the production bug) ─────────────────────
//
// `createReleaseLookup` is what every real caller (`refresh-cycle.mjs`,
// `bootcamp.mjs`, `check-fleet-toolchain.mjs`) actually holds. Before this,
// its returned function called `lookupLatest` UNCONDITIONALLY, which answers
// any source with no `.package` — Adoptium's and Maven Central's both — with
// `unknown: tool declares no upstream package`. jdk21 and maven would never
// have installed in production; see `scripts/lib/toolchain-floor.test.mjs`
// for the same assertion made against the real `REPAIRS.jdk21`/`REPAIRS.maven`.
test('createReleaseLookup dispatches by source.kind: adoptium, maven-metadata, and plain npm all in one run', async () => {
	const seen = [];
	const fetchStub = async (url, opts) => {
		if (String(url).includes('feature_releases')) {
			seen.push('adoptium');
			return {
				ok: true,
				json: async () => [
					{ version_data: { major: 21, minor: 0, security: 12 }, timestamp: ago(20) },
				],
			};
		}
		if (String(url).endsWith('maven-metadata.xml')) {
			seen.push('maven-metadata');
			return {
				ok: true,
				text: async () =>
					'<metadata><versioning><versions><version>3.9.16</version></versions></versioning></metadata>',
			};
		}
		if (opts?.method === 'HEAD') return { ok: true, headers: { get: () => ago(20) } };
		seen.push('npm');
		return { ok: true, json: async () => ({ time: TIME }) };
	};
	const lookup = createReleaseLookup({ fetch: fetchStub, now: NOW });
	const [jdk, mvn, npm] = await Promise.all([
		lookup({ kind: 'adoptium', feature: 21 }),
		lookup({ kind: 'maven-metadata', majorMinor: '3.9' }),
		lookup({ package: '@anthropic-ai/claude-code' }),
	]);
	assert.equal(jdk.status, 'known');
	assert.equal(jdk.version, '21.0.12');
	assert.equal(mvn.status, 'known');
	assert.equal(mvn.version, '3.9.16');
	assert.equal(npm.status, 'known');
	assert.equal(npm.version, '2.1.282');
	assert.ok(seen.includes('adoptium') && seen.includes('maven-metadata') && seen.includes('npm'));
});

/**
 * THE CACHE-KEY HALF OF THE SAME BUG. Both `jdk21` and `maven`'s sources carry
 * no `.package` at all, so a key built from `registry`+`package` collapses to
 * the identical string for both — one tool's cached answer would be served
 * back as the other's. MUTATION: narrow the key back to `registry`+`package`
 * and this fails (both calls return jdk21's version).
 */
test('createReleaseLookup: jdk21 and maven cache SEPARATELY — neither source carries a package', async () => {
	let adoptiumCalls = 0;
	let mavenCalls = 0;
	const fetchStub = async (url, opts) => {
		if (String(url).includes('feature_releases')) {
			adoptiumCalls++;
			return {
				ok: true,
				json: async () => [
					{ version_data: { major: 21, minor: 0, security: 12 }, timestamp: ago(20) },
				],
			};
		}
		if (String(url).endsWith('maven-metadata.xml')) {
			mavenCalls++;
			return {
				ok: true,
				text: async () =>
					'<metadata><versioning><versions><version>3.9.16</version></versions></versioning></metadata>',
			};
		}
		if (opts?.method === 'HEAD') return { ok: true, headers: { get: () => ago(20) } };
		throw new Error(`unexpected fetch: ${url}`);
	};
	const lookup = createReleaseLookup({ fetch: fetchStub, now: NOW });
	const jdk = await lookup({ kind: 'adoptium', feature: 21 });
	const mvn = await lookup({ kind: 'maven-metadata', majorMinor: '3.9' });
	assert.equal(jdk.version, '21.0.12');
	assert.equal(mvn.version, '3.9.16');
	assert.notEqual(jdk.version, mvn.version);
	assert.ok(adoptiumCalls >= 1 && mavenCalls >= 1, 'each source must reach its OWN upstream');
	// Asking again for either must hit the cache, not refetch — the ORIGINAL
	// per-run-once guarantee, which a key collision would not break (a
	// collision serves a WRONG cached answer, not a repeat fetch), so this is
	// a second, independent property of the same fix.
	await lookup({ kind: 'adoptium', feature: 21 });
	await lookup({ kind: 'maven-metadata', majorMinor: '3.9' });
	assert.equal(adoptiumCalls, 1);
	assert.equal(mavenCalls, 1);
});

/** The #56 shape: could not look must never read as up to date. */
test('assess never reports current when upstream or the installed version is unknown', () => {
	const unknown = { status: 'unknown', reason: 'rate limited (HTTP 429)' };
	const a = assess('2.1.285', unknown);
	assert.equal(a.status, 'unknown');
	assert.match(a.reason, /429/);
	assert.equal(assess('2.1.285', undefined).status, 'unknown');
	assert.equal(assess('2.1.285', null).status, 'unknown');
	const b = assess('', { status: 'known', version: '2.1.285' });
	assert.equal(b.status, 'unknown');
	assert.match(b.reason, /installed version/);
	assert.equal(assess('NOT-ON-PATH', { status: 'known', version: '2.1.285' }).status, 'unknown');
});

test('a request range: every comparator holds, missing parts are 0, anything else is unreadable', () => {
	assert.equal(satisfies('24.11.0', '>=24.0.0 <25.0.0'), true);
	assert.equal(satisfies('25.0.0', '>=24.0.0 <25.0.0'), false);
	assert.equal(satisfies('22.23.2', '>=22.12'), true);
	assert.equal(satisfies('22.11.9', '>=22.12'), false);
	assert.equal(satisfies('24.1.0', '=24.1.0'), true);
	assert.deepEqual(parseRange('>=22.12'), [{ op: '>=', v: '22.12.0' }]);
	for (const bad of ['^24', '24.x', '24', '', '>=a'])
		assert.equal(parseRange(bad), null, JSON.stringify(bad));
	assert.throws(() => satisfies('24.0.0', '^24'), /cannot read version range/);
});
