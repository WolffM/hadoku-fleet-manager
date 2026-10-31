/**
 * `capability-probe.sh`'s `service-host` block, EXECUTED (fleet-manager#16).
 *
 * WHAT RUNS. The real script, phase `presence`, under `/bin/bash` with a PATH
 * that is ONLY a fixture bin of coreutils plus a real `curl`. The tenant's tools
 * are stubs on `CAP_TENANT_PATH`, the tunnel config is a fixture file, and
 * `/ready` is a local HTTP server, so nothing on the host is asked: not its
 * cloudflared, not its PATH, not its pm2.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const PROBE = join(dirname(fileURLToPath(import.meta.url)), 'capability-probe.sh');
const TOOLS = ['pm2', 'node', 'git', 'curl', 'rsync', 'pnpm', 'python3'];
const TUNNEL = '65edf5fd-a0b0-49d5-b2b8-681daea41553';

function which(u) {
	for (const d of ['/usr/bin', '/bin', '/usr/local/bin']) {
		if (existsSync(join(d, u))) return join(d, u);
	}
	throw new Error(`${u} not found on this host`);
}

/**
 * @param {object} o
 * @param {string[]} [o.missing]  tenant tools left off the tenant PATH
 * @param {boolean} [o.venv]  whether `python3 -c 'import ensurepip, venv'` succeeds
 * @param {number} [o.ready]  the status `/ready` answers; 0 = nothing listening
 * @param {boolean | 'unreadable'} [o.config]  whether the tunnel config exists, or exists unreadable
 * @param {boolean} [o.stateRoot]  whether the state root exists
 * @param {boolean} [o.named]  whether the controller names a state root at all
 */
async function probeServiceHost({
	missing = [],
	venv = true,
	ready = 200,
	config = true,
	stateRoot = true,
	named = true,
} = {}) {
	const root = mkdtempSync(join(tmpdir(), 'fleet-probe-svchost-'));
	const bin = join(root, 'bin');
	const tenantBin = join(root, 'tenant-bin');
	for (const d of [bin, tenantBin, join(root, 'tmp'), join(root, 'home')]) {
		mkdirSync(d, { recursive: true });
	}
	for (const u of ['date', 'mktemp', 'rm', 'sleep', 'cat', 'hostname', 'chmod', 'tr', 'grep']) {
		symlinkSync(which(u), join(bin, u));
	}
	for (const u of ['wc', 'sed', 'head', 'env', 'sh', 'curl']) symlinkSync(which(u), join(bin, u));
	for (const t of TOOLS.filter((t) => !missing.includes(t))) {
		// python3 answers the venv import the way the test asks it to.
		const body = t === 'python3' ? `exit ${venv ? 0 : 1}` : 'exit 0';
		writeFileSync(join(tenantBin, t), `#!/bin/sh\n${body}\n`);
		chmodSync(join(tenantBin, t), 0o755);
	}
	const cfg = join(root, 'config.yml');
	if (config) writeFileSync(cfg, `tunnel: ${TUNNEL}\ncredentials-file: /etc/x.json\n`);
	if (config === 'unreadable') chmodSync(cfg, 0o000);
	const state = join(root, 'srv-data');
	if (stateRoot) mkdirSync(state);

	const server = createServer((req, res) => {
		res.writeHead(req.url === '/ready' ? ready : 404);
		res.end();
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const port = ready ? server.address().port : 1;
	try {
		const { stdout } = await promisify(execFile)('/bin/bash', [PROBE], {
			encoding: 'utf8',
			cwd: root,
			timeout: 60_000,
			env: {
				PATH: bin,
				HOME: join(root, 'home'),
				TMPDIR: join(root, 'tmp'),
				CAP_PROBE_PHASE: 'presence',
				CAP_TENANT_PATH: tenantBin,
				CAP_CLOUDFLARED_CONFIG: cfg,
				CAP_CLOUDFLARED_METRICS: `127.0.0.1:${port}`,
				...(named ? { CAP_STATE_ROOT: state } : {}),
			},
		});
		return stdout.split('\n').find((l) => l.startsWith('CAP service-host ')) ?? null;
	} finally {
		await new Promise((r) => server.close(r));
		rmSync(root, { recursive: true, force: true });
	}
}

test('a node with the tenant toolchain, its tunnel ready and a state root earns service-host, with the tunnel ID', async () => {
	assert.equal(await probeServiceHost(), `CAP service-host ok tunnel=${TUNNEL}`);
});

test('every missing piece is named, not just the first', async () => {
	assert.equal(
		await probeServiceHost({ missing: ['pm2', 'pnpm'], venv: false, ready: 503, stateRoot: false }),
		'CAP service-host no missing:pm2,pnpm,python3-venv,tunnel-not-ready,state-root'
	);
});

test('no cloudflared listening and no tunnel config: claw-1 today', async () => {
	assert.equal(
		await probeServiceHost({ missing: ['pm2'], ready: 0, config: false }),
		'CAP service-host no missing:pm2,tunnel-config,tunnel-not-ready'
	);
});

test('a state root the controller did not name is NOT JUDGED: no line at all, never "no"', async () => {
	assert.equal(await probeServiceHost({ named: false }), null);
});

test(
	'a tunnel config the probe cannot read is "could not look", named apart from absent',
	{
		skip: process.getuid?.() === 0 ? 'root reads a mode-000 file' : false,
	},
	async () => {
		assert.equal(
			await probeServiceHost({ config: 'unreadable' }),
			'CAP service-host no missing:tunnel-config-unreadable'
		);
	}
);
