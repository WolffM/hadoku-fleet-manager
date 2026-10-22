/**
 * A RECONCILER WITH NOTHING TO RECONCILE HAS NOT VERIFIED ANYTHING.
 *
 * CLAUDE.md: "'I could not look' must never render as 'nothing is wrong.' An
 * unreachable machine, a missing checkout, an unreadable runner listing, zero
 * repos scanned — each of these FAILS. Exit 0 with no evidence is a failure,
 * not a pass."
 *
 * `check-queue-health` carries that guard ("the coverage roster is EMPTY. A
 * fleet of zero repos is not a pass") and so does `check-capability-schema`.
 * `reconcile` — the one whose answer `ci:fleet-coverage` ACTS on — did not.
 *
 * MEASURED 2026-09-03 with a `gh` that authenticates fine and owns nothing:
 * exit 0, `desiredRepos: 0`, every array empty, no findings. The cron reads that
 * as "every covered repo has a runner". A token scoped to no repositories, an
 * owner typo in `autoInclude.owner`, or a `gh` authenticated as somebody else
 * all produce it, and none of them is a broken call — `execFileSync` throws on
 * those, which is the case that was already safe.
 *
 * WHY A SPAWNED SCRIPT AND NOT A UNIT TEST. The predicate is `!all.length` and
 * proving THAT correct is worth nothing. What can actually regress is the
 * wiring: that the guard runs before the summary, that it exits non-zero, and
 * that it still emits JSON — because the cron parses stdout BEFORE the exit
 * code, so a guard that dies with bare prose converts a real finding into "the
 * checker broke". Only running it shows all three.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tempDir } from './test-tmpdir.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'dist', 'cli.js');

/** A `gh` that SUCCEEDS and returns `repoList`. Not a broken call — those already throw. */
function fakeGhDir(repoList = '[]') {
	const dir = tempDir('fleet-zero-gh-');
	const bin = join(dir, 'gh');
	writeFileSync(
		bin,
		`#!/bin/sh\ncase "$*" in\n  *"repo list"*) echo '${repoList}' ;;\n  *) echo '[]' ;;\nesac\nexit 0\n`
	);
	chmodSync(bin, 0o755);
	return dir;
}

/** Run `fleet reconcile --json` against a fake gh. Returns {code, out}. */
function reconcileWith(dir) {
	try {
		return {
			code: 0,
			out: execFileSync(process.execPath, [CLI, 'reconcile', '--json'], {
				encoding: 'utf8',
				env: {
					...process.env,
					PATH: `${dir}:${process.env.PATH}`,
					// Pinned, or this result moves with whatever checkout the default
					// resolution finds. The fixtures are enough to get past manifest
					// loading, which is all this needs.
					FLEET_MANIFEST_DIR: join(ROOT, 'manifests'),
				},
				stdio: ['ignore', 'pipe', 'pipe'],
			}),
		};
	} catch (err) {
		return { code: err.status ?? 1, out: err.stdout ?? '' };
	}
}

test('an EMPTY universe is refused — gh owns nothing', (t) => {
	// `pnpm test` builds dist before these run; a bare `node --test` on this file
	// alone may not have. Skipping is honest — asserting against a stale build
	// would be worse than not running.
	if (!existsSync(CLI)) return t.skip('dist/cli.js is not built');
	const { code, out } = reconcileWith(fakeGhDir());
	assert.notEqual(code, 0, 'a fleet nobody looked at must not exit 0');
	assert.ok(out.trim().startsWith('{'), `stdout must stay JSON for the cron: ${out.slice(0, 120)}`);
	const parsed = JSON.parse(out);
	assert.equal(parsed.ok, false, 'it must say so in the payload, not only in the exit code');
	assert.match(parsed.error, /NO repositories/i, 'and name what went wrong');
	// The exact regression: a summary of zeros presented as a clean result.
	assert.equal(parsed.desiredRepos, undefined, 'it must not emit a summary it never gathered');
});

test('repos that EXIST but none covered is refused too', (t) => {
	// The second guard, and the one that needs RUNNING rather than reading: it
	// reports `desired`, `retired` and `ignored`, none of which is in the scope
	// that holds the repo list. The first draft reported a count from that list
	// and threw `all is not defined` — a guard that would have crashed the
	// coverage cron in precisely the situation it exists to report. eslint caught
	// it; this pins it.
	if (!existsSync(CLI)) return t.skip('dist/cli.js is not built');
	const archived =
		'[{"nameWithOwner":"WolffM/a","isFork":false,"isArchived":true,"pushedAt":"2026-01-01T00:00:00Z"}]';
	const { code, out } = reconcileWith(fakeGhDir(archived));
	assert.notEqual(code, 0, 'covering nothing is not a pass');
	assert.ok(out.trim().startsWith('{'), `stdout must stay JSON for the cron: ${out.slice(0, 120)}`);
	const parsed = JSON.parse(out);
	assert.equal(parsed.ok, false);
	assert.match(parsed.error, /NOTHING is covered/i);
	assert.equal(parsed.desiredRepos, undefined, 'it must not emit a summary it never gathered');
});
