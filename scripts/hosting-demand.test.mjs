/**
 * `fleet hosting-demand` (fleet-manager#16, agreed with cardtable): a count
 * restated every poll, limits refused with the reason, and the converger's
 * view returned on every call. A fixture fleet of zero machines and a fixture
 * state dir: nothing here can reach a node.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateHostingRequest } from './lib/hosting-request.mjs';
import { registerTenant } from './lib/tenant-registry.mjs';

const SCRIPT = fileURLToPath(new URL('hosting-demand.mjs', import.meta.url));
const CARDTABLE = JSON.parse(
	readFileSync(new URL('lib/fixtures/hosting-cardtable.json', import.meta.url), 'utf8')
);

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'hosting-demand-'));
	writeFileSync(join(root, 'fleet-runner-manifest.json'), JSON.stringify({ machines: {} }));
	registerTenant(root, validateHostingRequest(CARDTABLE).request, {
		source: 'fixture',
		by: 'test',
	});
	const env = { ...process.env, FLEET_MANIFEST_DIR: root, HADOKU_STATE_DIR: root };
	return { root, env };
}
function run(args, env) {
	try {
		return {
			code: 0,
			doc: JSON.parse(
				execFileSync(process.execPath, [SCRIPT, ...args, '--json'], { env, encoding: 'utf8' })
			),
		};
	} catch (err) {
		return { code: err.status, doc: err.stdout ? JSON.parse(err.stdout) : null };
	}
}

test('the same N restated changes nothing but when it was asked', () => {
	const f = fixture();
	try {
		const first = run(['cardtable', '--slices', '2', '--release-order', 'claw-6,claw-5'], f.env);
		assert.equal(first.code, 0);
		assert.equal(first.doc.contract, 1);
		assert.deepEqual(first.doc.recorded, { changed: true });
		const again = run(['cardtable', '--slices', '2', '--release-order', 'claw-6,claw-5'], f.env);
		assert.deepEqual(again.doc.recorded, { changed: false });
		assert.equal(again.doc.demand.since, first.doc.demand.since);
		assert.deepEqual(again.doc.demand.releaseOrder, ['claw-6', 'claw-5']);
		assert.deepEqual(again.doc.limits, { min: 1, max: 4 });
		assert.equal(again.doc.auto, false);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('outside min..max, or an order naming a node twice, is refused and records nothing', () => {
	const f = fixture();
	try {
		for (const args of [
			['--slices', '5'],
			['--slices', '0'],
			['--slices', '1.5'],
			['--slices', '2', '--release-order', 'claw-6,claw-6'],
		]) {
			const r = run(['cardtable', ...args], f.env);
			assert.equal(r.code, 1, args.join(' '));
			assert.equal(r.doc.ok, false);
		}
		assert.equal(run(['cardtable'], f.env).doc.demand, null, 'nothing was recorded');
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('an unregistered tenant is refused with the way to register', () => {
	const f = fixture();
	try {
		const r = run(['nobody', '--slices', '1'], f.env);
		assert.equal(r.code, 1);
		assert.match(r.doc.reason, /fleet hosting-request <owner\/repo> --register/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test('the view carries the converger’s last full pass for this tenant', () => {
	const f = fixture();
	try {
		const passAt = new Date(Date.now() - 60_000).toISOString();
		writeFileSync(
			join(f.root, 'hosting-converge-last.json'),
			JSON.stringify({
				at: passAt,
				dryRun: false,
				tenants: {
					cardtable: { live: false, actions: [{ op: 'declare', node: 'claw-5' }], blocked: [] },
				},
			})
		);
		const { doc } = run(['cardtable'], f.env);
		assert.equal(doc.lastPass.at, passAt);
		assert.equal(doc.lastPass.live, false);
		assert.deepEqual(doc.lastPass.actions, [{ op: 'declare', node: 'claw-5' }]);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});
