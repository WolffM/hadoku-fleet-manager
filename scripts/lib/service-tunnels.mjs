/**
 * service-tunnels — each pm2 service host's OWN Cloudflare tunnel, converged
 * from declarations instead of `cloudflared tunnel create` by hand (service-
 * hosts plan P1, 2026-10-27).
 *
 * WHAT IT OWNS, PER NON-HUB HOST IN hadoku_site's `scripts/pm2-hosts.json`
 * -----------------------------------------------------------------------
 *   tunnel      a Cloudflare tunnel NAMED AFTER THE NODE (claw-4's is `claw-4`).
 *               Created through the API when absent. A pm2-hosts.json `tunnel`
 *               naming anything else is a finding, never acted on.
 *   creds       /etc/cloudflared/<id>.json. Cloudflare keeps the secret, not the
 *               vault (hadoku_site, 2026-10-27): `GET …/cfd_tunnel/<id>/token`
 *               returns it whenever asked, so a reimaged host gets its file back
 *               and the tunnel id and CNAMEs stay put. Its contents never reach a
 *               log line, a finding or the JSON report.
 *   config      /etc/cloudflared/config.yml, rendered from the apps PLACED on the
 *               host (`host`, or `standby` so a switchover is only a DNS move) plus
 *               the 404 catch-all. Byte-identical to claw-4's hand-made file for
 *               the same inputs, so converging claw-4 restarts nothing.
 *   unit        cloudflared.service, claw-4's unit verbatim.
 *
 * WHAT IT DOES NOT OWN: DNS. `service-move.mjs` points `<app>.hadoku.me` at a
 * host at cutover, and two writers of one record is the race that file's
 * single-writer rules exist to prevent. This READS each primary placement's
 * CNAME and reports one that points elsewhere.
 *
 * VERIFIED FROM BOTH ENDS, NEVER FROM WHAT WAS WRITTEN: the host's own
 * cloudflared answers `/ready` with a connectorId, and Cloudflare's connection
 * list for that tunnel must carry the SAME connector with live connections. A
 * primary placement must also answer `https://<hostname>/health` through it.
 *
 * THE TOKEN exists only in a process mgmt-api spawned (`ci:toolchain-refresh`
 * inherits its vault mirror). A run without it cannot ask Cloudflare anything,
 * and says so as a finding: "could not look" is never "fine".
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { hostsPm2Services } from '../../dist/lib/node-role.js';

export const TOKEN_ENV = 'CLOUDFLARE_TUNNEL_API_TOKEN';
export const ZONE = 'hadoku.me';
const API = 'https://api.cloudflare.com/client/v4';
const ETC = '/etc/cloudflared';
const UNIT_PATH = '/etc/systemd/system/cloudflared.service';
/** cloudflared's default metrics ports: it takes the first free one. */
const METRICS_PORTS = [20241, 20242, 20243, 20244, 20245];

/** claw-4's unit, byte for byte (sha256 5c47829f… pinned in the test). */
export const UNIT = `[Unit]
Description=Cloudflare Tunnel client
After=network-online.target
Wants=network-online.target

[Service]
TimeoutStartSec=15
Type=notify
ExecStart=/usr/bin/cloudflared --no-autoupdate --config ${ETC}/config.yml tunnel run
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
`;

/**
 * The hosts this owns: every non-hub pm2-hosts.json host whose manifest entry
 * declares `services: "pm2"`. The hub's tunnel is hadoku_site's, under pm2.
 */
export function tunnelHosts(manifest, hostsDoc) {
	const hub = hostsDoc.hub;
	return Object.entries(hostsDoc.hosts ?? {})
		.filter(([node]) => node !== hub && hostsPm2Services(manifest.machines?.[node]))
		.map(([node, h]) => ({ node, declared: h.tunnel ?? null }));
}

/**
 * What a host's ingress must route: apps whose `host` or `standby` is this node,
 * with the port and hostname hadoku_site's own tools use (`service-move.mjs`).
 */
export function placementsFor(node, childApps) {
	const out = [];
	for (const app of childApps.apps ?? []) {
		const role = app.host === node ? 'primary' : app.standby === node ? 'standby' : null;
		if (!role) continue;
		const port = app.tunnel?.port ?? app.handWired?.port;
		if (!port) continue;
		out.push({
			id: app.id,
			role,
			port: String(port),
			hostname: app.handWired?.hostname ?? `${app.id}.${ZONE}`,
			...(role === 'primary' && app.standby ? { standby: app.standby } : {}),
		});
	}
	return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Where the APP LAYER runs a pm2 service today: its `host`, or the hub when it
 * names none, for an app with a port (`tunnel` or `handWired`). `app` matches
 * the row's `tenant` or its `id`. Null when no row is a service by that name.
 * The hosting converger reads it before giving a service its first slice:
 * an app already running somewhere is MOVED there, never started a second
 * time beside itself (fleet-manager#16).
 */
export function appLayerHost(app, { hostsDoc, childApps }) {
	const row = (childApps.apps ?? []).find((a) => a.tenant === app || a.id === app);
	if (!row || !(row.tunnel?.port ?? row.handWired?.port)) return null;
	return row.host ?? hostsDoc.hub ?? null;
}

export function renderConfig(tunnelId, placements) {
	const rules = placements.map(
		(p) => `  - hostname: ${p.hostname}\n    service: http://127.0.0.1:${p.port}\n`
	);
	return (
		`tunnel: ${tunnelId}\ncredentials-file: ${ETC}/${tunnelId}.json\ningress:\n` +
		`${rules.join('')}  - service: http_status:404\n`
	);
}

/** A tunnel run token (base64 JSON `{a, t, s}`) as cloudflared's credentials file. */
export function credentialsFromRunToken(runToken) {
	const { a, t, s } = JSON.parse(Buffer.from(runToken, 'base64').toString('utf8'));
	if (!a || !t || !s) throw new Error('run token is missing a, t or s');
	return `${JSON.stringify({ AccountTag: a, TunnelSecret: s, TunnelID: t })}\n`;
}

/** One read of what the host is actually running. Prints no secret. */
export const OBSERVE = `
c="$(base64 -w0 ${ETC}/config.yml 2>/dev/null)"; printf 'CONFIG %s\\n' "\${c:--}"
printf 'CREDS %s\\n' "$(sudo -n find ${ETC} -maxdepth 1 -name '*.json' -printf '%f ' 2>/dev/null)"
u="$(base64 -w0 ${UNIT_PATH} 2>/dev/null)"; printf 'UNIT %s\\n' "\${u:--}"
e="$(systemctl is-enabled cloudflared 2>/dev/null)"; a="$(systemctl is-active cloudflared 2>/dev/null)"; printf 'STATE %s %s\\n' "\${e:--}" "\${a:--}"
for p in ${METRICS_PORTS.join(' ')}; do r="$(curl -s -m 3 127.0.0.1:$p/ready 2>/dev/null)"; case "$r" in *connectorId*) printf 'READY %s\\n' "$r"; break;; esac; done
`;

export function parseObserve(out) {
	const line = (k) => out.match(new RegExp(`^${k} (.*)$`, 'm'))?.[1] ?? null;
	const b64 = (v) => (v && v !== '-' ? Buffer.from(v, 'base64').toString('utf8') : null);
	const [enabled, active] = (line('STATE') ?? '- -').split(' ');
	let ready = null;
	try {
		ready = line('READY') ? JSON.parse(line('READY')) : null;
	} catch {
		ready = { unparseable: line('READY') };
	}
	return {
		config: b64(line('CONFIG')),
		creds: (line('CREDS') ?? '').split(' ').filter(Boolean),
		unit: b64(line('UNIT')),
		enabled,
		active,
		ready,
	};
}

/** The shell that brings a host to `want`. `creds` is written only when given. */
export function repairScript({ tunnelId, config, creds, writeUnit, restart }) {
	const put = (path, body, mode) =>
		`printf '%s' '${Buffer.from(body).toString('base64')}' | base64 -d | ` +
		`sudo -n install -m ${mode} -o root -g root /dev/stdin ${path}`;
	const steps = ['set -eu', `sudo -n install -d -m 0755 ${ETC}`];
	if (creds) steps.push(put(`${ETC}/${tunnelId}.json`, creds, '0600'));
	if (config) steps.push(put(`${ETC}/config.yml`, config, '0644'));
	if (writeUnit) steps.push(put(UNIT_PATH, UNIT, '0644'), 'sudo -n systemctl daemon-reload');
	steps.push('sudo -n systemctl enable cloudflared >/dev/null 2>&1');
	steps.push(
		restart ? 'sudo -n systemctl restart cloudflared' : 'sudo -n systemctl start cloudflared'
	);
	return steps.join('\n');
}

/**
 * Cloudflare's v4 API, one call per method. Every failure returns `{ok:false,
 * why}` naming the status and Cloudflare's own message: a 403 here is a missing
 * token permission, not a bug, and the finding has to say which call it was.
 */
export function cloudflare(token, fetchImpl = fetch) {
	async function call(method, path, body) {
		let res;
		try {
			res = await fetchImpl(`${API}${path}`, {
				method,
				headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
				body: body ? JSON.stringify(body) : undefined,
				signal: AbortSignal.timeout(20_000),
			});
		} catch (err) {
			return { ok: false, why: `${method} ${path}: ${err.message}` };
		}
		let doc = null;
		try {
			doc = await res.json();
		} catch {
			doc = null;
		}
		if (!res.ok || !doc?.success) {
			const msg = doc?.errors?.map((e) => `${e.code} ${e.message}`).join('; ') || 'no body';
			return { ok: false, why: `${method} ${path}: HTTP ${res.status} (${msg})` };
		}
		return { ok: true, result: doc.result };
	}
	return {
		zone: (name) => call('GET', `/zones?name=${encodeURIComponent(name)}`),
		tunnels: (acct, name) =>
			call('GET', `/accounts/${acct}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`),
		create: (acct, name) =>
			call('POST', `/accounts/${acct}/cfd_tunnel`, { name, config_src: 'local' }),
		runToken: (acct, id) => call('GET', `/accounts/${acct}/cfd_tunnel/${id}/token`),
		connections: (acct, id) => call('GET', `/accounts/${acct}/cfd_tunnel/${id}/connections`),
		cname: (zoneId, name) =>
			call('GET', `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(name)}`),
	};
}

/** The connector the host reports, live on Cloudflare's side too. */
export function connectorLive(ready, connections) {
	const id = ready?.connectorId;
	if (!id) return { ok: false, why: 'the host reports no connector (cloudflared /ready)' };
	if (!(ready.readyConnections > 0))
		return {
			ok: false,
			why: `connector ${id} reports ${ready.readyConnections ?? 0} ready connections`,
		};
	const seen = connections.find((c) => c.id === id);
	if (!seen) return { ok: false, why: `Cloudflare lists no connector ${id} on this tunnel` };
	if (!seen.conns?.length)
		return { ok: false, why: `Cloudflare shows connector ${id} with no live connections` };
	return { ok: true, connections: seen.conns.length };
}

export function readSiteDocs(siteRoot) {
	const read = (f) => JSON.parse(readFileSync(join(siteRoot, 'scripts', f), 'utf8'));
	return { hostsDoc: read('pm2-hosts.json'), childApps: read('child-apps.json') };
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Converge (or, with `write: false`, only check) every owned host's tunnel.
 * Returns `{ tunnels, findings }`; `findings[]` uses the refresh report's shape.
 *
 * `deps`: `onNode(node, script) → {ok, out, stderr, error}`, `cf` (see
 * `cloudflare`), `health(url) → {status} | {error}`, `wait(ms)`.
 */
export async function convergeTunnels({ manifest, hostsDoc, childApps, token, write, deps, log }) {
	const findings = [];
	const tunnels = [];
	const find = (node, kind, reason) => findings.push({ node, kind, reason });
	const wait = deps.wait ?? pause;
	const hosts = tunnelHosts(manifest, hostsDoc);
	if (!hosts.length) return { tunnels, findings };

	if (!token) {
		for (const { node } of hosts)
			find(
				node,
				'tunnel-unverified',
				`no ${TOKEN_ENV} in this process: only a run spawned by mgmt-api carries it, so Cloudflare could not be asked`
			);
		return { tunnels, findings };
	}

	const zone = await deps.cf.zone(ZONE);
	const z = zone.ok ? zone.result?.[0] : null;
	if (!z?.account?.id) {
		const why = zone.ok ? `zone ${ZONE} not visible to the token` : zone.why;
		for (const { node } of hosts) find(node, 'tunnel-unverified', why);
		return { tunnels, findings };
	}
	const acct = z.account.id;

	for (const { node, declared } of hosts) {
		const rec = { node, declared, status: 'unverified' };
		tunnels.push(rec);
		const placements = placementsFor(node, childApps);
		rec.placements = placements.map((p) => `${p.hostname}:${p.port} (${p.role})`);
		if (declared !== null && declared !== node) {
			find(
				node,
				'tunnel-name',
				`pm2-hosts.json names tunnel "${declared}"; a host's tunnel is named after the node`
			);
			continue;
		}

		const listed = await deps.cf.tunnels(acct, node);
		if (!listed.ok) {
			find(node, 'tunnel-unverified', listed.why);
			continue;
		}
		const named = listed.result.filter((t) => t.name === node);
		if (named.length > 1) {
			find(
				node,
				'tunnel-ambiguous',
				`${named.length} live tunnels are named ${node}: ${named.map((t) => t.id).join(', ')}`
			);
			continue;
		}
		let tunnel = named[0] ?? null;
		if (!tunnel && write) {
			const made = await deps.cf.create(acct, node);
			if (!made.ok) {
				find(node, 'tunnel-create-failed', made.why);
				continue;
			}
			tunnel = made.result;
			rec.created = true;
			log(`TUNNEL ${node}: created ${tunnel.id}`);
		}
		if (!tunnel) {
			find(node, 'tunnel-missing', `no Cloudflare tunnel named ${node} (converged by --refresh)`);
			continue;
		}
		rec.id = tunnel.id;

		let res = deps.onNode(node, OBSERVE);
		if (!res.ok) {
			find(
				node,
				'tunnel-unreadable',
				(res.stderr || res.error || 'unreadable').trim().slice(0, 200)
			);
			continue;
		}
		let seen = parseObserve(res.out ?? '');
		const config = renderConfig(tunnel.id, placements);
		const drift = {
			creds: !seen.creds.includes(`${tunnel.id}.json`),
			config: seen.config !== config,
			unit: seen.unit !== UNIT,
			down: seen.enabled !== 'enabled' || seen.active !== 'active',
		};
		rec.drift = Object.keys(drift).filter((k) => drift[k]);

		if (rec.drift.length && write) {
			let creds = null;
			if (drift.creds) {
				const rt = await deps.cf.runToken(acct, tunnel.id);
				if (!rt.ok) {
					find(node, 'tunnel-creds-failed', rt.why);
					continue;
				}
				try {
					creds = credentialsFromRunToken(rt.result);
				} catch (err) {
					find(node, 'tunnel-creds-failed', `run token for ${tunnel.id}: ${err.message}`);
					continue;
				}
			}
			const fix = deps.onNode(
				node,
				repairScript({
					tunnelId: tunnel.id,
					config: drift.config ? config : null,
					creds,
					writeUnit: drift.unit,
					restart: drift.creds || drift.config || drift.unit || seen.active === 'active',
				})
			);
			if (!fix.ok) {
				// stderr only: the script itself carries the credentials.
				find(
					node,
					'tunnel-repair-failed',
					(fix.stderr || fix.error || 'repair failed').trim().slice(0, 300)
				);
				continue;
			}
			rec.repaired = rec.drift;
			log(`TUNNEL ${node}: wrote ${rec.drift.join(', ')}`);
		} else if (rec.drift.length) {
			find(
				node,
				'tunnel-drift',
				`${rec.drift.join(', ')} differ from what ${tunnel.id} needs (converged by --refresh)`
			);
			continue;
		}

		// RE-OBSERVE both ends. A fresh connector takes a few seconds to register.
		let live = null;
		for (let i = 0; i < 6; i++) {
			if (i) {
				await wait(5_000);
				res = deps.onNode(node, OBSERVE);
				if (!res.ok) continue;
				seen = parseObserve(res.out ?? '');
			}
			const conns = await deps.cf.connections(acct, tunnel.id);
			if (!conns.ok) {
				live = { ok: false, why: conns.why };
				break;
			}
			live = connectorLive(seen.ready, conns.result ?? []);
			if (live.ok) break;
		}
		if (!live?.ok) {
			find(node, 'tunnel-down', live?.why ?? 'the host could not be re-read');
			continue;
		}
		rec.connector = seen.ready.connectorId;
		rec.connections = live.connections;

		let routed = true;
		for (const p of placements.filter((x) => x.role === 'primary')) {
			const dns = await deps.cf.cname(z.id, p.hostname);
			const want = `${tunnel.id}.cfargotunnel.com`;
			const have = dns.ok ? (dns.result?.[0]?.content ?? null) : null;
			// A service with a hot standby: the site's lease follower points the name at
			// whichever host holds the lease, so the standby's tunnel is routed too.
			let standbyWant = null;
			if (dns.ok && have !== want && p.standby) {
				const sb = await deps.cf.tunnels(acct, p.standby);
				const id = sb.ok && sb.result?.length === 1 ? sb.result[0].id : null;
				standbyWant = id ? `${id}.cfargotunnel.com` : null;
			}
			if (!dns.ok || (have !== want && have !== standbyWant)) {
				routed = false;
				find(
					node,
					'tunnel-dns',
					dns.ok
						? `${p.hostname} points at ${have ?? 'nothing'}, not ${want}` +
								(p.standby
									? standbyWant
										? ` or its standby ${p.standby}'s ${standbyWant}`
										: ` (its standby ${p.standby}'s tunnel could not be read)`
									: '')
						: dns.why
				);
				continue;
			}
			const h = await deps.health(`https://${p.hostname}/health`);
			// Cloudflare's edge keeps sending some requests down the old tunnel for
			// minutes after a switchover, so a pair's name can land on its standby,
			// which reports itself truthfully on /health (and forwards every other
			// route to the lease holder). That is a routed name, not a broken one.
			const standbyAnswered = p.standby && h.status === 503 && h.standby;
			if (!(h.status < 500) && !standbyAnswered) {
				routed = false;
				find(
					node,
					'tunnel-route',
					`https://${p.hostname}/health: ${h.error ?? `HTTP ${h.status}`}`
				);
			}
		}
		if (!routed) continue;

		if (declared === null) {
			find(
				node,
				'tunnel-undeclared',
				`tunnel ${node} (${tunnel.id}) is live; set hosts.${node}.tunnel to "${node}" in the site's scripts/pm2-hosts.json`
			);
			rec.status = 'live';
			continue;
		}
		rec.status = 'ok';
	}
	return { tunnels, findings };
}

/** `deps.health` for live runs: the status code, or why there is none. */
export async function healthStatus(url) {
	try {
		const r = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'manual' });
		// A hot standby answers its own /health 503 by design (docs/service-state.md).
		let standby = false;
		if (r.status === 503) {
			const body = await r.json().catch(() => null);
			standby = body?.detail?.central?.state === 'standby';
		}
		return { status: r.status, standby };
	} catch (err) {
		return { error: err.message };
	}
}
