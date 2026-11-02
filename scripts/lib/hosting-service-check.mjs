/**
 * WHAT A SERVICE TENANT'S DEPLOY NEEDS OF ITS NODE (fleet-manager#16, the
 * hosting-placement reader draft's per-tenant items 5, 6, 8 and 9). Each is
 * invisible until a deploy or a cutover's last step. lib/hosting.mjs folds this
 * into its one observation, its parse and its judge, for `kind: service` only.
 */
import { hubRepo } from '../../dist/lib/fleet-config.js';

/** Single-quote for bash, as lib/hosting.mjs does. */
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * WHAT THE APP LAYER'S DEPLOY NEEDS OF A SERVICE TENANT (fleet-manager#16, the
 * reader draft's items 5, 6, 8 and 9), observed by doing each, as the deploy
 * does it. Never \`pm2 ping\`: any pm2 command spawns a daemon when none answers,
 * and a daemon outside the unit is the 2026-10-12 claw-4 failure; the unit's
 * state and the saved dump are read instead. The tunnel's config path is the
 * RUNNING cloudflared's, like the service-host probe's.
 */
export function serviceObserveScript(t) {
	return `HOSTNAME_WANT=${q(t.hostname ?? '')}
SITE_CLONE=${q(`${t.home}/srv/${hubRepo()}`)}
echo "actAsTenant=$(sudo -n -u "$AGENT_USER" true 2>/dev/null && echo yes || echo no)"
echo "pm2Unit=$(systemctl is-active "$SERVICE" 2>/dev/null)"
echo "pm2Saved=$(sudo -n python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$AGENT_HOME/.pm2/dump.pm2" 2>/dev/null || echo none)"
echo "siteClone=$(sudo -n -u "$AGENT_USER" sh -c '[ -d "$1" ] || { echo missing; exit 0; }; [ -w "$1" ] && echo writable || echo readonly' sh "$SITE_CLONE" 2>/dev/null || echo unreadable)"
${ingressProbe()}`;
}

/**
 * The tunnel half of the observation: which service the node's RUNNING
 * cloudflared routes \`$HOSTNAME_WANT\` to, asked of cloudflared itself with the
 * config file that process was started with.
 *
 * The process is picked by its executable name (\`comm\`), never by a pattern
 * over \`ps\` args: the pipeline's own \`grep\` carries that pattern in its argv,
 * and on 2026-11-02 it sorted ahead of the root cloudflared on claw-4 and
 * claw-6, so the config path read \`[^\` and every service tenant's slice went
 * \`not-guaranteed\` ("the node's tunnel rule … could not be read") while each
 * tunnel routed its hostname correctly.
 */
export function ingressProbe() {
	return `if [ -n "$HOSTNAME_WANT" ]; then
	cfg=$(ps -eo comm=,args= 2>/dev/null | awk '$1 == "cloudflared" { for (i = 2; i < NF; i++) if ($i == "--config") { print $(i + 1); exit } }')
	echo "ingressService=$(sudo -n cloudflared tunnel --config "\${cfg:-/etc/cloudflared/config.yml}" ingress rule "https://$HOSTNAME_WANT" 2>/dev/null | awk '$1 == "service:" { print $2; exit }')"
fi
`;
}

/** The service facts out of the observation's `KEY=value` map. */
export function parseServiceDeploy(kv) {
	const str = (k) => kv[k] || null;
	return {
		actAsTenant: str('actAsTenant'),
		pm2Unit: str('pm2Unit'),
		pm2Saved:
			kv.pm2Saved === undefined || kv.pm2Saved === '' || kv.pm2Saved === 'none'
				? null
				: Number(kv.pm2Saved),
		siteClone: str('siteClone'),
		ingressService: str('ingressService'),
	};
}

/** What the judge reports under `observed.deploy`. */
export function observedDeploy(t, obs) {
	return {
		actAsTenant: obs.actAsTenant === 'yes',
		pm2: { unit: obs.pm2Unit, saved: obs.pm2Saved },
		siteClone: obs.siteClone,
		ingress: t.hostname ? { hostname: t.hostname, service: obs.ingressService } : null,
	};
}

/**
 * Judge them: acting as the tenant's user, its pm2 saved, its site clone
 * writable, and the tunnel routing its hostname here. Every miss BLOCKS.
 */
export function judgeServiceDeploy(t, obs, block) {
	if (obs.actAsTenant !== 'yes')
		block(
			'hosting-user',
			`admin cannot act as ${t.user} (sudo -n -u ${t.user} true): the deploy cannot install`
		);
	if (obs.pm2Unit !== 'active')
		block('hosting-pm2', `${t.service} is ${obs.pm2Unit ?? 'unreadable'}, not active`);
	if (!(obs.pm2Saved > 0))
		block(
			'hosting-pm2',
			obs.pm2Saved === 0
				? `${t.user}'s pm2 has saved no app: a reboot brings nothing back`
				: `${t.home}/.pm2/dump.pm2 is missing or unreadable: a reboot brings nothing back`
		);
	if (obs.siteClone !== 'writable')
		block(
			'hosting-site-clone',
			`${t.home}/srv/${hubRepo()} is ${obs.siteClone ?? 'unreadable'} for ${t.user}: mgmt-api cannot push the deploy there`
		);
	if (t.ingress === 'tunnel') {
		const want = [`http://127.0.0.1:${t.port}`, `http://localhost:${t.port}`];
		if (!t.hostname)
			block('hosting-ingress', `${t.app} has a tunnel ingress and no hostname to route`);
		else if (!want.includes(obs.ingressService ?? ''))
			block(
				'hosting-ingress',
				obs.ingressService
					? `the node's tunnel routes ${t.hostname} to ${obs.ingressService}, not ${want[0]}`
					: `the node's tunnel rule for ${t.hostname} could not be read`
			);
	}
}
