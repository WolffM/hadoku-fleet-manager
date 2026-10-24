/**
 * demand-derive — the pure half of the P2.2 demand ledger.
 *
 * Split out for the same reason `job-metrics.mjs` split its join from
 * `collect-job-metrics.mjs`'s ssh orchestration: "so the join and the
 * summaries can be asserted without a fleet or an ssh connection." Every
 * function here is text in, data out — no fs, no network, no manifest.
 *
 * `check-tool-inventory.mjs` calls these against each job's (comment-stripped)
 * text once it has split a workflow into its jobs with {@link splitJobs}.
 * `reconcile-fleet-runners.mjs` calls {@link deriveJobReserves} against
 * job-metrics rows it has already read, so the memory half is rows in, data
 * out, on the same terms.
 */
import { mb, percentile } from './job-metrics.mjs';
import { normalizeEol } from './yaml-comments.mjs';

/** A tool named here is supplied by the runner image when runs-on is hosted. */
export const HOSTED_RE = /ubuntu-latest|ubuntu-\d|windows-|macos-/;

/**
 * Split a workflow's (comment-stripped) body into its jobs.
 *
 * THE UNIT IS THE JOB (P2.2), not the whole file — `check-tool-inventory.mjs`'s
 * missing-tool scan treats a file as one bag of text, which is right for "does
 * this file invoke a missing tool" and wrong for a demand ledger.
 *
 * A GITHUB ACTIONS JOB ID IS 2-SPACE INDENTED under a top-level `jobs:` key —
 * verified against every workflow every repo the gate reaches carries
 * (2026-09-07): none uses a different job indent. A workflow that broke the
 * convention would report ZERO jobs for ITSELF, which the caller surfaces the
 * same way the missing-tool scan surfaces zero files examined — as a finding,
 * never a silent skip. See `demand-derive.test.mjs` "zero jobs" for the case.
 */
export function splitJobs(text) {
	// Normalised here as well as in stripYamlComments: check-tool-inventory
	// splits RAW text, which never passes through it.
	const lines = normalizeEol(text).split('\n');
	const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
	if (jobsAt === -1) return [];
	const jobs = [];
	let current = null;
	for (let i = jobsAt + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line && !/^\s/.test(line)) break; // back to column 0: the jobs: block ended
		const m = /^ {2}([A-Za-z0-9_.-]+):(.*)$/.exec(line);
		if (m) {
			if (current) jobs.push(current);
			current = { id: m[1], lines: [] };
			continue;
		}
		if (current) current.lines.push(line);
	}
	if (current) jobs.push(current);
	return jobs.map((j) => ({ id: j.id, text: j.lines.join('\n') }));
}

/**
 * GitHub's JOB NAME for a job, which is the key job history is written on.
 *
 * THE LEDGER WAS KEYED ON THE WRONG THING (settled 2026-09-10). `splitJobs`
 * returns the workflow's job ID — `analyze`, `guard`, `detect-changes` — and
 * `JobRecord.name` in `job-history.jsonl` is what GitHub displays, which is the
 * job's `name:` when it has one and the id when it does not. So the two
 * ledgers could not be joined on 30 of 147 `(repo, job)` rows (measured
 * 2026-09-10 against the live files), and three of the joins that DID succeed
 * were wrong: `hadoku-pygmalion` has two jobs whose id is `build`, one of them
 * named `frontend-build`, and the ledger keyed both on `build`.
 *
 * A JOB-LEVEL `name:` IS 4-SPACE INDENTED — the job id is 2-space indented
 * under `jobs:` (see {@link splitJobs}), so its own keys sit one level in.
 * Matching any `name:` would pick up `steps[].name`, which is 8-space and
 * `- `-prefixed, and `strategy.matrix` entries below it.
 *
 * AN EXPRESSION IS NEVER GUESSED. `name: Deploy ${{ matrix.worker }}` resolves
 * only at run time — it produced the 15 `Deploy <worker> / Deploy <worker>`
 * names in job history, and the reusable-workflow call doubles it. Those rows
 * carry `jobName: null` and `unjoinable: "<reason>"`, because a ledger that
 * invented a name would join a resource measurement onto the wrong job, which
 * is worse than not joining at all.
 *
 * THE CALLER MUST NOT HAVE STRIPPED `name:` LINES. `check-tool-inventory.mjs`
 * drops them before the tool scan (a step called "Trigger the pm2 redeploy" is
 * not a pm2 invocation) and therefore splits the jobs a SECOND time off
 * comment-stripped-only text for this.
 */
export function deriveJobName(jobId, jobText) {
	const m = /^ {4}name:[ \t]*(.*)$/m.exec(jobText);
	// No `name:` at all: GitHub displays the job ID, so the id IS the name and
	// the row is joinable.
	if (!m) return { jobName: jobId, jobNameSource: 'job-id', unjoinable: null };
	const raw = m[1].trim();
	if (!raw) return { jobName: jobId, jobNameSource: 'job-id', unjoinable: null };
	// YAML quoting is optional and this fleet's workflows use both forms.
	const quoted = /^(['"])([\s\S]*)\1$/.exec(raw);
	const value = quoted ? quoted[2] : raw;
	if (/\$\{\{/.test(value)) {
		return {
			jobName: null,
			jobNameSource: 'expression',
			unjoinable:
				`the job's \`name:\` is \`${value}\`, an expression GitHub resolves at run time — ` +
				`the displayed job name (and therefore job-history's key) cannot be derived from ` +
				`the workflow text`,
		};
	}
	return { jobName: value, jobNameSource: 'literal', unjoinable: null };
}

/**
 * Rewrite the demand ledger's CI rows WITHOUT destroying anybody else's.
 *
 * `check-tool-inventory.mjs --write` used one `writeFileSync` of its own rows,
 * which was correct while it was the file's only writer and became a data-loss
 * bug the moment resident demand joined the same ledger
 * (`service-ledger-2026-09-10.md` §3 names it "the one real bug" of the five
 * readers). Every row of another class is rewritten VERBATIM and FIRST, in its
 * original order, so a `--write` is a replacement of the CI population only.
 *
 * A ROW WITH NO `class` IS A LEGACY CI ROW, and is replaced rather than kept:
 * this script was the ledger's only writer until 2026-09-10, so an unlabelled
 * row is one of its own earlier outputs, and preserving it would duplicate
 * every `(repo, job)` on the first run and grow the file without bound.
 *
 * AN UNPARSEABLE LINE THROWS. Truncating the file is the one outcome worse than
 * failing here — it would delete measurements taken from the kernel on another
 * box, and `parseDemandLedger` already holds exactly this line for a reader.
 */
export function mergeDemandLedger(existingText, ciRows) {
	const kept = [];
	const lines = (existingText ?? '').split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue;
		let row;
		try {
			row = JSON.parse(line);
		} catch (err) {
			throw new Error(
				`demand-ledger line ${i + 1} is not JSON (${err.message}); refusing to rewrite the ` +
					`file, because truncating it would discard rows this script did not write`
			);
		}
		if (row?.class === undefined || row.class === 'ci') continue;
		kept.push(line);
	}
	const out = [...kept, ...ciRows.map((r) => JSON.stringify(r))];
	return {
		text: out.length ? `${out.join('\n')}\n` : '',
		preserved: kept.length,
		written: ciRows.length,
	};
}

/**
 * Which identity capability a job's actual content asks for.
 *
 * DERIVED, NEVER DECLARED — `bootcamp-earned-labels-2026-09-02.md` §4: "a repo
 * declares needs by derivation, not by hand... deriving avoids a second
 * declaration that can drift from the workflows." The same four signals that
 * doc names, read off the JOB rather than counted by hand across the file.
 */
export function deriveCapabilities(jobText) {
	const caps = [];
	if (/uses:\s*actions\/setup-python/.test(jobText)) caps.push('python-toolcache');
	if (
		/uses:\s*\S*playwright\S*/i.test(jobText) ||
		// Any invocation, not just `npx playwright` — hadoku_site's e2e-canary.yml
		// carries NO `playwright install` step deliberately and calls it as
		// `pnpm exec playwright test`, which a narrower `npx playwright`-only check
		// missed entirely (measured 2026-09-07: the derivation reported 0 repos
		// needing playwright on the general pool while hadoku_site plainly does).
		/(^|[\s;&|("'`])playwright[\s]/m.test(jobText)
	)
		caps.push('playwright');
	if (/(^|[\s;&|("'`])ffmpeg[\s]/m.test(jobText)) caps.push('ffmpeg');
	if (/uses:\s*docker\//.test(jobText) || /(^|[\s;&|("'`])docker[\s]/m.test(jobText))
		caps.push('docker');
	// `jdk21` — NOT `jdk`. the earned capability is registered as `jdk21`
	// (the fleet installs one specific major), and demand ids are compared
	// against registered capability ids by STRING — `check-label-floor` and
	// this script's own pinned-demand report both do. A generic `jdk` would
	// never match it, so the gap could never close and label-floor would carry
	// an unregistered required id forever.
	if (
		// `actions/setup-java` NEGATES the whole capability for this job — it is
		// NOT a signal for it (manager decision, 2026-10-05, overriding the
		// brief's literal text). setup-java downloads its own Temurin and that
		// works on trixie (unlike setup-python, the only reason python-toolcache
		// exists at all), so a job using it asks the NODE for nothing: any
		// `java`/`gradle`/`mvn` it also runs resolves against the ACTION's JDK,
		// never the node's. `hadoku-task-mobile`'s Android build job is on the
		// GENERAL POOL and uses setup-java + gradle — counting that as demand
		// would put a jdk21 into hadoku-builder's REQUIRED set from this one job
		// alone, and redden `ci:label-floor` fleet-wide demanding a JDK no claw
		// needs to carry.
		!/uses:\s*actions\/setup-java/i.test(jobText) &&
		// `java`, `javac`, `mvn`, `gradle` as COMMANDS — word-boundary, same
		// shape as ffmpeg/docker above, so "javascript" (no whitespace after
		// "java") does not match: the engine tries the "java" branch, its
		// required trailing `[\s]` fails against "script", and it backtracks
		// to try "javac" etc. at the same position rather than accepting the
		// "java" prefix of a longer word.
		(/(^|[\s;&|("'`])(java|javac|mvn|gradle)[\s]/m.test(jobText) ||
			// `JAVA_HOME` referenced (set or read) anywhere in the job.
			/\bJAVA_HOME\b/.test(jobText) ||
			// THE INDIRECT CASE (cardtable#5): the job never invokes `java` itself —
			// a server process it starts spawns java from an env var whose VALUE is
			// a `.jar` path (`CARDTABLE_FORGE_JAR: .../forge.jar`). The signal is the
			// VALUE ending in `.jar`, never the variable's name, which is one repo's
			// choice and not a vocabulary this function can enumerate.
			/\.jar(?=["'\s]|$)/m.test(jobText))
	)
		caps.push('jdk21');
	return caps;
}

/**
 * Every `uses:` action the job invokes, deduped, `@version` kept — the version
 * is part of what changed the last time one of these broke a fleet node
 * (`actions/setup-python@v6`, not just `actions/setup-python`).
 */
export function deriveSetupActions(jobText) {
	const out = new Set();
	for (const m of jobText.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) out.add(m[1]);
	return [...out].sort();
}

/**
 * Which capabilities a PREVIOUS run's persisted snapshot named that this run's
 * freshly observed demand no longer backs (P3.4 item 3).
 *
 * Deliberately a pure comparison: `check-tool-inventory.mjs` decides whether
 * the current snapshot is trustworthy enough to compare at all (a covered repo
 * this run could not check out must never read as "no longer needs it" — the
 * same "I could not look" ≠ "nothing is wrong" trap CLAUDE.md names, here
 * applied to a capability's demand instead of a node's health) and whether to
 * persist the result; this function only says which entries dropped to zero.
 *
 * `previous` is `{ [capability]: repoName[] }`, as persisted to disk — never
 * empty arrays (nothing writes a key it found no repo for), but tolerated
 * defensively since the file is hand-readable operator state. `current` is a
 * `Map<capability, Set<repoName>>` built fresh this run.
 */
export function capabilityRetirements(previous, current) {
	const findings = [];
	for (const [cap, repos] of Object.entries(previous ?? {})) {
		if (!Array.isArray(repos) || repos.length === 0) continue;
		const now = current.get(cap);
		if (now && now.size > 0) continue;
		findings.push(
			`capability '${cap}' is no longer needed by any covered repo (last: ${repos.join(', ')}) — retired`
		);
	}
	return findings;
}

/**
 * The labels a job's `runs-on` resolves to — same classification
 * `check-tool-inventory.mjs`'s missing-tool scan uses, read per JOB instead
 * of per file.
 */
export function deriveLabels(jobText) {
	const runsOn = [...jobText.matchAll(/runs-on:\s*(.+)/g)].map((m) => m[1]).join(' ');
	const fleetForm = /vars\.CI_RUNNER/.test(runsOn);
	const selfHosted = /self-hosted/.test(runsOn) || fleetForm;
	const hosted = HOSTED_RE.test(runsOn) && !selfHosted;
	// A LITERAL LABEL LIST is `[self-hosted, pm2-host]` or
	// `["self-hosted", "hadoku-builder"]` — quotes are optional YAML, and this
	// fleet's own workflows use the bare form (`redeploy-service.yml`,
	// `cron-schedules-sync.yml`). Matching quoted strings only silently
	// reported `[]` for every `pm2-host` job (measured 2026-09-07). The fleet
	// form (`fromJSON(vars.CI_RUNNER)`) resolves to a label array at RUN time,
	// not something this static scan can see, so it has no literal list here.
	const bracket = /\[([^\]]*)\]/.exec(runsOn);
	const explicit = bracket
		? bracket[1]
				.split(',')
				.map((s) => s.trim().replace(/^["']|["']$/g, ''))
				.filter(Boolean)
		: [];
	return { runsOn: runsOn.trim(), fleetForm, selfHosted, hosted, explicit };
}

/**
 * A repo needs this many measured jobs in the window before its OWN p95 is
 * published; below it the repo carries the fleet-wide p95 and says so.
 *
 * Five is J's `--min-runs` (`workload-join-2026-09-15.md` §6: "a judgment
 * call... nothing was lowered to manufacture coverage"). A p95 over two rows is
 * the larger of two numbers, and publishing it as a repo's demand would let one
 * noisy job set that repo's admission reserve for a fortnight.
 */
export const RESERVE_MIN_RUNS = 5;

/**
 * How far the live figure may move from the committed one before
 * `--check-coverage` calls the roster stale.
 *
 * EVERY OTHER FACET IS A FUNCTION OF A COMMIT, and this one is a function of
 * the calendar. `wolffmConsumer` changes when a repo's package.json does, so an
 * exact comparison is right for it. A p95 over a 14-day window moves every time
 * a job finishes or one ages out, so an exact comparison would redden the
 * nightly `check:fleet-coverage` on every run and teach everyone to ignore the
 * one gate that says the roster is stale. The band is on the RESERVE, the only
 * number admission reads: a repo flipping from `fleet-p95` to `measured` inside
 * the band reserves the same memory either way.
 */
export const RESERVE_DRIFT_PCT = 25;

/**
 * `jobP95Mb` per covered repo, from job-metrics rows — DERIVED, never declared.
 *
 * THE AXIS IS THE REPO (Wave 3d J, `workload-join-2026-09-15.md` §5): the
 * same unit's peak spreads 35 % across nodes and 423 % across repos on one
 * node, so a per-node scalar spends its whole budget on the difference that is
 * not there. This is the p95 of each repo's per-JOB peak over every node it
 * ran on.
 *
 * `rows` MUST ALREADY BE PER-JOB — the output of `perJobCosts`. A standing or
 * warm unit's `memory.peak` is its high-water mark since start, which
 * `perJobCosts` nulls; a row with no numeric `peakBytes` is not a measurement
 * and is not counted, so a repo served only by warm listeners carries the
 * fleet figure rather than its listener's ceiling.
 *
 * THE WINDOW is `windowDays` back from `nowMs`, by the row's own `ts`. A row
 * whose `ts` does not parse cannot be placed in the window and is counted in
 * `undated` rather than silently kept or silently dropped.
 *
 * NOTHING MEASURED IS NOT A FLEET OF SMALL JOBS. With zero usable rows there is
 * no fleet p95 to fall back to, so this returns `byRepo: null` and a `reason`;
 * the caller must refuse to write a roster from it.
 *
 * A RESERVATION BUILT FROM CAPPED RUNS IS A LOWER BOUND, never the whole truth
 * (#76, CLAUDE.md). `rows` carries the same `limitBytes`/`oomKill` fields
 * `job-metrics.sh` has always written; {@link isClippedRow} reads them exactly
 * as the harvest's `clipped` mark does. When a repo's OWN rows include a
 * clipped one, its `byRepo` entry is raised to **at least** the highest capped
 * peak among them — reserving less than a ceiling the job is KNOWN to have hit
 * is not a floor, it is a guess wearing a measurement's clothes — and carries
 * `lowerBound: true` so `reconcile-fleet-runners.mjs` and admission can both
 * see it. This fires on EITHER basis: brave-quartet's 3 runs are all clipped
 * and all under `minRuns`, so its basis stays `fleet-p95` (3 runs is too few to
 * trust as its OWN percentile) while its `mb` is still raised past the fleet
 * figure to the floor its own capped runs proved. A repo whose clipped runs sit
 * below its own percentile (or the fleet one) still carries `lowerBound: true`
 * even though `mb` is unchanged — ONE capped sample taints trusting the
 * distribution as exact, the same reasoning `runner-mem-report.py`'s
 * `is_lower_bound` applies to a whole population from a single unmarked row.
 *
 * `fleetP95Mb` itself is NOT adjusted for clipping — it is the fallback answer
 * for repos with too little data of their own, read fresh every reconcile, and
 * narrowing its own population here is a bigger, riskier change than this
 * function's callers asked for. The per-repo floor above is the targeted fix:
 * it only raises a repo's OWN number, from its OWN clipped rows.
 *
 * "I COULD NOT LOOK" MUST NEVER READ AS "NEEDS THE DEFAULT" (#88). brave-quartet
 * ran 0 times in 14 days, so `own.length` fell under `minRuns` — and the OLD
 * code answered with `fleetP95Mb`, discarding the 6,313 MB floor #76 measured
 * from its own capped runs the moment the window rolled past them. A repo that
 * has gone quiet has not shrunk. So when a repo is under `minRuns` NOW,
 * `previousByRepo[repo]` (the committed roster's own entry for it — see
 * `reconcile-fleet-runners.mjs`) is consulted: if IT carries evidence of a real
 * measurement — `basis: 'measured'`, `basis: 'kept-last-measured'`, or
 * `lowerBound: true` (a capped run is a measurement, just an incomplete one) —
 * this repo's own last-measured figure is kept forward as `basis:
 * 'kept-last-measured'`, `measuredMb` carrying the ORIGINAL figure (never the
 * previous night's already-maxed `mb`, so repeated quiet nights cannot erode or
 * inflate it) and `measuredAt` carrying the date it was set, when known. A repo
 * `previousByRepo` says has NEVER had its own measurement (plain `fleet-p95`,
 * no `lowerBound`) still falls to `fleetP95Mb` — the fallback is for repos that
 * have genuinely never been measured, never for one the calendar caught quiet.
 *
 * NEVER LOWER THAN THE FLEET FIGURE, EITHER (blast radius note, wave 3x): a
 * kept reserve is `Math.max(measuredMb, fleetP95Mb)`, so this fix can only ever
 * raise a quiet repo's reserve relative to the old fleet-p95-only fallback,
 * never lower it below what that fallback would have given admission today.
 *
 * @param {Array<{repo?: string, ts?: string, peakBytes?: number|null, limitBytes?: number|null, oomKill?: number|null}>} rows
 * @param {{repos: string[], nowMs: number, windowDays: number, minRuns?: number, previousByRepo?: Record<string, {mb: number, basis: string, runs: number, lowerBound?: boolean, measuredAt?: string, measuredMb?: number}>}} opts
 */
export function deriveJobReserves(
	rows,
	{ repos, nowMs, windowDays, minRuns = RESERVE_MIN_RUNS, previousByRepo = {} }
) {
	const since = nowMs - windowDays * 24 * 60 * 60 * 1000;
	let undated = 0;
	const usable = [];
	for (const r of rows) {
		if (typeof r?.peakBytes !== 'number' || !Number.isFinite(r.peakBytes)) continue;
		const at = Date.parse(r.ts ?? '');
		if (!Number.isFinite(at)) {
			undated += 1;
			continue;
		}
		if (at < since) continue;
		usable.push({ repo: r.repo, mb: mb(r.peakBytes), clipped: isClippedRow(r) });
	}
	const fleetP95Mb = percentile(
		usable.map((r) => r.mb),
		0.95
	);
	const summary = { fleetP95Mb, fleetRuns: usable.length, undated, windowDays, minRuns };
	if (fleetP95Mb === null) {
		return {
			...summary,
			byRepo: null,
			reason:
				`no per-job peak in the last ${windowDays} days on any node read — ` +
				`there is no fleet p95 to fall back to, so no repo's reserve can be derived`,
		};
	}
	// Stamped on every entry this run actually establishes or reconfirms a
	// figure for (a true measurement, or a clipped floor-raise) — never on a
	// plain `fleet-p95` fallback, which proves nothing about this repo.
	const measuredAtToday = new Date(nowMs).toISOString().slice(0, 10);
	const byRepo = {};
	for (const repo of repos) {
		const own = usable.filter((r) => r.repo === repo);
		const ownMbs = own.map((r) => r.mb);
		const clippedMbs = own.filter((r) => r.clipped).map((r) => r.mb);
		let entry;
		if (own.length >= minRuns) {
			entry = {
				mb: percentile(ownMbs, 0.95),
				basis: 'measured',
				runs: own.length,
				measuredAt: measuredAtToday,
			};
		} else {
			const prev = previousByRepo[repo];
			const everMeasured =
				prev &&
				(prev.basis === 'measured' ||
					prev.basis === 'kept-last-measured' ||
					prev.lowerBound === true);
			if (everMeasured) {
				const measuredMb =
					prev.basis === 'kept-last-measured' ? (prev.measuredMb ?? prev.mb) : prev.mb;
				entry = {
					mb: Math.max(measuredMb, fleetP95Mb),
					basis: 'kept-last-measured',
					runs: own.length,
					measuredMb,
				};
				if (prev.measuredAt) entry.measuredAt = prev.measuredAt;
				if (prev.lowerBound) entry.lowerBound = true;
			} else {
				entry = { mb: fleetP95Mb, basis: 'fleet-p95', runs: own.length };
			}
		}
		if (clippedMbs.length) {
			const clippedMax = Math.max(...clippedMbs);
			entry.mb = Math.max(entry.mb, clippedMax);
			if (entry.measuredMb !== undefined) entry.measuredMb = Math.max(entry.measuredMb, clippedMax);
			entry.lowerBound = true;
			entry.measuredAt = measuredAtToday;
		}
		byRepo[repo] = entry;
	}
	return { ...summary, byRepo, reason: null };
}

/**
 * At or within this fraction of a unit's own ceiling, a peak is CAPPED rather
 * than measured — the same convention `runner-mem-report.py`'s `NEAR_CAP_FRACTION`
 * uses for the harvest's own samples (wave 3s, #44). Two DIFFERENT pipelines
 * measure the same jobs (that one polls; `job-metrics.sh` writes once at job
 * completion from the kernel's `memory.peak`/`memory.events`), so the constant
 * is a second copy of the same idea on purpose, not a drift risk — neither
 * reads the other's rows.
 */
export const NEAR_CAP_FRACTION = 0.98;

/**
 * Was this job-metrics row's `peakBytes` itself capped, so the true peak may
 * have been higher? (#76)
 *
 * TWO WAYS a row can be capped, same as the harvest's `clipped` mark:
 *
 *   - `oomKill`: the cgroup's `memory.events.oom_kill`, written by
 *     `job-metrics.sh` straight from the kernel. For a JIT row this is the
 *     counter for THIS job's own cgroup, born and destroyed with it — a
 *     cumulative counter on a transient unit is a per-job count. (A standing
 *     unit's `oomKill` is cumulative across many jobs and cannot be attributed
 *     to one without differencing `perJobCosts` does not do for it, so this
 *     only fires meaningfully on JIT rows; a non-zero value on a cumulative row
 *     still means SOME job on that unit was killed, which is the honest, if
 *     coarser, reading.)
 *   - `peakBytes` sitting at or within {@link NEAR_CAP_FRACTION} of the unit's
 *     own `limitBytes` (`memory.max`, also written by the same hook): the
 *     process may have been throttled or paused at the ceiling without an
 *     outright kill, which looks identical to "it fitted exactly" unless the
 *     ceiling itself is read alongside the peak.
 *
 * Either way `peakBytes` on this row is a FLOOR — brave-quartet's `wasm-size`
 * was measured this way three times running (#26, #76): one OOM-killed at
 * hokon's 4,096 MB, two pinned at claw-2's and claw-4's 6,313 MB slice
 * ceiling. None of the three is "the job needed exactly this much."
 */
export function isClippedRow(r) {
	if (typeof r?.peakBytes !== 'number' || !Number.isFinite(r.peakBytes)) return false;
	if (typeof r.oomKill === 'number' && r.oomKill > 0) return true;
	return (
		typeof r.limitBytes === 'number' &&
		r.limitBytes > 0 &&
		r.peakBytes >= r.limitBytes * NEAR_CAP_FRACTION
	);
}

/**
 * A repo under the min-runs floor (`basis` is `fleet-p95` or
 * `kept-last-measured`, never a true own percentile) has no measurement to
 * drift — #86 ask 3. Missing entirely counts the same way: nothing measured,
 * nothing to compare.
 */
function underMinFloor(entry) {
	return !entry || entry.basis !== 'measured';
}

/**
 * Where two `jobP95Mb` maps disagree by more than {@link RESERVE_DRIFT_PCT} —
 * ADVISORY ONLY (#86): every line this returns is `jobP95Mb` drift, which a
 * daily `--write-coverage` regenerates on its own, never a reason to fail
 * `check:fleet-coverage`. The caller is the one who decides what a non-empty
 * result MEANS; this function only finds disagreement.
 *
 * `disk` and `live` are `{ [repo]: {mb, basis, runs} }`. A repo under the
 * min-runs floor on BOTH sides is skipped entirely — brave-quartet moving
 * `fleet-p95` (stale) -> `kept-last-measured` (today) is not drift, it is the
 * fix (#88) doing its job, and a 0-run repo's fallback basis moving is never
 * worth a line. A repo that is measured on at least one side still compares,
 * so a transition INTO or OUT OF real measurement is reported. `runs` and
 * `basis` are carried for the reader and never compared beyond that check —
 * see the band's own note for why the reserve is the only number that matters
 * once both sides are actually measured.
 */
export function reserveDrift(disk, live, { tolerancePct = RESERVE_DRIFT_PCT } = {}) {
	const out = [];
	const d = disk ?? {};
	const l = live ?? {};
	for (const repo of [...new Set([...Object.keys(d), ...Object.keys(l)])].sort()) {
		const a = d[repo];
		const b = l[repo];
		if (underMinFloor(a) && underMinFloor(b)) continue;
		if (!a) {
			out.push(`  + jobP95Mb for ${repo}: ${b.mb}MB (${b.basis}, ${b.runs} runs) — not on disk`);
			continue;
		}
		if (!b) {
			out.push(`  - jobP95Mb for ${repo}: ${a.mb}MB on disk, no longer derived`);
			continue;
		}
		const pct = a.mb > 0 ? (Math.abs(b.mb - a.mb) / a.mb) * 100 : Infinity;
		if (pct <= tolerancePct) continue;
		out.push(
			`  ~ ${repo}.jobP95Mb: ${a.mb}MB (${a.basis}) -> ${b.mb}MB (${b.basis}, ${b.runs} runs), ` +
				`${Number.isFinite(pct) ? Math.round(pct) : 'inf'}% > ${tolerancePct}%`
		);
	}
	return out;
}

/**
 * Refuse a generator's write when its result fell below half of what is
 * already on disk, unless the operator passed `--allow-shrink` (#84 part 2).
 *
 * "WROTE A DEGRADED FILE, THEN FAILED" MUST BE UNREACHABLE — this is a PURE
 * check the caller runs BEFORE writing anything, never after, so there is no
 * window where a degraded result reaches disk ahead of the refusal. A
 * `previousCount` of 0 (no baseline, or the generator's first run) never
 * refuses: there is nothing to have shrunk FROM, and refusing a first write
 * would make the generator permanently unable to produce its own baseline.
 *
 * @param {number} previousCount entries already committed (0 if none)
 * @param {number} nextCount entries this run computed, about to be written
 * @param {{allowShrink?: boolean}} [opts]
 * @returns {string|null} the refusal reason, or `null` to proceed
 */
export function shrinkRefusal(previousCount, nextCount, { allowShrink = false } = {}) {
	if (allowShrink || !previousCount) return null;
	if (nextCount >= previousCount / 2) return null;
	const pct = Math.round((nextCount / previousCount) * 100);
	return (
		`refusing to write: ${nextCount} of ${previousCount} previous entries (${pct}%) — ` +
		'below half. A shrink this large is more likely a broken read (an empty REPOS_DIR, ' +
		'an unreadable roster) than a real retirement, and "wrote a degraded file, then ' +
		'failed" must stay unreachable. Pass --allow-shrink if this is a deliberate shrink.'
	);
}
