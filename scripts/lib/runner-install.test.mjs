/**
 * lib/runner-install.sh: ONE answer to "is this directory a runner install?",
 * and a guard that keeps every node-side reader asking it.
 *
 * Each reader used to keep its own answer, and this package's own suite (fake
 * Runner.Listener / Runner.Worker processes in a temp dir, while it runs as a
 * CI job on a node) got past each one differently: runner-supervision paged
 * eleven times from 11-01 to 11-16 (fleet-manager#79), and on 11-16 hokon's
 * throttle converger tried to RESTART four fixtures under /tmp.
 *
 * The rule runs for real in bash here, against a fixture $HOME; nothing reads
 * this machine's process table. Nothing here spawns git.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(HERE));
const RULE = join(HERE, 'runner-install.sh');
const CANONICAL = 'scripts/lib/runner-install.sh';

/** Run `body` after sourcing the rule, with HOME (and maybe TMPDIR) set. */
function sh(body, { home, tmpdirEnv, path } = {}) {
	const env = { PATH: path ?? process.env.PATH ?? '/usr/bin:/bin', HOME: home };
	if (tmpdirEnv !== undefined) env.TMPDIR = tmpdirEnv;
	return execFileSync('bash', ['-c', `. ${JSON.stringify(RULE)}\n${body}`], {
		env,
		encoding: 'utf8',
	});
}

/** Which of `dirs` runner_install_dir accepts. */
function installs(dirs, opts) {
	const body = dirs
		.map((d) => `runner_install_dir ${JSON.stringify(d)} && echo ${JSON.stringify(d)}`)
		.join('\n');
	return sh(`${body}\ntrue`, opts).split('\n').filter(Boolean);
}

void test('runner_install_dir: under $HOME is an install; a temp dir, inside $HOME or out, is not', () => {
	const home = '/home/ci';
	const keep = [
		`${home}/actions-runner`,
		`${home}/runners/actions-runner-hadoku-site`,
		`${home}/repos/app/actions-runner-app`,
		// No glob knows this name: the listener unions exist to catch it.
		`${home}/odd-place/runner`,
		`${home}/.hadoku/warm/listener`,
		`${home}/.hadoku/jit/slot0`,
	];
	const drop = [
		// The 11-09 page: a fixture under /tmp.
		'/tmp/runner-env-drift-AbC/actions-runner-x',
		// The 11-01..11-16 pages: a CI job's TMPDIR is ~/runner-tmp.
		`${home}/runner-tmp/runner-drift-def/actions-runner-x`,
		`${home}/runner-tmp`,
		home,
		'/opt/actions-runner',
	];
	// TMPDIR UNSET, as in the ssh shell every probe runs in.
	assert.deepEqual(installs([...keep, ...drop], { home }), keep);
});

void test('runner_install_dir: $TMPDIR is honoured only when it sits inside $HOME', () => {
	const home = '/home/ci';
	assert.deepEqual(
		installs([`${home}/tmp/x/actions-runner-x`, `${home}/actions-runner`], {
			home,
			tmpdirEnv: `${home}/tmp/`,
		}),
		[`${home}/actions-runner`]
	);
	// A hermetic test's HOME is under /tmp. A TMPDIR of /tmp (set, or the
	// fallback) must not drop every runner in it.
	const fixtureHome = '/tmp/runner-drift-Qq/home';
	assert.deepEqual(
		installs([`${fixtureHome}/actions-runner-x`], { home: fixtureHome, tmpdirEnv: '/tmp' }),
		[`${fixtureHome}/actions-runner-x`]
	);
	// TMPDIR equal to $HOME is not a temp dir INSIDE it.
	assert.deepEqual(installs([`${home}/actions-runner`], { home, tmpdirEnv: home }), [
		`${home}/actions-runner`,
	]);
});

void test('runner_jit_slot: the JIT tree and nothing else', () => {
	const home = '/home/ci';
	const out = sh(
		[
			`${home}/.hadoku/jit/slot1`,
			`${home}/.hadoku/jit/payload`,
			`${home}/.hadoku/warm/listener`,
			`${home}/actions-runner`,
		]
			.map((d) => `runner_jit_slot ${JSON.stringify(d)} && echo ${JSON.stringify(d)}`)
			.join('\n') + '\ntrue',
		{ home }
	);
	assert.deepEqual(out.split('\n').filter(Boolean), [
		`${home}/.hadoku/jit/slot1`,
		`${home}/.hadoku/jit/payload`,
	]);
});

void test('standing_runner_dirs: glob UNION live listeners, minus JIT slots and fixtures', () => {
	const root = mkdtempSync(join(tmpdir(), 'runner-install-'));
	try {
		const home = join(root, 'home');
		const bin = join(root, 'bin');
		const globbed = [
			join(home, 'actions-runner'),
			join(home, 'runners', 'actions-runner-a'),
			join(home, 'repos', 'r', 'actions-runner-r'),
		];
		for (const d of [...globbed, bin]) mkdirSync(d, { recursive: true });
		const listeners = [
			join(home, 'actions-runner'),
			join(home, 'odd-place', 'runner'),
			join(home, '.hadoku', 'jit', 'slot0'),
			join(home, 'runner-tmp', 'runner-drift-def', 'actions-runner-x'),
			join(root, 'elsewhere', 'actions-runner-x'),
		];
		// pgrep -af as production sees it, its own shell's line included.
		writeFileSync(
			join(bin, 'pgrep'),
			'#!/usr/bin/env bash\n' +
				listeners.map((d, i) => `echo "${100 + i} ${d}/bin/Runner.Listener run"`).join('\n') +
				'\necho "999 bash -c pgrep -af bin/Runner\\.Listener"\n',
			{ mode: 0o755 }
		);
		const out = sh('standing_runner_dirs', { home, path: `${bin}:/usr/bin:/bin` });
		assert.deepEqual(
			out.split('\n').filter(Boolean),
			[...globbed, join(home, 'odd-place', 'runner')].sort()
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// --- the guard ---------------------------------------------------------------

/**
 * Readers that turn a process's argv into a runner directory WITHOUT asking the
 * rule, each with why that is safe. Adding one needs a reason a reviewer can
 * check: the default is to ask runner_install_dir.
 */
const OUTSIDE_THE_RULE = Object.freeze({
	'scripts/clean-runner-debris.sh':
		'its busy and listener lists only PROTECT a directory from deletion; counting a fixture keeps more, never deletes more',
	'src/lib/node-probe.ts':
		'attributes a live job to a repo through the gitHubUrl in .runner; a fixture carries none, so it adds nothing',
});

/** Splitting a runner directory off a Listener/Worker argv or exe path. */
const PARSES_RUNNER_DIR = /%%?\/bin\*?\/Runner\.(?:Listener|Worker)/;

function sources(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		if (entry === 'node_modules' || entry === 'dist' || entry === 'tests') continue;
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) {
			sources(p, out);
			continue;
		}
		if (/\.(ts|mjs|sh)$/.test(entry) && !/\.test\.(ts|mjs)$/.test(entry)) out.push(p);
	}
	return out;
}

const ALL = ['src', 'scripts', 'deploy', 'herdr']
	.flatMap((d) => sources(join(ROOT, d)))
	.map((abs) => ({
		rel: relative(ROOT, abs),
		text: readFileSync(abs, 'utf8'),
	}));

void test('every reader that parses a runner directory from a process asks runner_install_dir', () => {
	const offenders = ALL.filter(
		({ rel, text }) =>
			rel !== CANONICAL &&
			!(rel in OUTSIDE_THE_RULE) &&
			PARSES_RUNNER_DIR.test(text) &&
			!/\brunner_install_dir\b/.test(text)
	).map(({ rel }) => rel);
	assert.deepEqual(
		offenders,
		[],
		`these split a runner directory off a Runner.Listener/Worker path without asking ` +
			`runner_install_dir (${CANONICAL}):\n  ${offenders.join('\n  ')}\n\n` +
			"This package's own suite starts fake listeners and workers in a temp dir while it " +
			'runs as a CI job on a node; a reader that does not ask the rule judges them, pages ' +
			'about them, or restarts them. Ask the rule, or add the file to OUTSIDE_THE_RULE ' +
			'with why a fixture cannot mislead it.'
	);
});

void test('OUTSIDE_THE_RULE names only files that still parse a runner directory', () => {
	const stale = Object.keys(OUTSIDE_THE_RULE).filter((rel) => {
		const f = ALL.find((x) => x.rel === rel);
		return !f || !PARSES_RUNNER_DIR.test(f.text);
	});
	assert.deepEqual(stale, [], `remove these from OUTSIDE_THE_RULE: ${stale.join(', ')}`);
});

void test('the rule has one definition, and every file that asks it carries it', () => {
	const defines = ALL.filter(({ text }) => /^\s*runner_install_dir\s*\(\)\s*\{/m.test(text)).map(
		({ rel }) => rel
	);
	assert.deepEqual(defines, [CANONICAL]);
	// A caller that names the function but never loads the file would fail on the
	// node with "command not found", and every probe would read as unreachable.
	const unloaded = ALL.filter(
		({ rel, text }) =>
			rel !== CANONICAL &&
			/\brunner_install_dir\b/.test(text) &&
			!text.includes('runner-install.sh')
	).map(({ rel }) => rel);
	assert.deepEqual(unloaded, []);
});

void test('the rule names the TMPDIR ci-throttle-install.sh gives every CI job', () => {
	const install = ALL.find(({ rel }) => rel === 'scripts/ci-throttle-install.sh').text;
	assert.match(
		install,
		/^RUNNER_TMPDIR="\$HOME\/runner-tmp"$/m,
		'RUNNER_TMPDIR moved: update runner-install.sh too'
	);
	assert.match(readFileSync(RULE, 'utf8'), /"\$HOME"\/runner-tmp\/\*/);
});
