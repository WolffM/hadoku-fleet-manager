/**
 * HEAVY KINDS (#102) — derived, never declared, from REAL job history.
 *
 * Split out of `traffic.ts` (ci-scheduling) so an OBSERVATION reader can ask
 * the same question the warm cache asks: `scripts/check-warm-canary.mjs` must
 * not score a node "not warm" when the warm cache withheld its listener
 * because the node is running a heavy-kind job (#102.4). Pure, like
 * `speed-tier.ts` beside it: no fs, no network, no clock — the caller hands
 * in the job-history records it already read.
 */
import type { JobRecord } from '../job-history-store.js';
import { percentile } from '../job-history-stats.js';
import { jobKind } from '../lib/job-kind.js';

/**
 * A pure model of which (repo, job) KINDS run long enough that stacking them
 * on one node is what turned cardtable's first Forge night into four reruns
 * and three widened budgets (wave 4c, #102): three Forge jobs landed on
 * claw-9 at once and `forge-e2e` took 35 minutes instead of 16 alone.
 *
 * DERIVED, NEVER DECLARED — no label, no per-repo list (CLAUDE.md,
 * `docs/planning/wave4c-2026-10-07.md` "Settled"). A kind is heavy when its
 * MEASURED p75 runtime clears {@link HEAVY_P75_SEC}; see that constant's own
 * doc for the real table it was picked from.
 */
export interface HeavyModel {
	/**
	 * Is THIS (repo, job) kind heavy? Exact match when `jobName` is known —
	 * which it is for a QUEUED job since `dispatch-tick.ts`'s `pending.push`
	 * already carries `j.name` onto `PendingRun.jobName` (#89, landed before
	 * this wave). `jobName: undefined` falls back to {@link isHeavyRepo}: a
	 * caller that cannot name the job (see that method's own note) gets the
	 * coarser, conservative answer rather than a crash or a silent `false`.
	 */
	isHeavy(repo: string, jobName: string | undefined): boolean;
	/**
	 * Does this REPO run ANY heavy kind at all — the only answer available
	 * for a node's CURRENTLY RUNNING workers, whose job NAME the fleet probe
	 * cannot see without a new per-job read. `ephemeral-tick.ts`'s probe
	 * attributes a running `Runner.Worker` to a REPO only (`.runner`'s
	 * `gitHubUrl`, read off the process tree) and never to a job name —
	 * genuinely unavailable without new I/O (CLAUDE.md: "pick the most
	 * faithful approximation, documented"). This is that approximation, and
	 * it is deliberately CONSERVATIVE in one direction only: a light job from
	 * a repo that also runs heavy ones reads as "running heavy" here. The
	 * cost of that is a missed spreading opportunity — ranking a node
	 * slightly lower than it needed to be — never a wrong REFUSAL, because
	 * every place this feeds (`placement.ts`'s heavy-avoidance term,
	 * `ephemeral-tick.ts`'s warm-fill withholding) only ever REORDERS or
	 * WITHHOLDS a fill, never refuses a mint outright (#102.4: "a heavy job
	 * still places (never queue forever)").
	 */
	isHeavyRepo(repo: string): boolean;
}

/**
 * Samples a (repo, job) kind needs before its p75 says anything — the same
 * confidence bar `speed-tier.ts`'s `MIN_SAMPLES` uses and for the same
 * reason: an even count lets one outlier move a quantile outright, and below
 * this a kind is simply unproven — NOT heavy, the safe default, same as a
 * thin-history node reading `'unknown'` rather than `'slow'`.
 */
export const MIN_HEAVY_SAMPLES = 5;

/**
 * The p75 runtime (seconds) a (repo, job) kind must clear to be called heavy.
 *
 * RE-DERIVED 2026-10-07 from the real `~/.hadoku-mgmt/job-history.jsonl`
 * (6,799 records, the file's whole span: 2026-09-23 to 2026-10-07 — job-
 * history.ts's own 14-day retention already bounds the window, so this model
 * takes no separate one) through this module's own code path
 * (`percentile(samples, 75)`, `MIN_HEAVY_SAMPLES` = 5), sorted by p75:
 *
 *   hadoku_site          Static Analysis   n=12   p75=1713s
 *   hadoku-cardtable     forge-jvm         n=37   p75=1320s
 *   hadoku-cardtable     forge-e2e         n=111  p75= 575s
 *   hadoku-dataplatform  pytest            n=37   p75= 564s
 *   ------------------------------------------------------- 420s -----------
 *   hadoku-pygmalion     test              n=31   p75= 292s
 *   hadoku-cardtable     check             n=166  p75= 245s
 *   hadoku-scraper       check             n=29   p75= 232s
 *   hadoku_site          build             n=167  p75= 137s
 *
 * 420 sits in the gap between 292 and 564 — ~128s of margin on either side —
 * and isolates exactly the four kinds this wave's incident named: cardtable's
 * two Forge jobs, dataplatform's GPU-bound pytest, and hadoku_site's periodic
 * static-analysis sweep. Every other measured kind on the fleet, including
 * every OTHER cardtable job (`check`, `dispatch redeploy`, `changes`), sits
 * well below it.
 */
export const HEAVY_P75_SEC = 420;

/**
 * The share of a repo's jobs that must be heavy kinds before the REPO counts as
 * heavy — `isHeavyRepo`, the coarse answer used where a running job's name is
 * not visible (the warm tick's probe, `runningHeavy`).
 *
 * Measured 2026-10-09 over the job history: hadoku_site 12 of 4,030 (0.3%,
 * Static Analysis only), hadoku-dataplatform 35 of 252 (14%, pytest),
 * hadoku-cardtable 461 of 1,549 (30%, forge-e2e/forge-jvm). Without a share,
 * one rare nightly kind made every hadoku_site build "running heavy", so a
 * hadoku_site build on claw-1 evicted claw-1's own hadoku_site warm listener —
 * claw-1, which never runs a heavy job. 10% sits in the gap between 0.3% and
 * 14%. The EXACT per-job answer (`isHeavy` with a job name) is unaffected.
 */
export const HEAVY_REPO_MIN_SHARE = 0.1;

/** `repo` and `name` joined with a separator neither ever contains — the same
 *  trick `speed-tier.ts`'s `kindKey` uses, kept as a private duplicate rather
 *  than imported: that file is unowned this wave (CLAUDE.md "owned by nobody"),
 *  and this model must not depend on an unowned file's internals to stay
 *  correct. */
function heavyKindKey(repo: string, name: string): string {
	return `${repo}\u0000${jobKind(name)}`;
}

/**
 * Build the heavy-kind model from job history — pure, like `buildSpeedModel`:
 * no fs, no network, no clock. The caller (`ephemeral-tick.ts`) is the one
 * reader of `~/.hadoku-mgmt/job-history.jsonl`; this takes the records it
 * already loaded, the same "no second reader" rule `speed-tier.ts` follows.
 */
export function buildHeavyModel(records: readonly JobRecord[]): HeavyModel {
	const samplesByKind = new Map<string, number[]>();
	const jobsByRepo = new Map<string, number>();
	for (const r of records) {
		// Same usability bar as `speed-tier.ts`'s `isUsable`, restated here rather
		// than imported for the same unowned-file reason as `heavyKindKey` above:
		// a failed job's duration is how far it got before failing, not its
		// normal runtime, and a probe sample (`shadow`/`forced-rerun`) is a
		// synthetic placement test, not organic traffic.
		if (r.conclusion !== 'success') continue;
		if (typeof r.runSec !== 'number' || !Number.isFinite(r.runSec)) continue;
		if (r.probe) continue;
		jobsByRepo.set(r.repo, (jobsByRepo.get(r.repo) ?? 0) + 1);
		const kk = heavyKindKey(r.repo, r.name);
		const arr = samplesByKind.get(kk);
		if (arr) arr.push(r.runSec);
		else samplesByKind.set(kk, [r.runSec]);
	}

	const heavyKinds = new Set<string>();
	const heavyJobsByRepo = new Map<string, number>();
	for (const [kk, samples] of samplesByKind) {
		if (samples.length < MIN_HEAVY_SAMPLES) continue;
		const p75 = percentile(samples, 75);
		if (p75 !== null && p75 >= HEAVY_P75_SEC) {
			heavyKinds.add(kk);
			// The repo half of the key, up to the NUL separator — never a second
			// split of `r.repo` itself, which may contain no NUL by construction
			// (a GitHub repo slug cannot).
			const repo = kk.slice(0, kk.indexOf('\u0000'));
			heavyJobsByRepo.set(repo, (heavyJobsByRepo.get(repo) ?? 0) + samples.length);
		}
	}
	const heavyRepos = new Set(
		[...heavyJobsByRepo]
			.filter(([repo, n]) => n / (jobsByRepo.get(repo) ?? n) >= HEAVY_REPO_MIN_SHARE)
			.map(([repo]) => repo)
	);

	return {
		isHeavy(repo, jobName) {
			if (jobName === undefined) return heavyRepos.has(repo);
			// EXACT KIND KNOWN: trust it either way, never fall back to the
			// coarser repo-level answer once the precise one is in hand — a light
			// job from a heavy repo must not read as heavy just because its
			// sibling kind is.
			return heavyKinds.has(heavyKindKey(repo, jobName));
		},
		isHeavyRepo(repo) {
			return heavyRepos.has(repo);
		},
	};
}
