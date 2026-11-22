import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { leaseIdentity, leaseKeyItem } from '../../dist/lib/node-users.js';

import {
	devBackScript,
	devInventoryScript,
	devSetupScript,
	flipDevManifest,
	leaseCheckScript,
	leaseKeyScript,
	manifestSaysDev,
	parseLeaseWhoami,
} from './node-users-dev.mjs';

const USERS = {
	admin: 'hadoku',
	ci: 'hadoku-ci',
	dev: 'hadoku-dev',
	adminHome: '/home/hadoku',
	devHome: '/home/hadoku-dev',
};
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixture';
const setup = (users = USERS) => devSetupScript(users, { controllerKeys: [KEY] });

test('all three scripts are valid bash', () => {
	for (const text of [devInventoryScript(USERS), setup(), devBackScript(USERS)]) {
		const r = spawnSync('bash', ['-n'], { input: text, encoding: 'utf8' });
		assert.equal(r.status, 0, r.stderr);
	}
});

test('the inventory changes nothing: no write, no useradd, no reload', () => {
	const inv = devInventoryScript(USERS);
	assert.doesNotMatch(
		inv,
		/useradd|usermod|tee |sed -i|systemctl (reload|daemon-reload|set-property)|rm -/
	);
	assert.match(inv, /INVENTORY-END/);
});

test('a dev user that is admin or ci is refused before any script exists', () => {
	assert.throws(() => setup({ ...USERS, dev: 'hadoku' }), /must not be hadoku/);
	assert.throws(() => setup({ ...USERS, dev: 'hadoku-ci' }), /must not be hadoku-ci/);
	assert.throws(() => setup({ ...USERS, dev: 'x; rm -rf /' }), /refusing dev user/);
	assert.throws(() => setup({ ...USERS, devHome: '/root' }), /refusing devHome/);
});

test('the setup checks sudo and groups by reading them back, and dies on either', () => {
	const s = setup();
	assert.match(s, /die user "\$DEV may run sudo"/);
	assert.match(s, /die user "\$DEV is in groups/);
	assert.doesNotMatch(s, /usermod -aG|--groups|sudoers/);
});

test('the key is pinned to the controller address, keeps a pty, and forwards nothing', () => {
	const s = setup();
	assert.match(s, /from="%s",no-agent-forwarding,no-X11-forwarding/);
	assert.doesNotMatch(s, /,restrict /);
	assert.throws(() => devSetupScript(USERS, { controllerKeys: ['not a key'] }), /no usable/);
});

test('the weight is read back from the kernel and must sit below ci, not trusted from the drop-in', () => {
	const s = setup();
	assert.match(s, /set-property --runtime "\$unit"/);
	assert.match(s, /cpu\.weight/);
	assert.match(s, /does not weigh less than \$CI's/);
});

test('the undo refuses while anything runs as dev: a live session is active work', () => {
	const b = devBackScript(USERS);
	assert.match(b, /a live session is active work/);
	assert.ok(b.indexOf('active work') < b.indexOf('rm -f "$DH/.ssh/authorized_keys"'));
	assert.ok(b.indexOf('active work') < b.indexOf('userdel'));
	assert.doesNotMatch(b, /userdel (-r|--remove)/, 'the home is kept');
});

test('the manifest flip writes users.dev beside ci and removes only it', () => {
	const doc = { machines: { 'claw-fixture': { users: { ci: 'hadoku-ci' } } } };
	const m = doc.machines['claw-fixture'];
	assert.equal(manifestSaysDev(m, { dev: 'hadoku-dev' }), false);
	flipDevManifest(doc, 'claw-fixture', { dev: 'hadoku-dev' });
	assert.deepEqual(m.users, { ci: 'hadoku-ci', dev: 'hadoku-dev' });
	assert.equal(manifestSaysDev(m, { dev: 'hadoku-dev' }), true);
	flipDevManifest(doc, 'claw-fixture', { back: true });
	assert.deepEqual(m.users, { ci: 'hadoku-ci' });
	assert.equal(manifestSaysDev(m, { back: true }), true);
	assert.throws(
		() => flipDevManifest(doc, 'claw-absent', { dev: 'hadoku-dev' }),
		/not in the manifest/
	);
	assert.throws(
		() => flipDevManifest(doc, 'claw-fixture', { dev: 'Bad Name' }),
		/refusing dev user/
	);
});

const EDGE_KEY = '0123abcd-4567-89ef-0123-456789abcdef';

test('a node leases as <node>-sessions, from the vault item key-generate names for it', () => {
	assert.equal(leaseIdentity('claw-9'), 'claw-9-sessions');
	assert.equal(leaseKeyItem('claw-9'), 'KEY_SERVICE_CLAW_9_SESSIONS');
});

test('the lease key script writes a 0600 JSON key file through a rename, and nothing else', () => {
	const home = mkdtempSync(join(tmpdir(), 'lease-key-'));
	try {
		const r = spawnSync('bash', ['-s'], {
			input: leaseKeyScript(EDGE_KEY),
			encoding: 'utf8',
			env: { PATH: process.env.PATH, HOME: home },
		});
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /^KEY-WRITTEN 600$/m);
		assert.doesNotMatch(r.stdout + r.stderr, new RegExp(EDGE_KEY));
		const f = join(home, '.config/claude-lease/key.json');
		assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { key: EDGE_KEY });
		assert.equal(statSync(f).mode & 0o777, 0o600);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test('anything but a registry key is refused before a script exists', () => {
	for (const bad of ['', "x'; rm -rf ~; '", `${EDGE_KEY}\n`, undefined])
		assert.throws(() => leaseKeyScript(bad), /not a registry key/);
});

test('whoami answers are read for identity and membership; anything else keeps its reason', () => {
	assert.deepEqual(
		parseLeaseWhoami(
			'identity:  claw-9-sessions (service)\nkey file:  /home/hadoku-dev/.config/claude-lease/key.json\n' +
				'lease list crossposter-claude-code-lease: member (the lease route reached crossposter)\nWHOAMI-EXIT 0\n'
		),
		{ identity: 'claw-9-sessions', member: true, why: null }
	);
	assert.equal(
		parseLeaseWhoami(
			'identity:  claw-9-sessions (service)\nlease list crossposter-claude-code-lease: NOT a member (the edge refused the lease route)\nWHOAMI-EXIT 1\n'
		).member,
		false
	);
	assert.deepEqual(
		parseLeaseWhoami(
			'claude-lease: no service key at /home/hadoku-dev/.config/claude-lease/key.json (No such file or directory)\nWHOAMI-EXIT 1\n'
		),
		{
			identity: null,
			member: null,
			why: 'claude-lease: no service key at /home/hadoku-dev/.config/claude-lease/key.json (No such file or directory)',
		}
	);
	assert.match(
		leaseCheckScript(),
		/CLAUDE_LEASE_KEY_FILE="\$HOME\/\.config\/claude-lease\/key\.json"/
	);
});

test('the undo deletes the lease key with the ssh key: a kept home holds no credential', () => {
	assert.match(
		devBackScript(USERS),
		/rm -f "\$DH\/\.ssh\/authorized_keys" "\$DH\/\.config\/claude-lease\/key\.json"/
	);
});
