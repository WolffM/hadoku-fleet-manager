/**
 * `src/lib/manifest.ts` — the one typed manifest reader (wave 5c, F1).
 *
 * `readManifestState` is the primitive: `{ok:true, doc}` on a successful
 * read+parse, `{ok:false, why}` on anything else. The CONTRACT under test is
 * AGENTS.md's: "I could not look" must never render as "nothing is wrong" —
 * a missing file and a corrupt one are both `ok:false`, never an empty
 * `{machines:{}}` doc, because that reads as a healthy fleet of zero machines
 * and pages every label at once (`fleet-loop.ts`'s own header, moved here).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
	readManifestState,
	readFleetManifest,
	loadEphemeralNodes,
	loadGuestNodes,
	loadClawNodes,
	loadFleetNodeNames,
	loadFleetManifestMachines,
	loadNodeCapacity,
} from '../lib/manifest.js';
import { __setHostForTesting } from '../host.js';
import { testHost } from './install-test-host.js';
import { tempDir } from './tmpdir.js';

/** Run `fn` against a throwaway manifest dir, restoring the ambient test host after. */
function withManifestDir(fn: (dir: string) => void): void {
	const dir = tempDir('manifest-test-');
	__setHostForTesting({ ...testHost, manifestDir: dir } as never);
	try {
		fn(dir);
	} finally {
		__setHostForTesting(testHost);
		rmSync(dir, { recursive: true, force: true });
	}
}

function writeManifest(dir: string, doc: unknown): void {
	writeFileSync(join(dir, 'fleet-runner-manifest.json'), JSON.stringify(doc));
}

// ── readManifestState: the primitive ────────────────────────────────────────

void test('readManifestState: ok:true with the parsed doc on a valid manifest', () => {
	withManifestDir((dir) => {
		writeManifest(dir, { machines: { 'claw-1': { ephemeral: true } } });
		const result = readManifestState();
		assert.equal(result.ok, true);
		if (result.ok) assert.deepEqual(result.doc, { machines: { 'claw-1': { ephemeral: true } } });
	});
});

void test('readManifestState: ok:false, never an empty doc, when the file is MISSING', () => {
	withManifestDir(() => {
		// No fleet-runner-manifest.json written in the manifest dir at all.
		const result = readManifestState();
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.match(result.why, /cannot read/);
			assert.match(result.why, /fleet-runner-manifest\.json/);
		}
	});
});

void test('readManifestState: ok:false, never an empty doc, when the file is CORRUPT', () => {
	withManifestDir((dir) => {
		writeFileSync(join(dir, 'fleet-runner-manifest.json'), '{ not valid json');
		const result = readManifestState();
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.why, /not valid JSON/);
	});
});

void test('readManifestState: a `dir` override reads without the configured host manifestDir', () => {
	const dir = tempDir('manifest-override-');
	try {
		writeManifest(dir, { machines: { claw9: {} } });
		// Ambient test host points elsewhere (manifests/, from install-test-host.ts) —
		// the override must win, never falling back to the ambient directory.
		const result = readManifestState(dir);
		assert.equal(result.ok, true);
		if (result.ok) assert.deepEqual(Object.keys(result.doc.machines ?? {}), ['claw9']);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── readFleetManifest: the null-returning compatibility shim ───────────────

void test('readFleetManifest: null (never {}) when the manifest cannot be read', () => {
	withManifestDir(() => {
		assert.equal(readFleetManifest(), null);
	});
});

void test('readFleetManifest: the parsed doc on a valid manifest', () => {
	withManifestDir((dir) => {
		writeManifest(dir, { machines: { claw1: {} } });
		assert.deepEqual(readFleetManifest(), { machines: { claw1: {} } });
	});
});

// ── the six loaders: each must answer "could not look" distinctly from empty ─

void test('loadEphemeralNodes: the ephemeral set on a readable manifest, empty (not thrown) when unreadable', () => {
	withManifestDir((dir) => {
		writeManifest(dir, { machines: { 'claw-3': { ephemeral: true }, 'claw-1': {} } });
		assert.deepEqual(loadEphemeralNodes(), new Set(['claw-3']));
	});
	withManifestDir(() => {
		// No manifest written: an unreadable manifest must not throw and must not
		// silently manufacture a wrong-but-plausible ephemeral set either — empty
		// is the documented fallback every loader in this module shares.
		assert.deepEqual(loadEphemeralNodes(), new Set());
	});
});

void test('loadGuestNodes: reads role through isGuestNode, never the raw field', () => {
	withManifestDir((dir) => {
		writeManifest(dir, { machines: { hokon: { role: 'guest' }, 'claw-1': { role: 'claw' } } });
		assert.deepEqual(loadGuestNodes(), new Set(['hokon']));
	});
});

void test('loadClawNodes: every node except the pm2-host label', () => {
	withManifestDir((dir) => {
		writeManifest(dir, {
			machines: {
				hokon: { labels: ['pm2-host'] },
				'claw-1': { labels: ['self-hosted'] },
			},
		});
		assert.deepEqual(loadClawNodes(), new Set(['claw-1']));
	});
});

void test('loadFleetNodeNames: every declared node, pm2-host included', () => {
	withManifestDir((dir) => {
		writeManifest(dir, { machines: { hokon: { labels: ['pm2-host'] }, 'claw-1': {} } });
		assert.deepEqual(loadFleetNodeNames().sort(), ['claw-1', 'hokon']);
	});
});

void test('loadFleetManifestMachines: null — not {} — when the manifest cannot be read', () => {
	withManifestDir(() => {
		assert.equal(loadFleetManifestMachines(), null);
	});
	withManifestDir((dir) => {
		writeManifest(dir, { machines: { 'claw-1': { maxConcurrent: 2 } } });
		assert.deepEqual(loadFleetManifestMachines(), { 'claw-1': { maxConcurrent: 2 } });
	});
});

void test('loadNodeCapacity: maxConcurrent per node, skipping nodes without one', () => {
	withManifestDir((dir) => {
		writeManifest(dir, {
			machines: { 'claw-1': { maxConcurrent: 4 }, 'claw-2': {} },
		});
		assert.deepEqual(loadNodeCapacity(), { 'claw-1': 4 });
	});
});

// ── MUTATION (recorded for the closing note; left in as a standing regression
// test): a loader that turned a parse error into an empty doc instead of
// ok:false is exactly the bug this module exists to rule out. ──────────────

void test('MUTATION GUARD: readManifestState must stay ok:false on a corrupt file, never ok:true with {}', () => {
	withManifestDir((dir) => {
		writeFileSync(join(dir, 'fleet-runner-manifest.json'), 'not json at all');
		const result = readManifestState();
		// The assertion a buggy "return {ok:true, doc:{}} on a parse error" would
		// fail: see this wave's closing note for the reverted-and-rerun counts.
		assert.equal(result.ok, false, 'a corrupt manifest must never read as an empty, healthy one');
	});
});
