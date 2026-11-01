/**
 * No backtick in any unquoted heredoc that writes a generated artifact.
 *
 * These heredocs interpolate variables, so they cannot be quoted, which makes
 * every backtick command substitution — executed as root, since these run under
 * sudo. Twice today that turned prose into an executed command:
 *
 *   make-preseed.sh   12 backticks in comments, silently eaten from the output
 *   node-usb-prep.sh  `logger -t fleet` in the README, which reads stdin with
 *                     no message argument and hung an install indefinitely,
 *                     with no output and no disk activity to show why
 *
 * The first got a test and the second did not, so the rule lived in one file
 * and the mistake moved to the other. This covered every file that writes one
 * — but from a hand-kept list of five, which is the same shape of bug one
 * level up: `register-fleet-runner.sh` carried the live backtick-execution bug
 * (fleet#1) for as long as it did BECAUSE it was not on the list, and nothing
 * here would have caught the next script that made the same mistake either.
 *
 * Found by the 2026-11-01 test audit, re-checking the fix: at the same moment
 * `register-fleet-runner.sh` was added to the list, `scripts/fixes/nm-convert.sh`
 * and `scripts/node-bootstrap.sh` carried the identical pattern — a comment
 * inside an unquoted heredoc with a backslash-escaped backtick around a command
 * name (`\`nm-convert.sh --commit\``, `\`fleet enroll\``) — and neither was on
 * the list either. The escape means these two were never LIVE command
 * substitution (`\`` inside bash's unquoted-heredoc expansion is a literal
 * backtick, the same escaping rule as inside double quotes), but the fix this
 * repo settled on for the exact same shape (`daab26f`, register-fleet-runner.sh)
 * is to remove the backtick from the prose entirely rather than rely on every
 * future edit re-escaping it correctly, so these two now use plain quotes too.
 *
 * This file now discovers every git-tracked `*.sh`, rather than naming them,
 * so the next script with this mistake does not need a second entry here to
 * be caught.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * Every file this repo's git tracks, or `null` when git could not answer —
 * same GIT_DIR-clearing discipline `identity-scan.mjs`'s `trackedFiles` uses,
 * copied rather than imported: that module's own import chain reaches
 * `fleet-roster.mjs`, whose top-level `manifest('fleet-runner-coverage.json')`
 * call requires `HADOKU_SITE_ROOT` to exist just to be IMPORTED, which is
 * exactly the blind-CI trap CLAUDE.md's "Local gate blind to CI" note warns
 * about (`HADOKU_SITE_ROOT=/nonexistent` is how this file is run in CI, and
 * this discovery has nothing to do with hadoku_site at all).
 */
function trackedFiles() {
	try {
		const env = { ...process.env };
		for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
		const out = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], {
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
			stdio: ['ignore', 'pipe', 'ignore'],
			env,
			cwd: ROOT,
		});
		const set = new Set(out.split('\0').filter(Boolean));
		return set.size ? set : null;
	} catch {
		return null;
	}
}

/** Body of every `<<DELIM` heredoc whose delimiter is NOT quoted. */
export function unquotedHeredocs(src) {
	const out = [];
	const lines = src.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/<<-?([A-Za-z_][A-Za-z0-9_]*)\s*$/);
		if (!m) continue; // a quoted delimiter (<<'EOF') does not match: no $ or ` expansion
		const delim = m[1];
		const body = [];
		for (let j = i + 1; j < lines.length; j++) {
			if (lines[j].trim() === delim) break;
			body.push(lines[j]);
		}
		out.push({ line: i + 1, delim, body: body.join('\n') });
	}
	return out;
}

/**
 * Every tracked `.sh` file carrying a backtick inside one of its own unquoted
 * heredocs, as `${rel}: line N (<<DELIM)` strings — the shape this test's
 * assertion reports. Pure and disk-free given `readFile`, so the discovery
 * mechanism (which files get checked) can be proven separately from git and
 * the filesystem.
 */
export function heredocBacktickViolations(files, readFile) {
	const bad = [];
	for (const rel of files) {
		const src = readFile(rel);
		for (const h of unquotedHeredocs(src)) {
			if (h.body.includes('`')) bad.push(`${rel}: line ${h.line} (<<${h.delim})`);
		}
	}
	return bad;
}

// ---------------------------------------------------------------------------
// Planted violation — proves the CHECK bites, with no disk and no git.
// ---------------------------------------------------------------------------

test('planted violation: a backtick in an unquoted heredoc is caught in ANY file the discovery hands it, not only a named few', () => {
	// `totally-new-fix.sh` is not, and never was, on any hardcoded list — which
	// is exactly the shape `register-fleet-runner.sh` (fleet#1) and the two
	// files this fix adds (nm-convert.sh, node-bootstrap.sh) had in common. The
	// list this file now checks comes from discovery, not from here, so this
	// proves the CHECK itself, independent of which files git happens to track.
	const files = ['scripts/fixes/totally-new-fix.sh'];
	const src = {
		'scripts/fixes/totally-new-fix.sh':
			'#!/bin/sh\ncat >"$OUT" <<EOF\n# removed by `totally-new-fix.sh --undo`\nEOF\n',
	};
	const bad = heredocBacktickViolations(files, (f) => src[f]);
	assert.deepEqual(bad, ['scripts/fixes/totally-new-fix.sh: line 2 (<<EOF)']);
});

test('a quoted heredoc delimiter is never expanded, so a backtick inside it is not a finding', () => {
	const files = ['scripts/fixes/quoted.sh'];
	const src = {
		'scripts/fixes/quoted.sh': '#!/bin/sh\ncat >"$OUT" <<\'EOF\'\nsee `man sh` for details\nEOF\n',
	};
	const bad = heredocBacktickViolations(files, (f) => src[f]);
	assert.deepEqual(bad, []);
});

test('no unquoted heredoc at all is not a finding', () => {
	const files = ['scripts/fixes/no-heredoc.sh'];
	const src = {
		'scripts/fixes/no-heredoc.sh': '#!/bin/sh\necho "no heredoc here, and no backtick either"\n',
	};
	const bad = heredocBacktickViolations(files, (f) => src[f]);
	assert.deepEqual(bad, []);
});

// ---------------------------------------------------------------------------
// Discovery — which files the real scan below checks.
// ---------------------------------------------------------------------------

const tracked = trackedFiles();
// "I could not look" must never render as "nothing is wrong": a `git ls-files`
// that failed returns `null` from `trackedFiles`, and treating that as "zero
// .sh files" would pass this test by scanning nothing.
assert.ok(tracked, 'trackedFiles() could not read git — refusing to run a scan of nothing');
const SH_FILES = [...tracked].filter((f) => f.endsWith('.sh')).sort();

/**
 * The repo carried 38 tracked `.sh` files at the time of the 2026-11-01 test
 * audit (the hand-kept list this file replaces checked 5 of them). A floor
 * near zero would not catch `trackedFiles` degrading to a near-empty set; it
 * only has to catch a scan that finds almost nothing to check.
 */
const MIN_SH_FILES = 25;

test('discovery finds enough tracked .sh files to be worth trusting', () => {
	assert.ok(
		SH_FILES.length >= MIN_SH_FILES,
		`found only ${SH_FILES.length} tracked .sh file(s), expected at least ${MIN_SH_FILES}`
	);
});

// ---------------------------------------------------------------------------
// The real scan — one test per discovered file, same shape as before.
// ---------------------------------------------------------------------------

for (const rel of SH_FILES) {
	test(`${rel} has no backtick in an unquoted heredoc`, () => {
		const bad = heredocBacktickViolations([rel], (f) => readFileSync(join(ROOT, f), 'utf8'));
		assert.deepEqual(
			bad,
			[],
			`backticks inside an unquoted heredoc are command substitution, run as root:\n  ` +
				`${bad.join('\n  ')}\nUse plain quotes in prose, even for one already backslash-escaped.`
		);
	});
}
