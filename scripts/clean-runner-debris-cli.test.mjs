/**
 * clean-runner-debris.mjs, the controller half: nodes run CONCURRENTLY, each on
 * its own clock, and each one's duration is named on stderr (#50).
 *
 * Run one after another, every node shared mgmt-api's single 600 s budget, so
 * on 2026-11-01..03 one slow node (hokon) spent it and `ci:claw-cleanup` died
 * naming nobody. Fixture manifest + an ssh shim on PATH, never a live node;
 * stdout and stderr captured to FILES (a pipe loses everything past 8 KB, #33).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'clean-runner-debris.mjs');
const NODES = ['fixture-a', 'fixture-b', 'fixture-c'];
const SLEEP_S = 2;

// Every node answers after SLEEP_S; `fixture-b` cannot be reached.
const SSH_SHIM = `#!/usr/bin/env bash
cat > /dev/null
node="\${5##*@}"
sleep ${SLEEP_S}
if [ "$node" = fixture-b ]; then
  echo "ssh: connect to host $node port 22: No route to host" >&2
  exit 255
fi
echo "SUMMARY stale_kb=0 update_kb=0 orphan_kb=0 diag_kb=0 tmpfs_kb=1048576 busy_skipped=0 free_kb=1000000 tmpfs_used_kb=0"
`;

test('nodes are cleaned concurrently, each named on stderr, and one failure fails only itself', (t) => {
	const root = mkdtempSync(join(tmpdir(), 'crd-cli-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(
		join(root, 'fleet-runner-manifest.json'),
		JSON.stringify({ machines: Object.fromEntries(NODES.map((n) => [n, {}])) })
	);
	const bin = join(root, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'ssh'), SSH_SHIM);
	chmodSync(join(bin, 'ssh'), 0o755);

	const outPath = join(root, 'out.json');
	const errPath = join(root, 'err.txt');
	const t0 = Date.now();
	const r = spawnSync('sh', ['-c', `node "${SCRIPT}" --json > "${outPath}" 2> "${errPath}"`], {
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			FLEET_MANIFEST_DIR: root,
			HADOKU_STATE_DIR: root,
		},
	});
	const elapsed = (Date.now() - t0) / 1000;
	const doc = JSON.parse(readFileSync(outPath, 'utf8'));
	const err = readFileSync(errPath, 'utf8');

	// Sequential would be 3 x SLEEP_S; concurrent is one SLEEP_S plus start-up.
	// MUTATION: turn the Promise.all back into a for-await loop and this fails.
	assert.ok(elapsed < SLEEP_S * NODES.length, `took ${elapsed}s: the nodes ran one at a time`);
	assert.equal(r.status, 1, 'the unreachable node fails the run');
	assert.deepEqual(
		doc.results.map((x) => [x.machine, x.ok]),
		[
			['fixture-a', true],
			['fixture-b', false],
			['fixture-c', true],
		],
		'results in manifest order, whichever answered first'
	);
	assert.equal(doc.totalReclaimGb, 2, 'tmpfs_kb summed from the two that answered');
	for (const x of doc.results)
		assert.equal(typeof x.seconds, 'number', `${x.machine} has no duration`);
	assert.match(err, /clean-runner-debris: fixture-a done in \d+s/);
	assert.match(err, /clean-runner-debris: fixture-b FAILED in \d+s/);
	assert.match(err, /clean-runner-debris: fixture-c done in \d+s/);
});
