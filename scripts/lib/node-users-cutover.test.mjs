import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';

import {
	CONFIG_STAYS,
	MOVES,
	RECORD,
	backScript,
	cutoverScript,
	flipManifest,
	inventoryScript,
	parseSteps,
} from './node-users-cutover.mjs';

const USERS = { admin: 'ops', ci: 'ops-ci', adminHome: '/home/ops', ciHome: '/home/ops-ci' };
const KEYS = { controllerKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIfixture'] };
const bashOk = (text) => execFileSync('bash', ['-n'], { input: text });

test('all three scripts are valid bash, and each prints its end marker last', () => {
	for (const [text, end] of [
		[inventoryScript(USERS), 'INVENTORY-END'],
		[cutoverScript(USERS, KEYS), 'CUTOVER-END'],
		[backScript(USERS), 'BACK-END'],
	]) {
		bashOk(text);
		assert.equal(text.trim().split('\n').at(-1), `echo ${end}`);
	}
});

test('the runner tree moves, and admin keeps its own ssh, kit and systemd config', () => {
	assert.ok(MOVES.includes('.cargo') && MOVES.includes('.cache') && MOVES.includes('.npmrc'));
	assert.equal(MOVES[0], '.hadoku', 'the runner tree, from the payload constant');
	for (const stays of ['.ssh', 'kit', 'srv-data', '.hadoku-mgmt', '.config'])
		assert.ok(!MOVES.includes(stays), `${stays} stays with admin`);
	assert.deepEqual(CONFIG_STAYS, ['systemd']);
});

test('refuses names that would land in a shell script, and a ci user that is admin', () => {
	assert.throws(() => inventoryScript({ ...USERS, ci: "x'; id; '" }), /refusing ci user/);
	assert.throws(() => inventoryScript({ ...USERS, ci: 'ops' }), /must not be admin/);
	assert.throws(() => inventoryScript({ ...USERS, ciHome: '/root' }), /refusing ciHome/);
	assert.throws(
		() => cutoverScript(USERS, { controllerKeys: ['not a key'] }),
		/no controller public key/
	);
});

test('the cutover refuses a busy node and records every path BEFORE it moves', () => {
	const s = cutoverScript(USERS, KEYS);
	assert.match(s, /job\(s\) running: drain the node and wait/);
	assert.ok(s.indexOf('record "$1"') < s.indexOf('sudo -n mv "$AH/$1"'), 'record, then move');
	assert.match(s, new RegExp(`RECORD='${RECORD}'`));
});

test('the ci key is restricted: from= the controller session and restrict, nothing else', () => {
	const s = cutoverScript(USERS, KEYS);
	assert.match(s, /from="%s",restrict %s %s fleet-controller/);
	assert.match(s, /from=\$\{SSH_CLIENT%% \*\}/);
	assert.match(
		s,
		/grep -qF " \$b" "\$AH\/\.ssh\/authorized_keys"/,
		'only a key admin already trusts'
	);
});

test('text is rewritten AS ci, and the rewrite cannot eat the new home', () => {
	const s = cutoverScript(USERS, KEYS);
	assert.match(s, /sudo -n -u "\$CI" sed -i -E/);
	// Run the substitution itself: /home/ops/ moves, /home/ops-ci/ is left alone.
	const sed = 's#/home/ops(/|$|[^-a-zA-Z0-9_])#/home/ops-ci\\1#g';
	const out = execFileSync('sed', ['-E', sed], {
		input: '#!/home/ops/.local/bin/python\nhome = /home/ops\nx=/home/ops-ci/y\n/home/opsx\n',
	}).toString();
	assert.equal(
		out,
		'#!/home/ops-ci/.local/bin/python\nhome = /home/ops-ci\nx=/home/ops-ci/y\n/home/opsx\n'
	);
});

test('the rollback reads the record, takes the key and linger away, and keeps the uid', () => {
	const s = backScript(USERS);
	assert.match(s, /done < "\$RECORD"/);
	assert.match(s, /disable-linger/);
	assert.match(s, /rm -f "\$CH\/\.ssh\/authorized_keys"/);
	assert.match(s, /usermod --lock/);
	assert.doesNotMatch(s, /userdel/);
});

test('parseSteps: a run without its end marker is incomplete, whatever its steps said', () => {
	const done = parseSteps(
		'STEP user ok made\nSTEP move ok 3 path(s)\nCUTOVER-END\n',
		'CUTOVER-END'
	);
	assert.equal(done.complete, true);
	assert.deepEqual(done.steps[1], { name: 'move', status: 'ok', detail: '3 path(s)' });
	const cut = parseSteps('STEP user ok made\n', 'CUTOVER-END');
	assert.equal(cut.complete, false);
});

test('flipManifest sets users.ci (and containers on --docker), and back removes both', () => {
	const doc = { machines: { 'claw-x': { role: 'claw', users: { admin: 'ops' } } } };
	flipManifest(doc, 'claw-x', { ci: 'ops-ci', docker: true });
	assert.deepEqual(doc.machines['claw-x'], {
		role: 'claw',
		users: { admin: 'ops', ci: 'ops-ci' },
		containers: 'docker',
	});
	flipManifest(doc, 'claw-x', { back: true });
	assert.deepEqual(doc.machines['claw-x'], { role: 'claw', users: { admin: 'ops' } });
	const bare = { machines: { n: {} } };
	flipManifest(bare, 'n', { ci: 'ops-ci' });
	flipManifest(bare, 'n', { back: true });
	assert.deepEqual(bare.machines.n, {}, 'an emptied users map is removed, not left as {}');
	assert.throws(() => flipManifest(doc, 'nope', { ci: 'x' }), /not in the manifest/);
	assert.throws(() => flipManifest(doc, 'claw-x', { ci: 'Bad Name' }), /refusing ci user/);
});

test('a re-run tolerates a moved path that reappeared in admin home, and only a recorded one', () => {
	const s = cutoverScript(USERS, KEYS);
	assert.match(
		s,
		/grep -qxF "\$1" "\$RECORD" 2>\/dev\/null \|\| die "move:\$1" "both homes hold \$1"/
	);
	assert.match(s, /reappeared in \$AH after the move, left there/);
});

test('admin never stats inside the 0700 ci home without sudo', () => {
	for (const s of [inventoryScript(USERS), cutoverScript(USERS, KEYS), backScript(USERS)]) {
		assert.doesNotMatch(s, /\[ -[eLdf] "\$CH/, 'a plain test under $CH reads "absent" as admin');
		assert.match(s, /ci_has\(\) \{ sudo -n test -e "\$1" \|\| sudo -n test -L "\$1"; \}/);
	}
});

/** Run the rendered script's one sed line (the one `pick` matches) against a sample sshd config. */
function runSed(script, pick, conf) {
	const line = script.split('\n').find((l) => pick.test(l));
	assert.ok(line, `no line matching ${pick}`);
	const dir = mkdtempSync(join(tmpdir(), 'node-users-sshd-'));
	try {
		const f = join(dir, 'fleet.conf');
		writeFileSync(f, conf);
		execFileSync('bash', ['-c', line.trim().replace(/^sudo -n /, '')], {
			env: { ...process.env, CI: USERS.ci, conf: f },
		});
		return readFileSync(f, 'utf8');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test('sshd lets ci in: the cutover adds it to AllowUsers and the rollback takes it out', () => {
	// claw-5, 2026-10-28: AllowUsers named admin alone, every ci ssh was refused
	// before sshd read a key, and every node step had said ok.
	const base = 'Port 22\nAllowUsers ops\nPasswordAuthentication no\n';
	const added = runSed(cutoverScript(USERS, KEYS), /sed -i -E "s\/\^\(/, base);
	assert.equal(added, 'Port 22\nAllowUsers ops ops-ci\nPasswordAuthentication no\n');
	const back = runSed(backScript(USERS), /\[Uu\]sers\[\[:space:\]\]\/ s\//, added);
	assert.equal(back, base);
});

test('the sshd step comes after the key and before admin stops CI, and is verified', () => {
	const s = cutoverScript(USERS, KEYS);
	assert.ok(s.indexOf('step key ok') < s.indexOf('step sshd ok'));
	assert.ok(s.indexOf('step sshd ok') < s.indexOf('step stop ok'));
	assert.match(s, /sshd -t/, 'the edited config is tested before the reload');
	assert.match(s, /effective AllowUsers still leaves out/, 'read back from sshd -T, not the file');
});

test('the inventory skips a moved path admin recreated, and still fails an unrecorded one', () => {
	const s = inventoryScript(USERS);
	assert.match(s, /grep -qxF "\$p" "\$RECORD".*skip "moved; \$ADMIN has its own since/);
	assert.match(s, /step "move:\$p" fail "both homes hold it"/);
});

test("/tmp: admin's top-level files nothing holds open are removed, after admin's CI stops", () => {
	// claw-5, 2026-10-28: admin's /tmp/report-job.json (sticky /tmp) failed
	// every ci job's report step with "Permission denied".
	const s = cutoverScript(USERS, KEYS);
	assert.ok(s.indexOf('step stop ok') < s.indexOf('step tmp ok'), 'only once admin runs no CI');
	assert.match(s, /find \/tmp -maxdepth 1 -type f -user "\$ADMIN"/);
	assert.match(s, /fuser -s "\$f"[^\n]*&& continue/, 'a file a process holds open is kept');
});
