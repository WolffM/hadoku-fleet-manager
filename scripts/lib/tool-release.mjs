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
 */

/** Seven days, in MINUTES. Source: hadoku_site/pnpm-workspace.yaml:36 `minimumReleaseAge`. */
export const DEFAULT_MIN_AGE_MINUTES = 10080;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** `[major, minor, patch]` of a STRICT x.y.z, else null. Prereleases are not candidates. */
export function parseVersion(v) {
	const m = SEMVER.exec(String(v ?? '').trim());
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * -1 / 0 / 1. THROWS on an unparseable side: a comparison with garbage has no
 * honest answer, and a quiet `0` would read as "current".
 */
export function compareVersions(a, b) {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	if (!pa || !pb) throw new TypeError(`cannot compare versions ${JSON.stringify([a, b])}`);
	for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
	return 0;
}

const COMPARATOR = /^(>=|<=|>|<|=)?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

/**
 * A version range as a hosting request states one (`runtime.node`):
 * whitespace-separated comparators, `>=24.0.0 <25.0.0` or `>=22.12`, every one
 * of which must hold. A missing minor or patch is 0. A bare version is `=` and
 * must be a full x.y.z. Null when any part is not that grammar: a range the
 * fleet cannot evaluate is refused at validation, never guessed at.
 */
export function parseRange(range) {
	const parts = String(range ?? '')
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (!parts.length) return null;
	const out = [];
	for (const part of parts) {
		const m = COMPARATOR.exec(part);
		if (!m || (!m[1] && m[4] === undefined)) return null;
		out.push({ op: m[1] ?? '=', v: `${m[2]}.${m[3] ?? 0}.${m[4] ?? 0}` });
	}
	return out;
}

/** Whether `version` (x.y.z) satisfies `range`. THROWS on either side unparseable, like compareVersions. */
export function satisfies(version, range) {
	const cs = parseRange(range);
	if (!cs) throw new TypeError(`cannot read version range ${JSON.stringify(range)}`);
	return cs.every(({ op, v }) => {
		const c = compareVersions(version, v);
		return op === '>='
			? c >= 0
			: op === '>'
				? c > 0
				: op === '<='
					? c <= 0
					: op === '<'
						? c < 0
						: c === 0;
	});
}

/** Pull the first x.y.z out of `claude --version`-shaped output ("2.1.286 (Claude Code)"). */
export function parseInstalledVersion(out) {
	const m = /(\d+\.\d+\.\d+)(?![\w.-])/.exec(String(out ?? ''));
	return m ? m[1] : null;
}

/**
 * The newest version in an npm registry `time` map that has been public for at
 * least `minAge` minutes at `now`.
 *
 * Ignores the registry's `created`/`modified` keys, prereleases, and entries
 * whose timestamp does not parse. A version PUBLISHED IN THE FUTURE (clock
 * skew, or a bad timestamp) is not cleared — it is skipped, never trusted.
 *
 * @returns {{status:'known', version:string, publishedAt:string, ageMinutes:number, minAge:number}
 *          | {status:'unknown', reason:string}}
 */
export function newestCleared(time, { now = Date.now(), minAge = DEFAULT_MIN_AGE_MINUTES } = {}) {
	if (!time || typeof time !== 'object' || Array.isArray(time)) {
		return { status: 'unknown', reason: 'registry returned no per-version time map' };
	}
	let best = null;
	let considered = 0;
	for (const [version, stamp] of Object.entries(time)) {
		if (!parseVersion(version)) continue;
		const at = Date.parse(stamp);
		if (Number.isNaN(at)) continue;
		considered++;
		const ageMinutes = (now - at) / 60_000;
		if (ageMinutes < minAge) continue;
		if (!best || compareVersions(version, best.version) > 0) {
			best = {
				version,
				publishedAt: new Date(at).toISOString(),
				ageMinutes: Math.floor(ageMinutes),
			};
		}
	}
	if (!best) {
		return {
			status: 'unknown',
			reason: considered
				? `no release is older than minAge (${minAge} min) in ${considered} candidates`
				: 'registry time map held no parseable stable releases',
		};
	}
	return { status: 'known', ...best, minAge };
}

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
	const {
		attempts = 2,
		timeoutMs = 15_000,
		now = Date.now(),
		minAge = DEFAULT_MIN_AGE_MINUTES,
	} = opts;
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
			const r = newestCleared(time, { now, minAge });
			if (r.status !== 'known') return { status: 'unknown', reason: `${source.repo}: ${r.reason}` };
			return { status: 'known', version: r.version, publishedAt: r.publishedAt, attempts: i };
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
 * Compare what is installed with what the debounce allows.
 *
 *   current  installed === newest cleared
 *   ahead    installed is NEWER than anything cleared — fine, not a finding
 *            (an operator or the vendor's own updater moved it; the debounce
 *            gates what WE install, not what a node already holds)
 *   behind   installed is older; `behindBy` says whether this is new
 *   unknown  installed could not be read, or upstream could not be asked —
 *            `reason` says which. NEVER reported as current.
 *
 * @param {string|null} installed  output of the tool's `version` command, or null if unreadable
 * @param {{status:string, version?:string, reason?:string}} latest  a lookupLatest/newestCleared result
 */
export function assess(installed, latest) {
	if (!latest || latest.status !== 'known') {
		return { status: 'unknown', reason: latest?.reason ?? 'upstream was not consulted' };
	}
	const have = parseInstalledVersion(installed);
	if (!have) {
		return {
			status: 'unknown',
			reason: 'installed version could not be read',
			target: latest.version,
		};
	}
	const cmp = compareVersions(have, latest.version);
	const status = cmp === 0 ? 'current' : cmp < 0 ? 'behind' : 'ahead';
	return { status, installed: have, target: latest.version, publishedAt: latest.publishedAt };
}
