import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { dataEndpointUrl, probeScript, unprobed } from './probe-script.mjs';

function siteWith(doc) {
	const root = mkdtempSync(join(tmpdir(), 'probe-script-'));
	mkdirSync(join(root, 'scripts'));
	if (doc) writeFileSync(join(root, 'scripts', 'pm2-hosts.json'), JSON.stringify(doc));
	return root;
}

function withSite(root, fn) {
	const before = process.env.HADOKU_SITE_ROOT;
	process.env.HADOKU_SITE_ROOT = root;
	try {
		return fn();
	} finally {
		if (before === undefined) delete process.env.HADOKU_SITE_ROOT;
		else process.env.HADOKU_SITE_ROOT = before;
		rmSync(root, { recursive: true, force: true });
	}
}

test('the endpoint is the hub tailnetIp in pm2-hosts.json, the address the listener binds', () => {
	const root = siteWith({ hub: 'hub-a', hosts: { 'hub-a': { tailnetIp: '192.0.2.1' }, b: {} } });
	withSite(root, () => assert.deepEqual(dataEndpointUrl({}), { url: 'http://192.0.2.1:9002' }));
});

test('FLEET_DATA_URL overrides, and a value that is not a URL is refused, not pasted', () => {
	assert.deepEqual(dataEndpointUrl({ FLEET_DATA_URL: 'http://198.51.100.5:9100/' }), {
		url: 'http://198.51.100.5:9100',
	});
	const bad = dataEndpointUrl({ FLEET_DATA_URL: "http://x'; rm -rf ~; '" });
	assert.equal(bad.url, null);
	assert.match(bad.why, /not a URL/);
});

test('an unreadable registry is "could not name", with the reason — and data-peer is unprobed', () => {
	const root = siteWith(null);
	withSite(root, () => {
		const d = dataEndpointUrl({});
		assert.equal(d.url, null);
		assert.match(d.why, /pm2-hosts\.json/);
		assert.match(unprobed(d)['data-peer'], /could not be named/);
	});
	assert.deepEqual(unprobed({ url: 'http://h:1' }), {});
});

test('the script carries the phase and the endpoint only when there is one', () => {
	const all = probeScript('all', { url: null, why: 'x' });
	assert.ok(all.startsWith('#!/usr/bin/env bash\n'), 'nothing is exported ahead of the probe');
	const m = probeScript('measured', { url: 'http://h:1' });
	assert.ok(m.startsWith("export CAP_PROBE_PHASE=measured\nexport CAP_DATA_URL='http://h:1'\n"));
});

/** Run only the probe's data-peer block against `url`. */
async function dataPeerLine(url) {
	const script = probeScript('all', { url });
	const start = script.indexOf('data_peer_try() {');
	const end = script.indexOf('\nfi\n', start) + 4;
	const head = `say() { printf 'CAP %s %s %s\\n' "$1" "$2" "$3"; }\nexport CAP_DATA_URL='${url}'\n`;
	const { stdout } = await promisify(execFile)('bash', ['-c', head + script.slice(start, end)]);
	return stdout.trim();
}

test('the probe reads the listener verdict: 401 is admitted, a 403 or a bare 404 is refused', async () => {
	let status = 401;
	const srv = createServer((_req, res) => {
		res.writeHead(status);
		res.end(status === 401 ? '{"error": "service key required"}' : '');
	});
	await new Promise((r) => srv.listen(0, '127.0.0.1', r));
	const url = `http://127.0.0.1:${srv.address().port}`;
	try {
		assert.equal(await dataPeerLine(url), 'CAP data-peer ok admitted');
		status = 403;
		assert.equal(await dataPeerLine(url), 'CAP data-peer no refused');
		status = 404;
		assert.equal(await dataPeerLine(url), 'CAP data-peer no refused');
		status = 500;
		assert.equal(await dataPeerLine(url), 'CAP data-peer no http-500');
	} finally {
		srv.close();
	}
	assert.equal(await dataPeerLine('http://127.0.0.1:9'), 'CAP data-peer no unreachable');
});
