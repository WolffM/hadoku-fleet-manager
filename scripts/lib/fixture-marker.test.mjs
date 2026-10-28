/**
 * THE MANIFEST FIXTURES SAY THEY ARE FIXTURES.
 *
 * `manifests/fleet-runner-{manifest,coverage}.json` are copies for the suites.
 * Production reads `FLEET_MANIFEST_DIR`, which defaults to hadoku_site's
 * `scripts/admin`, and every writer writes there. An agent that follows the
 * file name edits a copy nothing reads, so each fixture opens with a
 * `$fixture` key naming the live copy. A raw `cp` refresh drops it; this
 * fails until the refresh in `manifests/README.md` puts it back.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFESTS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'manifests');

for (const name of ['fleet-runner-manifest', 'fleet-runner-coverage']) {
	test(`${name}.json is marked as a fixture and names the live copy`, () => {
		const doc = JSON.parse(readFileSync(resolve(MANIFESTS, `${name}.json`), 'utf8'));
		assert.equal(Object.keys(doc)[0], '$fixture', 'the marker must be the first key a reader sees');
		assert.match(doc.$fixture, new RegExp(`hadoku_site/scripts/admin/${name}\\.json`));
	});
}
