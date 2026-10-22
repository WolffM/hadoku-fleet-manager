/**
 * An interrupted runner removal must be attributable, and then swept.
 *
 * Removal is not atomic and cannot be made so: `removeScript` deregisters over
 * the network, then deletes the tree. Interrupted between those two steps it
 * leaves the 678 MB package, no `.runner`, no unit and no GitHub registration —
 * and in that state nothing could identify it, because every tool that might
 * have keys on the record the deregistration just deleted.
 *
 * Measured on claw-1, 2026-09-01: three such directories holding 3.1 GB, while
 * `fleet cleanup` reported `stale 0.00 GB` standing beside them.
 *
 * These tests drive the REAL shell against a fabricated HOME rather than
 * grepping it, because the property that matters is behavioural: which
 * directories survive.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPTS = dirname(dirname(fileURLToPath(import.meta.url)));
const SWEEP = join(SCRIPTS, 'clean-runner-debris.sh');

/**
 * A HOME holding one directory per case.
 *
 * `bin`/`externals` are real subdirectories because the healthy path resolves
 * them with `readlink -f` and bails out as SKIP-UNRESOLVED without them — a
 * fixture that skipped for the wrong reason would pass this suite while proving
 * nothing.
 */
function fixture() {
	const home = mkdtempSync(join(tmpdir(), 'orphan-sweep-'));
	const mk = (name, { runner, removing }) => {
		const d = join(home, name);
		mkdirSync(join(d, 'bin'), { recursive: true });
		mkdirSync(join(d, 'externals'), { recursive: true });
		writeFileSync(join(d, 'externals', 'payload'), 'x'.repeat(4096));
		if (runner) writeFileSync(join(d, '.runner'), '{"gitHubUrl":"https://github.com/W/x"}');
		if (removing)
			writeFileSync(join(d, '.removing'), 'repo=WolffM/x\nstarted=2026-09-01T00:00:00Z\n');
		return d;
	};
	return {
		home,
		// The fault: deregistered, then interrupted before `rm -rf`.
		orphan: mk('actions-runner-beta', { runner: false, removing: true }),
		// A removal whose deregister FAILED. `.runner` survives, so a retry is
		// owed — sweeping this would delete a live registration's install.
		retryOwed: mk('actions-runner-alpha', { runner: true, removing: true }),
		// Mid-CONFIG. No `.runner` yet and no marker. claw-5 sat here for hours
		// on 2026-09-01 while being provisioned.
		midConfig: mk('actions-runner-gamma', { runner: false, removing: false }),
		// Healthy.
		healthy: mk('actions-runner-delta', { runner: true, removing: false }),
	};
}

/** Run the real sweep against a fabricated HOME. */
function sweep(home, { apply }) {
	return execFileSync('bash', [SWEEP], {
		env: {
			...process.env,
			HOME: home,
			APPLY: apply ? '1' : '0',
			// No tmpfs root, so no tmpfs sweep. This used to rely on TMP_KEEP_MIN
			// being huge, which fenced the sweeps of its day and not the backstop
			// added on 2026-10-10: this suite then swept hokon's real /tmp under
			// APPLY=1. The script now sweeps only a root its caller names.
			TMPFS_ROOT: '',
		},
		encoding: 'utf8',
	});
}

test('dry run names ONLY the interrupted removal', () => {
	const f = fixture();
	try {
		const out = sweep(f.home, { apply: false });
		const would = out
			.split('\n')
			.filter((l) => l.startsWith('WOULD-REMOVE'))
			.join(' ');
		assert.match(would, /actions-runner-beta/, 'the orphan must be found');
		assert.doesNotMatch(would, /actions-runner-alpha/, 'a retry-owed removal is not debris');
		assert.doesNotMatch(would, /actions-runner-gamma/, 'a mid-config install is not debris');
		assert.doesNotMatch(would, /actions-runner-delta/, 'a healthy runner is not debris');
	} finally {
		rmSync(f.home, { recursive: true, force: true });
	}
});

test('apply deletes the orphan and nothing else', () => {
	const f = fixture();
	try {
		sweep(f.home, { apply: true });
		assert.equal(existsSync(f.orphan), false, 'the interrupted removal must be finished');
		assert.equal(existsSync(f.retryOwed), true, 'a retry-owed removal must survive');
		assert.equal(existsSync(f.midConfig), true, 'a mid-config install must survive');
		assert.equal(existsSync(f.healthy), true, 'a healthy runner must survive');
	} finally {
		rmSync(f.home, { recursive: true, force: true });
	}
});

test('the reclaim is reported under its OWN key, not folded into stale', () => {
	// stale/_update are the runner's own self-update litter and move every week.
	// orphan_kb only ever moves when a removal this fleet started did not finish,
	// so sharing a column would hide it.
	const f = fixture();
	try {
		const out = sweep(f.home, { apply: false });
		const summary = out.split('\n').find((l) => l.startsWith('SUMMARY')) ?? '';
		const orphanKb = Number(/orphan_kb=(\d+)/.exec(summary)?.[1] ?? 0);
		const staleKb = Number(/stale_kb=(\d+)/.exec(summary)?.[1] ?? 0);
		assert.ok(orphanKb > 0, `orphan_kb must count the tree, got: ${summary}`);
		assert.equal(staleKb, 0, 'and must not be attributed to stale');
	} finally {
		rmSync(f.home, { recursive: true, force: true });
	}
});

test('a marker alone never justifies deletion — .runner is the veto', () => {
	// The dangerous inversion. If the sweep keyed on `.removing` alone it would
	// delete the install of a registration that is still live on GitHub, which is
	// the state a FAILED deregister deliberately leaves behind so it can retry.
	const f = fixture();
	try {
		sweep(f.home, { apply: true });
		assert.ok(existsSync(join(f.retryOwed, '.runner')), 'the live registration survives intact');
		assert.ok(existsSync(join(f.retryOwed, 'externals', 'payload')));
	} finally {
		rmSync(f.home, { recursive: true, force: true });
	}
});

/** removeScript's output, lifted from the module the way remove-script-guest.test does. */
function generatedRemoveScript() {
	const SRC = readFileSync(join(SCRIPTS, 'reconcile-fleet-runners.mjs'), 'utf8');
	const start = SRC.indexOf('function removeScript');
	const end = SRC.indexOf('\n}', SRC.indexOf('return `', start)) + 2;
	const make = new Function('repoSuffix', `return ${SRC.slice(start, end)}`);
	return make((r) => r.split('/').pop().toLowerCase())({ repo: 'WolffM/x', token: 'tok' });
}

test('the breadcrumb is written BEFORE the deregistration that deletes .runner', () => {
	// The ordering IS the mechanism. Written after, it would never exist in the
	// window it is meant to survive, and every test above would still pass
	// because they fabricate the marker themselves.
	// ANCHORED ON THE WRITE, not on the first mention of `.removing`.
	//
	// `blankComments` keeps STRINGS by design, and the shell script here is a
	// template literal — so the `#` prose inside it survives blanking. The first
	// version of this test searched for `.removing` and matched its own
	// explanatory comment, which sits before `config.sh remove` no matter where
	// the write actually is. It passed against a build with the write moved AFTER
	// the deregistration: a comment standing in as evidence for the rule it
	// describes, which CLAUDE.md records happening three times before this.
	//
	// Read off the GENERATED script, not the module source (#123): the
	// deregistration step is now assembled in removeScript's prologue, so its
	// text sits ABOVE the write in the source while running after it.
	const src = generatedRemoveScript();
	// [^>]* rather than [^\n]*: the template turns the format string's \n into
	// real newlines, so the generated printf spans lines.
	const write = /printf [^>]*>\s*"\$DIR\/\.removing"/.exec(src);
	const deregister = src.indexOf('./config.sh remove');
	assert.ok(write, 'removeScript must WRITE a .removing marker, not merely mention one');
	assert.ok(deregister > 0, 'and still deregister');
	assert.ok(
		write.index < deregister,
		'the marker must be written before `config.sh remove`, or it cannot survive the gap'
	);
});
