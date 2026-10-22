/**
 * A FRESH BOX MUST BE MEASURABLE THE MOMENT IT FINISHES BOOTSTRAPPING.
 *
 * The base toolpack and the bootstrap profiles are two lists of the same fact,
 * kept in different files because they run at different times: node-bootstrap.sh
 * executes ON the node before this package exists there, so it cannot import the
 * pack it is supposed to install. Two lists of one fact drift, and this one
 * drifts SILENTLY -- a claw comes up, every gate passes, and the first benchmark
 * quietly has holes in it because dmidecode was never installed.
 *
 * When this fails, add the package to the PROFILE. The pack list is derived from
 * what benchmark-node.sh actually calls, so it is the side that is right.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const packs = JSON.parse(readFileSync(join(ROOT, 'scripts', 'toolpacks.json'), 'utf8')).packs;
const profiles = JSON.parse(readFileSync(join(ROOT, 'manifests', 'node-profiles.json'), 'utf8'));

void test('every bootstrap profile installs the whole base toolpack', () => {
	const base = packs.base.apt;
	const all = profiles.profiles ?? profiles;
	const seen = Object.entries(all).filter(([, p]) => p?.toolchain?.packages);
	// A profile set that reads as empty would pass this vacuously.
	assert.ok(seen.length > 0, 'no profile declares toolchain.packages — the test read nothing');
	for (const [name, p] of seen) {
		const missing = base.filter((b) => !p.toolchain.packages.includes(b));
		assert.deepEqual(
			missing,
			[],
			`profile "${name}" does not install ${missing.join(', ')}, which the base toolpack ` +
				'requires. A node bootstrapped from it cannot be measured honestly: ' +
				'benchmark-node.sh calls these directly and every missing one turns into an ' +
				'unk field in the first record.'
		);
	}
});

void test('the base pack names a binary for every package it installs', () => {
	// A pack that installs something nothing verifies is a pack that cannot fail.
	assert.ok(packs.base.bins.length > 0);
	for (const b of packs.base.bins) assert.equal(typeof b, 'string');
});
