/**
 * `fleet hosting-placement` end to end, on a fixture fleet of zero machines
 * and a fixture state dir: every path that needs no node. What the document
 * says about slices on real nodes is lib/hosting-placement-view.test.mjs.
 * No fixture here holds a slice, so nothing here can reach a node.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateHostingRequest } from './lib/hosting-request.mjs';
import { registerTenant } from './lib/tenant-registry.mjs';

const SCRIPT = fileURLToPath(new URL('hosting-placement.mjs', import.meta.url));
const CARDTABLE = JSON.parse(
	readFileSync(new URL('lib/fixtures/hosting-cardtable.json', import.meta.url), 'utf8')
);

function fixture({ register = true } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'hosting-placement-'));
	writeFileSync(join(root, 'fleet-runner-manifest.json'), JSON.stringify({ machines: {} }));
	if (register)
		registerTenant(root, validateHostingRequest(CARDTABLE).request, { source: 'fixture', by: 't' });
	const env = { ...process.env, FLEET_MANIFEST_DIR: root, HADOKU_STATE_DIR: root };
	return { root, env, done: () => rmSync(root, { recursive: true, force: true }) };
}
function run(args, env) {
	try {
		const stdout = execFileSync(process.execPath, [SCRIPT, ...args, '--json'], {
			env,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { code: 0, doc: JSON.parse(stdout) };
	} catch (err) {
		return { code: err.status, doc: err.stdout ? JSON.parse(err.stdout) : null };
	}
}

test('a tenant holding no slice in a readable record is unplaced, ok, exit 0', () => {
	const f = fixture();
	try {
		const r = run(['cardtable'], f.env);
		assert.equal(r.code, 0);
		assert.equal(r.doc.contract, 1);
		assert.equal(r.doc.ok, true);
		assert.equal(r.doc.cached, false);
		assert.deepEqual(r.doc.placement, { state: 'unplaced', epoch: 0, nodes: [], target: null });
		assert.deepEqual(r.doc.slices, []);
		assert.equal(r.doc.tenant.kind, CARDTABLE.kind);
	} finally {
		f.done();
	}
});

test('an app that is not a registered tenant is refused with exit 2 and a reason', () => {
	const f = fixture();
	try {
		const r = run(['watchparty'], f.env);
		assert.equal(r.code, 2);
		assert.equal(r.doc.ok, false);
		assert.equal(r.doc.contract, 1);
		assert.match(r.doc.error, /watchparty is not a registered tenant \(registered: cardtable\)/);
		assert.equal(r.doc.placement, undefined, 'no placement is ever said for an unknown app');
	} finally {
		f.done();
	}
});

test('an unreadable hosting record is could-not-look: ok false, no placement, still exit 0', () => {
	const f = fixture();
	try {
		writeFileSync(join(f.root, 'fleet-hosting.json'), '{ not json');
		const r = run(['cardtable'], f.env);
		assert.equal(r.code, 0, 'the document was written: ok says it, not the exit code (§2)');
		assert.equal(r.doc.ok, false);
		assert.equal(r.doc.placement, null, 'never an empty "unplaced"');
		assert.match(r.doc.error, /fleet-hosting\.json\) is unreadable/);
	} finally {
		f.done();
	}
});

test('an unreadable registry, demand record or converger pass each fail the document', () => {
	const f = fixture();
	try {
		writeFileSync(join(f.root, 'hosting-demand.json'), '[');
		writeFileSync(join(f.root, 'hosting-converge-last.json'), '{');
		const r = run(['cardtable'], f.env);
		assert.equal(r.code, 0);
		assert.equal(r.doc.ok, false);
		assert.match(r.doc.error, /hosting-demand\.json\) is unreadable/);
		assert.match(r.doc.error, /hosting-converge-last\.json\) is unreadable/);
		writeFileSync(join(f.root, 'hosting-tenants.json'), '{');
		const reg = run(['cardtable'], f.env);
		assert.equal(reg.code, 0);
		assert.equal(reg.doc.ok, false);
		assert.match(reg.doc.error, /tenant registry is unreadable/);
	} finally {
		f.done();
	}
});

test('no tenant registered is no evidence, and fails', () => {
	const f = fixture({ register: false });
	try {
		const r = run([], f.env);
		assert.equal(r.code, 0);
		assert.equal(r.doc.ok, false);
		assert.match(r.doc.error, /no tenant is registered/);
	} finally {
		f.done();
	}
});

test('without an app, every registered tenant under apps[]', () => {
	const f = fixture();
	try {
		const r = run([], f.env);
		assert.equal(r.code, 0);
		assert.equal(r.doc.ok, true);
		assert.deepEqual(
			r.doc.apps.map((a) => a.app),
			['cardtable']
		);
	} finally {
		f.done();
	}
});

test('--max-age serves the per-app copy while it is young, marked cached', () => {
	const f = fixture();
	try {
		const live = run(['cardtable'], f.env);
		assert.ok(existsSync(join(f.root, 'hosting-placement-last', 'cardtable.json')));
		const served = run(['cardtable', '--max-age', '600'], f.env);
		assert.equal(served.doc.cached, true);
		assert.equal(served.doc.generatedAt, live.doc.generatedAt);
		// An old copy is not served.
		const old = { ...live.doc, generatedAt: new Date(Date.now() - 3_600_000).toISOString() };
		writeFileSync(join(f.root, 'hosting-placement-last', 'cardtable.json'), JSON.stringify(old));
		assert.equal(run(['cardtable', '--max-age', '60'], f.env).doc.cached, false);
	} finally {
		f.done();
	}
});

test('a usage error is a document too, exit 2', () => {
	const f = fixture();
	try {
		for (const args of [
			['cardtable', '--bogus'],
			['cardtable', '--max-age', '0'],
			['--max-age', '60'],
			['cardtable', 'watchparty'],
		]) {
			const r = run(args, f.env);
			assert.equal(r.code, 2, args.join(' '));
			assert.equal(r.doc.ok, false);
		}
	} finally {
		f.done();
	}
});

test("an offer's ci is the dispatcher's fresh capacity row for that node, and null once it is stale", () => {
	const f = fixture();
	try {
		const now = Date.now();
		writeFileSync(
			join(f.root, 'hosting-converge-last.json'),
			JSON.stringify({
				at: new Date(now).toISOString(),
				tenants: {
					cardtable: {
						live: true,
						offers: { ranked: [{ node: 'claw-9', ciJobs: { before: 1, after: 1 } }], refused: [] },
					},
				},
			})
		);
		const dir = join(f.root, 'dispatch-decisions');
		mkdirSync(dir);
		const write = (atMs) =>
			writeFileSync(
				join(dir, `${new Date(now).toISOString().slice(0, 10)}.jsonl`),
				JSON.stringify({
					v: 1,
					at: new Date(atMs).toISOString(),
					capacity: [{ node: 'claw-9', busy: 2, heavyJobs: 1, max: 3 }],
				}) + '\n'
			);
		write(now - 30_000);
		const fresh = run(['cardtable'], f.env).doc.offers.ranked[0].ci;
		assert.equal(fresh.jobs, 2);
		assert.equal(fresh.heavyJobs, 1);
		assert.equal(fresh.max, 3);
		assert.equal(fresh.load1, null);
		write(now - 3_600_000);
		assert.equal(run(['cardtable'], f.env).doc.offers.ranked[0].ci, null, 'unmeasured, not idle');
	} finally {
		f.done();
	}
});
