import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { debInstalled } from './deb-installed.mjs';
import { tempDir } from './test-tmpdir.mjs';
/**
 * A PATH holding stub `dpkg-query` and `dpkg` that answer like hokon on
 * 2026-11-02: amd64 native with i386 enabled, `libgbm1` installed for BOTH,
 * `ca-certificates` arch-all, `steam-libs-i386` installed for i386 only, and
 * `gone` removed with its config left behind. The stubs make the test the
 * same on a claw with no foreign architecture, where `dpkg -s` never fails.
 */
function dpkgStubPath() {
	const bin = tempDir('deb-installed-');
	const rows = {
		libgbm1: 'ii amd64\nii i386',
		'ca-certificates': 'ii all',
		'steam-libs-i386': 'ii i386',
		gone: 'rc amd64',
	};
	const cases = Object.entries(rows)
		.map(([pkg, out]) => `  ${pkg}) printf '${out}\\n' ;;`)
		.join('\n');
	writeFileSync(
		join(bin, 'dpkg-query'),
		`#!/bin/sh\n# args: -W -f=<fmt> <pkg>\ncase "$3" in\n${cases}\n  *) exit 1 ;;\nesac\n`
	);
	writeFileSync(join(bin, 'dpkg'), '#!/bin/sh\n[ "$1" = --print-architecture ] && echo amd64\n');
	chmodSync(join(bin, 'dpkg-query'), 0o755);
	chmodSync(join(bin, 'dpkg'), 0o755);
	return bin;
}

function installed(bin, pkg) {
	const r = spawnSync('sh', ['-c', debInstalled('"$1"'), 'sh', pkg], {
		env: { PATH: `${bin}:/usr/bin:/bin` },
	});
	return r.status === 0;
}

test('debInstalled: a library installed for amd64 AND i386 is installed (dpkg -s says ambiguous)', () => {
	const bin = dpkgStubPath();
	assert.equal(installed(bin, 'libgbm1'), true);
	assert.equal(installed(bin, 'ca-certificates'), true, 'arch-all counts');
});

test('debInstalled: an i386-only copy, a removed package and an unknown one are not installed', () => {
	const bin = dpkgStubPath();
	assert.equal(
		installed(bin, 'steam-libs-i386'),
		false,
		'a foreign-arch copy is not the native one'
	);
	assert.equal(installed(bin, 'gone'), false, 'rc is config-files only');
	assert.equal(installed(bin, 'nosuchpkg'), false);
});

test('no package check in scripts/ uses dpkg -s, which refuses a multi-arch package', () => {
	const scripts = resolve(dirname(fileURLToPath(import.meta.url)), '..');
	const bad = [];
	const walk = (dir) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (/\.mjs$/.test(e.name) && !/\.test\./.test(e.name)) {
				const lines = readFileSync(p, 'utf8').split('\n');
				lines.forEach((l, i) => {
					if (/\bdpkg -s\b/.test(l) && !/^\s*(\*|\/\/)/.test(l)) bad.push(`${p}:${i + 1}`);
				});
			}
		}
	};
	walk(scripts);
	assert.deepEqual(bad, [], `use debInstalled() instead:\n  ${bad.join('\n  ')}`);
});
