import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tempDir } from './test-tmpdir.mjs';
import { FONT_PACKAGES, FONT_REPAIR_PACKAGES } from './toolchain-fonts.mjs';
import {
	REPAIRS,
	applicableRepairs,
	declaredPackages,
	repairNeedsRoot,
} from './toolchain-floor.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROFILES = join(ROOT, 'manifests', 'node-profiles.json');

/** A directory of stub programs, put FIRST on PATH for one `sh -c`. */
function run(script, programs) {
	const bin = tempDir('tf-fonts-');
	for (const [name, body] of Object.entries(programs)) {
		const p = join(bin, name);
		writeFileSync(p, body);
		chmodSync(p, 0o755);
	}
	const r = spawnSync('sh', ['-c', script], {
		encoding: 'utf8',
		env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, LOG: join(bin, 'log') },
	});
	let log = '';
	try {
		log = readFileSync(join(bin, 'log'), 'utf8');
	} catch (e) {
		if (e.code !== 'ENOENT') throw e;
	}
	return { status: r.status, out: r.stdout.trim(), log };
}

/** An `fc-list` that finds every family except `missing`. */
const fcList = (missing) =>
	`#!/bin/sh\n[ "$1" = -q ] || exit 2\ncase "$2" in ":family=${missing}") exit 1 ;; esac\nexit 0\n`;

/**
 * IMAGING AND DRIFT REPAIR NAME THE SAME PACKAGES. A font the repair installs
 * that the profiles lack would be missing on every newly imaged node until the
 * cycle got to it, which is claw-10's 8 fonts; one the profiles carry that the
 * repair lacks is never put back on a running node.
 */
test('every package the fonts repair installs is in the floor every profile agrees on', () => {
	const { common } = declaredPackages(PROFILES);
	const missing = FONT_REPAIR_PACKAGES.filter((p) => !common.includes(p));
	assert.deepEqual(missing, [], `node-profiles.json lacks ${missing.join(', ')}`);
	const fontLike = common.filter((p) => /^(x?fonts-|fontconfig$)/.test(p)).sort();
	assert.deepEqual(fontLike, [...FONT_REPAIR_PACKAGES].sort());
});

test('fonts apply to every node, the backstop included, and the repair is root work', () => {
	assert.equal(REPAIRS.fonts.when, undefined);
	for (const node of [{}, { role: 'backstop' }, { labels: ['playwright'] }]) {
		assert.ok(applicableRepairs(node, 'any').some(([id]) => id === 'fonts'));
	}
	assert.equal(repairNeedsRoot('fonts'), true);
});

test('every font package names the family fontconfig must find and why it is carried', () => {
	for (const [pkg, f] of Object.entries(FONT_PACKAGES)) {
		assert.ok(f.family && f.why, pkg);
	}
});

test('detect asks fontconfig for every family: all found is OK', () => {
	const r = run(REPAIRS.fonts.detect, { 'fc-list': fcList('none') });
	assert.equal(r.out, 'OK');
});

/** MUTATION: drop any family from the loop, or `|| { m=...` , and one of these reads OK. */
test('detect names the first family no installed font matches', () => {
	for (const { family } of Object.values(FONT_PACKAGES)) {
		const r = run(REPAIRS.fonts.detect, { 'fc-list': fcList(family) });
		assert.equal(r.out, `no font for family ${family}`);
	}
});

test('detect with no fontconfig at all is not OK', () => {
	const r = spawnSync('/bin/sh', ['-c', REPAIRS.fonts.detect], {
		encoding: 'utf8',
		env: { PATH: tempDir('tf-fonts-empty-') },
	});
	assert.notEqual(r.stdout.trim(), 'OK');
});

/** dpkg stubs: every package installed except those in `absent`. */
function dpkgStubs(absent) {
	return {
		dpkg: '#!/bin/sh\necho amd64\n',
		'dpkg-query': `#!/bin/sh\nfor a in "$@"; do p="$a"; done\ncase " ${absent.join(' ')} " in *" $p "*) exit 1 ;; esac\necho "ii all"\n`,
		sudo: '#!/bin/sh\n[ "$1" = -n ] && shift\necho "$*" >> "$LOG"\n',
	};
}

test('repair on a node with every package installed runs no apt at all', () => {
	const r = run(REPAIRS.fonts.repair, dpkgStubs([]));
	assert.equal(r.status, 0);
	assert.equal(r.log, '');
});

test('repair installs exactly the packages dpkg says are absent', () => {
	const r = run(REPAIRS.fonts.repair, dpkgStubs(['fonts-liberation', 'fonts-dejavu-core']));
	assert.equal(r.status, 0);
	const lines = r.log.trim().split('\n');
	assert.equal(lines[0], 'apt-get update -qq');
	assert.match(
		lines[1],
		/apt-get install -y -qq --no-install-recommends +fonts-liberation fonts-dejavu-core$/
	);
});
