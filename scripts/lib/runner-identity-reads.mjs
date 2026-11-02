/**
 * reconcile-runner-identity.mjs's GitHub-read primitives — split off the
 * 800-line ceiling (wave 5q lane B, pure move). None of these call `runOn`;
 * the one function that reaches a node over ssh (`probeNode`) stays in the
 * CLI file itself, same reasoning as `reconcile-fleet-runners.mjs`'s `ssh()`
 * — `expected-down-guard.test.mjs` scans only top-level `scripts/*.mjs` for
 * that call, and this file's own `deferralFor` call (probing loop) already
 * satisfies it regardless; moving `probeNode` out would just remove the one
 * thing the guard looks for in the first place.
 */
import { execFile } from 'node:child_process';
import { READ_ATTEMPTS, describeReadFailure } from './read-retry-policy.mjs';

/**
 * A read that never finishes is a read that never reports. 20s matches
 * `check-queue-health`, and it is what makes `describeReadFailure`'s timeout
 * branch reachable rather than decorative.
 */
export const READ_TIMEOUT_MS = 20_000;
/** Long enough for a blip to pass, short enough to be invisible at a 0.13% rate. */
export const RETRY_DELAY_MS = 1_000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * REQUIRED NAMING CONTRACT for anything the dispatcher mints:
 *
 *     jit-<node>-<repo-slug>-<epochSeconds>
 *
 * The trailing epoch is load-bearing, not decoration — it is the only mint-time
 * fact the GitHub API will give back to us. A JIT runner named without it is
 * treated as ageless and therefore immediately reapable.
 */
export function mintAgeMs(name, now) {
	const m = /-(\d{10,})$/.exec(name);
	if (!m) return Infinity;
	return now - Number(m[1]) * 1000;
}

/**
 * One `gh api` call, as `{ok, data}` or `{ok: false, reason}`.
 *
 * This was `catch { res(null) }` — the shape CLAUDE.md names explicitly, where
 * the reason is discarded and the finding becomes unactionable. `describeReadFailure`
 * is written against `execFileSync`'s error shape, which spells the exit code
 * `status`; async `execFile` spells it `code`. Translated here rather than
 * re-implemented, because the interesting part — timeout vs exit vs stderr — is
 * the same question in both.
 */
export function ghOnce(path) {
	return new Promise((res) => {
		execFile(
			'gh',
			['api', path],
			{ maxBuffer: 8 << 20, timeout: READ_TIMEOUT_MS },
			(err, stdout, stderr) => {
				if (err)
					return res({
						ok: false,
						reason: describeReadFailure(
							{
								killed: err.killed,
								signal: err.signal,
								status: err.code,
								stderr: stderr ?? '',
								message: err.message,
							},
							READ_TIMEOUT_MS
						),
					});
				try {
					res({ ok: true, data: JSON.parse(stdout) });
				} catch (e) {
					res({ ok: false, reason: `gh returned unparseable JSON: ${String(e.message)}` });
				}
			}
		);
	});
}

/** Data or null, for callers that treat a failed read as "no answer". */
export async function gh(path) {
	const r = await ghOnce(path);
	return r.ok ? r.data : null;
}

/**
 * The runner listing for one repo, retried once, with the reason on failure.
 *
 * `{ok: false}` is COULD NOT LOOK and is never a pass — a repo whose listing
 * cannot be read is indistinguishable from a repo with no registrations, and
 * this whole file is about telling those apart.
 */
export async function readRunners(repo) {
	let reason = 'no attempt was made';
	for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
		const r = await ghOnce(`repos/${repo}/actions/runners`);
		if (r.ok && Array.isArray(r.data?.runners)) return { ok: true, runners: r.data.runners };
		// The LAST reason wins: it is the one that stood after the blip had a
		// moment to pass, which is the more informative of the two.
		reason = `${r.ok ? 'gh answered with no `runners` array — not a runner listing' : r.reason} (attempt ${attempt}/${READ_ATTEMPTS})`;
		if (attempt < READ_ATTEMPTS) await sleep(RETRY_DELAY_MS);
	}
	return { ok: false, reason };
}

/**
 * Resolve a repo slug to its CANONICAL full_name, following renames.
 *
 * A runner's .runner file records the URL it was configured with and is never
 * rewritten when the repo is renamed, so the fleet is full of stale names:
 * `WolffM/tenhands` is now `WolffM/hadoku-tenhands`, `WolffM/OSS-Issue-Aggregator`
 * is now `WolffM/hadoku-aggregator`. Comparing a coverage roster (canonical)
 * against .runner (historical) without this reports every renamed repo on every
 * node as an identity mismatch — the first run of this tool produced ten such
 * findings and zero real ones.
 *
 * GitHub redirects the API for a renamed repo, so one call per DISTINCT stale
 * name resolves it. Cached, because the same stale name appears on every node.
 */
const canonCache = new Map();
export async function canonical(slug) {
	if (!slug || slug === '?') return slug;
	if (canonCache.has(slug)) return canonCache.get(slug);
	const data = await gh(`repos/${slug}`);
	const full = data?.full_name ?? slug;
	canonCache.set(slug, full);
	return full;
}

/** The warm units a probe saw ACTIVE. A loaded-but-dead unit backs nothing. */
export function activeWarmUnits(out) {
	const live = new Set();
	for (const line of out.split('\n')) {
		const p = line.trim().split(/\s+/);
		if (p[0] === 'WARMUNIT' && p[2] === 'active') live.add(p[1]);
	}
	return live;
}
