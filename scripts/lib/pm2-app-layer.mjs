/**
 * THE APP LAYER'S PM2 HOST LIST — `hadoku_site/scripts/pm2-hosts.json`,
 * another system's own data, read as-is.
 *
 * MOVED OUT of `collect-offers.mjs` (wave layers-3 lane H, cut (iii) layer
 * debt): reading a file another system owns and authors is the plan's own
 * "access" rule (§3.2), not tenancy content, and `doctor-run.mjs`
 * (observation) needed it without reaching UP into collect-offers' tenancy
 * table to get it. `collect-offers.mjs` re-exports it unchanged, so every
 * existing importer keeps compiling and behaving byte-identically.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { siteRoot } from '../../dist/lib/fleet-paths.js';

/** The app layer's pm2 hosts as `{ set }`, or `{ set: null, why }`: could not look is not "none". */
export function pm2Peers() {
	let p;
	try {
		p = join(siteRoot(), 'scripts', 'pm2-hosts.json');
		const doc = JSON.parse(readFileSync(p, 'utf8'));
		return { set: new Set(Object.keys(doc.hosts ?? doc)) };
	} catch (err) {
		return { set: null, why: `${p ?? 'the site checkout'}: ${err.message}` };
	}
}
