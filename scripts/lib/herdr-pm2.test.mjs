import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { JLIST_SCRIPT, parseJlist, readPlacement, readPm2 } from './herdr-pm2.mjs';
import { tempDir } from './test-tmpdir.mjs';

// Low entropy on purpose: the test needs a unique marker that must not appear
// in the output, and a realistic-looking token trips this repo's own gitleaks
// scan (#130).
const SECRET = 'planted-marker-that-must-stay-on-the-host';

/**
 * Run the real on-host script with a stub `pm2` on PATH, as fleet-exec would:
 * `bash -s`.
 *
 * PATH IS ONE DIRECTORY, built here, and nothing else. The first cut appended
 * node's own bin dir and `/usr/bin:/bin` so `node` stayed findable, and on a
 * pm2 host that is exactly where the REAL pm2 lives (claw-4: `/usr/bin/pm2`
 * beside `/usr/bin/node`) — so `withPm2: false` found one anyway, the "not on
 * PATH" case passed on hokon and failed on every publish gate that landed on
 * a pm2 host (2026-10-21, two releases). `node` is a symlink in the same
 * directory; `command`, `echo` and `exit` are builtins; bash is named by
 * absolute path so the parent's PATH is not consulted either.
 */
function onHost(jlistOutput, { withPm2 = true } = {}) {
	const bin = tempDir('herdr-pm2-');
	symlinkSync(process.execPath, join(bin, 'node'));
	if (withPm2) {
		// A node script, not `sh` + `cat`: with PATH being one directory, `cat`
		// is not there either. The stub needs nothing but the interpreter it
		// names by absolute path.
		writeFileSync(
			join(bin, 'pm2'),
			`#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(`${jlistOutput}\n`)});\n`
		);
		chmodSync(join(bin, 'pm2'), 0o755);
	}
	return execFileSync('/bin/bash', ['-s'], {
		input: JLIST_SCRIPT,
		encoding: 'utf8',
		env: { PATH: bin },
	});
}

test('herdr-pm2: the on-host reducer drops every process environment, secrets included', () => {
	const jlist = JSON.stringify([
		{
			name: 'tenhands',
			pm2_env: {
				status: 'online',
				restart_time: 3,
				unstable_restarts: 0,
				pm_uptime: 1,
				pm_cwd: '/srv/x',
				GITHUB_TOKEN: SECRET,
				env: { API_KEY: SECRET },
			},
		},
	]);
	const out = onHost(jlist);
	assert.ok(!out.includes(SECRET), 'the planted secret never leaves the host');
	assert.deepEqual(parseJlist(out), {
		procs: [
			{ name: 'tenhands', status: 'online', restarts: 3, unstable: 0, since: 1, cwd: '/srv/x' },
		],
		error: null,
	});
});

test('herdr-pm2: a host without pm2, or with output pm2 did not mean, is an error, not an empty list', () => {
	assert.match(parseJlist(onHost('', { withPm2: false })).error, /pm2 is not on PATH/);
	assert.match(
		parseJlist(onHost('>>>> In-memory PM2 is out-of-date, do:\n[]')).error,
		/did not parse/
	);
	assert.deepEqual(
		parseJlist(onHost('[]')),
		{ procs: [], error: null },
		'a real empty list is fine'
	);
	assert.match(parseJlist('PM2-BEGIN\n[{"name":"x"').error, /incomplete/);
});

function deployTree({ hostsDoc, services }) {
	const root = tempDir('herdr-pm2-site-');
	mkdirSync(join(root, 'scripts'));
	mkdirSync(join(root, 'services', 'mgmt-api'), { recursive: true });
	if (hostsDoc) writeFileSync(join(root, 'scripts', 'pm2-hosts.json'), JSON.stringify(hostsDoc));
	if (services)
		writeFileSync(
			join(root, 'services', 'mgmt-api', 'deploy-config.json'),
			JSON.stringify({ services })
		);
	return root;
}
const HOSTS = { hub: 'hokon', hosts: { hokon: {}, 'claw-4': { ssh: 'claw-4' } } };

test('herdr-pm2: placement is read from the deployed tree, and a service without a host is the hub’s', () => {
	const root = deployTree({
		hostsDoc: HOSTS,
		services: [
			{ name: 'a', pm2Service: 'a' },
			{ name: 'p', host: 'claw-4' },
			{ name: 'm', enabled: false },
		],
	});
	assert.deepEqual(readPlacement(root), {
		hub: 'hokon',
		hosts: ['hokon', 'claw-4'],
		services: [
			{ name: 'a', pm2: 'a', host: 'hokon', enabled: true },
			{ name: 'p', pm2: 'p', host: 'claw-4', enabled: true },
			{ name: 'm', pm2: 'm', host: 'hokon', enabled: false },
		],
	});
	assert.throws(
		() => readPlacement(deployTree({ hostsDoc: HOSTS })),
		/deploy-config\.json: ENOENT/
	);
	assert.throws(
		() => readPlacement(deployTree({ hostsDoc: { hosts: {} }, services: [] })),
		/names no hub/
	);
});

test('herdr-pm2: one unreachable host is that host’s error; the others still read', async () => {
	const root = deployTree({ hostsDoc: HOSTS, services: [] });
	const run = async (host) =>
		host === 'claw-4'
			? { ok: false, stdout: '', error: 'ssh: connect timed out' }
			: { ok: true, stdout: 'PM2-BEGIN\n[]\nPM2-END\n', error: null };
	const p = await readPm2({ root, run });
	assert.equal(p.error, null);
	assert.deepEqual(p.hosts.hokon, { hub: true, procs: [], error: null });
	assert.deepEqual(p.hosts['claw-4'], {
		hub: false,
		procs: null,
		error: 'could not reach claw-4: ssh: connect timed out',
	});
	const broken = await readPm2({ root: deployTree({}), run });
	assert.match(broken.error, /placement unreadable: .*pm2-hosts\.json: ENOENT/);
});
