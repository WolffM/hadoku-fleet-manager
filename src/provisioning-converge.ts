/**
 * Standing-runner provisioning, converged by the controller — fleet-manager#1.
 *
 * WHY THIS EXISTS. A standing runner whose `.env` lacks the throttle keys has
 * no concurrency limit and cannot see the shared tool cache, and one running
 * outside its slice has no group memory ceiling. Until 2026-10-24 the only
 * thing that noticed either was hadoku_site's nightly check:throttle /
 * check:slice, and hadoku_site does not run fleet fixes. So every drift waited
 * for a human: claw-4 and claw-6 sat in that state from 10-22 to 10-24. Now
 * `fleet converge-provisioning` runs here on its own timer. It repairs what is
 * safe to repair unattended, re-reads the node, and reports what it changed.
 * It pages only on what it could not converge. The nightly gates stay as the
 * backstop and should find nothing.
 *
 * THE WORK IS THE SUBCOMMAND'S. This module schedules it, reads its `--json`,
 * and decides what is worth a page. The repair rules, idle units only and one
 * restart per unit, live in scripts/converge-provisioning.mjs and
 * lib/provisioning-converge.mjs, where the operator's CLI runs the same code.
 *
 * WHAT PAGES, and only this:
 *   - a (node, facet) the repair ran on and the re-check still disagrees with
 *     (`unconverged`), once, then again every REPAGE_MS while it stays;
 *   - a (node, facet) deferred behind a live job for longer than
 *     DEFER_PAGE_MS. A standing runner is idle most of the time, so one that
 *     never is at a pass for that long is not "busy", it is stuck;
 *   - the converger itself failing to produce a report for DEFER_PAGE_MS.
 * A recovery is posted for anything that paged. An UNREADABLE node is
 * logged, not paged: node reachability already pages from runner-health, and
 * the nightly gates still fail on it.
 *
 * STATE IS ON DISK. mgmt-api restarts many times a day (28 in one morning,
 * 2026-09), so a module-level timer that started fresh at every boot could
 * run the converger at every boot, or never run it at all if restarts come
 * faster than the interval. The last run time, the deferral clocks and what
 * has paged all live in `provisioning-converge.json` under stateDir.
 */
import { spawn } from 'node:child_process';
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { logger, manifestDir, postDiscord, stateDir } from './host.js';

/** Between converger passes. Each pass is two fleet-wide `--check` sweeps (~20s) and no GitHub call. */
export const PROVISIONING_CONVERGE_MS = 30 * 60_000;
/** A deferral, or a converger that cannot run, pages after this long. */
export const DEFER_PAGE_MS = 6 * 60 * 60_000;
/** An unconverged facet that stays that way pages again after this long. */
export const REPAGE_MS = 24 * 60 * 60_000;
/**
 * The earliest a pass runs after boot, however overdue it is. Boot is when the
 * fast loop probes every node, and a converger due at once would put two ssh
 * sweeps on the fleet together.
 */
export const FIRST_PASS_MIN_MS = 5 * 60_000;
/** The converger is killed past this. A pass that repairs several nodes is minutes, not this. */
const RUN_TIMEOUT_MS = 20 * 60_000;
/** The key for "the converger itself did not report", beside the (node, facet) keys. */
const SELF_KEY = 'converger';

export interface ConvergeRow {
	node: string;
	facet: 'throttle' | 'slice';
	before?: string;
	changed?: string;
	why?: string;
}

/** `fleet converge-provisioning --json`, as far as this module reads it. */
export interface ConvergeDoc {
	ok: boolean;
	planned: ConvergeRow[];
	converged: ConvergeRow[];
	deferred: ConvergeRow[];
	unconverged: ConvergeRow[];
	unreadable: { node: string; facet: string; why: string }[];
	changed: { node: string; facet: string; changed: string }[];
}

export type ConvergeRunner = () => Promise<{ doc: ConvergeDoc | null; why: string }>;

interface ConvergeState {
	lastRunAt: string | null;
	/** When each (node, facet) was first seen deferred, this streak. */
	deferredSince: Record<string, string>;
	/** When each key last paged. A key here has an open page and will get a recovery. */
	paged: Record<string, string>;
	/** When the converger first failed to report, this streak. */
	failingSince: string | null;
}

const statePath = (): string => join(stateDir(), 'provisioning-converge.json');

function readState(): ConvergeState {
	const empty: ConvergeState = {
		lastRunAt: null,
		deferredSince: {},
		paged: {},
		failingSince: null,
	};
	if (!existsSync(statePath())) return empty;
	try {
		return {
			...empty,
			...(JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<ConvergeState>),
		};
	} catch (err) {
		// A torn or hand-edited file must not stop the converger. It costs at
		// most one repeated page, and the reason is logged rather than swallowed.
		logger.warn(
			`[provisioning] ${statePath()} unreadable, starting from empty state: ` +
				(err instanceof Error ? err.message : String(err))
		);
		return empty;
	}
}

function writeState(s: ConvergeState): void {
	mkdirSync(dirname(statePath()), { recursive: true });
	const tmp = `${statePath()}.tmp`;
	writeFileSync(tmp, JSON.stringify(s, null, 2));
	renameSync(tmp, statePath());
}

const key = (r: { node: string; facet: string }): string => `${r.node}|${r.facet}`;

/** The packaged subcommand, beside this module's `dist/` in the installed package. */
export function convergeScriptPath(): string {
	return resolve(
		dirname(fileURLToPath(import.meta.url)),
		'..',
		'scripts',
		'converge-provisioning.mjs'
	);
}

/**
 * Run the subcommand with the HOST's manifest and state directories. Its
 * stdout goes to a file, because a pipe loses everything past 8 KB from a child
 * that prints and exits (#33).
 */
export const runConvergeScript: ConvergeRunner = () => {
	// The real converger runs `--confirm` against the live fleet. A test that
	// reaches it through start() must get a refusal, not a repair, because a
	// fixture HOME is not isolation (10-06, 10-10). Tests inject a runner.
	if (process.env.NODE_TEST_CONTEXT) {
		return Promise.resolve({ doc: null, why: 'refused under node --test (inject a runner)' });
	}
	const dir = mkdtempSync(join(tmpdir(), 'provisioning-converge-'));
	const out = join(dir, 'stdout.json');
	const fd = openSync(out, 'w');
	return new Promise((res) => {
		let stderr = '';
		let settled = false;
		const done = (why: string) => {
			if (settled) return;
			settled = true;
			closeSync(fd);
			const text = readFileSync(out, 'utf8');
			rmSync(dir, { recursive: true, force: true });
			let doc: ConvergeDoc | null = null;
			let parseErr = '';
			try {
				doc = text.trim() ? (JSON.parse(text) as ConvergeDoc) : null;
			} catch (err) {
				parseErr = err instanceof Error ? err.message : String(err);
			}
			const tail = stderr.trim().split('\n').slice(-2).join(' | ');
			res({
				doc,
				why: doc
					? ''
					: `${why}${parseErr ? `, unparseable (${parseErr})` : ', no report'}${tail ? ` — ${tail}` : ''}`,
			});
		};
		const child = spawn(process.execPath, [convergeScriptPath(), '--json'], {
			env: {
				...process.env,
				FLEET_MANIFEST_DIR: manifestDir(),
				HADOKU_STATE_DIR: stateDir(),
				FLEET_NO_BANNER: '1',
			},
			stdio: ['ignore', fd, 'pipe'],
			timeout: RUN_TIMEOUT_MS,
		});
		child.stderr?.on('data', (d: Buffer) => {
			stderr = (stderr + d.toString()).slice(-2000);
		});
		child.on('error', (err) => done(`could not start: ${err.message}`));
		child.on('close', (code, signal) =>
			done(`exit ${code ?? 'none'}${signal ? ` (${signal})` : ''}`)
		);
	});
};

export interface ConvergeTickSummary {
	ran: boolean;
	changed: number;
	pages: number;
	recoveries: number;
}

const hours = (ms: number): string => `${Math.round(ms / 3_600_000)}h`;

/**
 * One converger pass: run it, log what it changed, and page by the rules in
 * the header. Never throws: a broken pass is logged and retried next interval.
 */
export async function convergeProvisioningTick(
	run: ConvergeRunner = runConvergeScript,
	now: number = Date.now()
): Promise<ConvergeTickSummary> {
	const state = readState();
	state.lastRunAt = new Date(now).toISOString();
	const summary: ConvergeTickSummary = { ran: false, changed: 0, pages: 0, recoveries: 0 };
	const page = async (k: string, content: string) => {
		const last = state.paged[k] ? Date.parse(state.paged[k]) : null;
		if (last !== null && now - last < REPAGE_MS) return;
		state.paged[k] = new Date(now).toISOString();
		summary.pages++;
		await postDiscord(content, 'provisioning');
	};
	const recover = async (k: string, content: string) => {
		if (!state.paged[k]) return;
		delete state.paged[k];
		summary.recoveries++;
		await postDiscord(content, 'provisioning');
	};

	const { doc, why } = await run();
	if (!doc) {
		state.failingSince ??= state.lastRunAt;
		const failingFor = now - Date.parse(state.failingSince);
		logger.warn(`[provisioning] the converger produced no report: ${why}`);
		if (failingFor >= DEFER_PAGE_MS) {
			await page(
				SELF_KEY,
				`⚠️ fleet converge-provisioning has not produced a report for ${hours(failingFor)} — ` +
					`standing-runner throttle env and slice placement are not being converged. Last: ${why}`
			);
		}
		writeState(state);
		return summary;
	}
	summary.ran = true;
	state.failingSince = null;
	await recover(SELF_KEY, '✅ fleet converge-provisioning is reporting again.');

	for (const c of doc.changed) {
		summary.changed++;
		logger.info(`[provisioning] ${c.node} ${c.facet}: ${c.changed}`);
	}

	const open = new Set<string>();
	for (const r of doc.deferred) {
		const k = key(r);
		open.add(k);
		state.deferredSince[k] ??= state.lastRunAt;
		const deferredFor = now - Date.parse(state.deferredSince[k]);
		logger.info(
			`[provisioning] ${r.node} ${r.facet} deferred ${hours(deferredFor)}: ${r.why ?? ''}`
		);
		if (deferredFor >= DEFER_PAGE_MS) {
			await page(
				k,
				`⚠️ ${r.node}: ${r.facet} drift on a standing runner has been deferred behind a live job for ` +
					`${hours(deferredFor)} (${r.why ?? r.before ?? ''}). A standing runner is idle most of the ` +
					`time, so this one is stuck rather than busy. Fix: fleet ${r.facet} --machine ${r.node} ` +
					`--confirm${r.facet === 'slice' ? ' --restart' : ''} once it is idle.`
			);
		}
	}
	for (const r of doc.unconverged) {
		const k = key(r);
		open.add(k);
		delete state.deferredSince[k];
		logger.warn(`[provisioning] ${r.node} ${r.facet} did NOT converge: ${r.why ?? ''}`);
		await page(
			k,
			`🔴 ${r.node}: fleet converge-provisioning repaired ${r.facet} drift (${r.before ?? ''}) and the ` +
				`re-check still disagrees: ${r.why ?? ''}. Needs a human: fleet ${r.facet} --machine ${r.node} --check`
		);
	}
	for (const u of doc.unreadable) {
		logger.warn(`[provisioning] ${u.node} ${u.facet} could not be read: ${u.why}`);
	}

	// Anything that had a clock or a page and is neither open nor unreadable
	// this pass was read and found clean.
	const unread = new Set(doc.unreadable.map((u) => u.node));
	const closed = [
		...new Set([...Object.keys(state.deferredSince), ...Object.keys(state.paged)]),
	].filter(
		(k) => k !== SELF_KEY && !open.has(k) && !unread.has(k.split('|')[0]) && !unread.has('*')
	);
	for (const k of closed) {
		delete state.deferredSince[k];
		const [node, facet] = k.split('|');
		await recover(k, `✅ ${node}: standing-runner ${facet} provisioning converged.`);
	}

	writeState(state);
	return summary;
}

let started = false;
let inFlight = false;
let timers: ReturnType<typeof setTimeout>[] = [];

/** Test seam: clear the timers and the `started` guard. */
export function __stopProvisioningConvergeForTesting(): void {
	for (const t of timers) clearTimeout(t);
	timers = [];
	started = false;
	inFlight = false;
}

/**
 * Start the converger's timer. The first pass is due PROVISIONING_CONVERGE_MS
 * after the LAST one, read from disk, so a restart neither skips the interval
 * nor reruns it. Controller-only: `createFleetManager().start()` gates it.
 */
export function startProvisioningConverge(run: ConvergeRunner = runConvergeScript): void {
	if (started) return;
	started = true;
	const pass = () => {
		if (inFlight) return;
		inFlight = true;
		convergeProvisioningTick(run)
			.then((s) => {
				if (s.changed || s.pages || s.recoveries) {
					logger.info(
						`[provisioning] pass: ${s.changed} change(s), ${s.pages} page(s), ${s.recoveries} recovery(ies)`
					);
				}
			})
			.catch((err: unknown) => {
				logger.warn(
					`[provisioning] pass threw: ${err instanceof Error ? err.message : String(err)}`
				);
			})
			.finally(() => {
				inFlight = false;
			});
	};
	const last = readState().lastRunAt;
	const sinceLast = last ? Date.now() - Date.parse(last) : Infinity;
	const firstIn = Math.max(
		FIRST_PASS_MIN_MS,
		Math.min(PROVISIONING_CONVERGE_MS, PROVISIONING_CONVERGE_MS - sinceLast)
	);
	logger.info(
		`[provisioning] converger every ${PROVISIONING_CONVERGE_MS / 60_000} min, next in ${Math.round(firstIn / 60_000)} min`
	);
	const first = setTimeout(() => {
		pass();
		const every = setInterval(pass, PROVISIONING_CONVERGE_MS);
		every.unref?.();
		timers.push(every);
	}, firstIn);
	first.unref?.();
	timers.push(first);
}
