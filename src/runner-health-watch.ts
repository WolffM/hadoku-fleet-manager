import {
	checkSupervision,
	describeProblem,
	logReport,
	type SupervisionReport,
} from './runner-supervision.js';
import { logger, postDiscord as postDiscordSink } from './host.js';
import { loadFleetNodeNames, loadEphemeralNodes } from './lib/manifest.js';
import { jobRecords } from './job-history-store.js';
import { nodeOf } from './runners/census.js';
import { admissionVerdictsForReport } from './runner-health-mint.js';
import { alertOnce, clearAlert } from './lib/alert-ledger.js';
import { selfHostname } from './lib/runner-health-shared.js';
import {
	diskReadingsForReport,
	judgeWorkDisk,
	judgeTmpDisk,
	tmpAdvisoryLineMb,
	tmpIsSmall,
	worseDiskLevel,
	DISK_WATCH_ADVISORY_FREE_GB,
	DISK_WATCH_PAGE_FREE_GB,
	TMP_WATCH_PAGE_MARGIN_MB,
	type DiskWatchLevel,
} from './runners/disk-watch.js';
import { backstopMachinesReader } from './runners/backstop-machines.js';
import { mintsOnDemand, type MintBearingNode } from './lib/node-role.js';
import { TMP_FREE_FLOOR_MB, parseJitName } from './lib/jit-naming.js';
// Re-exported so runner-health-queue-classify.ts's mismatchedMints/deafMints
// do not open a second direct edge to lib/jit-naming.ts for this parser.
export { parseJitName };
import { checkNodeRegressions, defaultGatedKinds } from './runners/node-regression.js';
import { lastSnapshot, getRunnerHealthSnapshot } from './runner-health-snapshot.js';
import type { TickReport } from './runner-health-snapshot.js';

/**
 * Host-side supervision probe, or null to skip it.
 *
 * Deliberately null by default. The probe SSHes every claw, so leaving it on
 * would make a plain `tick()` in the unit suite open real network connections
 * and sit through a 15s timeout per unreachable node — a test suite that
 * depends on the garage being up is not a test suite. `startRunnerHealthMonitor`
 * turns it on for the real process; tests opt in with a fake.
 */
let supervisionCheck: (() => Promise<SupervisionReport | null>) | null = null;

export function __setSupervisionCheckerForTesting(
	fn: (() => Promise<SupervisionReport | null>) | null
): void {
	supervisionCheck = fn;
}

/**
 * Installs the real SSH-based probe as the default, without clobbering a
 * test's fake (`__setSupervisionCheckerForTesting`) that ran first — the
 * same `??=` `startWithToken` always did inline, now a function because
 * `supervisionCheck` lives in this module.
 */
export function installDefaultSupervisionCheck(): void {
	supervisionCheck ??= checkSupervision;
}

/**
 * How long a node may sit refused by memory admission, with demand elsewhere
 * in the fleet, before `checkStarvation` calls it STARVED rather than a
 * transient dip.
 *
 * 2 HOURS. Far longer than any transient memory pressure this fleet has
 * actually measured — a pytest basetemp or a `node-compile-cache` filling
 * tmpfs builds up over days and clears only on a cleanup or a reboot, not
 * over minutes — and short enough to catch a lost claw the SAME DAY an
 * operator could act on it. claw-6 and claw-2 sat refused by memory for
 * DAYS before anything said so (wave 4a, #100): this threshold is picked to
 * have caught both within one working day, not tuned from a distribution
 * (there isn't one — the whole point is this had never been measured before
 * this wave). Same shape of judgment call as `LOWER_BOUND_HEADROOM`'s own
 * note in `ephemeral.ts`.
 */
export const STARVED_NO_JOB_MS = 2 * 60 * 60 * 1000;

/**
 * The epoch ms each node most recently STARTED a job, from job history —
 * never the end time `idleSecondsByNode` (`job-history.ts`) reads, because
 * `checkStarvation` needs to know when a node's own idle window BEGAN, not
 * how long its last job ran. A node absent from the map has no job in the
 * retained window at all, which `checkStarvation` reads as "idle forever",
 * never as "just started".
 */
function lastStartedAtMsByNode(nodes: readonly string[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const r of jobRecords()) {
		const node = nodeOf(r.runner, nodes);
		const t = Date.parse(r.startedAt);
		if (!Number.isFinite(t)) continue;
		const prev = out.get(node);
		if (prev === undefined || t > prev) out.set(node, t);
	}
	return out;
}

/**
 * A claw refused by memory admission for hours, while the rest of the fleet
 * served work, is a FINDING — wave 4a, #100: claw-6 and claw-2 sat refused by
 * the memory clause on every tick for days, and the only places that could
 * have said so (`admitMint`'s own per-run log line, and `admissionFree`,
 * which never applies the memory clause at all — see its doc comment)
 * reported `mintable` the whole time.
 *
 * STARVED requires all three, every tick:
 *
 *   (a) the LATEST verdict (`ephemeral-tick.ts`'s `admissionVerdictsForReport`)
 *       is a MEMORY or SPACE refusal (#101: a node out of `/tmp`/`_work`
 *       space is as starved as one out of memory) — never `concurrency` (a
 *       busy node is working, not starved) or `drained` (an operator's own
 *       decision) or `other`.
 *       This is also how a slow-tier node held by the #83 spill gate is
 *       excluded for free: that hold is a PLACEMENT refusal in
 *       `placement.ts`'s `refusalFor`, after `admitMint` already said `ok`,
 *       so the generic verdict here never sees it.
 *   (b) that node's LAST STARTED JOB (job history, persisted — survives a
 *       restart) is older than {@link STARVED_NO_JOB_MS}.
 *   (c) EVIDENCE OF DEMAND: some OTHER node started a job since this node's
 *       idle window began, or the queue is non-empty right now. An idle
 *       fleet is never a finding — a node with nothing to do is not starved
 *       by refusing to do it.
 *
 * `admitMint` ITSELF excludes drained nodes and hokon from ever reaching here
 * refused-on-memory in the first place: a backstop never appears in
 * `admissionVerdictsForReport` at all (`withoutBackstops`, `ephemeral-tick.ts`),
 * and a drained node's verdict clause is `'drained'`, not `'memory'`.
 *
 * AN ABSENT VERDICT IS "COULD NOT LOOK", NEVER "ADMITTED". Right after a
 * restart, `ephemeral-tick.ts`'s verdict snapshot is empty until its own
 * first tick lands — which, on its 15s dispatch cadence, is almost always
 * well inside this function's own 10-minute one. For a node this map simply
 * has no entry for, this tick neither sets nor clears `starved[node]`: the
 * PREVIOUS tick's reading (from `lastSnapshot.starved`, itself restorable
 * from disk — see `RunnerHealthSnapshot`) carries forward untouched, and the
 * alert ledger is left alone rather than cleared. That is also the shape
 * that makes "a restart finds the starvation from history alone" true: the
 * moment the first post-restart verdict records a memory refusal, (b) and
 * (c) are answered from PERSISTED job history, which a restart never resets
 * — there is no fresh-module-state clock to wait out.
 *
 * THE ALERT CLEARS ONLY WHEN A JOB ACTUALLY STARTED, never merely because
 * admission flipped back to `ok` (or to a non-memory clause) for one tick.
 * claw-6 measured 2026-10-06 04:00Z sits AT the admission line — 6,370 MB
 * available against a 5,632 MB reserve — and flips between admitted and
 * memory-refused from one tick to the next with no job ever landing. Clearing
 * on every `ok` tick re-armed `RE_ALERT_MS`'s dedupe on each flip, so a node
 * that is still, in every sense that matters, starved would re-page every
 * ~10 minutes instead of at most hourly. `starved[node]` still flips to
 * `false` the instant the clause stops being `memory` — the PANEL must not
 * keep showing a stale finding — but the LEDGER (`clearAlert`) is only
 * touched when {@link lastStartedAtMsByNode} shows a job genuinely started
 * within {@link STARVED_NO_JOB_MS}, which is the one fact that means the
 * starvation actually ended rather than admission merely sitting on a
 * boundary.
 */
export async function checkStarvation(data: TickReport): Promise<void> {
	const nowMs = Date.now();
	const nodeNames = loadFleetNodeNames();
	const lastStarted = lastStartedAtMsByNode(nodeNames);
	const verdicts = admissionVerdictsForReport();
	const queuedNow = data.queued_now ?? 0;
	const prevStarved = lastSnapshot?.starved ?? {};
	const starved: Record<string, boolean> = {};

	for (const node of loadEphemeralNodes()) {
		const verdict = verdicts.get(node);
		if (verdict === undefined) {
			// COULD NOT LOOK — see this function's own docblock. Carry the last
			// known reading forward; do not touch the alert ledger either way.
			starved[node] = prevStarved[node] ?? false;
			continue;
		}
		const last = lastStarted.get(node);
		const idleMs = last === undefined ? Infinity : nowMs - last;
		// THE STARVATION GENUINELY ENDED: a job actually started, however the
		// CURRENT verdict reads. Checked FIRST and ahead of the clause check,
		// so a job landing clears the ledger regardless of what admission says
		// about the NEXT one. This is the only branch allowed to clearAlert.
		if (idleMs < STARVED_NO_JOB_MS) {
			starved[node] = false;
			clearAlert(`starved:${node}`);
			continue;
		}
		// #101: SPACE is a starvation clause too — a node refused for want of
		// `/tmp` or `~/.hadoku/jit` free space is exactly as idle-while-others-
		// work as one refused for want of memory, and the same silent-for-days
		// failure (#100) applies to either resource.
		if (verdict.ok || (verdict.clause !== 'memory' && verdict.clause !== 'space')) {
			// Admitted (or refused for a clause this finding does not watch)
			// this tick, but no job has actually started — do NOT clear. See
			// this function's own "alert clears only when a job started" note:
			// a node sitting at the admission line flips `ok` for single ticks
			// with nothing ever running, and clearing here would re-arm the
			// page for each flip.
			starved[node] = false;
			continue;
		}
		// EVIDENCE OF DEMAND: another node started a job since this one went
		// idle, or the queue is non-empty right now. `windowStartMs` is where
		// this node's OWN idle window began — never-started falls back to the
		// threshold window, which is the most conservative window available.
		const windowStartMs = last ?? nowMs - STARVED_NO_JOB_MS;
		const othersActive = [...lastStarted].some(([n, t]) => n !== node && t >= windowStartMs);
		if (!othersActive && queuedNow <= 0) {
			// Idle fleet. Not a finding — see (c) above. Still no job ran, so
			// the ledger (if armed) stays armed — same "only a real job clears
			// it" rule as the `ok`/non-memory branch above.
			starved[node] = false;
			continue;
		}
		starved[node] = true;
		const idleH = (idleMs / 3_600_000).toFixed(1);
		const lastJobAt =
			last === undefined ? 'never (no job in the retained window)' : new Date(last).toISOString();
		// NAMES THE REPORTER, NOT THE NODE'S LOCATION (#101 send-back): the
		// original wording — "starved on hokon: claw-6 …" — reads as claw-6
		// LIVING on hokon, which is false; hokon is only where this check runs.
		// `clauseWord`/`clauseDetail` also say WHICH resource refused: MEMORY
		// (free MB vs. this check's reserve) or SPACE (free MB vs. the floor
		// on whichever filesystem `verdict.filesystem` names), never a bare
		// "admission" that leaves the reader to re-derive it from the raw
		// `reason` string.
		const clauseWord = verdict.clause === 'space' ? 'SPACE' : 'MEMORY';
		const spaceFsName =
			verdict.clause === 'space' && verdict.filesystem === 'tmp' ? '/tmp' : '_work';
		const clauseDetail =
			verdict.clause === 'space'
				? verdict.unreadable
					? `could not read free space on ${spaceFsName}`
					: `${verdict.availableMb}MB free on ${spaceFsName}, under this check's ${verdict.needMb}MB floor`
				: `${verdict.availableMb}MB free, this check reserves ${verdict.needMb}MB ` +
					`(basis: ${verdict.reserveBasis})`;
		await alertOnce(
			`starved:${node}`,
			`🥀 **starved** (reported by \`${selfHostname()}\`): \`${node}\` has been refused by ` +
				`${clauseWord} admission for ${idleH}h (no job started since ${lastJobAt}) while other ` +
				`claws kept working — ${clauseDetail}: ${verdict.reason}`
		);
	}
	data.starved = starved;
}

/**
 * An early warning on the `_work` filesystem — wave 4c §F, the operator's disk
 * ask (2026-10-07). `disk-watch.ts` holds the pure judgement
 * ({@link judgeWorkDisk}) and the per-tick reading registry
 * ({@link diskReadingsForReport}, filled by the `ephemeral-tick.ts` hunk this
 * lane lands after A); this function is the READER, same split
 * `checkStarvation` already uses against `admissionVerdictsForReport`.
 *
 * AN ABSENT READING IS "COULD NOT LOOK YET", NEVER "FINE" — same rule as
 * `checkStarvation`'s own docblock, for the same reason: right after a
 * restart, or before the `ephemeral-tick.ts` hunk has run its first tick, the
 * registry is empty. For a node this tick has no reading for, the PREVIOUS
 * tick's level carries forward untouched and the alert ledger is left alone.
 *
 * HOKON NEVER APPEARS HERE — `loadEphemeralNodes()` is the same set
 * `checkStarvation` walks, and hokon is never in it (`ephemeral: true` is
 * never set on a backstop; `ephemeral-tick.ts`'s `withoutBackstops` enforces it a
 * second time on the producing side). `disk-watch.ts`'s own header has the
 * full chain.
 *
 * ALERTING: `'page'` and `'advisory'` each page through `alertOnce` on their
 * OWN key, so a node already paging at `'page'` still gets a fresh notice the
 * moment it recovers to `'advisory'` (a transition, not a re-statement of the
 * same finding) — and `alertOnce`'s own RE_ALERT_MS window is what keeps
 * either from re-firing every ~10-minute tick while the level does not change.
 * `'unreadable'` is its OWN finding (CLAUDE.md: "could not look" must never
 * render as "nothing is wrong"), on its own key, so a node that stops
 * reporting free space at all is never silently read as whatever level it last
 * held. Every alert key clears the moment the node is no longer in that state,
 * so the NEXT crossing (in either direction) alerts immediately rather than
 * sitting inside the previous state's dedupe window.
 */
export async function checkDiskWatch(data: TickReport): Promise<void> {
	const readings = diskReadingsForReport();
	const prevDiskWatch = lastSnapshot?.diskWatch ?? {};
	const diskWatch: Record<string, DiskWatchLevel> = {};
	// Through the restoring getter: right after a restart `lastSnapshot` is null
	// until this tick captures, and the capacity fact must not be said again.
	const prevTmpSmall = getRunnerHealthSnapshot()?.tmpSmall ?? {};
	const tmpSmall: Record<string, number> = {};

	// Every node the dispatcher mints on: the ephemeral claws AND the
	// manifest's on-demand backstops (#120). hokon's /tmp refused every mint there
	// on 2026-10-20/21, deploys included, and nothing here was watching it.
	const machines = backstopMachinesReader();
	const onDemand = Object.entries(machines ?? {})
		.filter(([, m]) => mintsOnDemand(m as MintBearingNode))
		.map(([n]) => n);
	for (const node of new Set([...loadEphemeralNodes(), ...onDemand])) {
		const reading = readings.get(node);
		if (reading === undefined) {
			// COULD NOT LOOK — see this function's own docblock. Carry the last
			// known reading forward; do not touch the alert ledger either way.
			diskWatch[node] = prevDiskWatch[node] ?? 'ok';
			if (prevTmpSmall[node] !== undefined) tmpSmall[node] = prevTmpSmall[node];
			continue;
		}
		// /tmp FIRST (2026-10-21): judged against the mint floor it is about to
		// hit, its own alert keys, and folded into the node's one snapshot level
		// as the worse of the two. On a backstop the page says what the refusal
		// costs, because there it is not CI that stops.
		//
		// #132: judged against the tmpfs's own SIZE. An 8 GB claw's ~3.9 GB /tmp
		// sat under the absolute advisory line while empty and re-pinged hourly;
		// that is a property of the box, said once below, not a leak.
		//
		// WHY THIS STILL FIRES NOW THAT JOBS WRITE TO DISK (2026-10-24). Every
		// live job's TMPDIR and compile cache are on disk, observed per job by
		// the throttle check and converged by converge-provisioning, and claw-2
		// held 6 MB of /tmp that day. But /tmp is not empty of writers: a JVM
		// ignores TMPDIR (hsperfdata, kotlin-daemon logs), a subprocess built
		// from a scratch env drops it (this repo's own tests left 457 MB of
		// node-compile-cache and 580 leaked `tmp.*` dirs on claw-6), and ssh probes
		// carry none. tmpfs pages are RAM either way, and the dispatcher still
		// refuses a mint under the floor. So the floor and both lines stay as
		// they are; what changed is what a crossing MEANS — not "a job leaked",
		// but "something that ignores TMPDIR is filling RAM" — and the messages
		// say so.
		const tmpSizeMb = reading.tmpSizeMb ?? null;
		if (tmpSizeMb !== null && tmpIsSmall(tmpSizeMb)) {
			tmpSmall[node] = tmpSizeMb;
			if (prevTmpSmall[node] === undefined) {
				await postDiscordSink(
					`ℹ️ **disk** (reported by \`${selfHostname()}\`): \`${node}\`'s /tmp is a ` +
						`${Math.round((tmpSizeMb / 1024) * 10) / 10}GB filesystem — less than one mint floor ` +
						`(${TMP_FREE_FLOOR_MB}MB) of runway above the floor even when empty. A capacity fact, ` +
						`said once: its advisory line sits at ${tmpAdvisoryLineMb(tmpSizeMb)}MB free instead. ` +
						"CI jobs' TMPDIR is on disk, not here" +
						(onDemand.includes(node)
							? '.'
							: ': observed per live job by `fleet throttle --check` (jobtmpbad) and ' +
								'repaired by converge-provisioning.'),
					'runner-health'
				);
			}
		}
		const tmp = judgeTmpDisk(reading.tmpFreeMb, tmpSizeMb);
		if (tmp.level !== 'page') clearAlert(`diskwatch:tmp:page:${node}`);
		if (tmp.level !== 'advisory') clearAlert(`diskwatch:tmp:advisory:${node}`);
		if (tmp.level === 'advisory') {
			await alertOnce(
				`diskwatch:tmp:advisory:${node}`,
				`⚠️ **disk** (reported by \`${selfHostname()}\`): \`${node}\`'s /tmp has ${tmp.freeGb}GB free — ` +
					`within ${tmpAdvisoryLineMb(tmpSizeMb) - TMP_FREE_FLOOR_MB}MB of the ` +
					`${TMP_FREE_FLOOR_MB}MB floor under which the dispatcher refuses to mint there. ` +
					"A job's own TMPDIR is on disk, so this is something that ignores TMPDIR (a JVM's " +
					'java.io.tmpdir, a stripped-env subprocess, an ssh probe)' +
					(onDemand.includes(node)
						? ''
						: ' or a job that is not (`fleet throttle --check --machine ' +
							node +
							'`, JOBTMP-BAD)') +
					'. `find /tmp -maxdepth 1 -mmin +60` names the leftovers.'
			);
		} else if (tmp.level === 'page') {
			const cost = onDemand.includes(node)
				? ' On this node that includes the pm2-host deploys nothing else can run.'
				: '';
			await alertOnce(
				`diskwatch:tmp:page:${node}`,
				`🔥 **disk** (reported by \`${selfHostname()}\`): \`${node}\`'s /tmp has ${tmp.freeGb}GB free — ` +
					`${TMP_WATCH_PAGE_MARGIN_MB}MB from the ${TMP_FREE_FLOOR_MB}MB mint floor, under which the ` +
					`dispatcher refuses EVERY mint there, forced or not.${cost} Free /tmp now.`
			);
		}

		const verdict = judgeWorkDisk(reading.workFreeMb);
		diskWatch[node] = worseDiskLevel(verdict.level, tmp.level);

		if (verdict.level !== 'unreadable') clearAlert(`diskwatch:unreadable:${node}`);
		if (verdict.level === 'unreadable') {
			await alertOnce(
				`diskwatch:unreadable:${node}`,
				`🥀 **disk** (reported by \`${selfHostname()}\`): \`${node}\`'s _work filesystem free ` +
					`space could not be read this tick — "I could not look" is not "fine".`
			);
			continue;
		}
		if (verdict.level === 'ok') {
			clearAlert(`diskwatch:advisory:${node}`);
			clearAlert(`diskwatch:page:${node}`);
			continue;
		}
		if (verdict.level === 'advisory') {
			clearAlert(`diskwatch:page:${node}`);
			await alertOnce(
				`diskwatch:advisory:${node}`,
				`⚠️ **disk** (reported by \`${selfHostname()}\`): \`${node}\`'s _work filesystem has ` +
					`${verdict.freeGb}GB free — under the ${DISK_WATCH_ADVISORY_FREE_GB}GB advisory line. ` +
					`Not urgent; plan a cleanup before it crosses the ${DISK_WATCH_PAGE_FREE_GB}GB page line.`
			);
			continue;
		}
		// 'page'
		await alertOnce(
			`diskwatch:page:${node}`,
			`🔥 **disk** (reported by \`${selfHostname()}\`): \`${node}\`'s _work filesystem has ` +
				`${verdict.freeGb}GB free — under the ${DISK_WATCH_PAGE_FREE_GB}GB page line. Admission's ` +
				`own floor is 2GB; this is the warning before that refusal, not after it.`
		);
	}
	data.diskWatch = diskWatch;
	data.tmp_small = tmpSmall;
}

/**
 * Wave 4e §B (#102) — a node that fails PROVEN work loses the label. The
 * detection, the "real product red" exclusion and the injected stale-mark
 * all live in `runners/node-regression.ts`; this is that module's one
 * reader, same split `checkStarvation` uses against `admissionVerdictsForReport`
 * and `checkDiskWatch` against `diskReadingsForReport`.
 *
 * The operator, 2026-10-07: "this is exactly the thing that bootcamping a
 * claw should catch. if they are not suitable to handle a job, then we
 * should have seen that coming before we allowed them to earn that tag."
 * This is the automatic half of that: claw-3 failed five full cardtable
 * `forge-e2e` jobs while every one passed elsewhere within the hour, and a
 * human had to notice, diagnose and manually evict it — see
 * `node-regression.ts`'s own header for why 5 divergences in a 1-hour window
 * is the exact bar that incident cleared.
 *
 * PAGES ONCE, same mechanism as `checkStarvation`/`checkDiskWatch`:
 * `alertOnce` keyed per `node`+`capability`, which re-arms only after
 * `RE_ALERT_MS` or a genuine crossing. A node/kind pair that no longer meets
 * the threshold has its key cleared so the NEXT crossing — in either
 * direction — alerts immediately rather than sitting inside the previous
 * dedupe window. That "no longer meets the threshold" case covers two
 * genuinely different reasons, both handled inside `node-regression.ts`
 * (`filterDivergencesByFreshProof`), not here: its divergences aged out of
 * the 14-day retention, OR the node's `$proof` is no longer a fresh PASS —
 * either because THIS check already marked it stale (so the same divergence
 * set cannot re-trigger `markStale` on the next tick, which is also what
 * stops this from rewriting the facet every ~10 minutes forever), or because
 * the tracker re-proved the node after the divergences, in which case only
 * divergences dated AFTER that fresh proof count against it — a node is
 * never pinned by its own pre-proof history for the rest of the 14 days.
 *
 * HOKON NEVER APPEARS HERE — `loadEphemeralNodes()` is passed as
 * `watchedNodes`, the same set `checkStarvation`/`checkDiskWatch` already
 * walk, and `node-regression.ts`'s own fold refuses to charge any node
 * outside it.
 */
export async function checkNodeRegression(): Promise<void> {
	const nodes = loadFleetNodeNames();
	const watched = [...loadEphemeralNodes()];
	const gatedKinds = defaultGatedKinds();
	const applied = checkNodeRegressions(jobRecords(), nodes, watched);
	const activeKeys = new Set(applied.map((a) => `${a.node}\u0000${a.capability}`));
	for (const node of watched) {
		for (const kind of gatedKinds) {
			if (!activeKeys.has(`${node}\u0000${kind.capability}`)) {
				clearAlert(`regression:${node}:${kind.capability}`);
			}
		}
	}
	for (const a of applied) {
		const staleNote = a.result.ok
			? 'its $proof is marked STALE — the label is withdrawn'
			: `its $proof could NOT be marked stale (${a.result.reason}): ${a.result.why}`;
		await alertOnce(
			`regression:${a.node}:${a.capability}`,
			`🥀 **regression** (reported by \`${selfHostname()}\`): \`${a.node}\` failed ` +
				`${a.divergenceCount} \`${a.capability}\` run(s) that passed on another claw at the ` +
				`same commit within the hour — ${staleNote}. Runs: ${a.runIds.join(', ')}.`
		);
	}
}

/**
 * Host-side supervision — the one check GitHub structurally cannot answer.
 *
 * Fail-soft by design: an unreachable claw is reported, never counted as
 * healthy, and never fails the tick.
 */
export async function checkHostSupervision(data: TickReport): Promise<void> {
	// --- node-side supervision, which the GitHub API structurally cannot see ---
	//
	// Everything above asks GitHub which runners are ONLINE, and GitHub answers
	// about the listener process. A listener that has escaped its systemd unit
	// therefore reports perfectly healthy while nothing will ever restart it —
	// which is how nine orphaned runners across three claws went unnoticed for
	// three days in August 2026. Fail-soft: an unreachable claw is reported, not
	// counted as healthy, and never fails the tick.
	try {
		const sup = supervisionCheck ? await supervisionCheck() : null;
		if (sup) {
			data.supervision_problems = sup.problems.length;
			data.supervision_listeners = sup.listenersSeen;
			if (sup.unreachable.length) data.supervision_unreachable = sup.unreachable;
			logReport(sup);
			for (const p of sup.problems) {
				// Keyed by node+dir+kind so each broken runner pings on its own
				// hourly schedule — a whole claw going wrong must not collapse into
				// one alert that looks like a single runner.
				await alertOnce(
					`supervision:${p.node}:${p.dir}:${p.kind}`,
					`🩺 **runner supervision** on \`${selfHostname()}\`: ${describeProblem(p)}`
				);
			}
		}
	} catch (err) {
		logger.warn(
			`[runner-health] supervision probe failed: ${err instanceof Error ? err.message : String(err)}`
		);
	}
}
