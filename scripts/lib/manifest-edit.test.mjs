/**
 * `manifestEdit` is the fleet's highest-risk write path (plan §4.1 F4), so
 * this file proves four things, in this order:
 *
 *   1. BYTE-IDENTITY, per migrated writer (bootcamp, enroll, lan-reserve,
 *      provision): for the SAME starting manifest and the SAME mutation, the
 *      bytes `manifestEdit` lands are IDENTICAL to what that writer's OLD
 *      direct `writeFileSync` path produced before wave 5c. Each
 *      `oldXxxWrite` function below is transcribed verbatim from the
 *      pre-5c source (origin/main 53959ee, this wave's base) — it is not a
 *      simplification, it is the exact sequence that file ran: `writeTarget`,
 *      a raw `JSON.parse(readFileSync(...))`, the mutation, `renderJson`,
 *      `copyFileSync` to `.bak`, `writeFileSync`, a read-back check, and
 *      `landWrite`. The one deliberate byte-level divergence is the `.bak`
 *      sidecar: `manifestEdit` never writes one (the atomic rename is the
 *      crash safety now, not a backup copy), so the comparison is of
 *      `fleet-runner-manifest.json` itself, never the directory listing.
 *   2. REFUSAL: the deploy-tree refusal lands nothing and changes nothing on
 *      disk — proven against the real default root the same way
 *      `manifest-target.test.mjs` does, not an env var that only proves
 *      itself.
 *   3. READ-BACK MISMATCH: a disagreement between what was written and what
 *      reads back refuses to land — nothing is committed.
 *   4. FAULT INJECTION (5b's technique, `src/tests/atomic-json.test.ts`): a
 *      crash inside the write, injected into the real `writeSync` call
 *      `writeFileAtomic` makes, leaves the OLD manifest intact and is
 *      reported as `write-failed`, never swallowed and never left to crash
 *      the caller.
 *
 * The one-writer guard's own mutation proof (bypass `manifestEdit` with a
 * direct `writeFileSync` in a real writer, show `f3-one-writer.test.mjs`
 * fail, restore) is NOT repeated here as an automated test: it would have to
 * revert a real file to fail on purpose, which would leave the build red if
 * anything here stopped it reaching the `finally`. That exercise was run by
 * hand against this wave's actual files and its counts are in the closing
 * note instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { manifestEdit } from './manifest-edit.mjs';
import { renderJson } from './prettier-json.mjs';
import { landWrite, writeTarget, deploySiteRoot } from './manifest-target.mjs';
import { FIXTURE_IDENTITY, cleanGitEnv } from './test-git-identity.mjs';

const made = [];
process.on('exit', () => {
	for (const d of made) rmSync(d, { recursive: true, force: true });
});

function git(dir, args) {
	const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: cleanGitEnv() });
	assert.equal(r.status, 0, `git ${args.join(' ')} in ${dir}: ${r.stderr}`);
	return r.stdout.trim();
}

/**
 * A temp git checkout holding `machines` at HEAD — the same shape
 * `manifest-target.test.mjs`'s `repo()` builds, duplicated here rather than
 * imported because that helper is not exported and this file's fixture needs
 * no remote.
 */
function repo(machines) {
	const dir = mkdtempSync(join(tmpdir(), 'manifest-edit-'));
	made.push(dir);
	git(dir, ['init', '-q', '-b', 'main']);
	for (const [k, v] of [
		['user.name', FIXTURE_IDENTITY.name],
		['user.email', FIXTURE_IDENTITY.email],
	])
		git(dir, ['config', '--file', join(dir, '.git', 'config'), k, v]);
	const file = join(dir, 'fleet-runner-manifest.json');
	writeFileSync(file, `${JSON.stringify({ machines }, null, 2)}\n`);
	git(dir, ['add', '-A']);
	git(dir, ['commit', '-q', '-m', 'base']);
	return { dir, file };
}

/** Replace `fs[key]`, re-sync the live ESM bindings, return the restorer — atomic-json.test.ts's technique. */
function patchFs(key, replacement) {
	const original = fs[key];
	fs[key] = replacement;
	syncBuiltinESMExports();
	return () => {
		fs[key] = original;
		syncBuiltinESMExports();
	};
}

// ── per-writer OLD-STYLE reference implementations, verbatim from 53959ee ───

/** lan-reserve.mjs:131-149, pre-5c. */
async function oldLanReserveWrite(mp, node, record, { push = false } = {}) {
	const target = writeTarget(mp);
	if (!target.ok) return { ok: false, reason: target.reason };
	const doc = JSON.parse(readFileSync(mp, 'utf8'));
	copyFileSync(mp, `${mp}.bak`);
	doc.machines[node].lan = record;
	const rendered = await renderJson(doc, mp);
	writeFileSync(mp, rendered.text);
	const verify = JSON.parse(readFileSync(mp, 'utf8'));
	if (verify.machines?.[node]?.lan?.mac !== record.mac) {
		copyFileSync(`${mp}.bak`, mp);
		return { ok: false, reason: 'readback-mismatch' };
	}
	const landed = landWrite(mp, {
		writer: 'lan-reserve',
		summary: `${node} reserved at ${record.ip}`,
		push,
	});
	return { ok: landed.ok, landed };
}

/** provision-fleet.mjs:447-508 (`applyPlacementWrite`), pre-5c. */
async function oldProvisionWrite(mp, node, { backfill, ephemeral, noPush = true } = {}) {
	const target = writeTarget(mp);
	if (!target.ok) return { ok: false, reason: target.reason };
	const doc = JSON.parse(readFileSync(mp, 'utf8'));
	const entry = doc.machines?.[node];
	if (!entry) return { ok: false, reason: 'no-such-node' };
	const wrote = [];
	for (const [k, v] of Object.entries(backfill ?? {})) {
		entry[k] = v;
		wrote.push(k);
	}
	if (ephemeral) {
		entry.ephemeral = true;
		wrote.push('ephemeral');
	}
	if (!wrote.length) return { ok: true, reason: 'nothing-to-write' };
	const rendered = await renderJson(doc, mp);
	copyFileSync(mp, `${mp}.bak`);
	writeFileSync(mp, rendered.text);
	const verify = JSON.parse(readFileSync(mp, 'utf8'));
	const after = verify.machines?.[node];
	if (!after || (ephemeral && after.ephemeral !== true)) {
		copyFileSync(`${mp}.bak`, mp);
		return { ok: false, reason: 'readback-mismatch' };
	}
	const landed = landWrite(mp, {
		writer: 'provision',
		summary: `placement for ${node}${ephemeral ? ' (ephemeral on)' : ''}`,
		push: !noPush,
	});
	return { ok: landed.ok, landed };
}

/** bootcamp.mjs:1235-1374, pre-5c — the $capabilities facet, one node at a time for this fixture. */
async function oldBootcampWrite(mp, name, record, { push = false } = {}) {
	const target = writeTarget(mp);
	if (!target.ok) return { ok: false, reason: target.reason };
	const raw = JSON.parse(readFileSync(mp, 'utf8'));
	const node = raw.machines?.[name];
	if (!node) return { ok: false, reason: 'no-such-node' };
	node.$capabilities = record;
	const rendered = await renderJson(raw, mp);
	copyFileSync(mp, `${mp}.bak`);
	writeFileSync(mp, rendered.text);
	JSON.parse(readFileSync(mp, 'utf8')); // the old code's own read-back is parse-only
	const landed = landWrite(mp, {
		writer: 'bootcamp',
		summary: `$capabilities for 1 node(s)`,
		push,
	});
	return { ok: landed.ok, landed };
}

/** enroll-node.mjs:849-979, pre-5c — the surgical (`exists`) branch, the shape with the most to lose. */
async function oldEnrollSurgicalWrite(mp, name, measured, { push = false } = {}) {
	const target = writeTarget(mp);
	if (!target.ok) return { ok: false, reason: target.reason };
	const doc = JSON.parse(readFileSync(mp, 'utf8'));
	const priorChanges = doc.machines[name]?.$measured?.hardwareChanges ?? [];
	if (priorChanges.length) measured.$measured.hardwareChanges = [...priorChanges];
	copyFileSync(mp, `${mp}.bak`);
	const current = doc.machines[name];
	current.cores = measured.cores;
	current.ramGb = measured.ramGb;
	current.$measured = measured.$measured;
	const rendered = await renderJson(doc, mp);
	writeFileSync(mp, rendered.text);
	const verify = JSON.parse(readFileSync(mp, 'utf8'));
	if (!verify.machines?.[name]) {
		copyFileSync(`${mp}.bak`, mp);
		return { ok: false, reason: 'readback-mismatch' };
	}
	const landed = landWrite(mp, { writer: 'enroll', summary: `refresh ${name}`, push });
	return { ok: landed.ok, landed };
}

// ── byte-identity, one test per writer ───────────────────────────────────────

void test('byte-identity: lan-reserve — manifestEdit writes the same bytes as the old writeFileSync path', async () => {
	const machines = { 'claw-9': { cores: 4, labels: [] } };
	const record = {
		mac: '02:00:00:00:00:01',
		ip: '192.0.2.90',
		iface: 'wlan0',
		reservedOn: '2026-10-30',
	};

	const a = repo(machines);
	const old = await oldLanReserveWrite(a.file, 'claw-9', record);
	assert.equal(old.ok, true, JSON.stringify(old));

	const b = repo(machines);
	const next = await manifestEdit(
		(d) => {
			d.machines['claw-9'].lan = record;
			return true;
		},
		{
			target: b.file,
			writer: 'lan-reserve',
			reason: `claw-9 reserved at ${record.ip}`,
			push: false,
		}
	);
	assert.equal(next.changed, true, JSON.stringify(next));

	assert.equal(
		readFileSync(b.file, 'utf8'),
		readFileSync(a.file, 'utf8'),
		'bytes must be identical'
	);
});

void test('byte-identity: provision (backfill + ephemeral) — manifestEdit writes the same bytes as the old path', async () => {
	const machines = {
		'claw-8': { cores: 8, ramGb: 15, maxConcurrent: 3, minFreeMb: 2048, $why: 'human prose' },
	};
	const backfill = {
		labels: [],
		role: 'claw',
		maxRegistrations: 32,
		minFreeGb: 25,
		slice: { swapMb: 4096, unitMaxMb: 4096 },
	};

	const a = repo(machines);
	const old = await oldProvisionWrite(a.file, 'claw-8', {
		backfill,
		ephemeral: true,
		noPush: true,
	});
	assert.equal(old.ok, true, JSON.stringify(old));

	const b = repo(machines);
	const wrote = [];
	const next = await manifestEdit(
		(doc) => {
			const entry = doc.machines['claw-8'];
			for (const [k, v] of Object.entries(backfill)) {
				entry[k] = v;
				wrote.push(k);
			}
			entry.ephemeral = true;
			wrote.push('ephemeral');
			return wrote.length > 0;
		},
		{
			target: b.file,
			writer: 'provision',
			reason: 'placement for claw-8 (ephemeral on)',
			push: false,
		}
	);
	assert.equal(next.changed, true, JSON.stringify(next));

	assert.equal(
		readFileSync(b.file, 'utf8'),
		readFileSync(a.file, 'utf8'),
		'bytes must be identical'
	);
});

void test('byte-identity: bootcamp ($capabilities) — manifestEdit writes the same bytes as the old path', async () => {
	const machines = { 'claw-3': { cores: 4, labels: [] } };
	const record = {
		at: new Date().toISOString(),
		by: 'fleet bootcamp',
		declared: ['ffmpeg'],
		earned: ['ffmpeg'],
		unclaimed: [],
		unearned: [],
		blocked: [],
		prereqs: [],
		unprobed: [],
	};

	const a = repo(machines);
	const old = await oldBootcampWrite(a.file, 'claw-3', record);
	assert.equal(old.ok, true, JSON.stringify(old));

	const b = repo(machines);
	const next = await manifestEdit(
		(raw) => {
			raw.machines['claw-3'].$capabilities = record;
			return true;
		},
		{ target: b.file, writer: 'bootcamp', reason: '$capabilities for 1 node(s)', push: false }
	);
	assert.equal(next.changed, true, JSON.stringify(next));

	assert.equal(
		readFileSync(b.file, 'utf8'),
		readFileSync(a.file, 'utf8'),
		'bytes must be identical'
	);
});

void test('byte-identity: enroll (surgical refresh) — manifestEdit writes the same bytes as the old path', async () => {
	const machines = {
		'claw-5': {
			cores: 4,
			ramGb: 8,
			labels: [],
			$capabilities: { at: 'x', earned: ['gh'] },
			$health: { at: 'y', ok: true },
		},
	};
	const measured = {
		cores: 4,
		ramGb: 8,
		$measured: { at: new Date().toISOString(), by: 'fleet enroll', verified: true },
	};

	const a = repo(machines);
	const old = await oldEnrollSurgicalWrite(a.file, 'claw-5', JSON.parse(JSON.stringify(measured)));
	assert.equal(old.ok, true, JSON.stringify(old));

	const b = repo(machines);
	const next = await manifestEdit(
		(freshDoc) => {
			const current = freshDoc.machines['claw-5'];
			current.cores = measured.cores;
			current.ramGb = measured.ramGb;
			current.$measured = measured.$measured;
			return true;
		},
		{ target: b.file, writer: 'enroll', reason: 'refresh claw-5', push: false }
	);
	assert.equal(next.changed, true, JSON.stringify(next));

	assert.equal(
		readFileSync(b.file, 'utf8'),
		readFileSync(a.file, 'utf8'),
		'bytes must be identical'
	);
	// AND THE SURGICAL PROPERTY ITSELF: $capabilities/$health, which this edit
	// never named, survive beside what it wrote — the whole reason the old
	// writer was three named-field assignments and never a replacement.
	const after = JSON.parse(readFileSync(b.file, 'utf8')).machines['claw-5'];
	assert.deepEqual(after.$capabilities, { at: 'x', earned: ['gh'] });
	assert.deepEqual(after.$health, { at: 'y', ok: true });
});

// ── nothing-to-change is never conflated with refused ────────────────────────

void test('tx returning false changes nothing: no second read, no render, no write, no commit', async () => {
	const { dir, file } = repo({ 'claw-9': { ephemeral: true } });
	const before = readFileSync(file, 'utf8');
	const beforeHead = git(dir, ['rev-parse', 'HEAD']);

	const result = await manifestEdit(() => false, {
		target: file,
		writer: 'test',
		reason: 'should never be read',
		push: false,
	});

	assert.deepEqual(result, { changed: false });
	assert.equal(
		readFileSync(file, 'utf8'),
		before,
		'the file must be byte-identical to before the call'
	);
	assert.equal(git(dir, ['rev-parse', 'HEAD']), beforeHead, 'nothing must be committed');
});

// ── refusal: the deploy tree, against the real default root ─────────────────

void test('refusal: a target inside the deploy tree lands nothing and writes nothing', async () => {
	const inSrv = join(deploySiteRoot(), 'scripts', 'admin', 'fleet-runner-manifest.json');
	let txCalled = false;
	const result = await manifestEdit(
		(d) => {
			txCalled = true;
			d.machines ??= {};
			return true;
		},
		{ target: inSrv, writer: 'test', reason: 'must never run', push: false }
	);
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'deploy-tree');
	assert.match(result.why, /REFUSES to write/);
	assert.equal(txCalled, false, 'tx must never run when writeTarget refuses first');
});

// ── refusal: a read-back mismatch lands nothing ──────────────────────────────

void test('refusal: a read-back that disagrees with what tx produced is refused, nothing is landed, and the ORIGINAL bytes are restored', async () => {
	const { dir, file } = repo({ 'claw-9': { cores: 4 } });
	const beforeHead = git(dir, ['rev-parse', 'HEAD']);
	const originalBytes = readFileSync(file, 'utf8');

	const real = fs.readFileSync;
	let readsOfTarget = 0;
	const restore = patchFs('readFileSync', (path, ...rest) => {
		const text = real(path, ...rest);
		if (typeof path === 'string' && path === file) {
			readsOfTarget += 1;
			// Three reads of `target` happen on this path: (1) manifestEdit's
			// pre-mutation read through readManifestState, (2) its OWN raw
			// capture of the original bytes (for the restore this test is
			// proving), (3) the post-write verification. Answer the THIRD with
			// something that does not match what `tx` actually produced — the
			// first two must see the real file, or the restore itself would be
			// seeded from the tampered text instead of the genuine original.
			if (readsOfTarget === 3) return JSON.stringify({ machines: { 'claw-9': { cores: 999 } } });
		}
		return text;
	});
	let result;
	try {
		result = await manifestEdit(
			(d) => {
				d.machines['claw-9'].cores = 8;
				return true;
			},
			{ target: file, writer: 'test', reason: 'bump cores', push: false }
		);
	} finally {
		restore();
	}

	assert.equal(result.ok, false);
	assert.equal(result.reason, 'readback-mismatch');
	assert.match(result.why, /Restored the original file\.$/);
	assert.equal(
		git(dir, ['rev-parse', 'HEAD']),
		beforeHead,
		'nothing must be committed on a mismatch'
	);
	// THE MUTATION THIS GUARDS: the atomic write already happened (STEP 5) before
	// the mismatch was discovered, so without an explicit restore the WRITTEN
	// (not the mismatched-readback, but the real bytes `tx` produced) content
	// would sit on disk, uncommitted, for the next writer's landWrite to fold in
	// under its own subject. Restoring puts the ORIGINAL bytes back.
	assert.equal(
		readFileSync(file, 'utf8'),
		originalBytes,
		'the file on disk must be restored to exactly what it was before this call'
	);
});

// ── refusal: tx throwing is a refusal, never an uncaught exception ──────────

void test('refusal: tx throwing refuses the edit and lands nothing, rather than crashing the caller', async () => {
	const { dir, file } = repo({ 'claw-9': {} });
	const beforeHead = git(dir, ['rev-parse', 'HEAD']);

	const result = await manifestEdit(
		() => {
			throw new Error('claw-42 is not in the manifest');
		},
		{ target: file, writer: 'test', reason: 'must never land', push: false }
	);

	assert.equal(result.ok, false);
	assert.equal(result.reason, 'tx-refused');
	assert.match(result.why, /claw-42 is not in the manifest/);
	assert.equal(git(dir, ['rev-parse', 'HEAD']), beforeHead);
});

// ── a target under any other name can never be edited ───────────────────────

void test('a target not named fleet-runner-manifest.json is refused with a TypeError, before anything runs', async () => {
	const { dir } = repo({ 'claw-9': {} });
	const wrongName = join(dir, 'not-the-manifest.json');
	writeFileSync(wrongName, `${JSON.stringify({ machines: { 'claw-9': {} } }, null, 2)}\n`);
	let txCalled = false;
	await assert.rejects(
		() =>
			manifestEdit(
				() => {
					txCalled = true;
					return true;
				},
				{ target: wrongName, writer: 'test', reason: 'must never run', push: false }
			),
		/target must be a fleet-runner-manifest\.json path/
	);
	assert.equal(txCalled, false, 'tx must never run when the basename check refuses first');
});

// ── fault injection: a crash mid-write leaves the OLD manifest intact ───────

void test('mutation: a crash inside the write leaves the OLD manifest intact (fault-injected, 5b’s technique)', async () => {
	const { dir, file } = repo({ 'claw-9': { cores: 4 } });
	const before = readFileSync(file, 'utf8');
	const beforeHead = git(dir, ['rev-parse', 'HEAD']);

	const realWriteSync = fs.writeSync;
	let crashed = false;
	const restore = patchFs('writeSync', (fd, buffer) => {
		if (crashed) return realWriteSync(fd, buffer);
		crashed = true;
		// A REAL partial write lands — same as the production crash this
		// protects against — then the call throws, exactly as a kill mid-write
		// would terminate the process instead of returning.
		const half = buffer.subarray(0, Math.floor(buffer.length / 2));
		realWriteSync(fd, half);
		throw new Error('simulated crash mid-write');
	});

	let result;
	try {
		result = await manifestEdit(
			(d) => {
				d.machines['claw-9'].cores = 8;
				return true;
			},
			{ target: file, writer: 'test', reason: 'bump cores', push: false }
		);
	} finally {
		restore();
	}

	assert.equal(result.ok, false);
	assert.equal(result.reason, 'write-failed');
	assert.match(result.why, /simulated crash mid-write/);
	assert.equal(
		readFileSync(file, 'utf8'),
		before,
		'RESTORED: the live manifest is untouched by the crashed write'
	);
	assert.equal(git(dir, ['rev-parse', 'HEAD']), beforeHead, 'nothing was ever committed');
});
