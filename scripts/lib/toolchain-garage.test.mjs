import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	REPAIRS,
	installScript,
	isVersionManaged,
	repairNeedsRoot,
	toolAppliesTo,
} from './toolchain-floor.mjs';
import { createReleaseLookup, lookupPinned, resolveInstallTarget } from './tool-release.mjs';
import { judgeTool } from './toolchain-doctor.mjs';
import {
	GARAGE_RELEASE,
	GARAGE_SECRET_DIR,
	GARAGE_SECRET_ITEMS,
	GARAGE_DATA_DIRS_FILE,
	GARAGE_REPAIR,
	GARAGE_TOML,
	garageToml,
	GARAGE_UNIT,
} from './toolchain-garage.mjs';

const garage = REPAIRS.garage;
// Eight days after the pin: past its seven-day debounce, whatever today is.
const NOW = Date.parse(GARAGE_RELEASE.publishedAt) + 8 * 86_400_000;
const earned = (ids) => ({ role: 'claw', $capabilities: { earned: ids } });

test('#139: when: storage gates the entry, read through nodeOffer', () => {
	assert.equal(garage.when, 'storage');
	assert.equal(toolAppliesTo('garage', earned(['storage'])), true, 'a node that earned storage');
	assert.equal(toolAppliesTo('garage', earned(['jdk21'])), false, 'a bootcamped node without it');
	assert.equal(toolAppliesTo('garage', { role: 'claw' }), false, 'a node with no record');
	assert.equal(toolAppliesTo('garage', { role: 'backstop' }), false, 'the backstop');
	assert.equal(
		toolAppliesTo('garage', { role: 'claw', labels: ['storage'], $capabilities: { earned: [] } }),
		false,
		'a declared label is not an earned one on a bootcamped node'
	);
});

test('#139: the release is pinned, debounced, and the repair refuses any other version', async () => {
	assert.ok(isVersionManaged(garage));
	assert.equal(repairNeedsRoot('garage'), true);
	assert.match(GARAGE_RELEASE.sha256, /^[0-9a-f]{64}$/);
	const target = await resolveInstallTarget(garage, { lookup: createReleaseLookup({ now: NOW }) });
	assert.deepEqual(target, {
		status: 'known',
		version: GARAGE_RELEASE.version,
		publishedAt: new Date(GARAGE_RELEASE.publishedAt).toISOString(),
	});
	// A pin younger than the debounce is not installable yet.
	const young = lookupPinned(
		{ version: '9.9.9', publishedAt: new Date(NOW - 86_400_000).toISOString() },
		{ now: NOW, minAge: 10080 }
	);
	assert.equal(young.status, 'unknown');
	assert.match(young.reason, /younger than minAge/);
	assert.equal(lookupPinned({ version: 'latest' }, { now: NOW }).status, 'unknown');

	assert.throws(() => installScript('garage'), /needs a resolved version/);
	const script = installScript('garage', GARAGE_RELEASE.version);
	assert.ok(script.includes(GARAGE_RELEASE.url) && script.includes(GARAGE_RELEASE.sha256));
	// Executed: another version stops before anything is fetched or written.
	const r = spawnSync('bash', ['-c', installScript('garage', '2.4.1')], { encoding: 'utf8' });
	assert.equal(r.status, 1);
	assert.match(r.stderr, /not the pinned release 2\.5\.0/);
});

test('#139: secrets are files systemd hands over, never config text, and the unit asserts them', () => {
	for (const item of GARAGE_SECRET_ITEMS) {
		assert.ok(GARAGE_UNIT.includes(`AssertFileNotEmpty=${GARAGE_SECRET_DIR}/${item}`), item);
		assert.match(GARAGE_UNIT, new RegExp(`LoadCredential=\\w+:${GARAGE_SECRET_DIR}/${item}$`, 'm'));
	}
	assert.match(GARAGE_TOML, /^rpc_secret_file = /m);
	assert.match(GARAGE_TOML, /^admin_token_file = /m);
	assert.doesNotMatch(GARAGE_TOML, /^(rpc_secret|admin_token) =/m, 'no inline secret');
	assert.match(GARAGE_TOML, /^replication_factor = 3$/m);
	assert.match(
		GARAGE_TOML,
		/^\[admin\]\napi_bind_addr = "127\.0\.0\.1:3903"$/m,
		'admin on loopback'
	);
	assert.match(GARAGE_UNIT, /^DynamicUser=yes$/m);
	// The repair fails closed on missing secrets: stops the unit, never enables it.
	const failClosed = garage.repair.slice(garage.repair.indexOf('if [ -n "$missing" ]'));
	assert.ok(failClosed.indexOf('exit 1') < failClosed.indexOf('systemctl enable'));
});

/** Run the detect against a fake garage, a fake systemctl and a secret dir in a tmp root. */
function detectIn({ installed = true, items = [], active = true }) {
	const root = mkdtempSync(join(tmpdir(), 'garage-detect-'));
	try {
		const bin = join(root, 'bin');
		const secrets = join(root, 'secrets');
		spawnSync('mkdir', ['-p', bin, secrets]);
		const stub = (name, body) => {
			writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
			chmodSync(join(bin, name), 0o755);
		};
		if (installed) stub('garage', 'echo "garage v2.5.0 [features: lmdb]"');
		stub('systemctl', active ? 'exit 0' : 'exit 3');
		for (const i of items) writeFileSync(join(secrets, i), 'x\n');
		const text = garage.detect.replaceAll(GARAGE_SECRET_DIR, secrets);
		const r = spawnSync('bash', ['--noprofile', '--norc', '-c', text], {
			encoding: 'utf8',
			env: { PATH: `${bin}:/usr/bin:/bin` },
		});
		return r.stdout.split('\n')[0];
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test('#139: the detect fails closed and names the missing vault items for the doctor', () => {
	assert.equal(detectIn({ installed: false }), '', 'absent: no OK');
	const none = detectIn({});
	assert.match(none, /^WHY .*GARAGE_RPC_SECRET GARAGE_ADMIN_TOKEN/);
	assert.match(detectIn({ items: ['GARAGE_RPC_SECRET'] }), /^WHY .*\bGARAGE_ADMIN_TOKEN\b/);
	assert.doesNotMatch(detectIn({ items: ['GARAGE_RPC_SECRET'] }), /GARAGE_RPC_SECRET/);
	assert.equal(
		detectIn({ items: GARAGE_SECRET_ITEMS, active: false }),
		'WHY garage.service is not active'
	);
	assert.equal(detectIn({ items: GARAGE_SECRET_ITEMS }), 'OK');

	const j = judgeTool('garage', garage, { detect: none, login: none });
	assert.equal(j.finding, true);
	assert.match(j.reason, /GARAGE_RPC_SECRET GARAGE_ADMIN_TOKEN absent/);
});

/** Run the repair's own config-rendering lines with a data-dirs file (or none) in a tmp dir. */
function renderedToml(dataDirs) {
	const root = mkdtempSync(join(tmpdir(), 'garage-toml-'));
	try {
		const lines = GARAGE_REPAIR.split('\n');
		const from = lines.findIndex((l) => l.startsWith('cat > "$tmp/head"'));
		const to = lines.findIndex((l) => l.includes('> "$tmp/toml"'));
		assert.ok(from > 0 && to > from, 'the repair renders the config from head, data dirs, tail');
		const dd = join(root, 'data-dirs.toml');
		if (dataDirs !== null) writeFileSync(dd, dataDirs);
		const text = [`tmp=${root}`, ...lines.slice(from, to + 1)]
			.join('\n')
			.replaceAll(GARAGE_DATA_DIRS_FILE, dd);
		const r = spawnSync('bash', ['-c', text], { encoding: 'utf8' });
		assert.equal(r.status, 0, r.stderr);
		return readFileSync(join(root, 'toml'), 'utf8');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test('#141: the config on the node is garageToml() around its data-dirs file, byte for byte', () => {
	assert.equal(renderedToml(null), GARAGE_TOML);
	const dd = 'data_dir = [ { path = "/srv/storage/root/garage", capacity = "200000000000" } ]\n';
	assert.equal(renderedToml(dd), garageToml(dd));
	assert.match(
		garageToml(dd),
		/^metadata_dir = .*\ndata_dir = \[ \{ path = "\/srv\/storage\/root\/garage"/m
	);
	assert.doesNotMatch(garageToml(dd), /\/var\/lib\/garage\/data/);
	// ProtectSystem=strict keeps /srv read-only unless the unit opens it.
	assert.match(GARAGE_UNIT, /^ReadWritePaths=-\/srv\/storage$/m);
});
