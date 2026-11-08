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

// ── wave gates1 §A: a node already paged down by runner-health ─────────────

test('wave gates1 §A: a node already paged down by runner-health is skipped, not a fresh failure', (t) => {
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
	writeFileSync(
		join(root, 'runner-down-page.json'),
		JSON.stringify({
			'fixture-b': {
				since: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
				lastPage: new Date(Date.now() - 60_000).toISOString(),
			},
		})
	);

	const outPath = join(root, 'out.json');
	const r = spawnSync('sh', ['-c', `node "${SCRIPT}" --json > "${outPath}" 2>/dev/null`], {
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			FLEET_MANIFEST_DIR: root,
			HADOKU_STATE_DIR: root,
		},
	});
	const doc = JSON.parse(readFileSync(outPath, 'utf8'));
	assert.equal(r.status, 0, `fixture-b is the only unreachable node and is already paged down`);
	const b = doc.results.find((x) => x.machine === 'fixture-b');
	assert.equal(b.ok, true);
	assert.equal(b.skipped, 'known down');
	assert.equal(doc.knownDown.length, 1);
	assert.equal(doc.knownDown[0].node, 'fixture-b');
	assert.match(doc.knownDown[0].pagedBy, /runner-health/);
});

test('wave gates1 §A: the same unreachable node, NOT known down, still fails (control)', (t) => {
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
	// No runner-down-page.json at all — the safe-direction empty set.

	const outPath = join(root, 'out.json');
	const r = spawnSync('sh', ['-c', `node "${SCRIPT}" --json > "${outPath}" 2>/dev/null`], {
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			FLEET_MANIFEST_DIR: root,
			HADOKU_STATE_DIR: root,
		},
	});
	const doc = JSON.parse(readFileSync(outPath, 'utf8'));
	assert.equal(r.status, 1);
	const b = doc.results.find((x) => x.machine === 'fixture-b');
	assert.equal(b.ok, false);
	assert.deepEqual(doc.knownDown, []);
});

// ── fleet-manager#65: only an ABANDONED cache is sized on the node ──────────
//
// The node script runs `du -sk` on every path in CACHE_PATHS, and the
// controller reads back only the sizes of caches it has judged abandoned. Every
// declared cache used to go down, so claw-1 walked its own ~/.cache/trunk (403k
// files, 66s cold on a spinning disk) every night for a number nobody read, and
// on 2026-11-06 the scan crossed its 90s timeout.
const PAYLOAD_SHIM = `#!/usr/bin/env bash
node="\${5##*@}"
cat > "$PAYLOAD_DIR/$node.sh"
echo "CACHE-PRESENT ~/.gradle 2097152"
echo "SUMMARY stale_kb=0 update_kb=0 orphan_kb=0 diag_kb=0 tmpfs_kb=0 busy_skipped=0 free_kb=1000000 tmpfs_used_kb=0"
`;

function runWithCaches(t, { coverage }) {
	const root = mkdtempSync(join(tmpdir(), 'crd-caches-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(
		join(root, 'fleet-runner-manifest.json'),
		JSON.stringify({
			machines: { 'fixture-a': { labels: [] } },
			// WolffM/served runs anywhere; WolffM/gone needs a label fixture-a lacks.
			repos: { 'WolffM/gone': { needs: ['gpu'] } },
			toolCaches: {
				$why: 'a string, as the live manifest carries one',
				trunk: { path: '~/.cache/trunk', repos: ['WolffM/served'] },
				gradle: { path: '~/.gradle', repos: ['WolffM/gone'] },
				pnpm: { path: '~/.cache/pnpm' },
			},
		})
	);
	if (coverage)
		writeFileSync(join(root, 'fleet-runner-coverage.json'), JSON.stringify({ repos: coverage }));
	const bin = join(root, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'ssh'), PAYLOAD_SHIM);
	chmodSync(join(bin, 'ssh'), 0o755);
	const outPath = join(root, 'out.txt');
	const r = spawnSync('sh', ['-c', `node "${SCRIPT}" > "${outPath}" 2>&1`], {
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			FLEET_MANIFEST_DIR: root,
			HADOKU_STATE_DIR: root,
			PAYLOAD_DIR: root,
		},
	});
	const payload = readFileSync(join(root, 'fixture-a.sh'), 'utf8');
	return {
		status: r.status,
		cachePaths: /^CACHE_PATHS='([^']*)'$/m.exec(payload)?.[1],
		out: readFileSync(outPath, 'utf8'),
	};
}

test('only the caches a node has abandoned go down to be sized (#65)', (t) => {
	const r = runWithCaches(t, { coverage: ['WolffM/served', 'WolffM/gone'] });
	assert.equal(r.status, 0, r.out);
	// MUTATION: send every declared path again and this reads
	// '~/.cache/trunk ~/.gradle ~/.cache/pnpm'.
	assert.equal(r.cachePaths, '~/.gradle', 'trunk is still served and pnpm is unclaimed');
	assert.match(r.out, /CACHE-ABANDONED ~\/\.gradle {2}2(\.0+)? GB — fixture-a serves none/);
});

test('with no coverage nothing is judged abandoned, so nothing is sized', (t) => {
	const r = runWithCaches(t, { coverage: null });
	assert.equal(r.cachePaths, '', 'unreadable coverage is "no verdict", not "size it all"');
	assert.doesNotMatch(r.out, /CACHE-ABANDONED/);
});

// ── fleet-manager#65: the sweep record ──────────────────────────────────────
// `fixture-busy` answers SKIP-CACHES, the line the node script prints when a
// job held the bounded caches back. Only the other one counts as swept.
const SWEEP_SHIM = `#!/usr/bin/env bash
cat > /dev/null
node="\${5##*@}"
[ "$node" = fixture-busy ] && echo "SKIP-CACHES a job is running on this node"
echo "SUMMARY stale_kb=0 update_kb=0 orphan_kb=0 diag_kb=0 tmpfs_kb=0 busy_skipped=0 free_kb=1000000 tmpfs_used_kb=0"
`;

function runSweep(t, args, log) {
	const root = mkdtempSync(join(tmpdir(), 'crd-sweep-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(
		join(root, 'fleet-runner-manifest.json'),
		JSON.stringify({ machines: { 'fixture-idle': {}, 'fixture-busy': {} } })
	);
	if (log) writeFileSync(join(root, 'cache-sweep-log.json'), JSON.stringify(log));
	const bin = join(root, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'ssh'), SWEEP_SHIM);
	chmodSync(join(bin, 'ssh'), 0o755);
	const outPath = join(root, 'out.json');
	const r = spawnSync('sh', ['-c', `node "${SCRIPT}" ${args} --json > "${outPath}" 2>/dev/null`], {
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			FLEET_MANIFEST_DIR: root,
			HADOKU_STATE_DIR: root,
		},
	});
	let saved = null;
	try {
		saved = JSON.parse(readFileSync(join(root, 'cache-sweep-log.json'), 'utf8'));
	} catch {
		saved = null;
	}
	return { status: r.status, doc: JSON.parse(readFileSync(outPath, 'utf8')), saved };
}

test('--confirm records a sweep only where no job held the caches back', (t) => {
	const r = runSweep(t, '--confirm');
	assert.equal(r.status, 0);
	assert.deepEqual(
		r.doc.results.map((x) => [x.machine, x.cachesSwept]),
		[
			['fixture-idle', true],
			['fixture-busy', false],
		]
	);
	assert.equal(typeof r.saved['fixture-idle'].sweptAt, 'number');
	assert.equal(r.saved['fixture-busy'].sweptAt, undefined, 'a held-back night is not a sweep');
	assert.equal(typeof r.saved['fixture-busy'].seenAt, 'number', 'but its clock has started');
	assert.deepEqual(r.doc.findings, []);
});

test('a node no night has swept in a fortnight is a FINDING; a dry run neither records nor judges', (t) => {
	const old = Date.now() - 15 * 86_400_000;
	const log = { 'fixture-busy': { seenAt: old }, 'fixture-idle': { seenAt: old } };
	const r = runSweep(t, '--confirm', log);
	assert.equal(r.status, 1, 'overdue fails the run');
	assert.deepEqual(
		r.doc.findings.map((f) => [f.machine, f.kind]),
		[['fixture-busy', 'caches-unswept']],
		'the idle node was just swept, so only the busy one is overdue'
	);
	const dry = runSweep(t, '', log);
	assert.equal(dry.status, 0);
	assert.deepEqual(dry.doc.findings, []);
	assert.deepEqual(dry.saved, log, 'a dry run writes nothing');
});
