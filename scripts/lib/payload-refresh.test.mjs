/**
 * The JIT payload follows the release, and an old slot is relinked rather than
 * refused (fleet-manager#1, follow-up).
 *
 * On 2026-10-24 five nodes minted every job from a 2.336.0 payload built
 * 2026-07-20, against 2.338.1. Both minters built a payload only when it was
 * MISSING, and both reused a slot unconditionally and then asserted it was
 * hardlinked to the payload. So a payload swapped by hand would have failed
 * every mint on the node until each slot was cleared. Each case below runs
 * BOTH real scripts against a fixture $HOME, with the release served from a
 * file:// URL named the way GitHub names it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The text production sends (src/runners/node-script.ts), run the way it runs it.
const { nodeScriptText } = await import('../../dist/runners/node-script.js');

const cleanups = [];
test.after(() => {
	for (const d of cleanups) rmSync(d, { recursive: true, force: true });
});
const temp = (p) => {
	const d = mkdtempSync(join(tmpdir(), p));
	cleanups.push(d);
	return d;
};

/** A Runner.Listener that knows its version and can `configure` (for warm). */
const listener = (version) => `#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "${version}"; exit 0; fi
if [ "\${1:-}" = "configure" ]; then printf '{}' > .runner; printf '{}' > .credentials; exit 0; fi
exit 1
`;

function tree(dir, version) {
	mkdirSync(join(dir, 'bin'), { recursive: true });
	mkdirSync(join(dir, 'externals'), { recursive: true });
	writeFileSync(join(dir, 'bin', 'Runner.Listener'), listener(version));
	chmodSync(join(dir, 'bin', 'Runner.Listener'), 0o755);
	writeFileSync(join(dir, 'externals', 'marker'), version);
	return dir;
}

/** A release tarball shaped like GitHub's, at a file:// URL with GitHub's file name. */
function release(version) {
	const d = temp('payload-release-');
	tree(join(d, 'src'), version);
	const tgz = join(d, `actions-runner-linux-x64-${version}.tar.gz`);
	execFileSync('tar', ['czf', tgz, '-C', join(d, 'src'), 'bin', 'externals']);
	return `file://${tgz}`;
}

/** A node whose payload is `have`, with slot0 and the warm listener built from it. */
function node(have) {
	const home = temp('payload-node-');
	const jit = join(home, '.hadoku', 'jit');
	tree(join(jit, 'payload'), have);
	for (const slot of [join(jit, 'slot0'), join(home, '.hadoku', 'warm', 'listener')]) {
		mkdirSync(slot, { recursive: true });
		execFileSync('cp', [
			'-al',
			join(jit, 'payload', 'bin'),
			join(jit, 'payload', 'externals'),
			slot,
		]);
		mkdirSync(join(slot, '_work', 'repo'), { recursive: true });
		writeFileSync(join(slot, '_work', 'repo', 'checkout'), 'warm cache');
	}
	writeFileSync(join(home, '.hadoku', 'runner.env'), 'RUNNER_TOOL_CACHE=/opt/hostedtoolcache\n');
	writeFileSync(join(home, '.hadoku', 'standing.env'), 'RUNNER_TOOL_CACHE=/opt/hostedtoolcache\n');
	return home;
}

const MINTERS = [
	{
		name: 'jit-provision.sh',
		script: 'jit-provision.sh',
		slot: (h) => join(h, '.hadoku', 'jit', 'slot0'),
		ready: 'SLOT-READY',
		env: { SLOT: '0' },
	},
	{
		name: 'warm-provision.sh',
		script: 'warm-provision.sh',
		slot: (h) => join(h, '.hadoku', 'warm', 'listener'),
		ready: 'WARM-READY',
		env: {
			REG_TOKEN: 't',
			URL: 'https://github.com/WolffM/x',
			REPO: 'WolffM/x',
			NAME: 'warm-x',
			LABELS: 'self-hosted',
		},
	},
];

function mint(m, home, url) {
	return execFileSync('bash', ['-c', nodeScriptText(m.script), m.script], {
		encoding: 'utf8',
		env: { PATH: process.env.PATH, HOME: home, RESET: '1', RUNNER_TARBALL_URL: url, ...m.env },
	});
}
const version = (dir) =>
	execFileSync(join(dir, 'bin', 'Runner.Listener'), ['--version'], { encoding: 'utf8' }).trim();
const inode = (dir) => statSync(join(dir, 'bin', 'Runner.Listener')).ino;
const payloadOf = (h) => join(h, '.hadoku', 'jit', 'payload');

for (const m of MINTERS) {
	test(`${m.name}: a payload behind the release is rebuilt, and the old slot is relinked with its _work kept`, () => {
		const home = node('2.336.0');
		const out = mint(m, home, release('2.338.1'));
		assert.match(out, /PAYLOAD-REFRESHED 2\.336\.0 -> 2\.338\.1/, out);
		assert.equal(version(payloadOf(home)), '2.338.1');
		assert.match(out, /SLOT-RELINKED /, out);
		assert.equal(
			inode(m.slot(home)),
			inode(payloadOf(home)),
			'the slot is a hardlink of the NEW payload'
		);
		assert.equal(version(m.slot(home)), '2.338.1');
		assert.equal(
			readFileSync(join(m.slot(home), '_work', 'repo', 'checkout'), 'utf8'),
			'warm cache'
		);
		assert.match(out, new RegExp(`${m.ready} .*`), out);
		assert.doesNotMatch(out, /-FAIL /, out);
		const leftovers = execFileSync('ls', ['-a', join(home, '.hadoku', 'jit')], {
			encoding: 'utf8',
		});
		assert.doesNotMatch(
			leftovers,
			/payload\.(next|old|staging)/,
			'no staging or old tree is left behind'
		);
	});

	test(`${m.name}: a current payload is left alone, and an older release URL never downgrades it`, () => {
		const home = node('2.338.1');
		const before = inode(payloadOf(home));
		for (const url of [release('2.338.1'), release('2.337.0')]) {
			const out = mint(m, home, url);
			assert.doesNotMatch(out, /PAYLOAD-REFRESH|SLOT-RELINKED/, out);
		}
		assert.equal(inode(payloadOf(home)), before);
	});

	test(`${m.name}: a release that will not fetch keeps the old payload and still mints, saying so`, () => {
		const home = node('2.336.0');
		const missing = `file://${temp('payload-missing-')}/actions-runner-linux-x64-2.338.1.tar.gz`;
		const out = mint(m, home, missing);
		assert.match(out, /PAYLOAD-REFRESH-FAILED 2\.336\.0, wanted 2\.338\.1/, out);
		assert.equal(version(payloadOf(home)), '2.336.0');
		assert.match(out, new RegExp(m.ready), out);
	});
}

test('a slot still linked to the OLD payload keeps working: removing the old tree only unlinks names', () => {
	const home = node('2.336.0');
	const other = join(home, '.hadoku', 'jit', 'slot1');
	mkdirSync(other);
	execFileSync('cp', [
		'-al',
		join(payloadOf(home), 'bin'),
		join(payloadOf(home), 'externals'),
		other,
	]);
	mint(MINTERS[0], home, release('2.338.1'));
	// slot1 stands for a slot whose listener is mid-job: never touched, still runs.
	assert.equal(version(other), '2.336.0');
});

test('the payload functions are defined once, in runner-payload.sh', () => {
	// They were pasted into both minters until 2026-10-27, held together by a
	// byte-equality test. One definition needs no such test; this one fails if
	// a second appears anywhere in scripts/.
	const defines = /^payload_(want|fetch|ensure|link)\(\) \{/m;
	const holders = readdirSync(SCRIPTS).filter(
		(f) => f.endsWith('.sh') && defines.test(readFileSync(join(SCRIPTS, f), 'utf8'))
	);
	assert.deepEqual(holders, ['runner-payload.sh']);
});
