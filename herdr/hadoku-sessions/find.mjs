/**
 * Find a Claude Code session by what was typed into it; jump to it if it is
 * running, resume it if it is not.
 *
 *   node find.mjs [words...]          interactive picker (any terminal, or the herdr popup)
 *   node find.mjs --json [words...]   ranked results with liveness, as JSON
 *   node find.mjs --build             bring the index up to date and say what changed
 *   node find.mjs --enter [words...]  do what Enter would to the top result, and say what it did
 *
 * Enter on a LIVE session selects its tmux pane in the `claude` session. Enter
 * on a dead one opens a new window there, in the session's own directory, and
 * runs `claude --resume <id>` — refused when the transcript is not resumable
 * from that directory, the check `claude-tmux-session-hook` makes for the same
 * reason. A live session is never offered a resume: a second process on one
 * conversation is how three sessions came to be running twice on 2026-10-20.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
	build,
	defaultPaths,
	liveSessions,
	openIndex,
	resumable,
	search,
} from '../../scripts/lib/session-index.mjs';

const TMUX_SESSION = 'claude';
/** The markers `search()` asks FTS5's snippet() to put around a match. */
const HIT_ON = '\u0002';
const HIT_OFF = '\u0003';
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const words = args.filter((a) => !a.startsWith('--')).join(' ');
const paths = defaultPaths();

mkdirSync(dirname(paths.index), { recursive: true });
const db = openIndex(paths.index);

function refresh(progress) {
	const t0 = Date.now();
	const stats = build(db, paths.projects, { onProgress: progress });
	return { ...stats, ms: Date.now() - t0 };
}

function results(query, { liveOnly = false } = {}) {
	const { live, unresolved, tmux } = liveSessions(paths.registries);
	let rows = search(db, query, { limit: liveOnly ? 200 : 40 }).map((s) => ({
		...s,
		live: live.get(s.id) ?? [],
	}));
	if (liveOnly) rows = rows.filter((r) => r.live.length);
	// An empty query is "what was I doing": running sessions first, then recent.
	if (!query.trim()) rows.sort((a, b) => b.live.length - a.live.length || b.last_ts - a.last_ts);
	return { rows: rows.slice(0, 40), unresolved, tmux };
}

const tmux = (...a) =>
	execFileSync('tmux', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** What Enter will do for a row, said before it is done. */
function plan(row) {
	if (row.live.length) {
		const at = row.live.find((l) => l.tmux) ?? row.live[0];
		if (!at.tmux)
			return { kind: 'none', say: `running (pid ${at.pid}) outside tmux; nothing to jump to` };
		return { kind: 'jump', target: at.tmux, say: `jump to ${at.tmux}` };
	}
	const r = resumable(row);
	if (!r.ok) return { kind: 'none', say: `cannot resume: ${r.why}` };
	return { kind: 'resume', say: `resume in a new ${TMUX_SESSION} window in ${row.cwd}` };
}

function act(row) {
	const p = plan(row);
	if (p.kind === 'jump') {
		const [, rest] = p.target.split(':');
		const [win, pane] = rest.split('.');
		tmux('select-window', '-t', `${TMUX_SESSION}:${win}`);
		tmux('select-pane', '-t', pane);
		if (process.env.TMUX) tmux('switch-client', '-t', TMUX_SESSION);
		return `selected ${p.target}${process.env.TMUX ? '' : ` — attach with: tmux attach -t ${TMUX_SESSION}`}`;
	}
	if (p.kind === 'resume') {
		const name = (row.title ?? row.id).slice(0, 24);
		const pane = tmux(
			'new-window',
			'-d',
			'-P',
			'-F',
			'#{pane_id}',
			'-t',
			`${TMUX_SESSION}:`,
			'-c',
			row.cwd,
			'-n',
			name
		);
		tmux('send-keys', '-t', pane, `claude --resume ${row.id}`, 'Enter');
		return `resuming ${row.id} in ${TMUX_SESSION} pane ${pane}`;
	}
	return p.say;
}

function ago(ms) {
	if (!ms) return 'never';
	const m = Math.round((Date.now() - ms) / 60_000);
	if (m < 60) return `${m}m ago`;
	if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
	return `${Math.round(m / 1440)}d ago`;
}

const shortProject = (p) =>
	p.replace(/^-home-[^-]+-repos-/, '').replace(/--claude-worktrees-/, ' wt:');

if (flag('--build')) {
	console.log(JSON.stringify(refresh()));
	process.exit(0);
}

if (flag('--enter')) {
	refresh();
	const [top] = results(words).rows;
	if (!top) {
		console.error(`no session matches "${words}"`);
		process.exit(1);
	}
	console.log(act(top));
	process.exit(0);
}

if (flag('--json') || !process.stdin.isTTY) {
	const stats = refresh();
	const { rows, unresolved, tmux: hasTmux } = results(words);
	const out = rows.map((r) => ({
		id: r.id,
		title: r.title,
		project: r.project,
		cwd: r.cwd,
		branch: r.branch,
		lastAt: r.last_ts ? new Date(r.last_ts).toISOString() : null,
		prompts: r.prompts,
		hits: r.hits,
		snippet: r.snippet?.replaceAll(HIT_ON, '').replaceAll(HIT_OFF, '') ?? null,
		live: r.live,
		enter: plan(r).say,
	}));
	process.stdout.write(
		`${JSON.stringify({ index: stats, tmux: hasTmux, unresolvedPanes: unresolved, sessions: out }, null, 2)}\n`
	);
	process.exit(0);
}

// ── interactive ────────────────────────────────────────────────────────────

const out = process.stdout;
const ESC = '\x1b[';
let query = process.env.FIND_SEED ?? words;
let liveOnly = flag('--live');
let sel = 0;
let view = { rows: [], unresolved: [], tmux: true };
let status = '';

const fit = (s, w) => {
	let vis = 0;
	let res = '';
	// eslint-disable-next-line no-control-regex -- an ANSI escape IS a control character
	for (const part of s.split(/(\x1b\[[0-9;]*m)/)) {
		if (part.startsWith('\x1b[')) res += part;
		else {
			const room = w - vis;
			if (room <= 0) continue;
			res += part.slice(0, room);
			vis += Math.min(part.length, room);
		}
	}
	return res + `${ESC}0m`;
};

function draw() {
	const w = out.columns || 100;
	const h = out.rows || 30;
	const lines = [];
	lines.push(
		`${ESC}1mfind session${ESC}0m ${liveOnly ? `${ESC}32m[live only]${ESC}0m ` : ''}› ${query}${ESC}7m ${ESC}0m`
	);
	lines.push(
		`${ESC}2m${view.rows.length} shown · ↑↓ move · enter act · tab live-only · esc quit${ESC}0m`
	);
	if (!view.tmux)
		lines.push(`${ESC}33mno tmux server: nothing can be jumped to or resumed${ESC}0m`);
	if (view.unresolved.length) {
		lines.push(
			`${ESC}33m${view.unresolved.length} claude pane(s) whose session could not be identified: ${view.unresolved.join(' ')}${ESC}0m`
		);
	}
	const per = 2;
	const room = Math.max(1, Math.floor((h - lines.length - 2) / per));
	const top = Math.max(0, Math.min(sel - Math.floor(room / 2), view.rows.length - room));
	view.rows.slice(top, top + room).forEach((r, i) => {
		const on = top + i === sel;
		const live = r.live.length
			? `${ESC}32m● ${r.live.map((l) => l.status ?? 'live').join('/')}${ESC}0m `
			: `${ESC}2m○${ESC}0m `;
		const head = `${on ? `${ESC}7m` : ''}${live}${r.title ?? '(untitled)'}${on ? `${ESC}0m` : ''}`;
		const meta = `${ESC}2m · ${shortProject(r.project)} · ${ago(r.last_ts)} · ${r.prompts} prompts${ESC}0m`;
		lines.push(fit(`${head}${meta}`, w));
		const snip = (r.snippet ?? '')
			.replace(/\s+/g, ' ')
			.replaceAll(HIT_ON, `${ESC}33m`)
			.replaceAll(HIT_OFF, `${ESC}0m${ESC}2m`);
		lines.push(fit(`   ${ESC}2m${snip}${ESC}0m`, w));
	});
	const cur = view.rows[sel];
	lines.push('');
	lines.push(
		fit(`${ESC}36m${status || (cur ? `enter: ${plan(cur).say}` : 'no matches')}${ESC}0m`, w)
	);
	out.write(`${ESC}H${ESC}2J${lines.slice(0, h).join('\n')}`);
}

function update() {
	view = results(query, { liveOnly });
	sel = Math.min(sel, Math.max(0, view.rows.length - 1));
	draw();
}

function quit(code = 0, message = '') {
	out.write(`${ESC}?25h${ESC}?1049l`);
	if (message) console.log(message);
	process.exit(code);
}

// Raw mode BEFORE the first build: the build is synchronous, and keys typed
// while it runs would otherwise echo into the terminal instead of queueing.
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
// One chunk can carry several keys — everything typed during a build arrives
// at once — so it is split into escape sequences and single characters first.
// eslint-disable-next-line no-control-regex -- terminal keys are escape sequences
const KEYS = /\x1b\[[0-9;]*[A-Za-z~]|\x1b|[\s\S]/g;
process.stdin.on('data', (chunk) => {
	for (const key of chunk.match(KEYS) ?? []) onKey(key);
});

function onKey(key) {
	status = '';
	if (key === '\x1b' || key === '\x03') return quit();
	if (key === '\x1b[A' || key === '\x10') sel = Math.max(0, sel - 1);
	else if (key === '\x1b[B' || key === '\x0e') sel = Math.min(view.rows.length - 1, sel + 1);
	else if (key === '\t') {
		liveOnly = !liveOnly;
		sel = 0;
		return update();
	} else if (key === '\r') {
		const row = view.rows[sel];
		if (!row) return draw();
		try {
			return quit(0, act(row));
		} catch (err) {
			status = `failed: ${String(err.stderr || err.message).trim()}`;
			return draw();
		}
	} else if (key === '\x7f' || key === '\b') {
		query = query.slice(0, -1);
		sel = 0;
		return update();
	} else if (key === '\x15') {
		query = '';
		sel = 0;
		return update();
	} else if (!key.startsWith('\x1b') && key >= ' ') {
		query += key;
		sel = 0;
		return update();
	}
	draw();
}

out.write(`${ESC}?1049h${ESC}?25l`);
status = 'indexing…';
draw();
const stats = refresh((i, n) => {
	if (i % 25 === 0) {
		status = `indexing ${i}/${n}…`;
		draw();
	}
});
status = stats.read
	? `index: ${stats.added} new, ${stats.read} read, ${stats.prompts} prompts in ${stats.ms}ms`
	: '';
update();
