/**
 * The text of `capability-probe.sh` as a controller sends it: the phase, and
 * the facts only the controller can name, exported ahead of the script.
 *
 * `CAP_DATA_URL` is dataplatform's data listener, for the `data-peer` probe.
 * Its address is private and this repo is public, so it is read where the
 * listener itself reads its bind address: the hub's `tailnetIp` in hadoku_site's
 * `scripts/pm2-hosts.json` (dataplatform `data/peers.py`), on the listener's
 * default port. `FLEET_DATA_URL` overrides both. When neither can be read the
 * variable is left unset, and the probe prints nothing for `data-peer`: "not
 * judged", never a revocation on every node at once. `why` says which.
 */
import { readFileSync } from 'node:fs';

import { nodeHome } from '../../dist/lib/node-users.js';
import { readPm2Hosts } from './site-docs.mjs';
import { SERVICE_STATE_DIR } from './toolchain-floor.mjs';

const PROBE = readFileSync(new URL('../capability-probe.sh', import.meta.url), 'utf8');

/** dataplatform's `data_port` default (`dataplatform/config.py`). */
const DATA_PORT = 9002;

/** `{ url }`, or `{ url: null, why }` when the endpoint could not be named. */
export function dataEndpointUrl(env = process.env) {
	if (env.FLEET_DATA_URL) {
		const url = env.FLEET_DATA_URL.replace(/\/+$/, '');
		// It is pasted into the script inside single quotes.
		if (!/^https?:\/\/[^\s'"]+$/.test(url))
			return { url: null, why: `FLEET_DATA_URL is not a URL: ${url}` };
		return { url };
	}
	const read = readPm2Hosts();
	if (!read.ok) return { url: null, why: read.why };
	const ip = read.doc.hosts?.[read.doc.hub]?.tailnetIp;
	if (!ip) return { url: null, why: `${read.path}: the hub has no tailnetIp` };
	return { url: `http://${ip}:${DATA_PORT}` };
}

/**
 * The probe capabilities this controller could not enable, as `{ id: reason }`.
 * A caller treats each as UNJUDGED: absent from the probe's output, and still
 * neither a failure nor a reason to drop a label the node already earned.
 */
export function unprobed(data = dataEndpointUrl()) {
	return data.url ? {} : { 'data-peer': `the data endpoint could not be named (${data.why})` };
}

/**
 * Where a service host keeps tenant state on `entry`, for `service-host`'s probe:
 * the admin user's home plus the one `SERVICE_STATE_DIR`. Named here because
 * the probe runs as the ci user and must not work out who admin is.
 */
export function serviceStateRoot(entry) {
	return `${nodeHome(entry, 'admin')}/${SERVICE_STATE_DIR}`;
}

/**
 * The script to run on a node for `phase` (`all`, `presence` or `measured`).
 * `node.stateRoot` turns on `service-host`; without it that label is not judged.
 */
export function probeScript(phase = 'all', data = dataEndpointUrl(), node = {}) {
	const head = [];
	if (phase !== 'all') head.push(`export CAP_PROBE_PHASE=${phase}`);
	if (data.url) head.push(`export CAP_DATA_URL='${data.url}'`);
	if (node.stateRoot) {
		// It is pasted into the script inside single quotes.
		if (!/^\/[^\s'"]+$/.test(node.stateRoot))
			throw new Error(`stateRoot is not an absolute path: ${node.stateRoot}`);
		head.push(`export CAP_STATE_ROOT='${node.stateRoot}'`);
	}
	return head.length ? `${head.join('\n')}\n${PROBE}` : PROBE;
}
