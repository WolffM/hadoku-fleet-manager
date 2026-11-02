/**
 * tool-release — the pure half of "what version SHOULD this tool be on".
 *
 * Three consumers read the same answer (issue #69): the refresh cycle moves a
 * node to it, `check-fleet-toolchain` fails a node that has fallen behind it,
 * and bootcamp installs it. They share this file so they cannot disagree about
 * what "new enough to install" means.
 *
 * THE DEBOUNCE. A release is a candidate only once it has been public for
 * `minAge` minutes. Default {@link DEFAULT_MIN_AGE_MINUTES}; it is the same
 * number and the same unit the ecosystem already uses. SOURCE:
 * `hadoku_site/pnpm-workspace.yaml:36` — `minimumReleaseAge: 10080` — guarded
 * by that repo's `lint.yml`. A compromised or broken NEW release is the risk it
 * buys down; it does NOT apply to Debian-Security patches (decided 2026-09-30).
 *
 * "I COULD NOT LOOK" IS NEVER "CURRENT". Every function that can fail to learn
 * something returns `{ status: 'unknown', reason }` and never a value that a
 * caller could mistake for an answer: `assess` returns `unknown`, not `current`,
 * when upstream was unreachable, rate-limited or malformed. Retrying is fine
 * (see `attempts`); a lookup that fails every attempt is still unknown (#56 was
 * this bug in another form).
 *
 * THE LOOKUP IS INJECTABLE and MEMOISABLE. `lookupLatest` takes a `fetch`, so
 * tests use fixtures, and {@link createReleaseLookup} asks upstream ONCE per
 * tool per run — an unconditional external call, so the budget is per run, not
 * per node.
 *
 * THE PURE VERSION ALGEBRA LIVES IN `version-algebra.mjs` (cut (iii) layer
 * debt, wave layers-3 lane T): `parseVersion`, `compareVersions`,
 * `parseRange`, `satisfies`, `parseInstalledVersion`, `newestCleared` and
 * `DEFAULT_MIN_AGE_MINUTES` make no network call and read no node, so they
 * sit in `config`, the one layer every domain already imports legally; this
 * file re-exports every one of them unchanged. What stays here is the real
 * I/O against the registries THEMSELVES — npm, Adoptium, Maven Central,
 * GitHub's release list — which is "another system's data" (refactor plan
 * §3.2 rule 2), so this file is `access`, not `lifecycle` core: that is what
 * makes it legal for `check-fleet-toolchain.mjs` (observation, which may not
 * import a domain's core) to read `assess`/`createReleaseLookup` here, the
 * exact sharing issue #69 asked for in the first place.
 */

import { isVersionManaged, minAgeOf } from './toolchain-floor.mjs';
import {
	DEFAULT_MIN_AGE_MINUTES,
	parseVersion,
	compareVersions,
	newestCleared,
} from './version-algebra.mjs';

export {
	assess,
	DEFAULT_MIN_AGE_MINUTES,
	parseVersion,
	compareVersions,
	parseRange,
	satisfies,
	parseInstalledVersion,
	newestCleared,
} from './version-algebra.mjs';

/**
 * Ask npm for one package's per-version publish times and resolve the newest
 * cleared version.
 *
 * @param {{package:string, registry?:string}} source  the tool's `latest.source`
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetch]   injectable; defaults to global fetch
 * @param {number} [opts.attempts]      total tries, default 2 (measured transient rate is low; retry is not tolerance)
 * @param {number} [opts.timeoutMs]     per attempt
 * @param {number} [opts.now]
 * @param {number} [opts.minAge]        minutes
 * @returns {Promise<ReturnType<typeof newestCleared> & {attempts?:number}>}
 */
export async function lookupLatest(source, opts = {}) {
	const {
		attempts = 2,
		timeoutMs = 15_000,
		now = Date.now(),
		minAge = DEFAULT_MIN_AGE_MINUTES,
	} = opts;
	const doFetch = opts.fetch ?? globalThis.fetch;
	if (!source?.package) return { status: 'unknown', reason: 'tool declares no upstream package' };
	if (typeof doFetch !== 'function') return { status: 'unknown', reason: 'no fetch available' };
	const registry = (source.registry ?? 'https://registry.npmjs.org').replace(/\/+$/, '');
	// `@scope/name` keeps its `@`, and the slash is encoded, as npm's own client sends it.
	const url = `${registry}/${source.package.replace('/', '%2F')}`;
	let reason = 'no attempt was made';
	for (let i = 1; i <= Math.max(1, attempts); i++) {
		try {
			const res = await doFetch(url, {
				headers: { accept: 'application/json' },
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!res.ok) {
				reason =
					res.status === 429 ? 'rate limited (HTTP 429)' : `registry answered HTTP ${res.status}`;
				continue;
			}
			let body;
			try {
				body = await res.json();
			} catch (e) {
				reason = `registry body was not JSON (${e.message})`;
				continue;
			}
			return { ...newestCleared(body?.time, { now, minAge }), attempts: i };
		} catch (e) {
			reason =
				e?.name === 'TimeoutError'
					? `timed out after ${timeoutMs} ms`
					: `fetch failed (${e?.message ?? e})`;
		}
	}
	return {
		status: 'unknown',
		reason: `${reason}; gave up after ${Math.max(1, attempts)} attempt(s)`,
	};
}

/**
 * Adoptium's "feature release" feed for a Temurin GA line — the newest
 * release whose GA `timestamp` has cleared `minAge`.
 *
 * `lookupLatest` above is shaped for an npm registry's per-version `time`
 * map; Adoptium is not one. Same contract (injectable `fetch`, "could not
 * look" always `unknown`, never a guessed version), so {@link createReleaseLookup}
 * can dispatch to either without its callers (`refresh-cycle.mjs`,
 * `bootcamp.mjs`, `check-fleet-toolchain.mjs`) needing to know which one
 * answered.
 *
 * THE RETURNED VERSION IS THREE DOTTED NUMBERS (`major.minor.security`),
 * NEVER Adoptium's own release tag (`jdk-21.0.12.1+7`). `installScript`'s
 * injection guard in `toolchain-floor.mjs` and `compareVersions` both require
 * a strict x.y.z — the same guard issue #70 added for `claude` — and
 * `java -version` itself reports in that shape too (ignoring the rare
 * nonzero `patch` component, which the repair's own `sort -V` comparison
 * treats as "already ahead, skip" either way, so dropping it costs nothing).
 * `REPAIRS.jdk21.repair` re-resolves the FULL release tag it needs from this
 * pinned x.y.z against the same feed at install time, rather than threading
 * Adoptium's tag through `resolveInstallTarget`'s return value — which every
 * caller already destructures as `{status, version, publishedAt}` and must
 * not be asked to carry a fourth, tool-specific field.
 */
export async function lookupAdoptiumLatest(source, opts = {}) {
	const {
		attempts = 2,
		timeoutMs = 15_000,
		now = Date.now(),
		minAge = DEFAULT_MIN_AGE_MINUTES,
	} = opts;
	const doFetch = opts.fetch ?? globalThis.fetch;
	if (typeof doFetch !== 'function') return { status: 'unknown', reason: 'no fetch available' };
	const feature = source?.feature ?? 21;
	const url =
		source?.feedUrl ??
		`https://api.adoptium.net/v3/assets/feature_releases/${feature}/ga?image_type=jdk&` +
			'os=linux&architecture=x64&jvm_impl=hotspot&heap_size=normal&vendor=eclipse&page_size=20';
	let reason = 'no attempt was made';
	for (let i = 1; i <= Math.max(1, attempts); i++) {
		try {
			const res = await doFetch(url, {
				headers: { accept: 'application/json' },
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!res.ok) {
				reason =
					res.status === 429 ? 'rate limited (HTTP 429)' : `Adoptium answered HTTP ${res.status}`;
				continue;
			}
			let body;
			try {
				body = await res.json();
			} catch (e) {
				reason = `Adoptium body was not JSON (${e.message})`;
				continue;
			}
			if (!Array.isArray(body)) {
				reason = 'Adoptium response was not a release list';
				continue;
			}
			let best = null;
			for (const release of body) {
				const vd = release?.version_data;
				if (
					!vd ||
					!Number.isFinite(vd.major) ||
					!Number.isFinite(vd.minor) ||
					!Number.isFinite(vd.security)
				)
					continue;
				const version = `${vd.major}.${vd.minor}.${vd.security}`;
				if (!parseVersion(version)) continue;
				const at = Date.parse(release.timestamp);
				if (Number.isNaN(at)) continue;
				const ageMinutes = (now - at) / 60_000;
				if (ageMinutes < minAge) continue;
				if (!best || compareVersions(version, best.version) > 0) {
					best = { version, publishedAt: new Date(at).toISOString() };
				}
			}
			if (!best) {
				return {
					status: 'unknown',
					reason: `no Temurin ${feature} GA release is older than minAge (${minAge} min) in ${body.length} candidate(s)`,
				};
			}
			return { status: 'known', ...best, attempts: i };
		} catch (e) {
			reason =
				e?.name === 'TimeoutError'
					? `timed out after ${timeoutMs} ms`
					: `fetch failed (${e?.message ?? e})`;
		}
	}
	return {
		status: 'unknown',
		reason: `${reason}; gave up after ${Math.max(1, attempts)} attempt(s)`,
	};
}

/**
 * Apache Maven's own release feed — Maven Central's `maven-metadata.xml` for
 * the `apache-maven` artifact itself, narrowed to one minor line (`3.9` by
 * default) and resolved to a publish date via each candidate's POM
 * `Last-Modified` header, newest first, until one clears `minAge`.
 *
 * KEPT HERE for the same reason `lookupAdoptiumLatest` is: Maven Central is
 * not an npm registry either. `maven-metadata.xml` carries one `lastUpdated`
 * for the WHOLE document, not one per version, so there is no single
 * document that answers "how old is this candidate" — hence the second,
 * per-candidate request.
 */
export async function lookupMavenLatest(source, opts = {}) {
	const {
		attempts = 2,
		timeoutMs = 15_000,
		now = Date.now(),
		minAge = DEFAULT_MIN_AGE_MINUTES,
	} = opts;
	const doFetch = opts.fetch ?? globalThis.fetch;
	if (typeof doFetch !== 'function') return { status: 'unknown', reason: 'no fetch available' };
	const majorMinor = source?.majorMinor ?? '3.9';
	const metadataUrl =
		source?.metadataUrl ??
		'https://repo1.maven.org/maven2/org/apache/maven/apache-maven/maven-metadata.xml';
	const probeDepth = source?.probeDepth ?? 5;
	let reason = 'no attempt was made';
	for (let i = 1; i <= Math.max(1, attempts); i++) {
		try {
			const res = await doFetch(metadataUrl, { signal: AbortSignal.timeout(timeoutMs) });
			if (!res.ok) {
				reason =
					res.status === 429
						? 'rate limited (HTTP 429)'
						: `Maven Central answered HTTP ${res.status}`;
				continue;
			}
			const xml = await res.text();
			const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
				.map((m) => m[1])
				.filter((v) => parseVersion(v) && v.startsWith(`${majorMinor}.`))
				.sort(compareVersions)
				.reverse();
			if (!versions.length) {
				return {
					status: 'unknown',
					reason: `maven-metadata.xml listed no ${majorMinor}.x release`,
				};
			}
			// Per-version publish date needs a second call per candidate — see the
			// header comment. Capped at the newest few: the fleet only ever wants
			// the newest 3.9.x release, never a backfill of the whole line.
			for (const version of versions.slice(0, probeDepth)) {
				const pomUrl = `https://repo1.maven.org/maven2/org/apache/maven/apache-maven/${version}/apache-maven-${version}.pom`;
				const head = await doFetch(pomUrl, {
					method: 'HEAD',
					signal: AbortSignal.timeout(timeoutMs),
				});
				if (!head.ok) continue;
				const lastModified = head.headers.get('last-modified');
				const at = lastModified ? Date.parse(lastModified) : NaN;
				if (Number.isNaN(at)) continue;
				const ageMinutes = (now - at) / 60_000;
				if (ageMinutes < minAge) continue;
				return { status: 'known', version, publishedAt: new Date(at).toISOString(), attempts: i };
			}
			return {
				status: 'unknown',
				reason:
					`no ${majorMinor}.x release in the newest ${Math.min(versions.length, probeDepth)} ` +
					`is older than minAge (${minAge} min)`,
			};
		} catch (e) {
			reason =
				e?.name === 'TimeoutError'
					? `timed out after ${timeoutMs} ms`
					: `fetch failed (${e?.message ?? e})`;
		}
	}
	return {
		status: 'unknown',
		reason: `${reason}; gave up after ${Math.max(1, attempts)} attempt(s)`,
	};
}

/**
 * A GitHub repository's own release list — for a tool shipped as a release
 * binary (yt-dlp, deno), which no package registry tracks. `source.repo` is
 * `owner/name`; `source.tagPrefix` is stripped from each tag (deno tags
 * `v2.9.8`, yt-dlp `2026.10.26`), and the VERSION returned is the rest of the
 * tag exactly as written, because the install fetches by that tag. Drafts and
 * prereleases are never candidates.
 *
 * Unauthenticated: 60 calls an hour per address, and a run asks once per
 * tool. A refusal (403/429) is `unknown` with the reason, like any lookup.
 */
export async function lookupGithubRelease(source, opts = {}) {
	const { now = Date.now(), minAge = DEFAULT_MIN_AGE_MINUTES } = opts;
	const list = await fetchGithubReleaseTimes(source, opts);
	if (list.status !== 'known') return list;
	const r = newestCleared(list.time, { now, minAge });
	if (r.status !== 'known') return { status: 'unknown', reason: `${source.repo}: ${r.reason}` };
	return {
		status: 'known',
		version: r.version,
		publishedAt: r.publishedAt,
		attempts: list.attempts,
	};
}

/**
 * The release list itself, `{ version: publishedAt }`, prefix stripped,
 * drafts and prereleases left out: {@link lookupGithubRelease}'s read, and
 * what `backstop-tools` dates an INSTALLED version by (fleet-manager#34).
 *
 * @returns {Promise<{status:'known', time:Record<string,string>, attempts:number} | {status:'unknown', reason:string}>}
 */
export async function fetchGithubReleaseTimes(source, opts = {}) {
	const { attempts = 2, timeoutMs = 15_000 } = opts;
	const doFetch = opts.fetch ?? globalThis.fetch;
	if (typeof doFetch !== 'function') return { status: 'unknown', reason: 'no fetch available' };
	if (!/^[\w.-]+\/[\w.-]+$/.test(source?.repo ?? ''))
		return { status: 'unknown', reason: 'tool declares no GitHub owner/name repo' };
	const prefix = source.tagPrefix ?? '';
	const url = `https://api.github.com/repos/${source.repo}/releases?per_page=20`;
	let reason = 'no attempt was made';
	for (let i = 1; i <= Math.max(1, attempts); i++) {
		try {
			const res = await doFetch(url, {
				headers: { accept: 'application/vnd.github+json' },
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!res.ok) {
				reason =
					res.status === 429 || res.status === 403
						? `rate limited (HTTP ${res.status})`
						: `GitHub answered HTTP ${res.status}`;
				continue;
			}
			let body;
			try {
				body = await res.json();
			} catch (e) {
				reason = `GitHub body was not JSON (${e.message})`;
				continue;
			}
			if (!Array.isArray(body)) {
				reason = 'GitHub response was not a release list';
				continue;
			}
			const time = {};
			for (const release of body) {
				if (release?.draft || release?.prerelease) continue;
				const tag = String(release?.tag_name ?? '');
				if (!tag.startsWith(prefix)) continue;
				time[tag.slice(prefix.length)] = release.published_at;
			}
			return { status: 'known', time, attempts: i };
		} catch (e) {
			reason =
				e?.name === 'TimeoutError'
					? `timed out after ${timeoutMs} ms`
					: `fetch failed (${e?.message ?? e})`;
		}
	}
	return {
		status: 'unknown',
		reason: `${reason}; gave up after ${Math.max(1, attempts)} attempt(s)`,
	};
}

/**
 * Dispatch a `latest.source` to the lookup that can actually read it: npm by
 * default, Adoptium, Maven Central or a GitHub release list when the source says so.
 *
 * ONE DISPATCHER, not three call sites that each have to remember which
 * lookup goes with which `source.kind` — `createReleaseLookup`'s whole reason
 * to exist is that every real caller shares it.
 */
export function dispatchLookup(source, opts) {
	if (source?.kind === 'adoptium') return lookupAdoptiumLatest(source, opts);
	if (source?.kind === 'maven-metadata') return lookupMavenLatest(source, opts);
	if (source?.kind === 'github-release') return lookupGithubRelease(source, opts);
	return lookupLatest(source, opts);
}

/**
 * A per-run cache: ask upstream once per source however many nodes and
 * consumers want the answer. Caches the promise, so concurrent askers share
 * one call. An UNKNOWN result is cached too — re-asking a rate-limited registry
 * once per node is how a budget gets spent.
 *
 * THE CACHE KEY NAMES EVERY FIELD THAT PICKS A DIFFERENT UPSTREAM QUESTION,
 * not just `registry`+`package`. Before `jdk21`/`maven` existed every
 * version-managed tool WAS an npm package, so `package` alone disambiguated
 * every real source; jdk21's `{kind:'adoptium', feature:21}` and maven's
 * `{kind:'maven-metadata', majorMinor:'3.9'}` both have no `package` at all,
 * so the old key collapsed to the same `|undefined|<minAge>` string for both
 * — one tool's answer would have been cached and served back as the other's.
 */
export function createReleaseLookup(opts = {}) {
	const cache = new Map();
	return (source, perCall = {}) => {
		const minAge = perCall.minAge ?? opts.minAge ?? DEFAULT_MIN_AGE_MINUTES;
		const key = [
			source?.kind ?? 'npm',
			source?.registry ?? '',
			source?.package ?? '',
			source?.feature ?? '',
			source?.majorMinor ?? '',
			source?.repo ?? '',
			minAge,
		].join('|');
		if (!cache.has(key)) cache.set(key, dispatchLookup(source, { ...opts, ...perCall, minAge }));
		return cache.get(key);
	};
}

/**
 * THE ONE RESOLVER (issue #70): the install target for a tool, i.e. the newest
 * release that has cleared its debounce. Bootcamp and the refresh cycle both
 * call this rather than each computing "what to install" its own way — two
 * resolvers is #69's bug again, this time over the target version instead of
 * the declaration.
 *
 * A presence-only tool (no `latest`) has nothing to resolve:
 * `{ status: 'presence-only' }`. `installScript(id)` with no version is the
 * correct and only call for one of those.
 *
 * "COULD NOT LOOK" REFUSES, IT NEVER FALLS BACK. An unreachable, rate-limited
 * or malformed registry answer returns `{ status: 'unknown', reason }` and
 * NEVER a version — there is no path from here back to vendor-latest behind a
 * failed lookup. `installScript` enforces the other half: it throws rather
 * than install a version-managed tool with no version, so a caller cannot
 * skip this resolver and still get an install.
 *
 * MOVED HERE FROM `toolchain-floor.mjs` (cut (iii) layer debt, wave layers-3
 * lane T): it needs `dispatchLookup`, a real network call against another
 * system's registry, and `toolchain-floor.mjs` is `config`, which may import
 * nothing above config. The body is byte-identical; only `minAgeOf` and
 * `isVersionManaged`, which stay in `toolchain-floor.mjs` since
 * `check-fleet-toolchain.mjs` reads them from there too, are now imported
 * instead of local.
 *
 * @param {object} tool  a REPAIRS entry
 * @param {object} [opts]
 * @param {typeof dispatchLookup} [opts.lookup]  injectable; defaults to
 *        `dispatchLookup`, which reads the tool's own `latest.source.kind`
 *        (npm, Adoptium, Maven Central or a GitHub release). The default was a
 *        bare npm lookup until converge-toolchain, the one caller that passed
 *        none, failed jdk21/maven with "tool declares no upstream package".
 *        A caller asking for many nodes still passes `createReleaseLookup()`
 *        so upstream is asked once per run.
 * @returns {Promise<{status:'presence-only'}
 *          | {status:'known', version:string, publishedAt:string}
 *          | {status:'unknown', reason:string}>}
 */
export async function resolveInstallTarget(tool, opts = {}) {
	if (!isVersionManaged(tool)) return { status: 'presence-only' };
	const { lookup = dispatchLookup, ...rest } = opts;
	const latest = await lookup(tool.latest.source, { minAge: minAgeOf(tool), ...rest });
	if (latest.status !== 'known') return { status: 'unknown', reason: latest.reason };
	return { status: 'known', version: latest.version, publishedAt: latest.publishedAt };
}
