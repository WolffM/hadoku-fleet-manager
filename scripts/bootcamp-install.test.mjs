import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

import { args, CLAW, FFMPEG_ONLY, run, writableFixture } from './lib/bootcamp-fixtures.mjs';

// ── INSTALL ON ASSIGNMENT (#69, wave 3q lane D) ─────────────────────────────
//
// `taskauto` is ROLE-assigned: bootcamp cannot earn it, so "assigned" is read
// from the same `nodeOffer` derivation the mint uses (via `applicableRepairs`).
// The fixture node logs every script it is handed as DETECT / INSTALL / PROBE.

test('an assigned node missing claude gets it installed BEFORE the probe', () => {
	const f = writableFixture(FFMPEG_ONLY, { labels: ['taskauto'] });
	try {
		const r = run(args, f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		// detect (absent) -> install -> detect again (verifies) -> probe.
		assert.deepEqual(f.calls(), ['DETECT', 'INSTALL', 'DETECT', 'PROBE']);
		assert.match(r.out, /installed: claude/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

/**
 * THE MUTATION SIGNAL FOR #70. Pre-fix, `ensureTools` called
 * `installScript(id)` with no version at all, so the node's script never
 * pinned anything and the vendor's `install.sh` ran with no `$TARGET_VERSION`
 * — vendor-latest, bypassing the debounce on exactly this path. The resolved,
 * debounce-cleared release (`npmVersion` on the fixture) must appear in the
 * script actually handed to the node.
 */
test('the install is PINNED to the debounced release the lookup resolved, never bare', () => {
	const f = writableFixture(FFMPEG_ONLY, { labels: ['taskauto'], npmVersion: '2.1.283' });
	try {
		const r = run(args, f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		assert.match(
			f.installScript(),
			/TARGET_VERSION='2\.1\.283'/,
			'the resolved release must be pinned into the script, not left to vendor-latest'
		);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

/**
 * "COULD NOT LOOK" REFUSES, IT NEVER FALLS BACK (issue #70). A registry that
 * cannot say what the debounced release is must not be read as "nothing to
 * pin" and fall through to a bare, vendor-latest install — the exact bypass
 * this lane exists to close. The install must never even be ATTEMPTED.
 */
test('a lookup that cannot resolve the debounce is a FAILURE, and the install never runs', () => {
	const f = writableFixture(FFMPEG_ONLY, {
		labels: ['taskauto'],
		npmUnknown: 'registry answered HTTP 429',
	});
	try {
		const r = run([...args, '--json'], f.env);
		assert.equal(r.code, 1, 'an unresolved debounce must fail the run');
		const doc = JSON.parse(r.out);
		assert.equal(doc.ok, false);
		const t = doc.tools[CLAW].find((x) => x.id === 'claude');
		assert.equal(t.action, 'failed');
		assert.match(t.detail, /could not determine the debounced release/);
		assert.match(t.detail, /429/, 'the reason upstream gave must be carried, not swallowed');
		// detect (absent) -> PROBE. No INSTALL: the bare vendor-latest install
		// never ran, and nothing was ever handed to the node to run it.
		assert.deepEqual(f.calls(), ['DETECT', 'PROBE']);
		assert.equal(f.installScript(), null, 'no install script reached the node at all');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a node that is NOT assigned taskauto gets nothing installed and is not asked', () => {
	const f = writableFixture(FFMPEG_ONLY, { labels: [] });
	try {
		const r = run(args, f.env);
		assert.equal(r.code, 0, `${r.out}\n${r.err}`);
		assert.deepEqual(f.calls(), ['PROBE'], 'a tool for a capability the node lacks was touched');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a node that already carries claude is detected and left alone — no install, no write', () => {
	const f = writableFixture(FFMPEG_ONLY, { labels: ['taskauto'], claudePresent: true });
	try {
		const base = f.commits();
		assert.equal(run(args, f.env).code, 0);
		assert.deepEqual(f.calls(), ['DETECT', 'PROBE']);
		const after = f.commits();
		// The one write is the first capability record; the install path added none.
		assert.equal(after, base + 1);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('a failed install is a FAILURE carrying its reason, never a silent earned', () => {
	const f = writableFixture(FFMPEG_ONLY, { labels: ['taskauto'], failInstall: true });
	try {
		const r = run([...args, '--json'], f.env);
		assert.equal(r.code, 1, 'an install that failed must fail the run');
		const doc = JSON.parse(r.out);
		assert.equal(doc.ok, false);
		const t = doc.tools[CLAW].find((x) => x.id === 'claude');
		assert.equal(t.action, 'failed');
		assert.match(t.detail, /Could not resolve host: claude\.ai/);
		// install ran once and was NOT retried into a verdict.
		assert.deepEqual(f.calls(), ['DETECT', 'INSTALL', 'PROBE']);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('installing on assignment keeps --write idempotent: the second run installs and commits nothing (#59)', () => {
	const f = writableFixture(FFMPEG_ONLY, { labels: ['taskauto'] });
	try {
		const base = f.commits();
		assert.equal(run(args, f.env).code, 0);
		assert.equal(f.commits(), base + 1);
		const first = f.record();

		const second = run(args, f.env);
		assert.equal(second.code, 0, `${second.out}\n${second.err}`);
		assert.equal(f.commits(), base + 1, 'a re-run committed — that redeploys mgmt-api (#59)');
		assert.equal(f.record().at, first.at);
		assert.equal(
			f.calls().filter((c) => c === 'INSTALL').length,
			1,
			'the tool was installed twice'
		);
		assert.match(second.out, /re-probed and UNCHANGED/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});
