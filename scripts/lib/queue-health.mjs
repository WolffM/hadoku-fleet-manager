/**
 * The queue-health verdict, as pure arithmetic over ages.
 *
 * Separated from `check-queue-health.mjs` so the decision can be asserted
 * without a GitHub token and without a fleet: the whole point of that gate is
 * that it stays honest during an outage, and a rule only exercised during one
 * is a rule nobody has tested.
 */

/**
 * Seconds a run may sit queued before the fleet is called broken.
 *
 * DERIVED, not chosen. The fleet's measured queue p95 is 161 s
 * (queue-discovery.ts), and the worst LEGITIMATE just-in-time serve is
 * MIN_QUEUED_MS 90 s + a 60 s fast-loop tick + a ~9 s mint, so about 160 s. 300 is a
 * little under twice that, and half `QUEUED_WARN_MINUTES` — so this reddens
 * about five minutes before the alerter pages, which is the gap the
 * 2026-09-01 retro asked for.
 */
export const FAIL_SECONDS = 300;

/**
 * Attempts per repo before a read is called a failure.
 *
 * ONE RETRY, because the failure this gate actually produces is a coin-flip, not
 * a fault. Measured 2026-09-07 over the previous day: five `could not read`
 * findings against ~3,900 calls — 27 repos every 10 minutes — about 0.13%, a
 * different repo each time, every one recovering on the next run untouched.
 *
 * The evidence that it is transient rather than a broken repo: all five repos
 * answer in ~0.45s against a 20s timeout, none is archived or renamed, 216
 * consecutive hand-run calls produced zero failures, and 80 latency probes over
 * the same path gave p50 0.344s / max 0.430s with no outliers.
 *
 * A single blip in one repo out of 27 was paging @here. Retried once, the same
 * rate becomes roughly one finding every 150 days.
 *
 * THIS DOES NOT SOFTEN THE RULE. A repo that fails every attempt is still
 * unreadable and still fails the gate. What changes is that we look twice before
 * saying so, and that we say WHY.
 */
export const READ_ATTEMPTS = 2;

/**
 * Why one read attempt failed, in a form an operator can act on.
 *
 * The caller was a bare `catch { return null }` until 2026-09-07, so a finding
 * could name the repo and nothing else. Reporting that we could not look is
 * necessary; reporting it undiagnosably is only half the rule — a rate limit, a
 * timeout and a deleted repo are three different jobs.
 *
 * Pure over an error-LIKE object so it can be asserted without spawning
 * anything: `execFileSync` sets `killed`/`signal` on a timeout and
 * `status`/`stderr` on a non-zero exit.
 */
export function describeReadFailure(err, timeoutMs) {
	if (err?.killed || err?.signal) {
		const secs = Number.isFinite(timeoutMs) ? `${timeoutMs / 1000}s` : 'the timeout';
		return `timed out after ${secs} (${err.signal ?? 'killed'})`;
	}
	const stderr = String(err?.stderr ?? '')
		.trim()
		.replace(/\s+/g, ' ')
		.slice(0, 200);
	const code = err?.status ?? '?';
	return stderr ? `exit ${code}: ${stderr}` : `exit ${code}: ${err?.message ?? 'unknown error'}`;
}

/**
 * Read one repo, retrying a transient failure.
 *
 * `readOnce` and `sleep` are injected so the retry can be exercised with no
 * network and no clock — the whole reason this file is separate from the gate.
 *
 * Returns `{ ok: true, created }` or `{ ok: false, reason }`. There is no third
 * answer: an empty queue is `ok` with an empty list, and that distinction is the
 * one this gate exists to keep.
 */
export function readQueuedWithRetry(
	repo,
	readOnce,
	{ attempts = READ_ATTEMPTS, sleep = () => {}, timeoutMs } = {}
) {
	let reason = 'no attempt was made';
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return { ok: true, created: readOnce(repo) };
		} catch (err) {
			// The LAST reason wins: it is the one that stood after the blip had a
			// moment to pass, which is the more informative of the two.
			reason = `${describeReadFailure(err, timeoutMs)} (attempt ${attempt}/${attempts})`;
			if (attempt < attempts) sleep();
		}
	}
	return { ok: false, reason };
}

/**
 * How old a stuck run must be before it stops counting as a fresh casualty.
 *
 * THE EXCLUSION HAD AN INVERSION IN IT. Excluding stuck runs from the p95 is
 * right — the two runs queued since 2026-08-17/19 (a deleted branch, a label
 * nothing carries) would pin this gate red forever, and a gate that is always
 * red is one nobody reads. But it made the gate PASS harder the worse the
 * outage got: a 20-minute stall reddens on p95, and an outage long enough to
 * push its casualties past the one-hour line moved them into the excluded
 * bucket and turned the gate green again.
 *
 * Measured 2026-09-07: the fleet served nothing from 01:56 to 04:08, sixteen
 * runs stacked up, and `ci:queue-health` reported `ok: true, queued: 0` for the
 * back half of it.
 *
 * The two cases ARE separable and the data to do it is already here. A zombie is
 * DAYS old and static; a freeze produces runs that crossed the line minutes ago
 * and keeps producing more. 24 h is far below the zombies (20 days when this was
 * written) and far above any real serve, so nothing legitimate lands in between.
 *
 * This does not delay the alarm — p95 still reddens at 300 s. What it fixes is
 * the gate going green again an hour later while the fleet is still down.
 */
export const ZOMBIE_SECONDS = 24 * 60 * 60;

/**
 * Is a queued run waiting because every runner that could take it is BUSY —
 * saturation, not a stall?
 *
 * WHY THIS EXISTS. cardtable's Forge jobs need `jdk21`, which three claws
 * carry, and a Forge job fills its node; with three e2e shards plus forge-jvm
 * per push and verify dispatches on top, a job routinely waits for a shard to
 * finish. On 2026-10-08 that paged @here three times in an hour and a half
 * (p95 497 s, 1609 s, 765 s) — every one a cardtable Forge job, every jdk21
 * claw busy RUNNING Forge. That is a capacity fact, not "the fleet is not
 * serving work", and since the heavy hold (#102) makes a Forge job wait for a
 * free node ON PURPOSE it would page on most pushes.
 *
 * READ FROM GITHUB, never the fleet: `runners` is the repo's own runner
 * listing, and `busy` is GitHub's word that it is running a job. The two
 * stall shapes both fail it — no online runner carrying the labels at all
 * (nothing minted, everything offline), or one sitting IDLE that GitHub is
 * not assigning (the black hole). Saturation needs at least one matching
 * runner and every matching one busy, for EVERY queued job of the run.
 *
 * NOT A WAY OUT OF THE GATE: a saturated run leaves the p95 only. Past the
 * stuck ceiling it is `stranded` like any other and fails — so busy runners
 * wedged on hung jobs still page, at an hour instead of five minutes.
 *
 * AN IDLE BACKSTOP IS A PROMOTION IN FLIGHT, NOT A BLACK HOLE (#115). When the
 * claws are saturated, runner-health promotes the backstop by WRITING the
 * builder label onto its registrations, and GitHub hands an already-queued job
 * to a runner whose labels changed after it queued only lazily. Measured from
 * hokon's own listener log: label refresh at 22:36:01, job offered at
 * 22:48:42 (2026-10-15); 4.7 and 11.5 minutes after the 02:46 promotions on
 * 10-14 and 10-15; 49 s once. Every nightly 02:50 page landed inside that
 * window — the jdk21 claws busy, hokon idle with every label, the job not yet
 * offered. So an idle match that is a BACKSTOP registration does not break
 * saturation, PROVIDED at least one claw matches and every matching claw is
 * busy. With no matching claw the run is not saturated however the backstop
 * looks, so an outage still fails at the 300 s floor; and a backstop that
 * never takes the job is `stranded` at the stuck ceiling like anything else.
 *
 * `queuedJobs`: `[{labels: string[]}]` — the run's jobs with status `queued`.
 * `runners`: `[{name, status, busy, labels: string[]}]`. No queued job (the run
 * is held by `needs:` or approval) is NOT saturation; nor is an unread input.
 * `isBackstop(name)`: whether a registration belongs to a backstop node;
 * omitted, nothing is.
 */
export function isSaturated(queuedJobs, runners, { isBackstop = () => false } = {}) {
	if (!Array.isArray(queuedJobs) || !Array.isArray(runners) || !queuedJobs.length) return false;
	const lower = (xs) => (xs ?? []).map((x) => String(x).toLowerCase());
	return queuedJobs.every((j) => {
		const want = lower(j.labels);
		const matching = runners.filter((r) => {
			if (r.status !== 'online') return false;
			const has = new Set(lower(r.labels));
			return want.every((l) => has.has(l));
		});
		const claws = matching.filter((r) => !isBackstop(r.name));
		return claws.length > 0 && claws.every((r) => r.busy === true);
	});
}

/**
 * How far into the future a `createdAt` may sit before it means the CLOCK is
 * wrong rather than the caller merely being slow.
 *
 * A queue age cannot be negative. Small negatives are a stale clock read — the
 * caller stamped `now` before a multi-second sweep — and clamping those is
 * right. A LARGE one is skew between this box and GitHub, and then every age
 * this gate produces is wrong by that amount, so it must be a finding rather
 * than a clamp: silently flooring it would make the gate under-report queue age
 * fleet-wide and pass an outage it should fail.
 */
export const CLOCK_SKEW_TOLERANCE_SEC = 60;

/**
 * Split queued work into WAITING and STUCK, and summarise the waiting half.
 *
 * `stuckMs` is the dispatcher's own one-hour boundary rather than a second
 * opinion. Two runs on this fleet have been queued since 2026-08-18 — a deleted
 * branch, a label nothing carries — and folding them into a percentile pins the
 * gate red forever. A gate that is always red is one nobody reads, which is how
 * an outage runs ten minutes with a green sweep on screen.
 *
 * `stuck` is kept whole — mgmt-api's queue-health-check reads it — and split
 * alongside into `stranded` (crossed the line recently: a finding) and `zombie`
 * (days old: reported, not failed). See ZOMBIE_SECONDS. A run flagged
 * `saturated` and still under the stuck ceiling goes to `saturated`, out of
 * the percentile — see isSaturated.
 *
 * TWO READS OF THE RUN'S JOBS CORRECT WHAT THE RUN LISTING SAYS, both measured
 * on 2026-10-11 against cardtable's Forge runs, and both only in the direction
 * the jobs read can PROVE (an unread run keeps its listing values):
 *
 *   - `started: true` — the run is still listed `queued` but no job of it is
 *     queued and at least one has started. The run status lags its jobs; at
 *     13:00:17Z and 21:30:11Z the sweep counted runs whose last job had started
 *     8 and 10 seconds earlier at their full ages (1392 s, 874 s) and paged.
 *     Nothing is waiting, so the run leaves the queue and is reported as such.
 *   - `queuedSince` — the earliest `created_at` of the run's queued jobs, and
 *     the age is measured from there. A run can sit in a concurrency group
 *     before GitHub creates its jobs; run 38131197998 was created 10:13:48 and
 *     its jobs 10:40:32, so a 40-minute wait for a runner read as 66 minutes
 *     and went STRANDED past the one-hour line. Nothing could have placed a job
 *     that did not exist yet.
 */
export function summariseQueue(
	runs,
	{ stuckMs, nowMs = Date.now(), zombieSeconds, skewSeconds } = {}
) {
	const zombieSec = zombieSeconds ?? ZOMBIE_SECONDS;
	const skewToleranceSec = skewSeconds ?? CLOCK_SKEW_TOLERANCE_SEC;
	const waiting = [];
	/** Runs whose createdAt is far enough ahead of `nowMs` to mean clock skew. */
	const skewed = [];
	const stuck = [];
	const stranded = [];
	const zombie = [];
	const unscheduled = [];
	/** Waiting on runners that are all busy — see {@link isSaturated}. */
	const saturated = [];
	/** Listed queued, but every job is past queued and one has started. */
	const started = [];
	for (const r of runs) {
		const since = Number.isFinite(Date.parse(r.queuedSince)) ? r.queuedSince : r.createdAt;
		const rawAgeSec = Math.round((nowMs - Date.parse(since)) / 1000);
		if (!Number.isFinite(rawAgeSec)) continue;
		// A RUN GITHUB NEVER EXPANDED INTO JOBS IS NOT FLEET WORK. The fleet can
		// only mint for a queued JOB; a run with zero jobs has nothing a runner
		// could take. Observed 2026-10-07: a scheduled hadoku_site run sat
		// `queued` with `total_count: 0` jobs, refused both cancel ("completed")
		// and force-cancel ("not queued yet"), and paged @here as "the fleet is
		// not serving work" at 905 s while a fresh dispatch of the same workflow
		// ran at once on warm-claw-1. Reported in its own list, never dropped;
		// runner-health pages the run itself as "GitHub has not scheduled it".
		// `jobless` is set ONLY when a jobs read answered zero. An unread count
		// stays undefined, and the run counts as fleet work: the strict direction.
		if (r.jobless === true) {
			unscheduled.push({ repo: r.repo, ageSec: Math.max(0, rawAgeSec) });
			continue;
		}
		if (r.started === true) {
			started.push({ repo: r.repo, ageSec: Math.max(0, rawAgeSec) });
			continue;
		}
		// A NEGATIVE AGE IS NOT A THING A QUEUE CAN HAVE, and it does not merely
		// look odd: it sorts to the front of the percentile array and drags p50
		// down, so the gate reports the queue HEALTHIER than it is. That is the one
		// direction an outage gate must never round. Observed 2026-09-07 as
		// `p50=-9s` beside `oldest=15s`.
		if (rawAgeSec < -skewToleranceSec) skewed.push({ repo: r.repo, aheadSec: -rawAgeSec });
		const ageSec = Math.max(0, rawAgeSec);
		if (ageSec * 1000 > stuckMs) {
			const entry = { repo: r.repo, ageSec };
			stuck.push(entry);
			(ageSec > zombieSec ? zombie : stranded).push(entry);
		} else if (r.saturated === true) {
			saturated.push({ repo: r.repo, ageSec });
		} else {
			waiting.push({ repo: r.repo, ageSec });
		}
	}
	stranded.sort((a, b) => b.ageSec - a.ageSec);
	zombie.sort((a, b) => b.ageSec - a.ageSec);
	waiting.sort((a, b) => b.ageSec - a.ageSec);
	unscheduled.sort((a, b) => b.ageSec - a.ageSec);
	saturated.sort((a, b) => b.ageSec - a.ageSec);
	started.sort((a, b) => b.ageSec - a.ageSec);
	const ages = waiting.map((w) => w.ageSec).sort((a, b) => a - b);
	const pct = (q) =>
		ages.length ? ages[Math.min(ages.length - 1, Math.floor(ages.length * q))] : 0;
	return {
		waiting,
		stuck,
		stranded,
		zombie,
		skewed,
		unscheduled,
		saturated,
		started,
		queued: waiting.length,
		p50: pct(0.5),
		p95: pct(0.95),
		oldest: ages.length ? ages[ages.length - 1] : 0,
	};
}

/**
 * The findings, from a summary and whatever could not be read.
 *
 * An unreadable repo is a FINDING, never an omission: a token that expired
 * mid-sweep would otherwise render as a fleet with nothing queued, which is the
 * exact shape of "I could not look" reported as "nothing is wrong".
 */
export function queueFindings(summary, unreadable = [], failSeconds = FAIL_SECONDS) {
	const findings = [];
	if (summary.p95 > failSeconds) {
		findings.push(
			`p95 queue age is ${summary.p95}s, over the ${failSeconds}s floor — the fleet is not serving work`
		);
	}
	// STRANDED IS A FINDING. Without this the gate got EASIER to pass the longer
	// the fleet stayed down: p95 reddens for the first hour, then each casualty
	// crosses the stuck line, leaves the percentile, and the gate goes green with
	// the outage still running. The age band is what tells these from the two
	// permanent zombies — see ZOMBIE_SECONDS.
	const stranded = summary.stranded ?? [];
	if (stranded.length) {
		findings.push(
			`${stranded.length} run(s) queued past the stuck ceiling but far too new to be zombies — ` +
				`the fleet stopped serving and these are the casualties: ` +
				stranded
					.slice(0, 5)
					.map((s) => `${s.repo} ${s.ageSec}s`)
					.join(', ')
		);
	}
	// SKEW IS A FINDING, NOT A CLAMP. The ages are floored at 0 so a stale clock
	// read cannot flatter the percentile, but a run genuinely MINUTES ahead of us
	// means this box and GitHub disagree about the time — and then every age here
	// is wrong by that amount, in the direction that hides a queue.
	const skewed = summary.skewed ?? [];
	if (skewed.length) {
		findings.push(
			`${skewed.length} run(s) created ahead of this box's clock by up to ` +
				`${Math.max(...skewed.map((r) => r.aheadSec))}s — every age this gate reports is ` +
				`understated by that much. Check the clock before trusting a green queue.`
		);
	}
	// THE REASON, not just the repo. This read `${unreadable.join(', ')}` until
	// 2026-09-07, so five findings in one day named a repo and nothing else — and
	// a rate limit, a 20s timeout and a deleted repo are three different jobs for
	// an operator who cannot tell them apart. Reporting that we could not look is
	// necessary; reporting it undiagnosably is only half the rule.
	//
	// Entries may be a plain repo name or `{repo, reason}`. Both are accepted so
	// this stays usable by any caller that has only the names.
	if (unreadable.length) {
		findings.push(
			`could not read the queue for ${unreadable.length} repo(s): ` +
				unreadable
					.slice(0, 5)
					.map((u) => (typeof u === 'string' ? u : `${u.repo} — ${u.reason}`))
					.join('; ')
		);
	}
	return findings;
}
