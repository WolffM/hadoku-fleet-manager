/**
 * One fleet pane: read the shared snapshot, judge one target, report it to
 * herdr as this pane's agent state, and draw the reason.
 *
 *   node watch.mjs node:claw-1 | ci | fleet
 *
 * Run through supervise.sh, never bare: herdr clears a pane's agent when the
 * process holding it exits, and the supervisor is what turns a crash here into
 * a red pane instead of a missing one. The judging lives in
 * `scripts/lib/herdr-fleet.mjs`, where the tests are.
 *
 * The classifier is imported only after `staleBuild` says `dist/` matches
 * `src/`, and the watcher exits with RELOAD_EXIT the moment any file it loaded
 * changes, so a pane never judges with code that is no longer on disk.
 */

import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	codeFiles,
	fingerprint,
	RELOAD_EXIT,
	staleBuild,
} from '../../scripts/lib/herdr-fleet-freshness.mjs';

const TICK_MS = 15_000;
const target = process.argv[2];
const pane = process.env.HERDR_PANE_ID;
const herdr = process.env.HERDR_BIN_PATH ?? 'herdr';
const stateDir = process.env.FLEET_HERDR_STATE;
const apiBase = process.env.FLEET_API_URL ?? 'http://127.0.0.1:4000/api';
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const label = target?.replace(/^node:/, '');

if (!target || !pane || !stateDir) {
	console.error(
		'usage: FLEET_HERDR_STATE=<dir> HERDR_PANE_ID=<pane> node watch.mjs <node:NAME|ci|fleet>'
	);
	process.exit(2);
}

/**
 * WHICH TREE IS RUNNING. A linked plugin runs whatever this checkout holds,
 * published or not, so the pane says so — otherwise this is the next
 * deployed-not-published trap.
 */
function sourceLabel() {
	const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
	const git = (...args) =>
		execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim();
	try {
		const dirty = git('status', '--porcelain', '--', 'herdr', 'scripts/lib', 'src');
		return `${version}@${git('rev-parse', '--short', 'HEAD')}${dirty ? '+dirty' : ''}`;
	} catch (err) {
		return `${version} (not a git checkout: ${String(err.message).split('\n')[0]})`;
	}
}

/** What `open` gave panes. pm2Hosts is null for a workspace opened before pm2 panes existed. */
function panes() {
	try {
		const p = JSON.parse(readFileSync(join(stateDir, 'panes.json'), 'utf8'));
		return { nodes: p.nodes ?? [], pm2Hosts: p.pm2Hosts ?? null };
	} catch (err) {
		if (err?.code === 'ENOENT') return { nodes: [], pm2Hosts: null };
		throw err;
	}
}

const source = sourceLabel();
let last = null;

function report(verdict) {
	const key = `${verdict.state}\u0000${verdict.message}`;
	if (key === last) return;
	const args = ['pane', 'report-agent', pane, '--source', 'hadoku.fleet', '--agent', label];
	args.push('--state', verdict.state, '--message', verdict.message, '--seq', String(Date.now()));
	execFile(herdr, args, (err, _out, stderr) => {
		// Not remembered on failure, so the next tick tries again.
		if (err) console.error(`report-agent failed: ${String(stderr || err.message).trim()}`);
		else last = key;
	});
	const meta = ['pane', 'report-metadata', pane, '--source', 'hadoku.fleet:display'];
	meta.push('--token', `summary=${verdict.message}`, '--token', `src=${source}`);
	execFile(herdr, meta, (err, _out, stderr) => {
		if (err) console.error(`report-metadata failed: ${String(stderr || err.message).trim()}`);
	});
}

function draw(verdict, snap) {
	const now = Date.now();
	const age = snap?.fetchedAt
		? `${Math.round((now - Date.parse(snap.fetchedAt)) / 1000)}s`
		: 'none';
	const lines = [
		`${label}  ${verdict.state.toUpperCase()}`,
		verdict.message,
		'',
		...verdict.detail,
		'',
		`read ${new Date(now).toISOString()}  snapshot age ${age}  source ${source}`,
	];
	process.stdout.write(`\x1b[2J\x1b[H${lines.join('\n')}\n`);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));

const stale = staleBuild(repoRoot);
if (stale.length) {
	// Stay up and red until the build catches up, then hand over to a fresh
	// process: this one never loaded the classifier, so it cannot judge.
	const verdict = {
		state: 'blocked',
		message: `dist/ is stale: run pnpm run build in ${repoRoot}`,
		detail: stale.map((s) => `stale    ${s}`),
	};
	report(verdict);
	draw(verdict, null);
	setInterval(() => {
		if (staleBuild(repoRoot).length === 0) process.exit(RELOAD_EXIT);
	}, TICK_MS);
} else {
	const { classify, loadSnapshot } = await import('../../scripts/lib/herdr-fleet.mjs');
	const { readPm2 } = await import('../../scripts/lib/herdr-pm2.mjs');
	const files = codeFiles(repoRoot);
	const loaded = fingerprint(files);

	const tick = async () => {
		if (fingerprint(files) !== loaded) process.exit(RELOAD_EXIT);
		let snap = null;
		let verdict;
		try {
			snap = await loadSnapshot(stateDir, apiBase, { pm2Reader: readPm2 });
			const { nodes, pm2Hosts } = panes();
			verdict = classify(target, snap, Date.now(), nodes, pm2Hosts);
		} catch (err) {
			verdict = {
				state: 'blocked',
				message: `watcher error: ${err.message}`,
				detail: [String(err.stack)],
			};
		}
		report(verdict);
		draw(verdict, snap);
	};
	await tick();
	setInterval(tick, TICK_MS);
}
