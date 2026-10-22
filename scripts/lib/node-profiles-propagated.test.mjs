/**
 * THE PROFILE THIS PACKAGE SHIPS AND THE PROFILE THE FLEET READS MUST AGREE.
 *
 * `manifestDir()` resolves to `siteRoot()/scripts/admin`, so `fleet usb-prep`
 * reads hadoku_site's `node-profiles.json` — NOT this package's `manifests/`
 * copy. The package copy is the source; the site copy is what production
 * resolves. Nothing connected them.
 *
 * WHAT THAT COST, 2026-09-08. A `gpu` block and a `network.wireless` block were
 * added here, tested here, and shipped. The stick was rebuilt from the SITE
 * copy, which had neither, so claw-7 converged with:
 *
 *     11b/12 — no network.wireless policy in this profile
 *     ENROLL gpuDriver none undeclared-vendor-0x10de
 *
 * The node found its GTX 980 Ti and had nothing to look it up in; it found no
 * wireless policy and left the radio alone. `ready ok converged` was TRUE, every
 * test passed, and both features were inert — because the thing verified was not
 * the thing that ran. That is `deployed-not-published-2026-09-05.md` exactly,
 * and `docs/planning/workstreams.md` already listed this guard as open under
 * P1.5: "a test that the two copies differ ONLY in lanCidr/trustedCidrs".
 *
 * SKIPPED, NOT FAILED, WHEN THE SITE CHECKOUT IS ABSENT. This package's CI does
 * not check hadoku_site out, and a gate that cannot run must not be a gate that
 * fails — but it says so rather than passing quietly.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestDir } from './paths.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG = resolve(ROOT, 'manifests', 'node-profiles.json');

/**
 * Where the fleet actually reads it from — ASKED, not reconstructed.
 *
 * A first version walked `resolve(ROOT, '..', '..', 'hadoku_site')`, which is
 * correct from the main checkout and wrong from a worktree, where `../..` is
 * `.claude/worktrees`. It found nothing and SKIPPED — a guard written to catch a
 * silent no-op, silently not running. `manifestDir()` is the same function
 * `fleet usb-prep` resolves through, including its worktree handling, so it is
 * the only honest source for this answer.
 */
function siteProfilePath() {
	return resolve(manifestDir(), 'node-profiles.json');
}

/**
 * The ONLY keys the two copies may differ on.
 *
 * The LAN is a property of the SITE and `manifests/` is PUBLISHED, so the
 * package ships RFC 5737 TEST-NET-1 and the site carries the real range.
 * Everything else is package content and must be identical.
 */
const ALLOWED = new Set(['network.lanCidr', 'network.trustedCidrs']);

/**
 * `$`-prefixed keys are annotations: prose no reader consumes (node-bootstrap
 * reads wireless SSIDs from `ssidEnv`, never from a `$why-*` field). Since
 * 2026-10-19 the PUBLISHED copy scrubs identifiers out of that prose (the home
 * SSID became `ExampleNet`), so the two copies legitimately differ there. An
 * annotation images nothing, which is the only thing this guard protects; a
 * `$` key appearing on one side only is still drift, because that is a
 * structural change rather than a reworded comment.
 */
const isAnnotation = (key) => key.split('.').some((seg) => seg.startsWith('$'));

function flatten(value, prefix, out) {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
	} else {
		out.set(prefix, JSON.stringify(value));
	}
	return out;
}

test('the package profile and the deployed profile differ ONLY in the LAN fields', (t) => {
	let sitePath;
	try {
		sitePath = siteProfilePath();
	} catch (err) {
		t.skip(`cannot resolve the deployed manifest dir: ${err.message.split('\n')[0]}`);
		return;
	}
	if (!existsSync(sitePath)) {
		t.skip(`no deployed profile at ${sitePath} — cannot compare`);
		return;
	}
	const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
	const site = JSON.parse(readFileSync(sitePath, 'utf8'));

	assert.deepEqual(
		Object.keys(pkg.profiles).sort(),
		Object.keys(site.profiles).sort(),
		'the two copies declare different profiles'
	);

	const drift = [];
	for (const id of Object.keys(pkg.profiles)) {
		const a = flatten(pkg.profiles[id], '', new Map());
		const b = flatten(site.profiles[id], '', new Map());
		for (const key of new Set([...a.keys(), ...b.keys()])) {
			if (ALLOWED.has(key) || [...ALLOWED].some((p) => key.startsWith(`${p}.`))) continue;
			if (isAnnotation(key) && a.has(key) && b.has(key)) continue;
			if (a.get(key) !== b.get(key)) {
				drift.push(
					`${id}.${key}: package=${a.get(key) ?? '<absent>'} site=${b.get(key) ?? '<absent>'}`
				);
			}
		}
	}
	assert.deepEqual(
		drift,
		[],
		'the deployed profile is not the profile this package ships. `fleet usb-prep` reads ' +
			'the SITE copy, so anything only in the package copy is INERT — it images nothing. ' +
			'Propagate to hadoku_site/scripts/admin/node-profiles.json and commit there.\n  ' +
			drift.join('\n  ')
	);
});

test('the LAN delta is real, not an accident of both being placeholders', (t) => {
	// If the site copy still shipped TEST-NET-1 the comparison above would pass
	// while every node bootstrapped against a range it is not on — the exact
	// lockout class node-bootstrap's FLEET_LAN_CIDR refusal exists to prevent.
	let sitePath;
	try {
		sitePath = siteProfilePath();
	} catch {
		t.skip('cannot resolve the deployed manifest dir');
		return;
	}
	if (!existsSync(sitePath)) {
		t.skip('no deployed profile');
		return;
	}
	const site = JSON.parse(readFileSync(sitePath, 'utf8'));
	for (const [id, prof] of Object.entries(site.profiles)) {
		assert.ok(
			!/^(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(prof.network.lanCidr),
			`${id}: the DEPLOYED profile still carries the documentation placeholder ` +
				`${prof.network.lanCidr}`
		);
	}
});
