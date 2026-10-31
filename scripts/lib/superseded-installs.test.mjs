import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './test-tmpdir.mjs';
import { parseSuperseded, supersededScript } from './superseded-installs.mjs';

/**
 * A fixture node: admin's HOME, an opt root, a link dir, and a sudo stub that
 * RUNS what it is given. The sweep is executed, not grepped. No ci user is
 * passed, so `getent` is never asked about a real account.
 */
function fixture() {
	const root = tempDir('superseded-');
	const fx = {
		home: join(root, 'home'),
		opt: join(root, 'opt'),
		links: join(root, 'links'),
		stubs: join(root, 'stubs'),
	};
	for (const d of Object.values(fx)) mkdirSync(d, { recursive: true });
	writeFileSync(join(fx.stubs, 'sudo'), '#!/bin/sh\n[ "$1" = -n ] && shift\nexec "$@"\n');
	chmodSync(join(fx.stubs, 'sudo'), 0o755);
	return fx;
}

function install(dir) {
	mkdirSync(join(dir, 'bin'), { recursive: true });
	writeFileSync(join(dir, 'bin', 'java'), '#!/bin/sh\n');
	return dir;
}

function sweep(fx, apply) {
	const r = spawnSync('bash', ['--noprofile', '--norc', '-c', supersededScript({ apply })], {
		encoding: 'utf8',
		env: {
			PATH: `${fx.stubs}:/usr/bin:/bin`,
			HOME: fx.home,
			FLEET_TOOL_OPT: fx.opt,
			FLEET_LINK_DIR: fx.links,
		},
	});
	assert.equal(r.status, 0, r.stderr);
	return parseSuperseded(r.stdout);
}

const statusOf = (res, dir) => res.entries.find((e) => e.dir === dir)?.status;

test('superseded: a home JDK is removed once the opt root holds one and nothing points at it', () => {
	const fx = fixture();
	install(join(fx.opt, 'jdk-21.0.13+9'));
	const old = install(join(fx.home, '.local', 'opt', 'jdk-21.0.13+9'));
	const dry = sweep(fx, false);
	assert.ok(dry.complete);
	assert.equal(statusOf(dry, old), 'would');
	assert.ok(existsSync(old), 'a dry run removes nothing');
	assert.equal(statusOf(sweep(fx, true), old), 'removed');
	assert.ok(!existsSync(old));
});

test('superseded: the only install of a tool is never removed', () => {
	const fx = fixture();
	const only = install(join(fx.home, '.local', 'opt', 'jdk-21.0.13+9'));
	assert.equal(statusOf(sweep(fx, true), only), 'keep');
	assert.ok(existsSync(only));
});

test('superseded: a link resolving into it keeps it', () => {
	const fx = fixture();
	install(join(fx.opt, 'jdk-21.0.13+9'));
	const old = install(join(fx.home, '.local', 'opt', 'jdk-21.0.12+7'));
	symlinkSync(join(old, 'bin', 'java'), join(fx.links, 'java'));
	assert.equal(statusOf(sweep(fx, true), old), 'keep');
	assert.ok(existsSync(old));
});

test('superseded: a runner env naming it keeps it', () => {
	const fx = fixture();
	install(join(fx.opt, 'apache-maven-3.9.16'));
	const old = install(join(fx.home, '.local', 'opt', 'apache-maven-3.9.11'));
	mkdirSync(join(fx.home, '.hadoku'), { recursive: true });
	writeFileSync(join(fx.home, '.hadoku', 'runner.env'), `MAVEN_HOME=${old}\n`);
	assert.equal(statusOf(sweep(fx, true), old), 'keep');
	assert.ok(existsSync(old));
});

/** A REAL process executing from inside the old install. MUTATION: drop the /proc check. */
test('superseded: a live process running from it is BUSY and kept', async () => {
	const fx = fixture();
	install(join(fx.opt, 'jdk-21.0.13+9'));
	const old = install(join(fx.home, '.local', 'opt', 'jdk-21.0.12+7'));
	copyFileSync('/bin/sleep', join(old, 'bin', 'sleep'));
	chmodSync(join(old, 'bin', 'sleep'), 0o755);
	const child = spawn(join(old, 'bin', 'sleep'), ['30'], { stdio: 'ignore' });
	try {
		await new Promise((r) => child.once('spawn', r));
		assert.equal(statusOf(sweep(fx, true), old), 'busy');
		assert.ok(existsSync(old));
	} finally {
		child.kill();
	}
});

test('superseded: output without the SWEPT trailer is incomplete, never "nothing to remove"', () => {
	assert.equal(parseSuperseded('KEEP /x why\n').complete, false);
	assert.equal(parseSuperseded('').complete, false);
});

/**
 * NEVER ci's HOME. A job's own scripts install a JDK into `~/.local/opt` and
 * reuse it (cardtable's Forge spike), which is indistinguishable by name from a
 * fleet leftover. Candidates come from admin's $HOME alone, whoever ci is.
 */
test("superseded: candidates come from admin's home only, even when a ci user is named", () => {
	const s = supersededScript({ ciUser: 'ci-user-fixture', apply: true });
	const sources = s.match(/for d in "[^"]+"\/\.local\/opt/g) ?? [];
	assert.ok(sources.length > 0);
	assert.ok(
		sources.every((x) => x.startsWith('for d in "$h"')),
		sources.join(' | ')
	);
	assert.match(s, /^h="\$HOME"/m);
	assert.doesNotMatch(s, /^h="\$ci_home"|for h in/m);
});
