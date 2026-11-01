/**
 * `fleet hosting-eligibility` end to end, on a fixture manifest and state dir.
 * The reader reaches no node, so nothing here can either. What the document
 * says from those files is lib/hosting-eligibility.test.mjs.
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

const SCRIPT = fileURLToPath(new URL('hosting-eligibility.mjs', import.meta.url));
const CARDTABLE = JSON.parse(
	readFileSync(new URL('lib/fixtures/hosting-cardtable.json', import.meta.url), 'utf8')
);

function fixture({ register = true, pass = true } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'hosting-eligibility-'));
	writeFileSync(
		join(root, 'fleet-runner-manifest.json'),
		JSON.stringify({ machines: { hokon: { role: 'backstop' }, 'claw-8': {}, 'claw-9': {} } })
	);
	const request = validateHostingRequest({
		...CARDTABLE,
		placement: { ...CARDTABLE.placement, auto: true },
	}).request;
	if (register)
		registerTenant(root, request, { source: 'WolffM/hadoku-cardtable:hosting.json', by: 't' });
	writeFileSync(
		join(root, 'fleet-hosting.json'),
		JSON.stringify({
			nodes: {
				'claw-8': [
					{
						tenant: 'cardtable',
						memoryMb: 4096,
						cores: 4,
						port: 7621,
						since: new Date(Date.now() - 2 * 86_400_000).toISOString(),
					},
				],
			},
			apps: {},
		})
	);
	if (pass)
		writeFileSync(
			join(root, 'hosting-converge-last.json'),
			JSON.stringify({
				at: new Date().toISOString(),
				dryRun: false,
				tenants: {
					cardtable: {
						eligibility: { eligible: ['claw-9'], ruledOut: [], unknown: [] },
					},
				},
			})
		);
	const env = { ...process.env, FLEET_MANIFEST_DIR: root, HADOKU_STATE_DIR: root };
	return { root, env, done: () => rmSync(root, { recursive: true, force: true }) };
}
function run(args, env) {
	try {
		const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
			env,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { code: 0, doc: JSON.parse(stdout) };
	} catch (err) {
		return { code: err.status, doc: err.stdout ? JSON.parse(err.stdout) : null };
	}
}

test("placed from the ledger, eligible with the converger's candidates, exit 0", () => {
	const f = fixture();
	try {
		const r = run(['--json'], f.env);
		assert.equal(r.code, 0);
		assert.equal(r.doc.ok, true);
		assert.equal(r.doc.contract, 1);
		assert.deepEqual(r.doc.nodes, {
			'claw-8': {
				placed: ['WolffM/hadoku-cardtable'],
				eligible: ['WolffM/hadoku-cardtable'],
				unknown: [],
			},
			'claw-9': { placed: [], eligible: ['WolffM/hadoku-cardtable'], unknown: [] },
		});
		assert.deepEqual(
			r.doc.notLent.map((n) => n.node),
			['hokon']
		);
	} finally {
		f.done();
	}
});

test('no converger pass kept is could-not-look: ok false, no nodes, exit 1', () => {
	const f = fixture({ pass: false });
	try {
		const r = run(['--json'], f.env);
		assert.equal(r.code, 1);
		assert.equal(r.doc.ok, false);
		assert.equal(r.doc.nodes, null);
		assert.match(r.doc.error, /converger has kept no pass \(hosting-converge-last\.json\)/);
	} finally {
		f.done();
	}
});

test('an unreadable ledger, registry, drain record or pass each fail the document, naming the file', () => {
	for (const [file, re] of [
		['fleet-hosting.json', /hosting record \(fleet-hosting\.json\) is unreadable/],
		['hosting-tenants.json', /tenant registry \(hosting-tenants\.json\) is unreadable/],
		['fleet-drain.json', /drain record \(fleet-drain\.json\) is unreadable/],
		['hosting-converge-last.json', /last pass \(hosting-converge-last\.json\) is unreadable/],
	]) {
		const f = fixture();
		try {
			writeFileSync(join(f.root, file), '{ not json');
			const r = run(['--json'], f.env);
			assert.equal(r.code, 1, file);
			assert.equal(r.doc.ok, false);
			assert.equal(r.doc.nodes, null, `${file}: never an empty map`);
			assert.match(r.doc.error, re);
		} finally {
			f.done();
		}
	}
});

test('no tenant registered fails rather than answering "nothing anywhere"', () => {
	const f = fixture({ register: false });
	try {
		const r = run(['--json'], f.env);
		assert.equal(r.code, 1);
		assert.equal(r.doc.nodes, null);
		assert.match(
			r.doc.error,
			/claw-8 holds a slice of cardtable, which is not a registered tenant/
		);
		assert.match(r.doc.error, /no tenant is registered/);
	} finally {
		f.done();
	}
});

test('an unexpected argument is a usage error, still a document, exit 2', () => {
	const f = fixture();
	try {
		const r = run(['claw-8', '--json'], f.env);
		assert.equal(r.code, 2);
		assert.equal(r.doc.ok, false);
		assert.equal(r.doc.nodes, null);
	} finally {
		f.done();
	}
});
