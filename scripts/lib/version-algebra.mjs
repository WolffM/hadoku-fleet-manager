/**
 * version-algebra — the zero-import pure half of `tool-release.mjs` (cut
 * (iii) layer debt, wave layers-3 lane T).
 *
 * EXTRACTED, NOT REWRITTEN. Every export below is byte-identical to its old
 * home in `tool-release.mjs`: parsing, comparing and range-checking an x.y.z
 * version string, plus picking the newest entry out of a registry's
 * per-version `time` map that has cleared a debounce, and `assess`, the pure
 * installed-vs-cleared verdict built on those two. None of it makes a
 * network call or reads a node — it is declarative version algebra, so it
 * sits in `config`, the one layer every domain already imports legally.
 * `tool-release.mjs` re-exports every name here unchanged, so nothing outside
 * this pair of files needs to know the split happened; the importers this
 * split exists FOR (`toolchain-floor.mjs`, a config file that may import
 * nothing above config) read these names from here directly instead.
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
