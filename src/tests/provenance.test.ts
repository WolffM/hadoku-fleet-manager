/**
 * The banner that names which tree and which install answered.
 *
 * Two properties, and they pull in opposite directions, which is why they are
 * tested together.
 *
 * IT MUST SAY SOMETHING TRUE about the paths that actually resolved — that is
 * the whole point of issue #4, and a banner reporting a hardcoded default would
 * be worse than none, because it would look like evidence.
 *
 * IT MUST NEVER THROW. `siteRoot()` and `manifestDir()` throw on purpose:
 * everything behind them turns a failed read into an empty result, which renders
 * as a clean audit of a fleet with nothing in it. A BANNER has nothing behind
 * it, so inheriting that throw would mean `fleet onboard` — a command that
 * builds a USB stick and never opens a manifest — dying on a box with no
 * hadoku_site checkout. "I could not look" is still reported as exactly that;
 * it is just not fatal here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { packageVersion, provenance, provenanceLine } from '../lib/provenance.js';

/** dist/tests/ -> dist/ -> the package root. */
const PKG = fileURLToPath(new URL('../../package.json', import.meta.url));

/** Swap the two path variables, restore whatever was there, whatever happens. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
	const before: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(vars)) {
		before[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		fn();
	} finally {
		for (const [k, v] of Object.entries(before)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

void test('the version is the running package’s own, read from the file beside it', () => {
	const declared = (JSON.parse(readFileSync(PKG, 'utf8')) as { version: string }).version;
	assert.equal(packageVersion(), declared);
	// Not a placeholder, and not a manifest number. The one fact that tells
	// ~/repos/.../node_modules/@wolffm/fleet-manager apart from srv's copy is
	// which package.json sits beside the running code.
	assert.match(packageVersion(), /^\d+\.\d+\.\d+/);
});

void test('it reports the paths that actually answered', () => {
	// The site root and the manifest dir are independent inputs — FLEET_MANIFEST_DIR
	// wins on its own — so point them at two DIFFERENT real directories. A banner
	// that derived one from the other would pass a single-directory fixture and
	// then hide exactly the split it exists to show.
	const site = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
	const manifests = fileURLToPath(new URL('../../manifests', import.meta.url)).replace(/\/$/, '');
	withEnv({ HADOKU_SITE_ROOT: site, FLEET_MANIFEST_DIR: manifests }, () => {
		const p = provenance();
		assert.equal(p.site, site);
		assert.equal(p.manifests, manifests);
		assert.equal(
			provenanceLine(p),
			`site=${site} manifests=${manifests} fleet-manager=${p.version}`
		);
	});
});

void test('an unresolvable path is REPORTED, not thrown, and not silently blank', () => {
	withEnv(
		{
			HADOKU_SITE_ROOT: '/nonexistent-fleet-site',
			FLEET_MANIFEST_DIR: '/nonexistent-fleet-manifests',
		},
		() => {
			const p = provenance();
			assert.match(p.site, /^<unresolved: /);
			assert.match(p.manifests, /^<unresolved: /);
			// It names the PATH it tried. "unresolved" alone sends the reader back
			// to guess which variable was wrong.
			assert.match(p.site, /\/nonexistent-fleet-site/);
			assert.match(p.manifests, /\/nonexistent-fleet-manifests/);
			// The version is a separate question and must survive both.
			assert.match(p.version, /^\d+\.\d+\.\d+/);
		}
	);
});

void test('the banner is ONE line, however bad the failure', () => {
	// `must()` writes three lines of explanation, which is right for a fatal
	// error and wrong here: a banner that wraps to four lines stops being read,
	// and a newline on stderr ahead of a subcommand's own output would look like
	// that subcommand's.
	withEnv(
		{
			HADOKU_SITE_ROOT: '/nonexistent-fleet-site',
			FLEET_MANIFEST_DIR: '/nonexistent-fleet-manifests',
		},
		() => {
			assert.equal(provenanceLine().includes('\n'), false);
		}
	);
});
