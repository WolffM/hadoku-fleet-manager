/**
 * WHO is filling a node's /tmp, asked on that node at the moment the disk
 * watch is about to say so.
 *
 * The /tmp advisory used to carry a guess — "something that ignores TMPDIR"
 * — and `find /tmp -maxdepth 1 -mmin +60`, which names OLD leftovers. On
 * 2026-11-08 hokon's /tmp went under the advisory line and both pointed the
 * wrong way: the space was four 2.4 GB sqlite copies made within the last
 * few hours in a live Claude Code session's scratchpad
 * (`/tmp/claude-<uid>/<project>/<session>/scratchpad`, always on /tmp
 * whatever TMPDIR says), plus a script's `tempfile.mkdtemp` copy. Nothing
 * there was old, and nothing ignored TMPDIR in the sense the hint meant.
 *
 * So the alert now carries evidence instead: the largest RECENT files on the
 * /tmp filesystem, and the largest Claude session directories under
 * `/tmp/claude-*`, each with its size and age, read on the node itself.
 *
 * BOUNDED AND NEVER IN THE WAY. One shell round-trip, a hard timeout, a few
 * lines out. The caller (`runner-health-watch.ts`'s `checkDiskWatch`) asks
 * only when the alert is actually due to post, and a probe that fails says
 * WHY in the alert and leaves the alert itself untouched — the reading that
 * fired it came from a different probe and is not in doubt.
 */
import { execFile } from 'node:child_process';

import { nodeShell } from '../node-shell.js';

/** A regular file at least this large counts as a consumer worth naming. */
export const TMP_CONSUMER_MIN_FILE_MB = 500;
/** ...if it was modified within this many minutes. */
export const TMP_CONSUMER_RECENT_MIN = 120;
/** At most this many entries per list in the probe's output. */
export const TMP_CONSUMER_TOP = 5;
/** A Claude session directory smaller than this is not worth a line. */
export const TMP_CONSUMER_MIN_SESSION_MB = 100;
/** At most this many lines in the alert. */
export const TMP_CONSUMER_ALERT_LINES = 5;
/** The whole round-trip, ssh included. `find`/`du` inside get less. */
export const TMP_CONSUMER_TIMEOUT_MS = 20_000;

/** One consumer: an absolute path, its size, and how long since it last changed. */
export interface TmpConsumer {
	path: string;
	bytes: number;
	ageS: number;
}

export interface TmpConsumers {
	/** Large files modified recently, largest first. */
	files: TmpConsumer[];
	/** Claude session directories (`claude-*` / project / session), largest first. */
	sessions: TmpConsumer[];
}

export type TmpConsumerProbe = (
	node: string
) => Promise<{ ok: true; consumers: TmpConsumers } | { ok: false; why: string }>;

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The probe, one shell script. `root` is /tmp in production and a fixture
 * directory in tests — the same script either way.
 *
 * Output, tab-separated, one record per line: `N <now>` (the node's clock, so
 * ages never mix two clocks), then `F <bytes> <mtime> <path>` per large
 * recent file and `S <kbytes> <mtime> <path>` per session directory, where a
 * session's mtime is its NEWEST file's. `-xdev` keeps both on /tmp's own
 * filesystem. Errors (another user's unreadable directory) are dropped: the
 * probe reports what it could see, and the lists are evidence, not a census.
 */
export function tmpConsumersCmd(
	root = '/tmp',
	{
		minFileMb = TMP_CONSUMER_MIN_FILE_MB,
		recentMin = TMP_CONSUMER_RECENT_MIN,
		top = TMP_CONSUMER_TOP,
	} = {}
): string {
	const r = shQuote(root);
	const t = Math.max(1, Math.floor((TMP_CONSUMER_TIMEOUT_MS - 5000) / 2000));
	return (
		'printf "N\\t%s\\n" "$(date +%s)"; ' +
		`timeout ${t} find ${r} -xdev -type f -size +${minFileMb}M -mmin -${recentMin} ` +
		`-printf "F\\t%s\\t%T@\\t%p\\n" 2>/dev/null | sort -t "$(printf "\\t")" -k2,2nr | head -${top}; ` +
		`timeout ${t} du -sk ${r}/claude-*/*/*/ 2>/dev/null | sort -rn | head -${top} | ` +
		'while IFS="$(printf "\\t")" read -r k p; do ' +
		'p=${p%/}; ' +
		'm=$(find "$p" -xdev -type f -printf "%T@\\n" 2>/dev/null | sort -n | tail -1); ' +
		'printf "S\\t%s\\t%s\\t%s\\n" "$k" "${m%.*}" "$p"; ' +
		'done; true'
	);
}

/**
 * Parse {@link tmpConsumersCmd}'s output. `null` when there is no `N` line —
 * the script did not run, which is a failed probe, never "no consumers".
 */
export function parseTmpConsumers(out: string): TmpConsumers | null {
	let now: number | null = null;
	const files: TmpConsumer[] = [];
	const sessions: TmpConsumer[] = [];
	for (const line of out.split(/\r?\n/)) {
		const f = line.split('\t');
		if (f[0] === 'N' && /^\d+$/.test(f[1] ?? '')) now = Number(f[1]);
	}
	if (now === null) return null;
	for (const line of out.split(/\r?\n/)) {
		const [tag, size, mtime, ...rest] = line.split('\t');
		const path = rest.join('\t');
		if ((tag !== 'F' && tag !== 'S') || !path || !/^\d+$/.test(size ?? '')) continue;
		const known = /^\d+(?:\.\d+)?$/.test(mtime ?? '');
		const entry = {
			path,
			bytes: tag === 'F' ? Number(size) : Number(size) * 1024,
			ageS: known ? Math.max(0, now - Math.floor(Number(mtime))) : -1,
		};
		(tag === 'F' ? files : sessions).push(entry);
	}
	const bySize = (a: TmpConsumer, b: TmpConsumer) => b.bytes - a.bytes;
	return { files: files.sort(bySize), sessions: sessions.sort(bySize) };
}

function humanSize(bytes: number): string {
	const gb = bytes / 1024 ** 3;
	if (gb >= 1) return `${Math.round(gb * 10) / 10}GB`;
	return `${Math.round(bytes / 1024 ** 2)}MB`;
}

function humanAge(ageS: number): string {
	if (ageS < 0) return 'age unknown';
	if (ageS < 3600) return `${Math.max(1, Math.round(ageS / 60))}m ago`;
	if (ageS < 48 * 3600) return `${Math.round((ageS / 3600) * 10) / 10}h ago`;
	return `${Math.round(ageS / 86400)}d ago`;
}

/**
 * The alert's evidence lines, at most {@link TMP_CONSUMER_ALERT_LINES}:
 * Claude sessions first (the one consumer always on /tmp), then large recent
 * files that are not already inside a listed session, all ranked by size.
 * Sessions under {@link TMP_CONSUMER_MIN_SESSION_MB} are dropped. Empty when
 * nothing qualifies — the caller says so in words.
 */
export function formatTmpConsumers(c: TmpConsumers): string[] {
	const sessions = c.sessions.filter((s) => s.bytes >= TMP_CONSUMER_MIN_SESSION_MB * 1024 ** 2);
	const inListed = (p: string) => sessions.some((s) => p.startsWith(`${s.path}/`));
	const rows = [
		...sessions.map((s) => ({ ...s, kind: 'claude session' })),
		...c.files.filter((f) => !inListed(f.path)).map((f) => ({ ...f, kind: 'file' })),
	]
		.sort((a, b) => b.bytes - a.bytes)
		.slice(0, TMP_CONSUMER_ALERT_LINES);
	return rows.map(
		(r) => `• \`${r.path}\` ${humanSize(r.bytes)}, last written ${humanAge(r.ageS)} (${r.kind})`
	);
}

/** Run `tmpConsumersCmd()` through `bin argv`, with the timeout, and parse it. */
export function runTmpConsumerProbe(
	bin: string,
	argv: readonly string[]
): ReturnType<TmpConsumerProbe> {
	return new Promise((res) => {
		execFile(
			bin,
			[...argv],
			{ timeout: TMP_CONSUMER_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
			(err, stdout, stderr) => {
				if (err) {
					const detail = String(stderr).trim().split('\n').pop() ?? '';
					const why = err.killed
						? `timed out after ${TMP_CONSUMER_TIMEOUT_MS / 1000}s`
						: `${err.message.split('\n')[0]}${detail ? ` — ${detail}` : ''}`;
					res({ ok: false, why });
					return;
				}
				const consumers = parseTmpConsumers(String(stdout));
				res(
					consumers
						? { ok: true, consumers }
						: { ok: false, why: 'the probe printed nothing parseable' }
				);
			}
		);
	});
}

/**
 * The production probe: {@link tmpConsumersCmd} on `node` as ADMIN — the
 * operator's own Claude sessions are admin's, and admin can read at least as
 * much of /tmp as ci can. Locally on the controller, over ssh elsewhere.
 */
export const probeTmpConsumers: TmpConsumerProbe = (node) => {
	let bin: string;
	let argv: string[];
	try {
		[bin, argv] = nodeShell(node, 'admin', tmpConsumersCmd());
	} catch (err) {
		return Promise.resolve({
			ok: false,
			why: err instanceof Error ? err.message : String(err),
		});
	}
	return runTmpConsumerProbe(bin, argv);
};
