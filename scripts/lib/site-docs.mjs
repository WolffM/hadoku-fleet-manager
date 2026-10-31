/**
 * One reader each for hadoku_site's `scripts/pm2-hosts.json` and
 * `scripts/child-apps.json` (F7, plan §4.1).
 *
 * Before this, five call sites resolved and parsed `pm2-hosts.json` and four
 * resolved and parsed `child-apps.json`, each with its own `try`/`catch` and
 * its own wording for "could not look". `scripts/lib/f-guards/f7-guard.test.mjs`
 * lists today's debt; this module is what each migrated caller reads through
 * instead.
 *
 * CALLERS KEEP THEIR OWN FILTERS — this module only resolves the path, reads
 * the file and parses it. What a caller does with `doc.hosts`/`doc.apps` is
 * unchanged by this migration.
 *
 * THE SOURCE CHECKOUT IS THE DEFAULT, NEVER THE DEPLOYED TREE. `siteRoot()`
 * is hadoku_site's working checkout (`HADOKU_SITE_ROOT`, or the sibling beside
 * this one); `herdr-pm2.mjs` is the one caller that must read the DEPLOYED
 * tree instead (`deploySiteRoot()`, in `lib/manifest-target.mjs`) — it judges
 * pm2 placements against what mgmt-api actually serves, not the operator's
 * working copy. It gets there by passing `root` EXPLICITLY; this module never
 * switches trees on its own.
 *
 * `read`, when given, REPLACES path resolution entirely: `check-header-fleet.mjs`
 * reads hadoku_site the same way it reads every other repo it audits — through
 * a ref-pinned handle (`tryShipped`, or the working copy under `--worktree`) so
 * the catalogue it compares against is the SAME ref as the child repos being
 * checked. There is no directory to join a relative path against there, so
 * `read(file)` gets the bare relative name and does its own resolution.
 *
 * NEVER `{}` ON A MISS. A missing file, an unreadable one and a non-JSON one
 * are all `{ok: false, path, why}` — "I could not look" is a finding a caller
 * can act on, never an empty document that renders as "nothing is wrong".
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { siteRoot } from './paths.mjs';

/** hadoku_site's `scripts/pm2-hosts.json` — which boxes host pm2 services. */
export const PM2_HOSTS_FILE = 'scripts/pm2-hosts.json';

/** hadoku_site's `scripts/child-apps.json` — which repo builds each app id. */
export const CHILD_APPS_FILE = 'scripts/child-apps.json';

/**
 * Read one hadoku_site doc under `scripts/`, JSON-parsed.
 *
 * @param {string} file one of {@link PM2_HOSTS_FILE} / {@link CHILD_APPS_FILE}
 * @param {{root?: string, read?: (file: string) => string | null}} [opts]
 *   `root` — the hadoku_site checkout to resolve `file` under; defaults to
 *   `siteRoot()` (the SOURCE checkout), never the deployed tree.
 *   `read` — an injected reader, handed the bare `file`; when given, `root`
 *   is not consulted at all (a ref-pinned caller has no directory to join).
 * @returns {{ok: true, path: string, doc: unknown} | {ok: false, path: string | null, why: string}}
 */
function readSiteDoc(file, { root, read } = {}) {
	let path = null;
	try {
		path = read ? file : join(root ?? siteRoot(), file);
		const text = read ? read(file) : readFileSync(path, 'utf8');
		if (text === null || text === undefined) throw new Error('could not be read');
		return { ok: true, path, doc: JSON.parse(text) };
	} catch (err) {
		const label = path ?? file;
		return { ok: false, path, why: `${label}: ${err.code ?? err.message}` };
	}
}

/** {@link readSiteDoc} over {@link PM2_HOSTS_FILE}. */
export function readPm2Hosts(opts = {}) {
	return readSiteDoc(PM2_HOSTS_FILE, opts);
}

/** {@link readSiteDoc} over {@link CHILD_APPS_FILE}. */
export function readChildApps(opts = {}) {
	return readSiteDoc(CHILD_APPS_FILE, opts);
}
