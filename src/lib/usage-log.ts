/**
 * THE INVOCATION LOG — runtime evidence of which doors anybody opens.
 *
 * The question it exists for (refactor plan 2026-10-28 §4.2): which of the
 * CLI's subcommands and the router's routes does nobody use, so they can be
 * deleted. Grep cannot answer that. It cannot see cron profiles in another
 * repo, an operator over ssh, an agent's shell, or a copy deployed somewhere
 * the source tree does not mention. So the door writes down who came through.
 *
 * WHAT A RECORD MAY NEVER HOLD
 * ----------------------------
 * Flag VALUES and positional arguments. `--token`, `--address`, `--out` and a
 * repo name are all values a caller typed, and the log is a file anybody on
 * the box can read for half a year. Only flag NAMES are kept, and only names
 * that look like names (`flagNames` below) — `-5` is a value, not a flag.
 *
 * WHAT IT MAY NEVER DO
 * --------------------
 * Write to stdout (`--json` is a contract: mgmt-api parses it), change an exit
 * code, or make a command slower than a `stat` and an append. Every failure is
 * caught by the caller and reported on STDERR at most once per process.
 *
 * WHERE IT LANDS: `<state dir>/fleet-usage/usage-YYYY-MM.jsonl`, see
 * `usageDir`. Storage itself is `usage-store.ts`.
 */
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { appendUsage } from './usage-store.js';

/** Bumped when a field changes meaning. Readers skip versions they do not know. */
export const USAGE_SCHEMA = 1;

/**
 * Every route `routes/fleet.ts` serves, by its Express PATTERN.
 *
 * Declared rather than read off the router, so `fleet usage` can list the
 * routes nobody hit without importing the whole runtime half. The router test
 * holds this list and the router's own stack equal, so a route added there
 * without being added here fails the build.
 */
export const FLEET_ROUTES: readonly string[] = [
	'GET /fleet',
	'GET /fleet/ci-state',
	'POST /fleet/job-history/backfill',
];

/**
 * The log directory, or `null` for "do not log".
 *
 *   FLEET_USAGE_DIR=<path>  log there (tests name a temp dir this way)
 *   FLEET_USAGE_DIR=off     do not log
 *   under a test runner     do not log, unless FLEET_USAGE_DIR names a dir
 *   otherwise               `<state dir>/fleet-usage`
 *
 * THE TEST-RUNNER RULE IS WHY TESTS CANNOT LEAK. `node --test` sets
 * NODE_TEST_CONTEXT in every test process, and every test here that spawns the
 * CLI passes `...process.env` or names its own HADOKU_STATE_DIR. Without the
 * rule, one that did neither would append to the operator's real
 * `~/.hadoku-mgmt` — and worse than the leak, its invocations would be COUNTED
 * as usage, which is the one thing this log must not get wrong. A fixture HOME
 * is not isolation (it has bitten hokon twice); a log that switches itself off
 * under a test runner is.
 */
export function usageDir(stateDir: () => string): string | null {
	const env = process.env.FLEET_USAGE_DIR?.trim();
	if (env === 'off') return null;
	if (env) return env;
	if (process.env.NODE_TEST_CONTEXT || process.env.VITEST) return null;
	return join(stateDir(), 'fleet-usage');
}

const FLAG_NAME = /^--?[A-Za-z][\w-]*$/;

/**
 * Flag NAMES from an argv, values stripped, deduplicated, in first-seen order.
 * `--machine=claw-3` is `--machine`; `--` ends flags; anything that is not
 * shaped like a flag name (`-5`, `--=x`, a path) is dropped, not truncated.
 */
export function flagNames(argv: readonly string[]): string[] {
	const out: string[] = [];
	for (const a of argv) {
		if (a === '--') break;
		if (!a.startsWith('-')) continue;
		const name = a.split('=')[0];
		if (FLAG_NAME.test(name) && !out.includes(name)) out.push(name);
	}
	return out;
}

/** A subcommand name as typed. Unknown ones are kept so a typo'd door shows up, but only name-shaped. */
export function subName(raw: string | undefined): string | null {
	if (raw === undefined) return null;
	return /^[\w.:-]{1,64}$/.test(raw) ? raw : '<not-a-name>';
}

export interface CallerHints {
	/** stdout is a terminal — a person, almost always. */
	tty: boolean;
	/** `comm` of the parent, then grandparent, … up to six, nearest first. */
	ancestry: string[];
	/** The PM2 app name, when PM2 started the caller (mgmt-api's crons: `mgmt-api`). */
	pm2: string | null;
	/** `FLEET_CALLER`, when a caller names itself — the one hint that names a cron JOB. */
	declared: string | null;
	/** GitHub Actions. */
	ci: boolean;
	/** A coding agent's shell (`CLAUDECODE` / `AI_AGENT`). */
	agent: boolean;
	/** An ssh session (`SSH_CONNECTION`). */
	ssh: boolean;
}

/** `comm` and parent pid of a process, from /proc. Null off Linux or once it is gone. */
function procStat(pid: number): { comm: string; ppid: number } | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
		// "pid (comm) state ppid …" — comm may itself hold spaces and parens.
		const open = stat.indexOf('(');
		const close = stat.lastIndexOf(')');
		const ppid = Number(stat.slice(close + 2).split(' ')[1]);
		return { comm: stat.slice(open + 1, close), ppid };
	} catch {
		return null;
	}
}

function ancestry(): string[] {
	const out: string[] = [];
	let pid = process.ppid;
	for (let i = 0; i < 6 && pid > 1; i++) {
		const s = procStat(pid);
		if (!s) break;
		out.push(s.comm);
		pid = s.ppid;
	}
	return out;
}

const SAFE_LABEL = /^[\w:./-]{1,80}$/;
const label = (v: string | undefined): string | null => (v && SAFE_LABEL.test(v) ? v : null);

export function callerHints(): CallerHints {
	return {
		tty: process.stdout.isTTY === true,
		ancestry: ancestry(),
		pm2: process.env.pm_id !== undefined ? label(process.env.name) : null,
		declared: label(process.env.FLEET_CALLER),
		ci: process.env.GITHUB_ACTIONS === 'true',
		agent: process.env.CLAUDECODE === '1' || Boolean(process.env.AI_AGENT),
		ssh: Boolean(process.env.SSH_CONNECTION),
	};
}

/**
 * ONE word for who called, most specific evidence first. The raw hints ride
 * along in the record, so a wrong guess here is re-derivable, not lost.
 */
export function callerOf(h: CallerHints): string {
	if (h.declared) return h.declared;
	if (h.pm2) return `pm2:${h.pm2}`;
	if (h.ci) return 'github-actions';
	if (h.agent) return 'agent';
	if (h.ancestry.some((c) => /^(cron|crond|anacron)$/i.test(c))) return 'cron';
	if (h.ssh) return h.tty ? 'ssh-tty' : 'ssh';
	if (h.tty) return 'tty';
	return 'other';
}

/** How the door disposed of an invocation. */
export type CliOutcome =
	| 'ran'
	| 'usage'
	| 'door-help'
	| 'unknown-subcommand'
	| 'refused-flags'
	| 'missing-script'
	| 'spawn-error';

export interface CliRecord {
	v: number;
	kind: 'cli';
	at: string;
	version: string;
	host: string;
	sub: string | null;
	known: boolean;
	outcome: CliOutcome;
	flags: string[];
	exit: number | null;
	signal: string | null;
	ms: number;
	caller: string;
	hints: CallerHints;
}

export interface RouteRecord {
	v: number;
	kind: 'route';
	/** When this bucket was written. */
	at: string;
	/** When its first hit arrived. */
	from: string;
	version: string;
	host: string;
	method: string;
	route: string;
	status: number;
	count: number;
	msTotal: number;
	msMax: number;
}

/**
 * The CLI's recorder: build once, `finish` at every exit. Never throws; a
 * failed write goes to stderr once, unless FLEET_NO_BANNER=1 asked for fd 2 to
 * stay byte-identical.
 */
export function cliRecorder(opts: {
	version: () => string;
	stateDir: () => string;
	argv: readonly string[];
	known: (sub: string) => boolean;
}): (fate: { outcome: CliOutcome; exit: number | null; signal?: string | null }) => void {
	const [sub, ...rest] = opts.argv;
	let done = false;
	return (fate) => {
		if (done) return;
		done = true;
		try {
			const dir = usageDir(opts.stateDir);
			if (!dir) return;
			const hints = callerHints();
			const record: CliRecord = {
				v: USAGE_SCHEMA,
				kind: 'cli',
				at: new Date().toISOString(),
				version: opts.version(),
				host: hostname(),
				sub: subName(sub),
				known: sub !== undefined && opts.known(sub),
				outcome: fate.outcome,
				flags: flagNames(rest),
				exit: fate.exit,
				signal: fate.signal ?? null,
				ms: Math.round(performance.now()),
				caller: callerOf(hints),
				hints,
			};
			appendUsage(dir, record);
		} catch (err) {
			if (process.env.FLEET_NO_BANNER !== '1') {
				process.stderr.write(
					`fleet: invocation log not written (${err instanceof Error ? err.message : String(err)})\n`
				);
			}
		}
	};
}

// ── routes ──────────────────────────────────────────────────────────────────

/**
 * Route hits are COUNTED in memory and written as one bucket per
 * (method, route, status) every few minutes — not one line per request. The
 * command station polls `GET /fleet` for as long as somebody watches it, and a
 * line per poll would make this log mostly a record of how long a browser tab
 * was open. A crash loses at most one window of counts, which the question
 * ("is this route used AT ALL") does not notice.
 */
export const ROUTE_FLUSH_MS = 5 * 60_000;

interface Bucket {
	from: number;
	method: string;
	route: string;
	status: number;
	count: number;
	msTotal: number;
	msMax: number;
}

const buckets = new Map<string, Bucket>();
let flushTimer: NodeJS.Timeout | null = null;
let routeDir: (() => string | null) | null = null;
let routeVersion: () => string = () => 'unknown';
let routeWarned = false;

/** Write every pending bucket now. Sync, so it is safe from an `exit` handler. */
export function flushRouteHits(): void {
	if (!buckets.size || !routeDir) return;
	const pending = [...buckets.values()];
	buckets.clear();
	try {
		const dir = routeDir();
		if (!dir) return;
		const now = new Date();
		const host = hostname();
		const version = routeVersion();
		for (const b of pending) {
			const record: RouteRecord = {
				v: USAGE_SCHEMA,
				kind: 'route',
				at: now.toISOString(),
				from: new Date(b.from).toISOString(),
				version,
				host,
				method: b.method,
				route: b.route,
				status: b.status,
				count: b.count,
				msTotal: Math.round(b.msTotal),
				msMax: Math.round(b.msMax),
			};
			appendUsage(dir, record, now);
		}
	} catch (err) {
		if (!routeWarned) {
			routeWarned = true;
			process.stderr.write(
				`[fleet] route usage log not written (${err instanceof Error ? err.message : String(err)})\n`
			);
		}
	}
}

/**
 * Count one served request. `route` is the PATTERN (`/fleet`), never the raw
 * path, so an id in a URL can never reach the log.
 */
export function recordRouteHit(
	hit: { method: string; route: string; status: number; ms: number },
	ctx: { stateDir: () => string; version: () => string }
): void {
	if (!routeDir) {
		routeDir = () => usageDir(ctx.stateDir);
		routeVersion = ctx.version;
		process.on('exit', flushRouteHits);
	}
	const key = `${hit.method} ${hit.route} ${hit.status}`;
	const b = buckets.get(key);
	if (b) {
		b.count++;
		b.msTotal += hit.ms;
		b.msMax = Math.max(b.msMax, hit.ms);
	} else {
		buckets.set(key, {
			from: Date.now(),
			method: hit.method,
			route: hit.route,
			status: hit.status,
			count: 1,
			msTotal: hit.ms,
			msMax: hit.ms,
		});
	}
	if (!flushTimer) {
		flushTimer = setTimeout(() => {
			flushTimer = null;
			flushRouteHits();
		}, ROUTE_FLUSH_MS);
		flushTimer.unref();
	}
}

// ── the reader's arithmetic, pure ───────────────────────────────────────────

export interface CommandUsage {
	sub: string;
	count: number;
	lastAt: string | null;
	callers: Record<string, number>;
	exits: Record<string, number>;
	outcomes: Record<string, number>;
	hosts: string[];
	flags: Record<string, number>;
}

export interface RouteUsage {
	route: string;
	count: number;
	lastAt: string | null;
	statuses: Record<string, number>;
	msMax: number;
}

export interface UsageSummary {
	since: string;
	records: number;
	commands: CommandUsage[];
	/** Declared in COMMANDS, zero invocations in the window. Deletion CANDIDATES, not verdicts. */
	unusedCommands: string[];
	/** Names typed at the door that are not in COMMANDS: typos, or a caller of something already deleted. */
	unknownCommands: CommandUsage[];
	routes: RouteUsage[];
	unusedRoutes: string[];
}

const bump = (o: Record<string, number>, k: string, n = 1): void => {
	o[k] = (o[k] ?? 0) + n;
};

/**
 * Per-subcommand and per-route counts over records already filtered by the
 * caller's window. `commands`/`routes` are the DECLARED doors, so a door with
 * no record is listed as unused rather than silently absent.
 */
export function summariseUsage(
	records: readonly Record<string, unknown>[],
	opts: { sinceMs: number; commands: readonly string[]; routes: readonly string[] }
): UsageSummary {
	const declared = new Set(opts.commands);
	const bySub = new Map<string, CommandUsage>();
	const byRoute = new Map<string, RouteUsage>();
	let counted = 0;
	for (const r of records) {
		if (r.v !== USAGE_SCHEMA) continue;
		const at = typeof r.at === 'string' ? Date.parse(r.at) : NaN;
		if (!Number.isFinite(at) || at < opts.sinceMs) continue;
		counted++;
		if (r.kind === 'cli') {
			const sub = typeof r.sub === 'string' ? r.sub : '(none)';
			let u = bySub.get(sub);
			if (!u) {
				u = {
					sub,
					count: 0,
					lastAt: null,
					callers: {},
					exits: {},
					outcomes: {},
					hosts: [],
					flags: {},
				};
				bySub.set(sub, u);
			}
			u.count++;
			if (!u.lastAt || (r.at as string) > u.lastAt) u.lastAt = r.at as string;
			bump(u.callers, typeof r.caller === 'string' ? r.caller : 'other');
			bump(
				u.exits,
				typeof r.signal === 'string'
					? r.signal
					: typeof r.exit === 'number'
						? String(r.exit)
						: 'null'
			);
			bump(u.outcomes, typeof r.outcome === 'string' ? r.outcome : 'unknown');
			if (typeof r.host === 'string' && !u.hosts.includes(r.host)) u.hosts.push(r.host);
			if (Array.isArray(r.flags))
				for (const f of r.flags) if (typeof f === 'string') bump(u.flags, f);
		} else if (r.kind === 'route') {
			const route = `${String(r.method)} ${String(r.route)}`;
			let u = byRoute.get(route);
			if (!u) {
				u = { route, count: 0, lastAt: null, statuses: {}, msMax: 0 };
				byRoute.set(route, u);
			}
			const n = typeof r.count === 'number' ? r.count : 1;
			u.count += n;
			if (!u.lastAt || (r.at as string) > u.lastAt) u.lastAt = r.at as string;
			bump(u.statuses, String(r.status), n);
			if (typeof r.msMax === 'number') u.msMax = Math.max(u.msMax, r.msMax);
		}
	}
	const byCount = <T extends { count: number }>(a: T, b: T): number => b.count - a.count;
	const all = [...bySub.values()];
	return {
		since: new Date(opts.sinceMs).toISOString(),
		records: counted,
		commands: all.filter((u) => declared.has(u.sub)).sort(byCount),
		unusedCommands: opts.commands.filter((c) => !bySub.has(c)).sort(),
		unknownCommands: all.filter((u) => !declared.has(u.sub)).sort(byCount),
		routes: [...byRoute.values()].sort(byCount),
		unusedRoutes: opts.routes.filter((r) => !byRoute.has(r)),
	};
}
