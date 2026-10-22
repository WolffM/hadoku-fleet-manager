/**
 * Find a Claude Code session by what was TYPED into it, and say whether it is
 * still running and where.
 *
 * Ported in idea from Ruben's promptKB (Forest-Protocols/fleet,
 * `dashboard/activity/promptkb.py` at a44957d, Apache-2.0): index the human's prompts,
 * retrieve SESSIONS, and let a session that keeps mentioning a term outrank
 * one that mentions it once. The code is new; hokon is one machine with one
 * coder, so his mirroring, identity hashing and multi-coder extractors have no
 * counterpart here.
 *
 * WHERE THE DATA IS, MEASURED 2026-10-20
 * --------------------------------------
 * Every account dir under `~/.claude-accounts/` symlinks
 * `projects/` to ONE `~/.claude/projects`, so transcripts are read once from
 * there. What is per-account is the running-session registry,
 * `<config dir>/sessions/<pid>.json` — and `~/.claude/sessions` itself has been
 * empty since the account split, so a reader of that one dir sees nothing
 * live. 463 top-level transcripts held 3.3 GB and 4.2 MB of human prompts; the
 * largest single transcript was 333 MB. `subagents/` transcripts are not
 * sessions anyone typed into and are skipped.
 *
 * APPEND-ONLY, SO READ FROM WHERE WE STOPPED
 * ------------------------------------------
 * A transcript only ever grows. Each file's byte offset is stored, and a build
 * reads only what was appended since — a busy session costs its new lines, not
 * a reparse of 300 MB. A file that SHRANK was rewritten and is read again from
 * zero. Only complete lines are consumed: a line still being written is left
 * for the next build.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	closeSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	readSync,
	statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const INDEX_VERSION = '3';

/** One prompt is capped here: a pasted log is searchable by its head, not stored whole. */
export const MAX_PROMPT_CHARS = 20_000;

const CHUNK = 4 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const defaultPaths = () => {
	const home = homedir();
	const state = process.env.XDG_STATE_HOME || join(home, '.local', 'state');
	return {
		projects: join(home, '.claude', 'projects'),
		index: join(state, 'hadoku-sessions', 'index.db'),
		registries: [
			join(home, '.claude', 'sessions'),
			...listDir(join(home, '.claude-accounts')).map((a) =>
				join(home, '.claude-accounts', a, 'sessions')
			),
		],
	};
};

function listDir(dir) {
	try {
		return readdirSync(dir);
	} catch (err) {
		if (err?.code === 'ENOENT') return [];
		throw err;
	}
}

/**
 * Harness wrappers that arrive as `user` records but were not typed. Two
 * `<`-prefixed shapes ARE human input and are kept: a paste, and a `!` shell
 * command. Ruben's filter drops every `<`-prefixed record, which on hokon
 * would lose both.
 */
const KEEP_WRAPPED = [
	['pasted', /^<pasted_content[^>]*>([\s\S]*?)(?:<\/pasted_content>|$)/],
	['shell', /^<bash-input>([\s\S]*?)<\/bash-input>/],
];

/**
 * The human-typed text of one transcript record, or null.
 *
 * `isMeta` marks what the harness injected — another session's message, a
 * scheduled check-in, a hook — and is dropped. `isSidechain` is a subagent's
 * turn. Tool results arrive as `user` records whose content is a list with no
 * text part, so they fall out by having no text.
 */
export function promptOf(record) {
	if (record?.type !== 'user' || record.isMeta || record.isSidechain) return null;
	let content = record.message?.content;
	if (Array.isArray(content)) {
		content = content
			.filter((part) => part?.type === 'text')
			.map((part) => part.text)
			.join('\n');
	}
	if (typeof content !== 'string') return null;
	const text = content.trim();
	if (!text) return null;
	if (!text.startsWith('<')) return { kind: 'typed', text: text.slice(0, MAX_PROMPT_CHARS) };
	for (const [kind, re] of KEEP_WRAPPED) {
		const m = text.match(re);
		if (m && m[1].trim()) return { kind, text: m[1].trim().slice(0, MAX_PROMPT_CHARS) };
	}
	return null;
}

const NEEDLES = [Buffer.from('"type":"user"'), Buffer.from('"type":"ai-title"')];

/**
 * Read a transcript from `offset` to its last complete line.
 *
 * Returns the prompts and metadata found, and the offset to resume from. Lines
 * are decoded only when a byte search says they could hold a prompt or a
 * title; on a 300 MB transcript nearly every byte is assistant output and
 * tool results.
 */
export function readTranscript(path, offset = 0) {
	const fd = openSync(path, 'r');
	const out = {
		prompts: [],
		title: null,
		cwd: null,
		branch: null,
		firstTs: null,
		lastTs: null,
		bad: 0,
	};
	let carry = Buffer.alloc(0);
	let pos = offset;
	let consumed = offset;
	try {
		const buf = Buffer.alloc(CHUNK);
		for (;;) {
			const n = readSync(fd, buf, 0, CHUNK, pos);
			if (n === 0) break;
			pos += n;
			let data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
			let start = 0;
			for (let nl = data.indexOf(10, start); nl !== -1; nl = data.indexOf(10, start)) {
				const line = data.subarray(start, nl);
				if (NEEDLES.some((needle) => line.indexOf(needle) !== -1)) take(line, out);
				consumed += nl - start + 1;
				start = nl + 1;
			}
			carry = Buffer.from(data.subarray(start));
			data = null;
		}
	} finally {
		closeSync(fd);
	}
	return { ...out, offset: consumed };
}

function take(line, out) {
	let r;
	try {
		r = JSON.parse(line.toString('utf8'));
	} catch (err) {
		// Counted, not fatal: one torn line must not cost the rest of a session,
		// and `build` reports the count so a corrupt store is visible.
		if (!(err instanceof SyntaxError)) throw err;
		out.bad++;
		return;
	}
	if (r.type === 'ai-title') {
		if (typeof r.aiTitle === 'string' && r.aiTitle.trim()) out.title = r.aiTitle.trim();
		return;
	}
	const p = promptOf(r);
	if (!p) return;
	const ts = Date.parse(r.timestamp ?? '');
	out.prompts.push({ ...p, ts: Number.isFinite(ts) ? ts : null });
	// The FIRST cwd: the launch directory, which is what the transcript is
	// filed under and what `--resume` must run from. The agent `cd`s; in 100 of
	// 461 sessions on hokon the last cwd was somewhere else.
	if (r.cwd) out.cwd ??= r.cwd;
	if (r.gitBranch) out.branch = r.gitBranch;
	if (Number.isFinite(ts)) {
		out.firstTs ??= ts;
		out.lastTs = ts;
	}
}

export function openIndex(path) {
	const db = new DatabaseSync(path);
	db.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL;');
	db.exec(`
		CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
		CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, session TEXT, size INTEGER, offset INTEGER, head TEXT);
		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY, path TEXT, project TEXT, cwd TEXT, branch TEXT, title TEXT,
			first_ts INTEGER, last_ts INTEGER, prompts INTEGER DEFAULT 0);
		CREATE VIRTUAL TABLE IF NOT EXISTS prompts USING fts5(
			body, session UNINDEXED, kind UNINDEXED, ts UNINDEXED, tokenize = 'porter unicode61');
	`);
	const v = db.prepare("SELECT value FROM meta WHERE key = 'version'").get()?.value;
	if (v !== INDEX_VERSION) {
		db.exec('DROP TABLE files; DELETE FROM sessions; DELETE FROM prompts;');
		db.exec(
			'CREATE TABLE files (path TEXT PRIMARY KEY, session TEXT, size INTEGER, offset INTEGER, head TEXT)'
		);
		db.prepare("INSERT OR REPLACE INTO meta VALUES ('version', ?)").run(INDEX_VERSION);
	}
	return db;
}

/**
 * A hash of a transcript's first `len` bytes, where `len` never exceeds what
 * was already read — so an append cannot change it and a rewrite almost always
 * does, including one that comes back LONGER, which the size check alone would
 * read from a stale offset, mid-content.
 */
const HEAD_BYTES = 256;
function headOf(path, len) {
	const fd = openSync(path, 'r');
	try {
		const buf = Buffer.alloc(len);
		const n = readSync(fd, buf, 0, len, 0);
		return createHash('sha1').update(buf.subarray(0, n)).digest('hex');
	} finally {
		closeSync(fd);
	}
}

/** Top-level `<project>/<uuid>.jsonl` files. Subdirectories (subagents) are not walked. */
export function transcripts(projectsDir) {
	const out = [];
	for (const project of listDir(projectsDir)) {
		const dir = join(projectsDir, project);
		for (const f of listDir(dir)) {
			if (f.endsWith('.jsonl') && UUID.test(f.slice(0, -6))) out.push(join(dir, f));
		}
	}
	return out;
}

/**
 * Bring the index up to date with `projectsDir`. Returns what it did, so a
 * caller can say "indexed 3 new sessions" instead of nothing.
 */
export function build(db, projectsDir, { onProgress } = {}) {
	const files = transcripts(projectsDir);
	const known = new Map(
		db
			.prepare('SELECT path, session, size, offset, head FROM files')
			.all()
			.map((r) => [r.path, r])
	);
	const stats = {
		files: files.length,
		read: 0,
		reset: 0,
		added: 0,
		removed: 0,
		prompts: 0,
		badLines: 0,
	};
	const q = {
		file: db.prepare('INSERT OR REPLACE INTO files VALUES (?, ?, ?, ?, ?)'),
		dropPrompts: db.prepare('DELETE FROM prompts WHERE session = ?'),
		dropTitle: db.prepare("DELETE FROM prompts WHERE session = ? AND kind = 'title'"),
		dropSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
		dropFile: db.prepare('DELETE FROM files WHERE path = ?'),
		prompt: db.prepare('INSERT INTO prompts (body, session, kind, ts) VALUES (?, ?, ?, ?)'),
		session: db.prepare('SELECT * FROM sessions WHERE id = ?'),
		upsert: db.prepare(`INSERT OR REPLACE INTO sessions
			(id, path, project, cwd, branch, title, first_ts, last_ts, prompts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
	};
	db.exec('BEGIN IMMEDIATE');
	try {
		let i = 0;
		for (const path of files) {
			onProgress?.(++i, files.length);
			const id = basename(path, '.jsonl');
			let size;
			try {
				size = statSync(path).size;
			} catch (err) {
				if (err?.code === 'ENOENT') continue;
				throw err;
			}
			const prev = known.get(path);
			known.delete(path);
			if (prev && prev.size === size && prev.offset <= size) continue;
			const head = prev ? headOf(path, Math.min(HEAD_BYTES, prev.offset)) : null;
			let from = prev?.offset ?? 0;
			// Shorter, or a different first line: rewritten, not appended to.
			if (prev && (size < prev.offset || head !== prev.head)) {
				from = 0;
				stats.reset++;
			}
			if (!prev) stats.added++;
			if (from === 0) {
				q.dropPrompts.run(id);
				q.dropSession.run(id);
			}
			const got = readTranscript(path, from);
			stats.read++;
			stats.badLines += got.bad;
			const s = q.session.get(id) ?? { prompts: 0 };
			for (const p of got.prompts) q.prompt.run(p.text, id, p.kind, p.ts);
			stats.prompts += got.prompts.length;
			const title = got.title ?? s.title ?? null;
			if (got.title && got.title !== s.title) {
				q.dropTitle.run(id);
				q.prompt.run(got.title, id, 'title', null);
			}
			q.upsert.run(
				id,
				path,
				basename(join(path, '..')),
				s.cwd ?? got.cwd ?? null,
				got.branch ?? s.branch ?? null,
				title,
				s.first_ts ?? got.firstTs,
				got.lastTs ?? s.last_ts ?? null,
				(s.prompts ?? 0) + got.prompts.length
			);
			q.file.run(path, id, size, got.offset, headOf(path, Math.min(HEAD_BYTES, got.offset)));
		}
		for (const gone of known.values()) {
			q.dropPrompts.run(gone.session);
			q.dropSession.run(gone.session);
			q.dropFile.run(gone.path);
			stats.removed++;
		}
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
	return stats;
}

/**
 * The FTS5 expression for what someone typed into a search box. Every word
 * must match, as a prefix, and nothing they type is FTS syntax — `claw-5`,
 * an unbalanced quote or `NOT` are words, not a parse error.
 */
export function ftsQuery(text) {
	const words = String(text ?? '').match(/[\p{L}\p{N}_]+/gu) ?? [];
	return words.map((w) => `"${w}"*`).join(' ');
}

/**
 * Sessions matching `text`, best first. A session's score is the SUM of its
 * matching prompts' bm25, so repeated mention outranks a single one. An empty
 * query lists the most recent sessions.
 */
export function search(db, text, { limit = 30 } = {}) {
	const expr = ftsQuery(text);
	if (!expr) {
		return db
			.prepare(
				'SELECT *, NULL AS score, 0 AS hits, NULL AS snippet FROM sessions ORDER BY last_ts DESC LIMIT ?'
			)
			.all(limit);
	}
	// MATERIALIZED, or the planner folds bm25() into the aggregate, which FTS5
	// refuses ("unable to use function bm25 in the requested context").
	const ranked = db
		.prepare(
			`WITH hit AS MATERIALIZED (
			   SELECT session, bm25(prompts) AS rank FROM prompts WHERE prompts MATCH ?)
			 SELECT session, sum(rank) AS score, count(*) AS hits FROM hit
			 GROUP BY session ORDER BY score LIMIT ?`
		)
		.all(expr, limit);
	const best = db.prepare(
		`SELECT snippet(prompts, 0, '\u0002', '\u0003', '…', 16) AS snippet FROM prompts
		 WHERE prompts MATCH ? AND session = ? ORDER BY bm25(prompts) LIMIT 1`
	);
	const info = db.prepare('SELECT * FROM sessions WHERE id = ?');
	return ranked.map((r) => ({
		...info.get(r.session),
		score: r.score,
		hits: r.hits,
		snippet: best.get(expr, r.session)?.snippet ?? null,
	}));
}

/** Field 22 of /proc/<pid>/stat: the process start time, which a reused pid does not share. */
export function procStart(pid, read = readFileSync) {
	try {
		return read(`/proc/${pid}/stat`, 'utf8').split(') ').pop().split(' ')[19];
	} catch (err) {
		if (err?.code === 'ENOENT' || err?.code === 'ESRCH') return null;
		throw err;
	}
}

/**
 * Running sessions from every account's registry: sessionId -> where it runs.
 *
 * A registry file outlives its process when Claude is killed, and a pid gets
 * reused, so a file only counts when its pid is alive AND started when the
 * file says it did. One session can be live in several panes at once — seen
 * on hokon 2026-10-20, three sessions each attached in two panes — so the
 * value is a list.
 */
export function liveFromRegistries(registryDirs, { start = procStart } = {}) {
	const live = new Map();
	for (const dir of registryDirs) {
		const account = basename(join(dir, '..')) === '.claude' ? 'default' : basename(join(dir, '..'));
		for (const f of listDir(dir)) {
			if (!f.endsWith('.json')) continue;
			let r;
			try {
				r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
			} catch (err) {
				// Claude rewrites these in place; a torn read is a file mid-write,
				// and the next refresh reads it whole.
				if (err instanceof SyntaxError) continue;
				throw err;
			}
			if (!r?.sessionId || !r.pid || start(r.pid) !== String(r.procStart)) continue;
			const at = {
				pid: r.pid,
				account,
				tmux: r.tmux ?? null,
				status: r.status ?? null,
				name: r.name ?? null,
			};
			live.set(r.sessionId, [...(live.get(r.sessionId) ?? []), at]);
		}
	}
	return live;
}

/**
 * The project directory Claude files a cwd's transcripts under: '/', '.' and
 * '_' all fold to '-'. The rule is `claude-tmux-session-hook`'s, and it is
 * what `claude --resume <id>` looks the transcript up by.
 */
export const projectKey = (cwd) => cwd.replace(/[/._]/g, '-');

/** Can `claude --resume` find this session from its recorded cwd? */
export function resumable(session) {
	if (!session?.cwd) return { ok: false, why: 'no working directory recorded' };
	if (projectKey(session.cwd) !== session.project) {
		return {
			ok: false,
			why: `filed under ${session.project}, not ${projectKey(session.cwd)} (moved or renamed?)`,
		};
	}
	return { ok: true, why: null };
}

const SID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/**
 * Live sessions the registry did not name, found from tmux.
 *
 * Registry files vanish while their sessions keep running (seen 2026-10-12,
 * recorded in `claude-tmux-session-hook`), and a live session shown as dead
 * invites a second `--resume` of it. So every tmux pane running `claude` that
 * no registry entry claims is resolved the way that hook resolves it: walk the
 * pane's process tree, and take the session id from an open scratch-dir handle
 * (`/tmp/claude-<uid>/<project>/<id>`), else from `--resume <id>` on the
 * command line. A pane neither finds is reported as unresolved, not dropped.
 *
 * `sys` is the process table, injected so the rule is testable without tmux.
 */
export function liveFromPanes(panes, claimed, sys) {
	const found = new Map();
	const unresolved = [];
	for (const pane of panes) {
		if (pane.command !== 'claude' || claimed.has(pane.paneId)) continue;
		let sid = null;
		for (const pid of sys.descendants(pane.pid)) {
			const scratch = sys
				.fdTargets(pid)
				.find((t) => t.startsWith(`/tmp/claude-${sys.uid}/`) && SID.test(t));
			sid =
				scratch?.match(SID)[0] ??
				sys.cmdline(pid).match(new RegExp(`--resume (${SID.source})`))?.[1];
			if (sid) break;
		}
		const at = { pid: pane.pid, account: null, tmux: pane.target, status: null, name: null };
		if (sid) found.set(sid, [...(found.get(sid) ?? []), at]);
		else unresolved.push(pane.target);
	}
	return { found, unresolved };
}

/** The real process table, for {@link liveFromPanes}. */
export function realSys() {
	const children = (pid) => {
		try {
			return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
				.split('\n')
				.filter(Boolean);
		} catch (err) {
			if (err.status === 1) return []; // pgrep: no children
			throw err;
		}
	};
	const descendants = (pid) => [String(pid), ...children(pid).flatMap(descendants)];
	const gone = (err) => err?.code === 'ENOENT' || err?.code === 'EACCES' || err?.code === 'ESRCH';
	return {
		uid: process.getuid(),
		descendants,
		fdTargets: (pid) => {
			try {
				return readdirSync(`/proc/${pid}/fd`).flatMap((fd) => {
					try {
						return [readlinkSync(`/proc/${pid}/fd/${fd}`)];
					} catch (err) {
						if (gone(err)) return [];
						throw err;
					}
				});
			} catch (err) {
				if (gone(err)) return [];
				throw err;
			}
		},
		cmdline: (pid) => {
			try {
				return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
			} catch (err) {
				if (gone(err)) return '';
				throw err;
			}
		},
	};
}

/**
 * Every tmux pane, or null when there is no tmux server — which is "nothing
 * runs in tmux", not "could not look", and is said as such by the caller.
 */
export function tmuxPanes() {
	let out;
	try {
		out = execFileSync(
			'tmux',
			[
				'list-panes',
				'-a',
				'-F',
				'#{session_name}:#{window_id}.#{pane_id}|#{pane_pid}|#{pane_current_command}',
			],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
		);
	} catch (err) {
		if (err.code === 'ENOENT' || /no server running/.test(String(err.stderr))) return null;
		throw err;
	}
	return out
		.split('\n')
		.filter(Boolean)
		.map((line) => {
			const [target, pid, command] = line.split('|');
			return { target, paneId: target.split('.').pop(), pid: Number(pid), command };
		});
}

/** Registry first, tmux for whatever the registry missed. */
export function liveSessions(registryDirs, { panes = tmuxPanes(), sys = realSys() } = {}) {
	const live = liveFromRegistries(registryDirs);
	const claimed = new Set(
		[...live.values()].flat().flatMap((at) => (at.tmux ? [at.tmux.split('.').pop()] : []))
	);
	const { found, unresolved } = liveFromPanes(panes ?? [], claimed, sys);
	for (const [sid, ats] of found) live.set(sid, [...(live.get(sid) ?? []), ...ats]);
	return { live, unresolved, tmux: panes !== null };
}
