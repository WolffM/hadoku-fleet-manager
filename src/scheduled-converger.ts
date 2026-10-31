/**
 * A converger the controller runs on its own timer: ONE implementation of the
 * schedule, the paging policy and the on-disk state, for every subcommand that
 * repairs drift unattended. src/provisioning-converge.ts was the first (standing
 * runners, fleet-manager#1); the hosting converger (fleet-manager#16) is the
 * second. Each supplies its subcommand, its timings and its words; nothing else.
 *
 * THE WORK IS THE SUBCOMMAND'S. This module runs it, reads its `--json`
 * (`ConvergeDoc`), logs what changed and pages by one policy:
 *   - a (node, facet) the repair ran on and the re-check still disagrees with
 *     (`unconverged`) pages once, then again every `repageMs` while it stays;
 *   - a (node, facet) `deferred` for longer than `deferPageMs` pages;
 *   - the converger itself failing to report for `deferPageMs` pages;
 *   - whatever paged gets a recovery once it is read clean.
 * An UNREADABLE node is logged, not paged, and keeps its open page: "could not
 * look" is never "converged".
 *
 * STATE IS ON DISK. mgmt-api restarts many times a day, so the last run, the
 * deferral clocks and the open pages live in `<stateFile>` under stateDir. The
 * first pass after a boot is due one interval after the LAST pass on disk, and
 * never sooner than `firstPassMinMs` (boot is when the fast loop probes every
 * node).
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { logger, manifestDir, postDiscord, stateDir } from './host.js';
import { writeJsonAtomic } from './lib/atomic-json.js';

/** One (node, facet) finding, as every converger's `--json` reports it. */
export interface ConvergeRow {
	node: string;
	facet: string;
	before?: string;
	changed?: string;
	why?: string;
}

/** A converger subcommand's `--json`, as far as this module reads it. */
export interface ConvergeDoc<R extends ConvergeRow = ConvergeRow> {
	ok: boolean;
	planned: R[];
	converged: R[];
	deferred: R[];
	unconverged: R[];
	unreadable: { node: string; facet: string; why: string }[];
	changed: { node: string; facet: string; changed: string }[];
}

export type ConvergeRunner<R extends ConvergeRow = ConvergeRow> = () => Promise<{
	doc: ConvergeDoc<R> | null;
	why: string;
}>;

export interface ConvergeTickSummary {
	ran: boolean;
	changed: number;
	pages: number;
	recoveries: number;
}

/** What one converger is: its name, its file, its clock and its words. */
export interface ConvergerConfig<R extends ConvergeRow = ConvergeRow> {
	/** The log tag and alert source, e.g. `provisioning`. */
	name: string;
	/** Its state file under stateDir. */
	stateFile: string;
	intervalMs: number;
	deferPageMs: number;
	repageMs: number;
	firstPassMinMs: number;
	/** Every page and recovery's text. `hours` is a rounded duration like `6h`. */
	words: {
		silent(hours: string, why: string): string;
		reporting: string;
		deferred(r: R, hours: string): string;
		unconverged(r: R): string;
		recovered(node: string, facet: string): string;
	};
}

export interface Converger<R extends ConvergeRow = ConvergeRow> {
	tick(run: ConvergeRunner<R>, now?: number): Promise<ConvergeTickSummary>;
	start(run: ConvergeRunner<R>): void;
	/** Test seam: clear the timers and the `started` guard. */
	stopForTesting(): void;
}

interface ConvergeState {
	lastRunAt: string | null;
	/** When each (node, facet) was first seen deferred, this streak. */
	deferredSince: Record<string, string>;
	/** When each key last paged. A key here has an open page and will get a recovery. */
	paged: Record<string, string>;
	/** When the converger first failed to report, this streak. */
	failingSince: string | null;
}

/** The key for "the converger itself did not report", beside the (node, facet) keys. */
const SELF_KEY = 'converger';
const key = (r: { node: string; facet: string }): string => `${r.node}|${r.facet}`;
const hours = (ms: number): string => `${Math.round(ms / 3_600_000)}h`;

/** A subcommand of this package, beside this module's `dist/` in the installed package. */
export function packageScriptPath(script: string): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', script);
}

/**
 * Run one of this package's subcommand scripts with the HOST's manifest and
 * state directories, and read its `--json`. Its stdout goes to a file, because
 * a pipe loses everything past 8 KB from a child that prints and exits (#33).
 *
 * THE F6 "ONE SHAPE" TWIN. `scripts/lib/spawn-json.mjs`'s `spawnJsonToFile`
 * (plan §4.1) is the same contract — file-backed capture, parseable stdout
 * winning over the exit code, a parse failure that never collapses to a bare
 * `null` with the reason dropped — built for `run-fleet-script.mjs` and
 * `bootcamp.mjs`'s prove-job canary, which had no such guarantee before. This
 * function is NOT re-implemented on top of it: `tsconfig.json` sets no
 * `allowJs`, so `src/` cannot statically import a `.mjs` sibling, and a
 * dynamic `import()` of it would have to run either eagerly at module load —
 * the exact shape `src/cli.ts`'s `domainFor` comment records as JUST fixed on
 * 2026-10-30, because one bad import there broke every subcommand, including
 * crons that never call this path — or lazily inside every tick, trading a
 * correct implementation for import() overhead and a second failure mode, for
 * no behavioural gain. This copy was already the most complete of the four F6
 * found (file-backed before any of the others, already carrying the reason,
 * with its own `NODE_TEST_CONTEXT` guard) and is kept as a verified-matching
 * TS twin rather than risked for the sake of one fewer file.
 */
export function spawnScriptJson<T>(
	script: string,
	args: string[],
	timeoutMs: number
): Promise<{ doc: T | null; why: string }> {
	// The real scripts act on the live fleet. A test that reaches one through
	// start() must get a refusal, not a repair, because a fixture HOME is not
	// isolation (10-06, 10-10). Tests inject a runner.
	if (process.env.NODE_TEST_CONTEXT) {
		return Promise.resolve({ doc: null, why: 'refused under node --test (inject a runner)' });
	}
	const dir = mkdtempSync(join(tmpdir(), 'fleet-controller-'));
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
			let doc: T | null = null;
			let parseErr = '';
			try {
				doc = text.trim() ? (JSON.parse(text) as T) : null;
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
		const child = spawn(process.execPath, [script, ...args], {
			env: {
				...process.env,
				FLEET_MANIFEST_DIR: manifestDir(),
				HADOKU_STATE_DIR: stateDir(),
				FLEET_NO_BANNER: '1',
			},
			stdio: ['ignore', fd, 'pipe'],
			timeout: timeoutMs,
		});
		child.stderr?.on('data', (d: Buffer) => {
			stderr = (stderr + d.toString()).slice(-2000);
		});
		child.on('error', (err) => done(`could not start: ${err.message}`));
		child.on('close', (code, signal) =>
			done(`exit ${code ?? 'none'}${signal ? ` (${signal})` : ''}`)
		);
	});
}

export function createConverger<R extends ConvergeRow = ConvergeRow>(
	cfg: ConvergerConfig<R>
): Converger<R> {
	const tag = `[${cfg.name}]`;
	const statePath = (): string => join(stateDir(), cfg.stateFile);

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
				`${tag} ${statePath()} unreadable, starting from empty state: ` +
					(err instanceof Error ? err.message : String(err))
			);
			return empty;
		}
	}

	function writeState(s: ConvergeState): void {
		// Write-then-rename, fsync'd (F3, `lib/atomic-json.ts`). `readState` above
		// keeps its own corrupt-file-as-empty handling unchanged (recorded as a
		// divergence for 5c, not widened here).
		writeJsonAtomic(statePath(), s, { space: 2 });
	}

	/** One pass. Never throws: a broken pass is logged and retried next interval. */
	async function tick(
		run: ConvergeRunner<R>,
		now: number = Date.now()
	): Promise<ConvergeTickSummary> {
		const state = readState();
		state.lastRunAt = new Date(now).toISOString();
		const summary: ConvergeTickSummary = { ran: false, changed: 0, pages: 0, recoveries: 0 };
		const page = async (k: string, content: string) => {
			const last = state.paged[k] ? Date.parse(state.paged[k]) : null;
			if (last !== null && now - last < cfg.repageMs) return;
			state.paged[k] = new Date(now).toISOString();
			summary.pages++;
			await postDiscord(content, cfg.name);
		};
		const recover = async (k: string, content: string) => {
			if (!state.paged[k]) return;
			delete state.paged[k];
			summary.recoveries++;
			await postDiscord(content, cfg.name);
		};

		const { doc, why } = await run();
		if (!doc) {
			state.failingSince ??= state.lastRunAt;
			const failingFor = now - Date.parse(state.failingSince);
			logger.warn(`${tag} the converger produced no report: ${why}`);
			if (failingFor >= cfg.deferPageMs)
				await page(SELF_KEY, cfg.words.silent(hours(failingFor), why));
			writeState(state);
			return summary;
		}
		summary.ran = true;
		state.failingSince = null;
		await recover(SELF_KEY, cfg.words.reporting);

		for (const c of doc.changed) {
			summary.changed++;
			logger.info(`${tag} ${c.node} ${c.facet}: ${c.changed}`);
		}

		const open = new Set<string>();
		for (const r of doc.deferred) {
			const k = key(r);
			open.add(k);
			state.deferredSince[k] ??= state.lastRunAt;
			const deferredFor = now - Date.parse(state.deferredSince[k]);
			logger.info(`${tag} ${r.node} ${r.facet} deferred ${hours(deferredFor)}: ${r.why ?? ''}`);
			if (deferredFor >= cfg.deferPageMs) await page(k, cfg.words.deferred(r, hours(deferredFor)));
		}
		for (const r of doc.unconverged) {
			const k = key(r);
			open.add(k);
			delete state.deferredSince[k];
			logger.warn(`${tag} ${r.node} ${r.facet} did NOT converge: ${r.why ?? ''}`);
			await page(k, cfg.words.unconverged(r));
		}
		for (const u of doc.unreadable) {
			logger.warn(`${tag} ${u.node} ${u.facet} could not be read: ${u.why}`);
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
			await recover(k, cfg.words.recovered(node, facet));
		}

		writeState(state);
		return summary;
	}

	let started = false;
	let inFlight = false;
	let timers: ReturnType<typeof setTimeout>[] = [];

	function start(run: ConvergeRunner<R>): void {
		if (started) return;
		started = true;
		const pass = () => {
			if (inFlight) return;
			inFlight = true;
			tick(run)
				.then((s) => {
					if (s.changed || s.pages || s.recoveries) {
						logger.info(
							`${tag} pass: ${s.changed} change(s), ${s.pages} page(s), ${s.recoveries} recovery(ies)`
						);
					}
				})
				.catch((err: unknown) => {
					logger.warn(`${tag} pass threw: ${err instanceof Error ? err.message : String(err)}`);
				})
				.finally(() => {
					inFlight = false;
				});
		};
		const last = readState().lastRunAt;
		const sinceLast = last ? Date.now() - Date.parse(last) : Infinity;
		const firstIn = Math.max(
			cfg.firstPassMinMs,
			Math.min(cfg.intervalMs, cfg.intervalMs - sinceLast)
		);
		logger.info(
			`${tag} converger every ${cfg.intervalMs / 60_000} min, next in ${Math.round(firstIn / 60_000)} min`
		);
		const first = setTimeout(() => {
			pass();
			const every = setInterval(pass, cfg.intervalMs);
			every.unref?.();
			timers.push(every);
		}, firstIn);
		first.unref?.();
		timers.push(first);
	}

	function stopForTesting(): void {
		for (const t of timers) clearTimeout(t);
		timers = [];
		started = false;
		inFlight = false;
	}

	return { tick, start, stopForTesting };
}
