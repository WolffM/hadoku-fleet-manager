/**
 * `--max-age` and `contract` (fleet-manager#16, agreed with cardtable). A
 * fixture fleet of ZERO machines, so no call here can reach a node: the
 * cached branch answers before any ssh, and the live one has nothing to ask.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('node-status.mjs', import.meta.url));

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'node-status-'));
	writeFileSync(join(root, 'fleet-runner-manifest.json'), JSON.stringify({ machines: {} }));
	const env = {
		...process.env,
		FLEET_MANIFEST_DIR: root,
		HADOKU_STATE_DIR: root,
		HADOKU_SITE_ROOT: '/nonexistent',
	};
	return { root, env, last: join(root, 'node-status-last.json') };
}

/** stdout and the exit code; node-status exits 1 on findings and still prints the document. */
function run(args, env) {
	try {
		return {
			code: 0,
			out: execFileSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8' }),
		};
	} catch (err) {
		return { code: err.status, out: err.stdout };
	}
}

test('a live document carries the contract and is kept for --max-age', () => {
	const f = fixture();
	try {
		const live = JSON.parse(run(['--json'], f.env).out);
		assert.equal(live.contract, 1);
		assert.equal(live.cached, false);
		const kept = JSON.parse(readFileSync(f.last, 'utf8'));
		assert.equal(kept.generatedAt, live.generatedAt);
		assert.ok(!('cached' in kept), 'the kept copy is the document, not a served one');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('--max-age serves a young copy, marked cached, with its own generatedAt and exit', () => {
	const f = fixture();
	try {
		const at = new Date(Date.now() - 20_000).toISOString();
		writeFileSync(f.last, JSON.stringify({ contract: 1, ok: true, generatedAt: at, nodes: [] }));
		const r = run(['--json', '--max-age', '60'], f.env);
		const doc = JSON.parse(r.out);
		assert.equal(r.code, 0);
		assert.equal(doc.cached, true);
		assert.equal(doc.generatedAt, at);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('an old copy, or one of another contract, is never served: the call goes live', () => {
	const f = fixture();
	try {
		const old = new Date(Date.now() - 120_000).toISOString();
		for (const kept of [
			{ contract: 1, ok: true, generatedAt: old, nodes: [] },
			{ contract: 0, ok: true, generatedAt: new Date().toISOString(), nodes: [] },
		]) {
			writeFileSync(f.last, JSON.stringify(kept));
			const doc = JSON.parse(run(['--json', '--max-age', '60'], f.env).out);
			assert.equal(doc.cached, false);
			assert.notEqual(doc.generatedAt, kept.generatedAt);
		}
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('--max-age without a positive number is a usage error, not a document', () => {
	const f = fixture();
	try {
		const r = run(['--json', '--max-age', 'soon'], f.env);
		assert.equal(r.code, 2);
		assert.equal(r.out, '');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});
