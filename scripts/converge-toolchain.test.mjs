/**
 * converge-toolchain, the default (`main()`) check path — exercised as a CLI
 * over a fixture manifest, a fixture node-profiles.json and a stand-in `ssh`,
 * the same way every other fleet gate in this repo is tested. No prior test
 * file spawned this script's own CLI at all; this one covers only the
 * wave gates1 §A behaviour (known-down skip), not the whole surface.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'converge-toolchain.mjs');
const NODE = 'fixture-node';

/** A minimal profiles.json: one profile, zero required packages, so `observe()`'s
 * package-presence loop runs over nothing and only the ssh reachability itself
 * is under test. */
const PROFILES = JSON.stringify({
	profiles: { 'fixture-profile': { toolchain: { packages: [] } } },
});

/** `ssh` that answers every call cleanly, or refuses outright for `SSH_FAIL`. */
const SSH_SHIM = `#!/usr/bin/env bash
cat > /dev/null
if [ -n "\${SSH_FAIL:-}" ]; then
	echo "ssh: connect to host ${NODE} port 22: No route to host" >&2
	exit 255
fi
exit 0
`;

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'converge-toolchain-'));
	writeFileSync(
		join(root, 'fleet-runner-manifest.json'),
		JSON.stringify({ machines: { [NODE]: {} } })
	);
	writeFileSync(join(root, 'node-profiles.json'), PROFILES);
	const bin = join(root, 'bin');
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, 'ssh'), SSH_SHIM);
	chmodSync(join(bin, 'ssh'), 0o755);
	return { root, bin };
}

function cleanup(fx) {
	rmSync(fx.root, { recursive: true, force: true });
}

function run(fx, { fail = false, argv = [] } = {}) {
	const env = {
		...process.env,
		PATH: `${fx.bin}:${process.env.PATH}`,
		FLEET_MANIFEST_DIR: fx.root,
		FLEET_NODE_PROFILES: join(fx.root, 'node-profiles.json'),
		HADOKU_STATE_DIR: fx.root,
		SSH_FAIL: fail ? '1' : '',
	};
	try {
		const stdout = execFileSync('node', [GATE, ...argv], {
			env,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		return { code: 0, out: stdout, stdout };
	} catch (e) {
		return {
			code: e.status ?? -1,
			out: String(e.stdout ?? '') + String(e.stderr ?? ''),
			stdout: String(e.stdout ?? ''),
		};
	}
}

test('a clean, reachable node exits 0 — without this every case below is vacuous', () => {
	const fx = fixture();
	try {
		const r = run(fx);
		assert.equal(r.code, 0, `expected a clean fleet to pass, got ${r.code}:\n${r.out}`);
		assert.match(r.out, /Every node carries the declared toolchain/);
	} finally {
		cleanup(fx);
	}
});

test('an unreachable node fails the gate', () => {
	const fx = fixture();
	try {
		const r = run(fx, { fail: true });
		assert.equal(r.code, 1, `an unreachable node must fail the gate, got ${r.code}:\n${r.out}`);
		assert.match(r.out, /UNREADABLE/);
	} finally {
		cleanup(fx);
	}
});

test('wave gates1 §A: a node already paged down by runner-health is skipped, not a fresh failure', () => {
	const fx = fixture();
	try {
		writeFileSync(
			join(fx.root, 'runner-down-page.json'),
			JSON.stringify({
				[NODE]: {
					since: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
					lastPage: new Date(Date.now() - 60_000).toISOString(),
				},
			})
		);
		const r = run(fx, { fail: true, argv: ['--json'] });
		assert.equal(r.code, 0, `the only unreachable node is already paged down:\n${r.out}`);
		const doc = JSON.parse(r.stdout);
		assert.equal(doc.ok, true);
		assert.equal(doc.nodes[0].status, 'known-down');
		assert.equal(doc.knownDown.length, 1);
		assert.equal(doc.knownDown[0].node, NODE);
		assert.match(doc.knownDown[0].pagedBy, /runner-health/);
	} finally {
		cleanup(fx);
	}
});

test('wave gates1 §A: the same unreachable node, NOT known down, still fails (control)', () => {
	const fx = fixture();
	try {
		// No runner-down-page.json at all — the safe-direction empty set.
		const r = run(fx, { fail: true, argv: ['--json'] });
		assert.equal(r.code, 1);
		const doc = JSON.parse(r.stdout);
		assert.equal(doc.ok, false);
		assert.deepEqual(doc.knownDown, []);
		assert.equal(doc.nodes[0].status, 'unreadable');
	} finally {
		cleanup(fx);
	}
});
