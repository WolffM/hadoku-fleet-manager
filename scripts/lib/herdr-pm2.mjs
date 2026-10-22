/**
 * What the pm2 panes of hadoku.fleet read: where each service SHOULD run, from
 * the deployed tree's own config, and what each pm2 host is ACTUALLY running,
 * from that host's daemon.
 *
 * Desired state comes from the DEPLOYED hadoku_site (`deploySiteRoot()`):
 * `scripts/pm2-hosts.json` names the hosts, and the generated
 * `services/mgmt-api/deploy-config.json` places each service. That is what
 * mgmt-api resolves, not the operator's working checkout.
 *
 * Observed state is one `pm2 jlist` per host per snapshot, over the same
 * transport every fleet script uses. mgmt-api's `/placement/:service/processes`
 * answers the same question one service at a time, at ~0.57 s and an ssh to
 * every remote host EACH (measured 2026-10-20) — 17 services made that ~10 s
 * and 17 connections per refresh.
 *
 * `pm2 jlist` CARRIES EVERY PROCESS'S ENVIRONMENT, and the services' tokens are
 * in it: hokon's was 260 KB. So the list is reduced ON THE HOST, to the six
 * fields below, before a byte leaves it. Nothing here ever holds an env, and
 * the snapshot written to disk cannot either. `herdr-fleet.test.mjs` runs the
 * real reducer over a list carrying a planted secret and checks it is gone.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runOn } from './fleet-exec.mjs';
import { deploySiteRoot } from './manifest-target.mjs';

/**
 * Runs on the pm2 host. The reducer is node because pm2 is: a host with pm2
 * has node. BEGIN/END bracket the document so a cut-off read is an error, not
 * a shorter list.
 */
export const JLIST_SCRIPT = `
command -v pm2 >/dev/null 2>&1 || { echo "PM2-ERR pm2 is not on PATH"; exit 0; }
echo PM2-BEGIN
pm2 jlist 2>/dev/null | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
	let list;
	try {
		list = JSON.parse(s.replace(/^\\uFEFF/, "").trim() || "[]");
	} catch (e) {
		console.log("PM2-ERR pm2 jlist did not parse: " + JSON.stringify(s.slice(0, 80)));
		return;
	}
	console.log(JSON.stringify(list.map((p) => ({
		name: p.name,
		status: p.pm2_env?.status ?? null,
		restarts: p.pm2_env?.restart_time ?? null,
		unstable: p.pm2_env?.unstable_restarts ?? null,
		since: p.pm2_env?.pm_uptime ?? null,
		cwd: p.pm2_env?.pm_cwd ?? null,
	}))));
});' || echo "PM2-ERR the reducer failed"
echo PM2-END
`;

/** The reduced process list from {@link JLIST_SCRIPT}'s output, or a reason it is not one. */
export function parseJlist(out) {
	const err = out.match(/^PM2-ERR (.*)$/m);
	if (err) return { procs: null, error: err[1] };
	const m = out.match(/^PM2-BEGIN\n([\s\S]*?)^PM2-END$/m);
	if (!m) return { procs: null, error: 'pm2 listing incomplete (no PM2-END)' };
	try {
		return { procs: JSON.parse(m[1].trim()), error: null };
	} catch (e) {
		return { procs: null, error: `pm2 listing is not JSON: ${e.message}` };
	}
}

/**
 * Hosts and placements from the deployed tree. Throws with the path on a
 * missing or unreadable file: the caller turns that into a blocked pane.
 */
export function readPlacement(root = deploySiteRoot()) {
	const read = (rel) => {
		const path = join(root, rel);
		try {
			return JSON.parse(readFileSync(path, 'utf8'));
		} catch (e) {
			throw new Error(`${path}: ${e.code ?? e.message}`, { cause: e });
		}
	};
	const hostsDoc = read('scripts/pm2-hosts.json');
	const config = read('services/mgmt-api/deploy-config.json');
	const hub = hostsDoc.hub;
	if (!hub || !hostsDoc.hosts?.[hub])
		throw new Error('pm2-hosts.json names no hub among its hosts');
	return {
		hub,
		hosts: Object.keys(hostsDoc.hosts),
		services: (config.services ?? []).map((s) => ({
			name: s.name,
			pm2: s.pm2Service ?? s.name,
			host: s.host ?? hub,
			enabled: s.enabled !== false,
		})),
	};
}

/**
 * Everything the pm2 panes judge from. Never throws: a failure is carried as
 * `error` (the placement could not be read) or per host (that host could not
 * be read), and every pane that depends on it reads blocked.
 */
export async function readPm2({ root, run = runOn } = {}) {
	let placement;
	try {
		placement = readPlacement(root);
	} catch (e) {
		return { error: `placement unreadable: ${e.message}`, hosts: {}, services: [] };
	}
	const hosts = {};
	await Promise.all(
		placement.hosts.map(async (name) => {
			const r = await run(name, JLIST_SCRIPT, { timeoutMs: 60_000, maxBuffer: 8 * 1024 * 1024 });
			const parsed = r.ok || r.stdout ? parseJlist(r.stdout) : { procs: null, error: null };
			hosts[name] = {
				hub: name === placement.hub,
				procs: parsed.procs,
				error: parsed.error ?? (parsed.procs ? null : `could not reach ${name}: ${r.error}`),
			};
		})
	);
	return { error: null, hub: placement.hub, hosts, services: placement.services };
}
