/**
 * THE BACKSTOP'S HAND-INSTALLED TOOLS: how far behind upstream they are (fleet-manager#34).
 *
 * The services nodes keep yt-dlp and deno current on their own (0.34.164,
 * `toolchain-floor.mjs`): a checksum, one real extraction, then the swap.
 * The backstop is the operator's box and is never converged, yet the operator's party
 * playlist tool and the scraper's YouTube downloader run there, and a stale
 * yt-dlp is exactly how a party playlist stops downloading. The operator's
 * ruling (2026-10-31): a reminder to update them by hand, at most monthly,
 * in the emergency channel. So this READS and REMINDS; it installs nothing.
 *
 * STALE is "the copy installed was released more than STALE_DAYS before the
 * newest release". Measured between RELEASE dates, not against today, so a
 * project that has shipped nothing new is never stale, and yt-dlp's weekly
 * cadence does not page weekly. With the converger's 30-day repage, an
 * operator who updates monthly hears nothing.
 */

/** A copy released this long before the newest release is stale. */
export const STALE_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * Each tool the backstop carries by hand: the login-shell command that prints its
 * version, its GitHub release list, and the command that updates it the way
 * it was installed (yt-dlp with pip --user and its ejs extra, under Debian's
 * externally-managed Python; deno from its own installer).
 */
export const BACKSTOP_TOOLS = {
	'yt-dlp': {
		version: 'yt-dlp --version',
		source: { kind: 'github-release', repo: 'yt-dlp/yt-dlp' },
		update: "python3 -m pip install --user --break-system-packages -U 'yt-dlp[default]'",
	},
	deno: {
		version: 'deno --version | head -n 1',
		source: { kind: 'github-release', repo: 'denoland/deno', tagPrefix: 'v' },
		update: 'deno upgrade',
	},
};

/**
 * One tool's verdict. `installed` is the version a login shell reports (null:
 * not on its PATH); `releases` the release list as `{ version: publishedAt }`
 * (null: could not read it, with `why`).
 *
 * @returns {{ state: 'current'|'stale'|'missing'|'unknown', why: string, installed?: string|null, latest?: string, behindDays?: number|null }}
 */
export function judgeTool(name, { node, installed, releases, why = '' }) {
	const tool = BACKSTOP_TOOLS[name];
	if (!installed)
		return {
			state: 'missing',
			installed: null,
			why: `${name} is not on a login shell's PATH on ${node}. Install it, then: ${tool.update}`,
		};
	if (!releases)
		return { state: 'unknown', installed, why: `${name}'s releases could not be read: ${why}` };
	const dated = Object.entries(releases)
		.map(([v, at]) => [v, Date.parse(at)])
		.filter(([, t]) => Number.isFinite(t))
		.sort((a, b) => b[1] - a[1]);
	if (!dated.length) return { state: 'unknown', installed, why: `${name} lists no dated release` };
	const [latest, latestMs] = dated[0];
	const mine = dated.find(([v]) => sameVersion(v, installed));
	if (mine?.[0] === latest) return { state: 'current', installed, latest, behindDays: 0, why: '' };
	// Older than every release listed: behind by at least the list's span.
	const behindDays = mine ? Math.floor((latestMs - mine[1]) / DAY_MS) : null;
	const behind =
		behindDays === null
			? `older than every release in the list (the oldest listed is ${dated.at(-1)[0]})`
			: `${behindDays} days behind`;
	if (behindDays !== null && behindDays <= STALE_DAYS)
		return { state: 'current', installed, latest, behindDays, why: '' };
	return {
		state: 'stale',
		installed,
		latest,
		behindDays,
		why: `${name} ${installed} on ${node} is ${behind} ${latest}. Update it: ${tool.update}`,
	};
}

/**
 * yt-dlp tags `2026.08.19` and reports `2026.08.19`, but pip normalizes the
 * package to `2026.8.19`, and a hotfix may add `.1`: compare numerically.
 */
function sameVersion(a, b) {
	const parts = (v) =>
		String(v)
			.replace(/^v/, '')
			.split(/[.+-]/)
			.map((p) => (/^\d+$/.test(p) ? String(Number(p)) : p));
	const x = parts(a);
	const y = parts(b);
	return x.length === y.length && x.every((p, i) => p === y[i]);
}
