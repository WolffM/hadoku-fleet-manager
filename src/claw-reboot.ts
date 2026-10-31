/**
 * The claw reboot cycle, run by the controller.
 *
 * WHY THIS EXISTS. unattended-upgrades installs security updates with
 * Automatic-Reboot false (a self-reboot mid-job is a CI failure), so a staged
 * kernel waits for somebody. Nobody came: on 2026-10-25 every claw was still
 * on its boot kernel, most up since 2026-09-01..09-07. preflight's
 * `pending-reboot` finding said so every night and nothing acted on it.
 *
 * THE WORK IS THE SUBCOMMAND'S. `fleet reboot-claws` (scripts/reboot-claws.mjs,
 * policy in scripts/lib/reboot-cycle.mjs) does one pass: at most ONE claw,
 * nobody else's drain, drained as a lease that lapses by itself, idle before
 * the reboot, verified after it. This module schedules it, logs what it did,
 * and pages on:
 *   - a claw HELD after a failed verification, or one it could not undrain —
 *     once, then again every REPAGE_MS while it stays;
 *   - the cycle itself producing no report for FAIL_PAGE_MS.
 * A reboot that went well is posted once, as a note rather than a page: the
 * operator should be able to see which box restarted and onto what kernel.
 * An unreadable claw, a deferral and a drain that never went idle are logged:
 * reachability pages from runner-health, and the next pass retries.
 *
 * STATE IS ON DISK, twice. The cycle keeps the reboot in flight in
 * `claw-reboot.json` (the script's), so a pass killed mid-reboot is finished
 * by the next one. This module keeps when it last ran and what it paged in
 * `claw-reboot-controller.json`. A reboot in flight makes the first pass after
 * a restart due at FIRST_PASS_MIN_MS rather than a whole interval later.
 *
 * PORTED ONTO `src/lib/job-runner.ts` (wave 5e lane B): the paging ledger, the
 * boot-timing clock, the no-overlap guard and the job-sink call are the
 * runner's shared primitives — this module's own copies of all four are
 * gone. What stays HERE, unchanged, is this cycle's own report shape
 * (`RebootDoc`'s `nodes`/`findings`, not `ConvergeDoc`'s rows) and its own
 * words: a reboot cycle is not a converger with different labels, and
 * forcing its report into `ConvergeDoc`'s shape would be a behaviour change
 * this wave does not make.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { logger, postDiscord, stateDir } from './host.js';
import { writeJsonAtomic } from './lib/atomic-json.js';
import {
	classifyMissingDoc,
	computeFirstDelayMs,
	createOverlapGuard,
	createPager,
	finishTick,
	hours,
	scheduleRepeating,
	type Verdict,
} from './lib/job-runner.js';
import { packageScriptPath, spawnScriptJson } from './scheduled-converger.js';

/** Between passes. A pass with nothing to do is one ssh per claw. */
export const CLAW_REBOOT_MS = 60 * 60_000;
/** The earliest a pass runs after boot, so it never lands on the fast loop's boot probe. */
export const FIRST_PASS_MIN_MS = 5 * 60_000;
/** The cycle not reporting pages after this long. */
export const FAIL_PAGE_MS = 6 * 60 * 60_000;
/** A held node that stays held pages again after this long. */
export const REPAGE_MS = 24 * 60 * 60_000;
/**
 * Longest pass: a hosting node's 15-minute notice, a 45-minute idle wait, a
 * 12-minute boot window, a 6-minute services window and the re-prove, with
 * room. Past it the script is killed, and its signal handler puts back a node
 * it had not rebooted yet.
 */
const RUN_TIMEOUT_MS = 100 * 60_000;
const SELF_KEY = 'reboot-cycle';
/** The job-sink name (also the Discord alert source, as before). */
const JOB_NAME = 'reboot';

export interface RebootNode {
	node: string;
	status?: string;
	reason?: string;
	why?: string;
	kernel?: { from: string; to: string };
}

/** `fleet reboot-claws --json`, as far as this module reads it. */
export interface RebootDoc {
	ok: boolean;
	nodes: RebootNode[];
	findings: { node: string | null; kind: string; reason: string }[];
	rebooted: string[];
}

export type RebootRunner = () => Promise<{ doc: RebootDoc | null; why: string }>;

interface ControllerState {
	lastRunAt: string | null;
	paged: Record<string, string>;
	failingSince: string | null;
}

const statePath = (): string => join(stateDir(), 'claw-reboot-controller.json');
const cyclePath = (): string => join(stateDir(), 'claw-reboot.json');

function readState(): ControllerState {
	const empty: ControllerState = { lastRunAt: null, paged: {}, failingSince: null };
	if (!existsSync(statePath())) return empty;
	try {
		return {
			...empty,
			...(JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<ControllerState>),
		};
	} catch (err) {
		logger.warn(
			`[reboot] ${statePath()} unreadable, starting from empty state: ` +
				(err instanceof Error ? err.message : String(err))
		);
		return empty;
	}
}

function writeState(s: ControllerState): void {
	// Write-then-rename, fsync'd (F3, `lib/atomic-json.ts`).
	writeJsonAtomic(statePath(), s, { space: 2 });
}

/** Is a reboot in flight, by the cycle's own record? Unreadable counts as yes: look soon. */
function inFlight(): boolean {
	if (!existsSync(cyclePath())) return false;
	try {
		return Boolean(
			(JSON.parse(readFileSync(cyclePath(), 'utf8')) as { inFlight?: unknown }).inFlight
		);
	} catch {
		return true;
	}
}

export const rebootScriptPath = (): string => packageScriptPath('reboot-claws.mjs');

export const runRebootScript: RebootRunner = () =>
	spawnScriptJson<RebootDoc>(rebootScriptPath(), ['--json'], RUN_TIMEOUT_MS);

// dkms-missing pages: the claw can never take its kernel until a human builds
// the module, so it would sit on an unpatched kernel in silence.
const PAGED_KINDS = new Set(['verify-failed', 'hold-failed', 'undrain-failed', 'dkms-missing']);

export interface RebootTickSummary {
	ran: boolean;
	rebooted: number;
	pages: number;
	recoveries: number;
}

/**
 * The job-sink verdict (job-runner.ts's classify step), read from the SAME
 * `doc.findings`/`doc.nodes` the paging loop below reads — a second look at
 * the same report, never a second source of truth. `findings` for anything
 * that pages or holds a node; `unavailable` for a node this pass could not
 * read at all; `ok` otherwise (a deferral alone is "busy", not a problem).
 */
function classifyRebootDoc(doc: RebootDoc): Verdict {
	const pagingFindings = doc.findings.filter((f) => f.node && PAGED_KINDS.has(f.kind));
	const held = doc.nodes.some((n) => n.status === 'held');
	if (pagingFindings.length > 0 || held) return 'findings';
	const unreadable =
		doc.nodes.some((n) => n.status === 'unreadable') ||
		doc.findings.some((f) => f.kind === 'unreadable');
	return unreadable ? 'unavailable' : 'ok';
}

/** One pass: run it, log and page by the rules in the header. Never throws. */
export async function clawRebootTick(
	run: RebootRunner = runRebootScript,
	now: number = Date.now()
): Promise<RebootTickSummary> {
	const startedAt = Date.now();
	const state = readState();
	state.lastRunAt = new Date(now).toISOString();
	const summary: RebootTickSummary = { ran: false, rebooted: 0, pages: 0, recoveries: 0 };
	const pager = createPager({
		paged: state.paged,
		now,
		repageMs: REPAGE_MS,
		post: postDiscord,
		source: 'reboot',
	});

	const { doc, why } = await run();
	if (!doc) {
		state.failingSince ??= state.lastRunAt;
		const failingFor = now - Date.parse(state.failingSince);
		logger.warn(`[reboot] the reboot cycle produced no report: ${why}`);
		if (failingFor >= FAIL_PAGE_MS) {
			await pager.page(
				SELF_KEY,
				`⚠️ fleet reboot-claws has not produced a report for ${hours(failingFor)} — staged kernels ` +
					`on the claws are not being rebooted. Last: ${why}`
			);
		}
		summary.pages = pager.counts.pages;
		summary.recoveries = pager.counts.recoveries;
		writeState(state);
		await finishTick({
			intervalMs: CLAW_REBOOT_MS,
			jobName: JOB_NAME,
			now,
			verdict: classifyMissingDoc(why),
			durationMs: Date.now() - startedAt,
			why,
		});
		return summary;
	}
	summary.ran = true;
	state.failingSince = null;
	await pager.recover(SELF_KEY, '✅ fleet reboot-claws is reporting again.');

	for (const n of doc.nodes) {
		if (n.status === 'rebooted') {
			summary.rebooted++;
			const k = n.kernel ? `${n.kernel.from} → ${n.kernel.to}` : '';
			logger.info(`[reboot] ${n.node} rebooted ${k} (${n.reason ?? ''})`);
			await postDiscord(
				`🔄 ${n.node} rebooted by the fleet's reboot cycle (${n.reason ?? 'staged update'}): ` +
					`${k}, runners and services verified back, undrained.`,
				'reboot'
			);
		} else if (n.status === 'held') {
			logger.warn(`[reboot] ${n.node} HELD after its reboot: ${n.why ?? ''}`);
		} else if (n.status === 'deferred' || n.status === 'unreadable') {
			logger.info(`[reboot] ${n.node} ${n.status}: ${n.why ?? n.reason ?? ''}`);
		}
	}
	// One line per pass naming every node, so "did the cycle look at claw-8, and
	// what did it decide" is answered by the log even when nothing happened.
	logger.info(
		`[reboot] pass: ${doc.nodes.map((n) => `${n.node}=${n.status ?? '?'}`).join(' ') || 'no nodes'}`
	);

	const open = new Set<string>();
	for (const f of doc.findings) {
		if (!f.node || !PAGED_KINDS.has(f.kind)) {
			logger.warn(`[reboot] ${f.node ?? '-'} ${f.kind}: ${f.reason}`);
			continue;
		}
		open.add(f.node);
		await pager.page(
			f.node,
			`🔴 ${f.node}: the reboot cycle could not return it to service (${f.kind}): ${f.reason} ` +
				`Look at it, then \`fleet drain ${f.node} --undo\`.`
		);
	}
	// A node that paged and has since rebooted cleanly or is read as current recovers.
	for (const n of doc.nodes) {
		if (open.has(n.node)) continue;
		if (n.status === 'rebooted' || n.status === 'current') {
			await pager.recover(n.node, `✅ ${n.node}: back in service after the reboot cycle held it.`);
		}
	}

	summary.pages = pager.counts.pages;
	summary.recoveries = pager.counts.recoveries;
	writeState(state);
	await finishTick({
		intervalMs: CLAW_REBOOT_MS,
		jobName: JOB_NAME,
		now,
		verdict: classifyRebootDoc(doc),
		durationMs: Date.now() - startedAt,
	});
	return summary;
}

let started = false;
let guard = createOverlapGuard();
let scheduled: ReturnType<typeof scheduleRepeating> | null = null;

/** Test seam: clear the timers and the `started` guard. */
export function __stopClawRebootForTesting(): void {
	scheduled?.stop();
	scheduled = null;
	started = false;
	// A fresh guard, not a reset flag — see scheduled-converger.ts's identical note.
	guard = createOverlapGuard();
}

/** Start the cycle's timer. Controller-only: `createFleetManager().start()` gates it. */
export function startClawReboot(run: RebootRunner = runRebootScript): void {
	if (started) return;
	started = true;
	const pass = () =>
		guard.run(() =>
			clawRebootTick(run)
				.then((s) => {
					if (s.rebooted || s.pages || s.recoveries) {
						logger.info(
							`[reboot] pass: ${s.rebooted} rebooted, ${s.pages} page(s), ${s.recoveries} recovery(ies)`
						);
					}
				})
				.catch((err: unknown) => {
					logger.warn(`[reboot] pass threw: ${err instanceof Error ? err.message : String(err)}`);
				})
		);
	const last = readState().lastRunAt;
	const firstIn = inFlight()
		? FIRST_PASS_MIN_MS
		: computeFirstDelayMs({ intervalMs: CLAW_REBOOT_MS, firstPassMinMs: FIRST_PASS_MIN_MS }, last);
	logger.info(
		`[reboot] cycle every ${CLAW_REBOOT_MS / 60_000} min, next in ${Math.round(firstIn / 60_000)} min`
	);
	scheduled = scheduleRepeating(firstIn, CLAW_REBOOT_MS, pass, JOB_NAME);
}
