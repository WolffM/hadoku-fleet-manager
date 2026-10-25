/**
 * ci-runner-fallback — flip the fleet onto GitHub-hosted runners when every claw
 * is offline, and back when one returns.
 *
 * SCOPE: THIS IS A POLICY, NOT A POOL MANAGER. DO NOT GROW IT.
 * ------------------------------------------------------------
 * It expresses exactly one rule — "when self-hosted capacity reaches zero, route
 * elsewhere" — and it must keep expressing only that. Placement (which repo runs
 * on which node, and how many may register there) belongs to
 * fleet-runner-manifest.json and reconcile-fleet-runners.mjs; priority ordering
 * belongs to fleet-loop.ts. Three systems already write GitHub routing to
 * express node facts, and consolidating them into whichever one grew fastest
 * is how that tangle formed in the first place.
 *
 * It is also the most forge-specific thing in the fleet, and the least portable:
 * a self-hosted forge has NO hosted pool to fall back to, so on a migration this
 * module is not ported, it is DELETED — along with the whole `CI_RUNNER` variable
 * fan-out. Keeping it small and single-purpose is what keeps it cheap to delete.
 * `pnpm run check:forge-coupling` counts what it costs us meanwhile.
 *
 * THE MECHANISM
 * -------------
 * Fleet workflows declare:
 *
 *     runs-on: ${{ fromJSON(vars.CI_RUNNER) }}
 *
 * and this module owns `CI_RUNNER` across every repo in
 * `fleet-runner-coverage.json`: `["self-hosted","hadoku-builder"]` while the
 * claws are up, `"ubuntu-latest"` while every one of them is down. BOTH states
 * are an explicit value — see FLEET_VALUE below for why unset stopped meaning
 * "the claws" on 2026-08-30.
 *
 * This paragraph described the OLD mechanism (unset = claws, every workflow
 * carrying its own `|| '[...]'`) until 2026-08-31, thirty lines above the
 * FLEET_VALUE docstring that describes the new one. Two contradicting accounts
 * of the same variable in one file, and the stale one came first.
 *
 * WHY A VARIABLE AND NOT A PREFLIGHT JOB
 * --------------------------------------
 * The obvious design is a tiny job that asks "are the claws up?" and outputs a
 * label for downstream jobs. It costs a GitHub-hosted job on EVERY run of every
 * workflow — and 12 of the 20 fleet repos are private, where hosted minutes are
 * billed. A variable costs nothing on the happy path: no extra job, no API call,
 * no minutes. The monitor is already polling runner state every 10 minutes for
 * the hokon backstop, so the signal is free.
 *
 * WHY THIS CANNOT MASK A RED BUILD
 * --------------------------------
 * The switch is driven by RUNNER AVAILABILITY and never by job outcome. A failing
 * test fails on whichever pool it landed on and stays failed; nothing is retried
 * anywhere as a result of this module. That is the same discipline the failover
 * rerun in runner-health.ts enforces (it only reruns when the runner went
 * offline), and it is the reason "fall back on any failure" was rejected: it
 * would re-run genuine red builds on billed minutes and let a flaky pass bury a
 * real bug.
 *
 * ORDERING
 * --------
 * `runs-on` is evaluated when a job is CREATED, so flipping the variable steers
 * new runs only — a job already queued against the claws stays queued. That is
 * fine: the hokon backstop and the dropped-job rerun already cover the in-flight
 * cases, and this covers "the next hour of CI while the garage is dark".
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger, manifestDir } from './host.js';
import { ghTokenFingerprint, recordGhResponse } from './gh-budget.js';
import { conditionalCacheStore } from './conditional-cache-store.js';
import { mapConcurrent } from './lib/concurrency.js';
import { hubRepoFull, userAgent } from './lib/fleet-config.js';

/** Injected — see host.ts. coveredRepos() falls back to the HUB REPO on a read
 *  failure, so a wrong path here silently shrinks the fleet to one repo. */
const COVERAGE_PATH = () => resolve(manifestDir(), 'fleet-runner-coverage.json');

export const CI_RUNNER_VAR = 'CI_RUNNER';
/** JSON-encoded, because `runs-on` wraps it in fromJSON(). A bare string breaks the parse. */
export const HOSTED_VALUE = '"ubuntu-latest"';

/**
 * The fleet target. Written on every covered repo whenever the fleet is up.
 *
 * It used to be that "the fleet" meant CI_RUNNER ABSENT, and each of 107
 * workflows across 27 repos carried the fallback itself:
 *
 *   runs-on: ${{ fromJSON(vars.CI_RUNNER || '["self-hosted","hadoku-builder"]') }}
 *
 * That put three pieces of fleet internals in every repo — the label, this
 * variable's name, and the semantics of unset — so the fleet could not change
 * how it is addressed without a 107-file edit. Setting the value explicitly
 * lets a workflow say `fromJSON(vars.CI_RUNNER)` and nothing else.
 *
 * Safe because a GitHub variable is PERSISTENT state, not a lease: if this
 * process dies the last value stays and CI keeps scheduling.
 *
 * THE REMAINING HOLE, STATED HONESTLY. The failure is a repo where the variable
 * was NEVER WRITTEN: with the bare `fromJSON(vars.CI_RUNNER)` form and no value,
 * `runs-on` resolves to nothing and every workflow in that repo fails to start.
 *
 * For a year this comment said that case "is what the seeding pass and `fleet
 * check-runner-var` exist to catch" while neither existed — a comment standing
 * in for a guard, the failure this codebase has now been bitten by four times
 * (handoff §2 counts three). Half of it is now true: `check-runner-var` was
 * built on 2026-09-01 and DETECTS the case, wired as the `ci:runner-var` cron.
 *
 * THE SEEDING PASS STILL DOES NOT EXIST. `syncHostedFallback` below is the only
 * writer of this variable anywhere in either repo, and it iterates
 * `coveredRepos()`, so it structurally cannot reach a repo that is not in the
 * roster YET — exactly and only the population the original sentence claimed was
 * covered. A new repo has no CI_RUNNER until the nightly reconcile admits it.
 *
 * Consequence for anyone tempted to tidy the last `||` fallbacks away:
 * `hadoku_site/templates/*` MUST keep a fallback. Since 2026-09-01 it points at
 * `'"ubuntu-latest"'` rather than the claw labels — a scaffolded repo has no
 * runners either, so falling back to labels nothing carries aims its jobs at
 * nothing and QUEUES them silently (854 minutes, hadoku-games-host, 2026-08-23).
 * Hosted builds it, and the repo joins the fleet on its own once this module
 * writes the variable. The bare form is correct for a COVERED repo and fatal for
 * a template: its output is by definition not covered yet.
 * hadoku_site/scripts/test/template-runner-form.test.mjs enforces both halves.
 */
export const FLEET_VALUE = '["self-hosted","hadoku-builder"]';

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Repos to steer. Read fresh each call so a reconcile that adds a repo takes
 * effect without an mgmt-api restart.
 *
 * A missing or unparseable file yields the HUB REPO only, never an empty list
 * and never a throw: degrading to "steer the one repo we are certain about"
 * keeps a packaging mistake from silently turning the whole feature off, which
 * is the failure mode that would be invisible until the next outage.
 *
 * Which repo that is comes from `fleet-config`, not from here. The one repo this
 * degrades to is a fact about the ECOSYSTEM, and spelling it inline made the
 * degraded path steer a second operator's fleet at this operator's repo.
 */
export function coveredRepos(): string[] {
	try {
		const parsed = JSON.parse(readFileSync(COVERAGE_PATH(), 'utf8')) as { repos?: unknown };
		const repos = Array.isArray(parsed.repos)
			? parsed.repos.filter((r): r is string => typeof r === 'string' && r.includes('/'))
			: [];
		if (repos.length) return repos;
		logger.warn(
			`[ci-runner-fallback] ${COVERAGE_PATH()} has no repos — falling back to ${hubRepoFull()}`
		);
	} catch (err) {
		logger.warn(
			`[ci-runner-fallback] cannot read ${COVERAGE_PATH()} ` +
				`(${err instanceof Error ? err.message : String(err)}) — falling back to ${hubRepoFull()}`
		);
	}
	return [hubRepoFull()];
}

async function ghVar(
	method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
	path: string,
	token: string,
	body?: unknown,
	ifNoneMatch?: string
): Promise<{ ok: boolean; status: number; body?: unknown; etag?: string | null }> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			// Names the PACKAGE, not whichever service embeds it — see
			// fleet-config#userAgent. It said `hadoku-mgmt-api` until 2026-09-15,
			// which stops being true the moment anybody else installs this.
			'User-Agent': userAgent('ci-runner-fallback'),
		};
		if (body !== undefined) headers['Content-Type'] = 'application/json';
		if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch;
		const resp = await fetch(`https://api.github.com${path}`, {
			method,
			headers,
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: controller.signal,
		});
		clearTimeout(timeoutId);
		recordGhResponse(token, resp.status, resp.headers);
		// GET carries the value the caller needs to decide whether a write is a
		// CHANGE. The other verbs return nothing worth reading.
		if (method === 'GET' && resp.ok) {
			const parsed: unknown = await resp.json().catch(() => undefined);
			// Optional: a test double may carry no headers at all.
			return {
				ok: true,
				status: resp.status,
				body: parsed,
				etag: resp.headers?.get('etag') ?? null,
			};
		}
		return { ok: resp.ok, status: resp.status };
	} catch (err) {
		clearTimeout(timeoutId);
		logger.warn(
			`[ci-runner-fallback] ${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`
		);
		return { ok: false, status: 0 };
	}
}

/** PATCH first, POST on 404 — the variable usually already exists after the first outage. */
/**
 * Read the variable's CURRENT value. `null` when it is unset.
 *
 * The write path needs this to report `changed` honestly. It used to infer that
 * from whether a DELETE removed anything — also an observed fact. The one thing
 * it must never come from is `alreadyHosted`, which is EMPTY on a fresh process
 * and would report "nothing changed" on precisely the restart pass where the
 * whole fleet is being brought back off hosted.
 */
async function readVar(repo: string, token: string): Promise<string | null> {
	hydrateVarCache();
	const key = `${ghTokenFingerprint(token)}\n${repo}`;
	const cached = varCache.get(key);
	const res = await ghVar(
		'GET',
		`/repos/${repo}/actions/variables/${CI_RUNNER_VAR}`,
		token,
		undefined,
		cached?.etag
	);
	// A 304 IS an observation: GitHub says the value we hold is the value now.
	if (res.status === 304 && cached) return cached.value;
	if (!res.ok) {
		// Unset (404) or unreadable: either way the held value is not current.
		if (cached) {
			varCache.delete(key);
			varDisk.remove(key);
		}
		return null;
	}
	const raw = (res.body as { value?: unknown } | undefined)?.value;
	const value = typeof raw === 'string' ? raw : null;
	if (res.etag && value !== null) {
		varCache.set(key, { etag: res.etag, value });
		varDisk.save(key, res.etag, value);
	}
	return value;
}

/**
 * The variable's ETag and value per (token, repo), persisted (2026-10-25).
 *
 * `readVar` runs for every repo this PROCESS has not yet written — so the whole
 * roster on the first pass after each restart, 32 charged calls in the window
 * holding the 04:52Z boot on 2026-10-25, a morning of 12 boots. Sent
 * conditionally, an unchanged variable answers 304 for free, and the rule this
 * file states about `had` holds: a 304 is GitHub's answer about the value NOW,
 * observed, not cached. Why a restored pair is safe: conditional-cache-store.ts.
 */
const varCache = new Map<string, { etag: string; value: string }>();
const varDisk = conditionalCacheStore('ci-runner-var', { maxBytes: 1024 * 1024 });
let varCacheHydrated = false;

function hydrateVarCache(): void {
	if (varCacheHydrated) return;
	varCacheHydrated = true;
	for (const e of varDisk.load()) varCache.set(e.key, { etag: e.etag, value: e.text });
}

async function setVar(repo: string, token: string, value: string): Promise<boolean> {
	const patch = await ghVar('PATCH', `/repos/${repo}/actions/variables/${CI_RUNNER_VAR}`, token, {
		name: CI_RUNNER_VAR,
		value,
	});
	if (patch.ok) return true;
	if (patch.status !== 404) {
		logger.warn(`[ci-runner-fallback] PATCH ${repo} → HTTP ${patch.status}`);
		return false;
	}
	const post = await ghVar('POST', `/repos/${repo}/actions/variables`, token, {
		name: CI_RUNNER_VAR,
		value,
	});
	if (!post.ok) logger.warn(`[ci-runner-fallback] POST ${repo} → HTTP ${post.status}`);
	return post.ok;
}

export interface FallbackResult {
	/**
	 * `unmeasured` is a THIRD state, not a flavour of `fleet`.
	 *
	 * It means no write was attempted because capacity was unknown this tick —
	 * distinct from `fleet`, which is a decision that every repo should be on the
	 * claws and that the writes to get there have run. Collapsing them would make
	 * a held tick indistinguishable from a converged one in the digest.
	 */
	desired: 'hosted' | 'fleet' | 'unmeasured';
	changed: string[];
	failed: string[];
}

/**
 * The repos whose variable this PROCESS has observed and written, and which the
 * cache below may therefore skip. Everything else writes through: read the
 * variable, set it if it differs.
 *
 * PER REPO, NOT PER PROCESS. Until 2026-10-10 this was one flag, `convergedOnce`,
 * set by the first pass. That was right about what it guarded and wrong about
 * its scope. What it guarded: after a restart `alreadyHosted` is an empty set
 * that means "I have no idea", NOT "nothing is hosted", and those are opposite
 * instructions in the fleet direction. Missing that stranded all 20 repos on
 * billed runners on 2026-08-17, because the skip read the empty cache as "nothing
 * to clear" and the DELETE never fired.
 *
 * Its scope was wrong because `coveredRepos()` is read fresh every tick, so the
 * roster grows while the process runs, and a repo that joins after the first
 * pass is in neither cache state either. The flag said "trust the cache" for it
 * anyway, the fleet-direction skip read "not hosted" as "already on the fleet",
 * and the repo was skipped on every tick until the next mgmt-api restart.
 * hadoku-bomberman joined at 14:07 UTC on 2026-10-10 (restart 12:03) and still had
 * no CI_RUNNER at 18:00, so its CI ran on billed runners via the template
 * fallback (#107).
 *
 * A failed write REMOVES the repo, which is the same fact a third time: a repo
 * whose last write failed is in neither state, whatever the cache says. That
 * needed its own `writeFailed` set while the trust was process-wide. Without it,
 * a failed write in the fleet direction was never retried for the life of the
 * process.
 */
const converged = new Set<string>();

/** Test seam — a fresh process is the precondition this set models. */
export function __resetFallbackConvergenceForTesting(): void {
	converged.clear();
	varCache.clear();
	varDisk.clear();
	varCacheHydrated = true;
}

/** A restart: the process forgets, the disk does not. Test seam. */
export function __restartFallbackForTesting(): void {
	converged.clear();
	varCache.clear();
	varCacheHydrated = false;
}

/**
 * Converge every covered repo's CI_RUNNER on the current claw state.
 *
 * Idempotent: the steady state is a no-op DELETE (404) or a PATCH writing the
 * value already there, so this is safe to call on every 10-minute tick. It
 * reports only what CHANGED so the caller can alert on a transition rather than
 * on a condition.
 *
 * The repos are read (and, on a difference, written) `VAR_SYNC_CONCURRENCY` at
 * a time. One read per repo per tick, one after another, was ~10s of EVERY
 * runner-health tick — and the whole of what was left of the first tick after
 * a restart once the runs sweep and the backstop converge were fanned out
 * (12.4s measured on 0.21.3, 2026-09-01). Nothing here is shared between repos
 * except the two result lists and the per-repo sets, all keyed by repo; the
 * lists are sorted so the alert text does not depend on which read answered
 * first.
 */
export const VAR_SYNC_CONCURRENCY = 6;

export async function syncHostedFallback(
	/**
	 * Self-hosted capacity, or `null` for "I could not measure it this tick".
	 *
	 * NULLABLE ON PURPOSE. `0` and "unknown" are opposite instructions here and
	 * the type is what keeps them apart — a caller cannot pass its unmeasured
	 * zero through without saying so.
	 */
	clawsOnline: number | null,
	token: string,
	opts: { alreadyHosted?: Set<string> } = {}
): Promise<FallbackResult> {
	// HELD, BEFORE ANYTHING ELSE. Under all-JIT every claw's capacity comes from
	// the fast loop's probe, which is null until its first pass ~60s after boot,
	// so runner-health's first tick after a restart reads zero claws on a fleet
	// that is entirely healthy. Observed 2026-09-07 on three consecutive deploys:
	// claws_online read 1, then 10, then 0, then 3, against a steady 6 between
	// restarts — while `runners_checked=true` claimed the read had succeeded.
	//
	// `desired` below is `clawsOnline === 0 ? 'hosted' : 'fleet'` with no
	// debounce, so ONE such tick is enough to write `ubuntu-latest` to every
	// covered repo. 12 of them are private, where that is billed minutes, and a
	// hosted runner cannot reach the vault. It has not fired only because
	// `backstopOnline` happened to still count hokon — an incidental save from a
	// term this file's own docblock describes as a hazard in the other direction.
	//
	// Holding is conservative in BOTH directions, exactly as the backstop argues
	// for the same input: a fleet already on hosted stays there, and one on the
	// claws is not moved off them on evidence we do not have. A genuine outage is
	// delayed by one tick and still surfaces, because the next tick has the probe.
	//
	// BEFORE anything is marked `converged`. A tick that wrote nothing has
	// converged nothing, and marking it would let the NEXT tick trust an empty
	// `alreadyHosted`, which is the 2026-08-17 bug described above, reached by a
	// new road.
	if (clawsOnline === null) return { desired: 'unmeasured', changed: [], failed: [] };
	const desired: 'hosted' | 'fleet' = clawsOnline === 0 ? 'hosted' : 'fleet';
	const repos = coveredRepos();
	const changed: string[] = [];
	const failed: string[] = [];
	const converge = async (repo: string): Promise<void> => {
		const wasHosted = opts.alreadyHosted?.has(repo) ?? false;
		// Only a repo this process has itself written may be skipped: not on the
		// first pass, not one that joined the roster since, not one whose last
		// write failed.
		const trusted = converged.has(repo);
		if (trusted && desired === 'hosted' && wasHosted) return;
		if (trusted && desired === 'fleet' && !wasHosted && opts.alreadyHosted) return;

		// BOTH branches WRITE. The fleet branch used to DELETE the variable, which
		// is what forced every workflow to carry its own `|| '[...]'` fallback.
		const want = desired === 'hosted' ? HOSTED_VALUE : FLEET_VALUE;
		// OBSERVED, not cached — `alreadyHosted` is EMPTY on a fresh process and
		// would report "nothing changed" on exactly the restart pass that brings
		// the whole fleet back off hosted.
		const had = await readVar(repo, token);
		if (had !== want && !(await setVar(repo, token, want))) {
			failed.push(repo);
			converged.delete(repo);
			return;
		}
		converged.add(repo);

		// `changed` means CROSSED BETWEEN hosted and fleet — it drives the
		// outage/recovery alert. Writing a variable that was merely ABSENT is
		// seeding, not a transition: counting it would have announced a
		// fleet-wide recovery for all 27 repos on the first pass after this
		// shipped, for an outage that never happened.
		const hadHosted = had === HOSTED_VALUE;
		if (desired === 'hosted' ? !hadHosted : hadHosted) changed.push(repo);
		if (desired === 'hosted') opts.alreadyHosted?.add(repo);
		else opts.alreadyHosted?.delete(repo);
	};
	await mapConcurrent(repos, VAR_SYNC_CONCURRENCY, converge);
	changed.sort();
	failed.sort();

	return { desired, changed, failed };
}
