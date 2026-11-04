/**
 * THE CONTROLLER'S ADDRESSES, the only sources a tenant's port is opened to
 * (`network.ingress: controller`). Split out of scripts/hosting.mjs, the door,
 * which refuses with the reason these return.
 */
import { CONTROLLER_NODE } from './hosting.mjs';
import { runOn } from './fleet-exec.mjs';

/** The controller's reserved LAN address, or `{ why }` there is none to open the port to. */
export function controllerIp(manifest) {
	const ip = manifest.machines?.[CONTROLLER_NODE]?.lan?.ip;
	if (ip) return { ip };
	return {
		why:
			`machines.${CONTROLLER_NODE}.lan.ip is not recorded, so there is no address to open the ` +
			'port to. Record the reservation first (`fleet preflight` names it).',
	};
}

/**
 * The controller's addresses: its reserved LAN address from the manifest, and
 * its tailnet addresses as tailscale reports them on the controller itself.
 * The tailnet ones are opened above the mesh allow, so they must be read.
 * `{ addrs: { lan, tailnet4, tailnet6 } }`, or `{ why }` they could not be.
 */
export async function controllerAddrs(manifest) {
	const { ip: lan, why } = controllerIp(manifest);
	if (why) return { why };
	const r = await runOn(CONTROLLER_NODE, 'tailscale ip -4; tailscale ip -6', {
		as: 'admin',
		timeoutMs: 15_000,
	});
	const ips = r.stdout.split('\n').map((l) => l.trim());
	const tailnet4 = ips.find((l) => /^\d+\.\d+\.\d+\.\d+$/.test(l)) ?? null;
	const tailnet6 = ips.find((l) => l.includes(':')) ?? null;
	if (!tailnet4)
		return {
			why:
				`could not read ${CONTROLLER_NODE}'s tailnet address (${r.error ?? r.stderr.trim() ?? 'no answer'}), ` +
				'so the tailnet rule would shut the controller out with everyone else.',
		};
	return { addrs: { lan, tailnet4, tailnet6 } };
}
