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
import { join } from 'node:path';

import { siteRoot } from './paths.mjs';

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
	let p;
	try {
		p = join(siteRoot(), 'scripts', 'pm2-hosts.json');
		const doc = JSON.parse(readFileSync(p, 'utf8'));
		const ip = doc.hosts?.[doc.hub]?.tailnetIp;
		if (!ip) return { url: null, why: `${p}: the hub has no tailnetIp` };
		return { url: `http://${ip}:${DATA_PORT}` };
	} catch (err) {
		return { url: null, why: `${p ?? 'the site checkout'}: ${err.message}` };
	}
}

/**
 * The probe capabilities this controller could not enable, as `{ id: reason }`.
 * A caller treats each as UNJUDGED: absent from the probe's output, and still
 * neither a failure nor a reason to drop a label the node already earned.
 */
export function unprobed(data = dataEndpointUrl()) {
	return data.url ? {} : { 'data-peer': `the data endpoint could not be named (${data.why})` };
}

/** The script to run on a node for `phase` (`all`, `presence` or `measured`). */
export function probeScript(phase = 'all', data = dataEndpointUrl()) {
	const head = [];
	if (phase !== 'all') head.push(`export CAP_PROBE_PHASE=${phase}`);
	if (data.url) head.push(`export CAP_DATA_URL='${data.url}'`);
	return head.length ? `${head.join('\n')}\n${PROBE}` : PROBE;
}
