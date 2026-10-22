/**
 * hadoku.fleet.open — build the `fleet` workspace: a `gates` tab holding the
 * `fleet` and `ci` panes, and a `nodes` tab with one pane per node in the
 * live /fleet roster.
 *
 * The roster comes from GET /fleet, not the manifest: the panes show what the
 * server reports on, and the `fleet` pane flags any node that appears later
 * without a pane. An open that cannot read the roster REFUSES, loudly, rather
 * than building a workspace of zero nodes that looks like a quiet fleet.
 *
 * Idempotent by label: a second open focuses the existing workspace.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { staleBuild } from '../../scripts/lib/herdr-fleet-freshness.mjs';

const LABEL = 'fleet';
const herdr = process.env.HERDR_BIN_PATH ?? 'herdr';
const root = process.env.HERDR_PLUGIN_ROOT ?? process.cwd();
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
const apiBase = process.env.FLEET_API_URL ?? 'http://127.0.0.1:4000/api';

const h = (...args) => JSON.parse(execFileSync(herdr, args, { encoding: 'utf8' })).result;

function refuse(message) {
	console.error(`hadoku.fleet.open: ${message}`);
	execFileSync(herdr, [
		'notification',
		'show',
		'hadoku.fleet: cannot open',
		'--body',
		message,
		'--sound',
		'request',
	]);
	process.exit(1);
}

if (!stateDir) refuse('HERDR_PLUGIN_STATE_DIR is not set; run this as the plugin action');

const repoRoot = join(root, '..', '..');
const stale = staleBuild(repoRoot);
if (stale.length) refuse(`dist/ is stale (${stale.join(', ')}): run pnpm run build in ${repoRoot}`);
const { loadSnapshot } = await import('../../scripts/lib/herdr-fleet.mjs');
const { readPm2 } = await import('../../scripts/lib/herdr-pm2.mjs');

const existing = h('workspace', 'list').workspaces.find((w) => w.label === LABEL);
if (existing) {
	h('workspace', 'focus', existing.workspace_id);
	process.exit(0);
}

const snap = await loadSnapshot(stateDir, apiBase, { pm2Reader: readPm2 });
if (snap?.error || !snap?.fleet?.success) {
	refuse(`could not read the /fleet roster: ${snap?.error ?? 'no success'}`);
}
const nodes = snap.fleet.machines.map((m) => m.name);
if (nodes.length === 0) refuse('/fleet reports zero machines');
// An unreadable placement leaves no pm2 hosts to pane. The rest still opens:
// the `fleet` pane reports the pm2 error, and once it reads, the missing
// hosts as "no pm2 pane".
const pm2Hosts = Object.keys(snap.pm2?.hosts ?? {});

const env = ['--env', `FLEET_HERDR_STATE=${stateDir}`];
if (process.env.FLEET_API_URL) env.push('--env', `FLEET_API_URL=${apiBase}`);
const q = (s) => `'${s.replaceAll("'", "'\\''")}'`;
// `pane run` answers with an empty stdout, so it is not parsed.
const start = (paneId, target) =>
	execFileSync(herdr, ['pane', 'run', paneId, `${q(join(root, 'supervise.sh'))} ${q(target)}`]);

// Written BEFORE any watcher starts, so the `fleet` pane's first tick already
// knows which nodes and pm2 hosts have panes.
writeFileSync(
	join(stateDir, 'panes.json'),
	JSON.stringify({ nodes, pm2Hosts, openedAt: new Date().toISOString() })
);

/**
 * A tab of two equal columns of equal rows, one pane per target. `--ratio` is
 * the share the ORIGINAL pane keeps (measured on 0.9.5), so splitting the
 * newest pane at 1/remaining leaves every row the same height.
 */
function grid(label, targets) {
	const tab = h(
		'tab',
		'create',
		'--workspace',
		wsId,
		'--label',
		label,
		'--cwd',
		root,
		...env,
		'--no-focus'
	);
	const half = Math.ceil(targets.length / 2);
	const columns = [targets.slice(0, half), targets.slice(half)];
	const tops = [tab.root_pane.pane_id];
	if (columns[1].length) {
		tops.push(
			h('pane', 'split', tops[0], '--direction', 'right', ...env, '--no-focus').pane.pane_id
		);
	}
	columns.forEach((column, c) => {
		let pane = tops[c];
		column.forEach((target, i) => {
			if (i > 0) {
				const ratio = String(1 / (column.length - i + 1));
				pane = h(
					'pane',
					'split',
					pane,
					'--direction',
					'down',
					'--ratio',
					ratio,
					...env,
					'--no-focus'
				).pane.pane_id;
			}
			start(pane, target);
		});
	});
}

const ws = h('workspace', 'create', '--label', LABEL, '--cwd', root, ...env, '--focus');
const wsId = ws.workspace.workspace_id;
try {
	h('tab', 'rename', ws.tab.tab_id, 'gates');
	const fleetPane = ws.root_pane.pane_id;
	const ciPane = h('pane', 'split', fleetPane, '--direction', 'right', ...env, '--no-focus').pane
		.pane_id;
	start(fleetPane, 'fleet');
	start(ciPane, 'ci');

	grid(
		'nodes',
		nodes.map((n) => `node:${n}`)
	);
	if (pm2Hosts.length)
		grid(
			'pm2',
			pm2Hosts.map((h) => `pm2:${h}`)
		);
} catch (err) {
	// A half-built workspace would pass the idempotency check on the next open
	// and never be completed, so it is torn down before refusing.
	execFileSync(herdr, ['workspace', 'close', wsId]);
	refuse(`building the workspace failed and it was closed: ${err.message}`);
}
