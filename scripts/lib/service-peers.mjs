/**
 * A HOT STANDBY'S PEER PORT, closed to the tailnet except its pair-mate.
 *
 * A standby that is not holding the lease forwards requests to the host that
 * is (docs/service-state.md), so Cloudflare's edge, which keeps sending some
 * requests down the old tunnel for ~40 s after a switchover, never reaches a
 * 503. That forward goes to a second listener on the holder's tailnet address.
 * It carries the edge's identity headers, so it must be reachable from the
 * pair-mate ONLY: a tailnet node that could reach it could claim any user.
 *
 * NOT A UFW RULE, for the reason lib/hosting.mjs gives: tailscaled's
 * `ts-input` chain is first in INPUT and ACCEPTs everything on tailscale0. The
 * drop lives in the `raw` table's PREROUTING, which runs first and which
 * tailscaled never touches, re-asserted at boot by a oneshot unit (delete,
 * then insert, so it is never doubled). IPv6 to the port is dropped outright:
 * the pair-mate is reached by its MagicDNS name, which answers IPv4 first.
 *
 * WHICH PORT: a pair's port is the app's own `<APP>_PEER_PORT` in its literal
 * `tunnel.env` (hadoku_site child-apps.json), so the app and the fleet read
 * one value. A row with a standby and no such env has no peer listener, and
 * nothing is opened or closed for it.
 *
 * THE READER reads the kernel's raw table, never the unit file: a unit that
 * is enabled and whose rule is gone (an `iptables -t raw -F`, a reboot before
 * tailscaled) is still an open port.
 */

export const UNIT_DIR = '/etc/systemd/system';
export const unitName = (app) => `fleet-peer-${app}.service`;

const upperSnake = (id) => id.replace(/[^a-z0-9]+/gi, '_').toUpperCase();

/**
 * The peer ports each host must close: `node → [{app, port, mate, mateIp}]`,
 * for every app placed with a `host` and a `standby` whose `tunnel.env` names
 * its peer port. Problems (a mate without a tailnetIp, a bad port) are
 * returned with the app, so the caller reports them instead of guessing.
 */
export function peerPorts(childApps, hostsDoc) {
	const out = new Map();
	const problems = [];
	const add = (node, p) => out.set(node, [...(out.get(node) ?? []), p]);
	for (const app of childApps.apps ?? []) {
		if (!app.host || !app.standby) continue;
		const raw = app.tunnel?.env?.[`${upperSnake(app.id)}_PEER_PORT`];
		if (raw === undefined) continue;
		const port = Number(raw);
		if (!(Number.isInteger(port) && port >= 1024 && port <= 65535)) {
			problems.push({ app: app.id, why: `${upperSnake(app.id)}_PEER_PORT is ${raw}, not a port` });
			continue;
		}
		const pair = [
			[app.host, app.standby],
			[app.standby, app.host],
		];
		for (const [node, mate] of pair) {
			const mateIp = hostsDoc.hosts?.[mate]?.tailnetIp ?? null;
			if (!mateIp) {
				problems.push({
					app: app.id,
					node,
					why: `${mate} has no tailnetIp in the site's pm2-hosts.json`,
				});
				continue;
			}
			add(node, { app: app.id, port, mate, mateIp });
		}
	}
	return { byNode: out, problems };
}

/** The two raw-table rules for one pair-mate, exactly as `iptables -S` prints them. */
export function rules({ port, mateIp }) {
	return {
		// iptables prints the source before the interface (read from claw-9, 2026-10-28).
		v4: `-A PREROUTING ! -s ${mateIp}/32 -i tailscale0 -p tcp -m tcp --dport ${port} -j DROP`,
		v6: `-A PREROUTING -i tailscale0 -p tcp -m tcp --dport ${port} -j DROP`,
	};
}

/** The oneshot unit that keeps the drop in place across boots. */
export function renderUnit({ app, port, mateIp, mate }) {
	const r4 = `-i tailscale0 -p tcp --dport ${port} ! -s ${mateIp} -j DROP`;
	const r6 = `-i tailscale0 -p tcp --dport ${port} -j DROP`;
	return `[Unit]
Description=fleet: ${app} peer port ${port}, closed to the tailnet except ${mate}
After=tailscaled.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStartPre=-/usr/sbin/iptables -t raw -D PREROUTING ${r4}
ExecStartPre=-/usr/sbin/ip6tables -t raw -D PREROUTING ${r6}
ExecStart=/usr/sbin/iptables -t raw -I PREROUTING 1 ${r4}
ExecStart=/usr/sbin/ip6tables -t raw -I PREROUTING 1 ${r6}
ExecStop=-/usr/sbin/iptables -t raw -D PREROUTING ${r4}
ExecStop=-/usr/sbin/ip6tables -t raw -D PREROUTING ${r6}

[Install]
WantedBy=multi-user.target
`;
}

/** One ssh: each pair's unit (base64), whether it is enabled, and the live raw tables. */
export function observeScript(pairs) {
	const units = pairs
		.map(
			({ app }) =>
				`f=${UNIT_DIR}/${unitName(app)}; printf 'UNIT %s %s\\n' ${app} "$( [ -f "$f" ] && base64 -w0 "$f" || echo -)"; printf 'ENABLED %s %s\\n' ${app} "$(systemctl is-enabled ${unitName(app)} 2>/dev/null || true)"`
		)
		.join('\n');
	return `${units}
sudo -n /usr/sbin/iptables -t raw -S PREROUTING 2>/dev/null | sed 's/^/RAW4 /'
sudo -n /usr/sbin/ip6tables -t raw -S PREROUTING 2>/dev/null | sed 's/^/RAW6 /'
echo OBSERVED`;
}

export function parseObserve(out) {
	const units = {};
	const enabled = {};
	const raw4 = [];
	const raw6 = [];
	let complete = false;
	for (const line of String(out ?? '').split('\n')) {
		const [tag, ...rest] = line.split(' ');
		if (tag === 'UNIT')
			units[rest[0]] = rest[1] === '-' ? null : Buffer.from(rest[1] ?? '', 'base64').toString();
		else if (tag === 'ENABLED') enabled[rest[0]] = (rest[1] ?? '').trim() || null;
		else if (tag === 'RAW4') raw4.push(rest.join(' ').trim());
		else if (tag === 'RAW6') raw6.push(rest.join(' ').trim());
		else if (tag === 'OBSERVED') complete = true;
	}
	return { units, enabled, raw4, raw6, complete };
}

/** Install the units that differ, then enable and (re)start every pair's unit. */
export function repairScript(pairs, observed) {
	const lines = ['set -e'];
	let reload = false;
	for (const p of pairs) {
		const want = renderUnit(p);
		if (observed.units[p.app] !== want) {
			reload = true;
			lines.push(
				`printf '%s' '${Buffer.from(want).toString('base64')}' | base64 -d | sudo -n install -m 0644 -o root -g root /dev/stdin ${UNIT_DIR}/${unitName(p.app)}`
			);
		}
	}
	if (reload) lines.push('sudo -n systemctl daemon-reload');
	for (const p of pairs) {
		lines.push(`sudo -n systemctl enable ${unitName(p.app)} >/dev/null 2>&1`);
		lines.push(`sudo -n systemctl restart ${unitName(p.app)}`);
	}
	return lines.join('\n');
}

/** What is wrong with one pair on one host, as read from the kernel, or null. */
export function judgePair(p, observed) {
	const { v4, v6 } = rules(p);
	const missing = [];
	if (!observed.raw4.includes(v4)) missing.push('the IPv4 drop');
	if (!observed.raw6.includes(v6)) missing.push('the IPv6 drop');
	if (observed.units[p.app] !== renderUnit(p)) missing.push('its boot unit');
	else if (observed.enabled[p.app] !== 'enabled') missing.push('its boot unit enabled');
	return missing.length ? missing : null;
}

/**
 * Converge (or, `write: false`, only check) every owned host's peer ports.
 * `deps.onNode(node, script) → {ok, out, error}`. Returns `{ peers, findings }`.
 */
export async function convergePeerPorts({ childApps, hostsDoc, nodes, write, deps }) {
	const findings = [];
	const peers = [];
	const find = (node, kind, reason) => findings.push({ node, kind, reason });
	const { byNode, problems } = peerPorts(childApps, hostsDoc);
	for (const pr of problems) find(pr.node ?? null, 'peer-port-undeclared', `${pr.app}: ${pr.why}`);

	for (const node of nodes) {
		const pairs = byNode.get(node) ?? [];
		if (!pairs.length) continue;
		const look = async () => {
			const r = await deps.onNode(node, observeScript(pairs));
			const o = r.ok ? parseObserve(r.out) : null;
			return o?.complete ? { o } : { why: r.error ?? r.stderr?.trim() ?? 'no answer' };
		};
		let seen = await look();
		if (!seen.o) {
			find(node, 'peer-port-unreadable', `could not read ${node}'s raw table: ${seen.why}`);
			continue;
		}
		const wrong = pairs.map((p) => [p, judgePair(p, seen.o)]).filter(([, w]) => w);
		if (wrong.length && !write) {
			for (const [p, w] of wrong)
				find(node, 'peer-port-drift', `${p.app} port ${p.port} lacks ${w.join(', ')}`);
			continue;
		}
		if (wrong.length) {
			const r = await deps.onNode(node, repairScript(pairs, seen.o));
			if (!r.ok) {
				find(
					node,
					'peer-port-repair-failed',
					`${node}: ${r.error ?? r.stderr?.trim() ?? 'no answer'}`
				);
				continue;
			}
			seen = await look();
			if (!seen.o) {
				find(
					node,
					'peer-port-unreadable',
					`could not re-read ${node} after the repair: ${seen.why}`
				);
				continue;
			}
		}
		for (const p of pairs) {
			const still = judgePair(p, seen.o);
			if (still)
				find(node, 'peer-port-open', `${p.app} port ${p.port} still lacks ${still.join(', ')}`);
			peers.push({
				node,
				app: p.app,
				port: p.port,
				mate: p.mate,
				status: still ? 'open' : wrong.some(([w]) => w === p) ? 'repaired' : 'ok',
			});
		}
	}
	return { peers, findings };
}
