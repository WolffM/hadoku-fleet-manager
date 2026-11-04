/**
 * The rust entries and the AS_CI wrapper (toolchain-rust.mjs), tested apart
 * from toolchain-floor.test.mjs, which is at its size ceiling.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';

import { REPAIRS, installScript } from './toolchain-floor.mjs';

/**
 * The rust repair must ALWAYS re-link, not only when rustup is absent.
 *
 * The broken state that shipped was rustup PRESENT and the proxies unreachable.
 * A repair that installs-then-links only on the install path leaves that exact
 * node broken forever, because its `if` never fires.
 */
test('the rust repair re-links even when rustup is already installed', () => {
	const lines = REPAIRS.rust.repair.split('\n');
	const fi = lines.findIndex((l) => l.trim() === 'fi');
	const link = lines.findIndex((l) => l.includes('/usr/local/bin/$b'));
	assert.ok(fi >= 0 && link > fi, 'the symlink loop must sit OUTSIDE the install guard');
});

test("rustup installs into the ci user's home, not admin's, on a cut-over node", () => {
	// claw-10, 2026-11-03: cut over before its toolchain existed, the admin-run
	// repair put rust in admin's home and ci's rustup had no toolchain at all.
	for (const id of ['rust', 'rust-wasm32']) {
		const script = installScript(id, undefined, { ciUser: 'hadoku-ci' });
		assert.match(script, /^CI_USER='hadoku-ci'$/m, id);
		assert.match(script, /sudo -n -u "\$CI" -H bash -s/, `${id}: rustup must run as ci`);
		const body = script.slice(script.indexOf("<<'RUSTUP'"), script.lastIndexOf('\nRUSTUP'));
		assert.match(body, /rustup target add wasm32-unknown-unknown/, id);
	}
	const rust = installScript('rust', undefined, { ciUser: 'hadoku-ci' });
	assert.match(rust, /ln -sfn "\$CI_HOME\/\.cargo\/bin\/\$b"/, "links point into ci's home");
	assert.doesNotMatch(rust, /ln -sfn "\$HOME/, "never into the runner of the repair's home");
});

test('the as_ci wrapper runs the heredoc as the caller when there is no separate ci user', () => {
	const r = spawnSync(
		'bash',
		['-c', `${REPAIRS['rust-wasm32'].repair.split('as_ci <<')[0]}\nas_ci <<'X'\nid -un\nX`],
		{
			encoding: 'utf8',
			env: { ...process.env, CI_USER: '' },
		}
	);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout.trim(), userInfo().username);
});
