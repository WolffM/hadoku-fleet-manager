import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { importGraph, RELOAD_EXIT, staleBuild } from './herdr-fleet-freshness.mjs';
import { tempDir } from './test-tmpdir.mjs';

const REPO = new URL('../../', import.meta.url).pathname;

test('herdr-fleet-freshness: the import walk finds every dist/ module the plugin loads, helpers included', () => {
	const { dist, mjs, missing } = importGraph(REPO);
	assert.deepEqual(missing, []);
	for (const m of [
		'ci-alerts',
		'fleet-loop',
		'gh-budget',
		'runner-health',
		'lib/node-identity',
		'lib/node-role',
		'lib/fleet-config',
	]) {
		assert.ok(dist.includes(m), m);
	}
	assert.ok(mjs.includes('scripts/lib/herdr-pm2.mjs'), 'reached through a dynamic import()');
});

/** A plugin-shaped tree: the entries reach dist/ directly and through a dynamically imported helper. */
function tree() {
	const root = tempDir('herdr-fresh-');
	const put = (rel, text) => {
		mkdirSync(join(root, rel, '..'), { recursive: true });
		writeFileSync(join(root, rel), text);
	};
	put(
		'herdr/hadoku-fleet/watch.mjs',
		"import { a } from '../../scripts/lib/herdr-fleet.mjs';\nawait import('../../scripts/lib/helper.mjs');\n"
	);
	put('herdr/hadoku-fleet/open.mjs', "import { a } from '../../scripts/lib/herdr-fleet.mjs';\n");
	put('scripts/lib/herdr-fleet.mjs', "import { A } from '../../dist/alpha.js';\n");
	put('scripts/lib/helper.mjs', "import {\n\tB,\n} from '../../dist/lib/beta.js';\n");
	for (const m of ['alpha', 'lib/beta']) {
		put(`src/${m}.ts`, '');
		put(`dist/${m}.js`, '');
		utimesSync(join(root, 'src', `${m}.ts`), 1000, 1000);
		utimesSync(join(root, 'dist', `${m}.js`), 2000, 2000);
	}
	return root;
}

test('herdr-fleet-freshness: a build that is missing, older than its source, or a module gone is stale', () => {
	const root = tree();
	assert.deepEqual(
		importGraph(root).dist,
		['alpha', 'lib/beta'],
		'a multi-line import through a dynamic import() counts'
	);
	assert.deepEqual(staleBuild(root), []);
	utimesSync(join(root, 'src', 'lib', 'beta.ts'), 3000, 3000);
	rmSync(join(root, 'dist', 'alpha.js'));
	assert.deepEqual(staleBuild(root), ['alpha (not built)', 'lib/beta (src newer than dist)']);
	rmSync(join(root, 'scripts', 'lib', 'helper.mjs'));
	assert.deepEqual(staleBuild(root), ['scripts/lib/helper.mjs (missing)', 'alpha (not built)']);
});

/** Fake `herdr` and `node` on PATH, recording their argv. */
function fakes(dir, nodeScript) {
	const log = join(dir, 'calls');
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'herdr'), `#!/bin/sh\nprintf 'herdr %s\\n' "$*" >> '${log}'\n`);
	if (nodeScript) writeFileSync(join(bin, 'node'), nodeScript);
	for (const f of ['herdr', 'node']) {
		try {
			chmodSync(join(bin, f), 0o755);
		} catch (err) {
			if (err.code !== 'ENOENT') throw err;
		}
	}
	return { log, bin };
}

async function waitFor(log, re, ms = 10_000) {
	const deadline = Date.now() + ms;
	let text = '';
	while (Date.now() < deadline) {
		try {
			text = readFileSync(log, 'utf8');
		} catch (err) {
			if (err.code !== 'ENOENT') throw err;
		}
		if (re.test(text)) return text;
		await new Promise((r) => setTimeout(r, 100));
	}
	return text;
}

test('herdr-fleet-freshness: a reload exit restarts the watcher quietly; a crash does not', async (t) => {
	const dir = tempDir('herdr-fresh-');
	const count = join(dir, 'runs');
	// Run 1 asks for a reload, run 2 crashes.
	const node = `#!/bin/sh\necho x >> '${count}'\n[ "$(wc -l < '${count}')" -eq 1 ] && exit ${RELOAD_EXIT}\nexit 3\n`;
	const { log, bin } = fakes(dir, node);
	const supervise = join(REPO, 'herdr/hadoku-fleet/supervise.sh');
	const child = spawn('sh', [supervise, 'ci'], {
		env: { PATH: `${bin}:${process.env.PATH}`, HERDR_PANE_ID: 'w1:p1' },
		stdio: 'ignore',
	});
	t.after(() => child.kill('SIGKILL'));
	const calls = await waitFor(log, /exited 3/);
	assert.equal(
		readFileSync(count, 'utf8').trim().split('\n').length,
		2,
		'restarted after the reload'
	);
	assert.doesNotMatch(calls, new RegExp(`exited ${RELOAD_EXIT}`));
	assert.match(calls, /--state blocked --message watcher exited 3; restarting in 10s/);
});

test('herdr-fleet-freshness: the real watcher, over a stale build, reports blocked and never imports dist/', async (t) => {
	const root = tempDir('herdr-fresh-');
	for (const f of [
		'herdr/hadoku-fleet/watch.mjs',
		'scripts/lib/herdr-fleet-freshness.mjs',
		'package.json',
	]) {
		mkdirSync(join(root, f, '..'), { recursive: true });
		copyFileSync(join(REPO, f), join(root, f));
	}
	// No dist/ at all, and no herdr-fleet.mjs: importing the classifier would crash.
	const { log, bin } = fakes(root);
	const child = spawn(
		process.execPath,
		[join(root, 'herdr/hadoku-fleet/watch.mjs'), 'node:claw-1'],
		{
			env: { PATH: `${bin}:${process.env.PATH}`, HERDR_PANE_ID: 'w1:p1', FLEET_HERDR_STATE: root },
			stdio: 'ignore',
		}
	);
	t.after(() => child.kill('SIGKILL'));
	const calls = await waitFor(log, /report-agent/);
	assert.match(
		calls,
		/--agent claw-1 --state blocked --message dist\/ is stale: run pnpm run build in /
	);
	assert.equal(child.exitCode, null, 'stays up and red rather than crashing');
});
