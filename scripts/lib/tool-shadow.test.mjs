/**
 * SHADOWED, NOT MISSING (lib/tool-shadow.mjs). The fleet's tarball tool is
 * installed and linked; a copy earlier on PATH wins. Every reader must name
 * that file and plan no repair: a reinstall only rewrites the link the shadow
 * already beats (hokon, 2026-11-02: ~/.local/bin/mvn).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './test-tmpdir.mjs';
import { REPAIRS, applicableRepairs, parseObservation } from './toolchain-floor.mjs';
import { planNode } from './refresh-cycle.mjs';

const MVN = '#!/bin/sh\necho "Apache Maven 3.9.16"\n';
const JAVAC = '#!/bin/sh\nshift\ntouch "$1/compiled"\n';
const JAVA = '#!/bin/sh\nshift\nd="$1"\n[ -f "$d/compiled" ] && echo JDK21-PROBE-OK\n';
const BROKEN = '#!/bin/sh\nexit 1\n';

/** A dir holding the given executables. */
function bin(programs) {
	const dir = tempDir('ts-bin-');
	for (const [name, body] of Object.entries(programs)) {
		writeFileSync(join(dir, name), body);
		chmodSync(join(dir, name), 0o755);
	}
	return dir;
}

/** The fleet's install: tools under an opt root, linked from a link dir. */
function fleetInstall() {
	const opt = tempDir('ts-opt-');
	const installed = join(opt, 'tool', 'bin');
	mkdirSync(installed, { recursive: true });
	const links = tempDir('ts-links-');
	for (const [name, body] of Object.entries({ mvn: MVN, javac: JAVAC, java: JAVA })) {
		writeFileSync(join(installed, name), body);
		chmodSync(join(installed, name), 0o755);
		symlinkSync(join(installed, name), join(links, name));
	}
	return { opt, links };
}

function detect(id, path, { opt, links }) {
	const r = spawnSync('bash', ['--noprofile', '--norc', '-c', REPAIRS[id].detect], {
		encoding: 'utf8',
		env: {
			PATH: `${path.join(':')}:/usr/bin:/bin`,
			TMPDIR: tempDir('ts-tmp-'),
			FLEET_TOOL_OPT: opt,
			FLEET_TOOL_BIN: links,
		},
	});
	return (r.stdout ?? '').trim();
}

/**
 * Working or broken, the shadow is named. The fleet link first on PATH is OK.
 * With no fleet link at all it stays MISSING: then a repair IS the fix.
 * MUTATION: drop `|| shadowedBy(...)` from a detect and the first loop reads ''.
 */
test('jdk21 and maven detect: a copy earlier on PATH than the fleet link answers SHADOWED <path>', () => {
	const fleet = fleetInstall();
	for (const [id, name, body] of [
		['maven', 'mvn', '#!/bin/sh\necho "Apache Maven 3.9.9"\n'],
		['maven', 'mvn', BROKEN],
		['jdk21', 'java', JAVA],
		['jdk21', 'java', BROKEN],
	]) {
		const home = bin({ [name]: body });
		assert.equal(detect(id, [home, fleet.links], fleet), `SHADOWED ${join(home, name)}`, id);
	}
	assert.equal(detect('maven', [fleet.links], fleet), 'OK');
	assert.equal(detect('jdk21', [fleet.links], fleet), 'OK');
	const noLink = { opt: fleet.opt, links: tempDir('ts-links-') };
	assert.equal(detect('maven', [bin({ mvn: MVN })], noLink), '');
});

/** MUTATION: put `(\S*)` back in parseObservation and the spaced path is skipped as fine. */
test('parseObservation reads SHADOWED <path> as broken and keeps the path, spaces included', () => {
	const o = parseObservation(
		[
			'REPAIR maven SHADOWED /home/a b/.local/bin/mvn',
			'REPAIR jdk21 OK',
			'REPAIR rust MISSING',
		].join('\n')
	);
	assert.deepEqual(o.brokenCapabilities, ['maven', 'rust']);
	assert.deepEqual(o.shadowed, { maven: '/home/a b/.local/bin/mvn' });
});

/** MUTATION: drop the `j.shadowed` branch in planNode and jdk21 comes back as an install. */
test('the refresh cadence makes a SHADOWED jdk21 a finding that names the file, and plans no install', () => {
	const claw = { labels: [] };
	const tools = applicableRepairs(claw);
	assert.ok(
		tools.some(([id]) => id === 'jdk21'),
		'fixture claw carries jdk21'
	);
	const known = {
		status: 'known',
		version: '21.0.12',
		publishedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
	};
	const seen = { jdk21: { detect: 'SHADOWED /home/x/.local/bin/java', login: '', runner: '' } };
	const p = planNode(
		tools.filter(([id]) => id === 'jdk21'),
		seen,
		{ jdk21: known }
	);
	assert.deepEqual(p.work, []);
	assert.equal(p.findings.length, 1);
	assert.equal(p.findings[0].kind, 'shadowed');
	assert.match(
		p.findings[0].reason,
		/^\/home\/x\/\.local\/bin\/java comes before \/usr\/local\/bin\/java/
	);
	assert.match(p.findings[0].reason, /remove or rename/);
});
