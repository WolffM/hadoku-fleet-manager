/**
 * check-history-coverage, run for real against a stand-in `gh`.
 *
 * The stand-in fails a repo's runs listing a scripted number of times, then
 * answers, so the retry and the reason in the finding are asserted on the
 * script itself rather than on the helper it borrows.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tempDir, cleanupTempDirs } from './lib/test-tmpdir.mjs';

afterEach(cleanupTempDirs);

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-history-coverage.mjs');

/**
 * A fleet of `repos`, each with one completed run two hours old that job-history
 * recorded, and a `gh` that fails repo R's listing `failures[R]` times first
 * (`Infinity` = every time) with `stderr` as its message.
 *
 * `missed` adds that many completed runs to EVERY repo that job-history did
 * NOT record, and `jobs` is how the stand-in answers their jobs lookup:
 * `'ran'` (a job reached a runner — recordable), `'never'` (no job reached a
 * runner — unrecordable) or `'fail'` (the lookup itself fails with `stderr`).
 */
function run(
	repos,
	failures,
	stderr = 'HTTP 502: Bad Gateway',
	{ missed = 0, jobs = 'ran', rateRemaining = '' } = {}
) {
	const dir = tempDir('history-coverage-');
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	writeFileSync(
		join(dir, 'fleet-runner-coverage.json'),
		JSON.stringify({ repos: repos.map((r) => `WolffM/${r}`) })
	);
	const now = Date.now();
	const ran = new Date(now - 2 * 3600_000).toISOString();
	const history = repos.map((_, i) =>
		JSON.stringify({ runId: 1000 + i, startedAt: new Date(now - 3 * 3600_000).toISOString() })
	);
	writeFileSync(join(dir, 'job-history.jsonl'), history.join('\n') + '\n');
	const bodies = Object.fromEntries(
		repos.map((r, i) => [
			r,
			JSON.stringify({
				workflow_runs: [
					{ id: 1000 + i, status: 'completed', updated_at: ran },
					...Array.from({ length: missed }, (_, k) => ({
						id: 5000 + i * 100 + k,
						status: 'completed',
						updated_at: ran,
					})),
				],
			}),
		])
	);
	writeFileSync(join(dir, 'bodies.json'), JSON.stringify(bodies));
	writeFileSync(
		join(dir, 'failures.json'),
		JSON.stringify(
			Object.fromEntries(Object.entries(failures).map(([k, v]) => [k, v === Infinity ? 1e9 : v]))
		)
	);
	const gh = join(bin, 'gh');
	writeFileSync(
		gh,
		[
			'#!/usr/bin/env bash',
			'# gh api rate_limit -q <jq>: the reserve read (#9); unset answers nothing, as a broken gh would',
			'if [ "$2" = rate_limit ]; then',
			'  [ -n "$RATE_REMAINING" ] || exit 1',
			'  echo "$RATE_REMAINING 1761371940"; exit 0',
			'fi',
			'# gh api repos/WolffM/<repo>/actions/runs?per_page=100 -q <jq>',
			'case "$2" in */jobs)',
			'  case "$JOBS" in',
			'    fail) echo "$FAKE_STDERR" >&2; exit 1 ;;',
			'    never) printf "\\t\\t\\n"; exit 0 ;;',
			'    *) printf "claw-1\\t%s\\t%s\\n" "$JOB_AT" "$JOB_AT"; exit 0 ;;',
			'  esac ;;',
			'esac',
			'repo=$(printf "%s" "$2" | sed -E "s#repos/WolffM/([^/]+)/.*#\\1#")',
			'n=$(( $(cat "$DIR/calls-$repo" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$DIR/calls-$repo"',
			'max=$(jq -r --arg r "$repo" \'.[$r] // 0\' "$DIR/failures.json")',
			'if [ "$n" -le "$max" ]; then echo "$FAKE_STDERR" >&2; exit 1; fi',
			'jq -r --arg r "$repo" \'.[$r]\' "$DIR/bodies.json" | jq -r "$4"',
			'',
		].join('\n')
	);
	chmodSync(gh, 0o755);
	const r = spawnSync(process.execPath, [SCRIPT, '--json'], {
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			// A token the host may not supply: never the App's pool, never a real mint (#9).
			GH_TOKEN: 'fixture',
			FLEET_MANIFEST_DIR: dir,
			HADOKU_STATE_DIR: dir,
			DIR: dir,
			FAKE_STDERR: stderr,
			JOBS: jobs,
			JOB_AT: ran,
			RATE_REMAINING: String(rateRemaining),
		},
	});
	const listed = repos.filter((repo) => existsSync(join(dir, `calls-${repo}`)));
	return { status: r.status, doc: JSON.parse(r.stdout || '{}'), stderr: r.stderr, listed };
}

test('a clean fleet passes', () => {
	const r = run(['alpha', 'beta'], {});
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.doc.ok, true);
	// GateDoc (wave 5f lane B): a clean run carries no findings, nothing
	// unreadable, and no `why` at all.
	assert.deepEqual(r.doc.findings, []);
	assert.deepEqual(r.doc.unreadable, []);
	assert.ok(!('why' in r.doc), 'a clean GateDoc must not carry why');
});

test('one transient blip on one repo is retried, not a red digest (2026-10-25, secretProject)', () => {
	const r = run(['alpha', 'secretProject'], { secretProject: 1 });
	assert.equal(r.status, 0, JSON.stringify(r.doc));
	assert.equal(r.doc.ok, true);
});

test('a repo that fails EVERY attempt still fails the gate — retrying is not tolerating', () => {
	const r = run(['alpha', 'secretProject'], { secretProject: Infinity });
	assert.equal(r.status, 1);
	assert.equal(r.doc.ok, false);
	assert.match(r.doc.error, /could not list runs for 1 repo\(s\)/);
	// GateDoc: a `fail()` refusal is "I could not look", so it is ALWAYS
	// `unreadable`, never a `findings` entry — the gate never got far enough
	// to look at any repo's coverage.
	assert.deepEqual(r.doc.findings, []);
	assert.equal(r.doc.unreadable.length, 1);
	assert.equal(r.doc.unreadable[0].node, null);
	assert.match(r.doc.unreadable[0].why, /could not list runs for 1 repo\(s\)/);
	assert.equal(r.doc.why, r.doc.error);
});

test('the finding says WHY, not just which repo', () => {
	const r = run(['secretProject'], { secretProject: Infinity }, 'HTTP 404: Not Found');
	assert.match(r.doc.error, /WolffM\/secretProject — exit 1: HTTP 404: Not Found \(attempt 2\/2\)/);
});

// ── #10: a failed jobs lookup is counted, not silent ─────────────────────────

test('misses whose jobs lookup FAILED are counted and their reason carried (#10)', () => {
	const r = run(['alpha', 'beta'], {}, 'HTTP 403: API rate limit exceeded', {
		// 25 + the recorded one clears MIN_SAMPLE (20); two repos stay inside
		// the 60-lookup classify budget.
		missed: 25,
		jobs: 'fail',
	});
	// Still pessimistic: a run we could not classify counts against the recorder.
	assert.equal(r.status, 1, JSON.stringify(r.doc));
	assert.equal(r.doc.lookupFailed, 50);
	assert.deepEqual(r.doc.lookupReasons, [
		{ reason: 'exit 1: HTTP 403: API rate limit exceeded', count: 50 },
	]);
	assert.deepEqual(
		r.doc.repos.map((x) => x.lookupFailed),
		[25, 25]
	);
});

test('a lookup that ANSWERS is not a failed lookup, whatever it says', () => {
	const lost = run(['alpha'], {}, undefined, { missed: 25, jobs: 'ran' });
	assert.equal(lost.doc.lookupFailed, 0);
	assert.equal(lost.status, 1, '25 runs that reached a runner and were not recorded are loss');
	// GateDoc: real loss is a FINDING (the gate looked and did not like what
	// it saw), never `unreadable` — it got all the way through every repo.
	assert.deepEqual(lost.doc.unreadable, []);
	assert.equal(lost.doc.findings.length, 1);
	assert.equal(lost.doc.findings[0].node, null);
	assert.equal(lost.doc.findings[0].kind, 'low-coverage');
	assert.match(lost.doc.findings[0].reason, /^WolffM\/alpha: /);
	assert.ok(lost.doc.why, 'a failing GateDoc must carry why');

	const never = run(['alpha'], {}, undefined, { missed: 25, jobs: 'never' });
	assert.equal(never.doc.lookupFailed, 0);
	assert.equal(never.doc.unrecordable, 25);
	assert.equal(never.status, 0, JSON.stringify(never.doc));
	assert.deepEqual(never.doc.findings, []);
	assert.deepEqual(never.doc.unreadable, []);
});

test('#9: under the shared GitHub reserve the gate is NOT RUN, fails, and spends nothing', () => {
	const r = run(['alpha', 'beta'], {}, undefined, { rateRemaining: 1499 });
	assert.equal(r.status, 1, r.stderr);
	assert.equal(r.doc.ok, false);
	assert.match(r.doc.error, /history-coverage NOT RUN: 1499 GitHub calls left/);
	assert.deepEqual(r.listed, [], 'not one repo listing was spent');
});

test('#9: at the reserve the gate runs as normal', () => {
	const r = run(['alpha', 'beta'], {}, undefined, { rateRemaining: 1500 });
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.doc.ok, true);
	assert.deepEqual(r.listed, ['alpha', 'beta']);
});

test('human output is unaffected by the migration — same prose, same exit code', () => {
	// Reruns the exact "low coverage" fixture above, once with --json and once
	// without, over two fresh directories built the same way `run()` builds one.
	const dir = tempDir('history-coverage-human-');
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	writeFileSync(
		join(dir, 'fleet-runner-coverage.json'),
		JSON.stringify({ repos: ['WolffM/alpha'] })
	);
	const now = Date.now();
	const ran = new Date(now - 2 * 3600_000).toISOString();
	writeFileSync(
		join(dir, 'job-history.jsonl'),
		JSON.stringify({ runId: 1000, startedAt: new Date(now - 3 * 3600_000).toISOString() }) + '\n'
	);
	writeFileSync(
		join(dir, 'bodies.json'),
		JSON.stringify({
			alpha: JSON.stringify({
				workflow_runs: [
					{ id: 1000, status: 'completed', updated_at: ran },
					...Array.from({ length: 25 }, (_, k) => ({
						id: 5000 + k,
						status: 'completed',
						updated_at: ran,
					})),
				],
			}),
		})
	);
	writeFileSync(join(dir, 'failures.json'), JSON.stringify({}));
	const gh = join(bin, 'gh');
	writeFileSync(
		gh,
		[
			'#!/usr/bin/env bash',
			'if [ "$2" = rate_limit ]; then exit 1; fi',
			'case "$2" in */jobs)',
			'  printf "claw-1\\t%s\\t%s\\n" "$JOB_AT" "$JOB_AT"; exit 0 ;;',
			'esac',
			'jq -r \'.alpha\' "$DIR/bodies.json" | jq -r "$4"',
			'',
		].join('\n')
	);
	chmodSync(gh, 0o755);
	const env = {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		GH_TOKEN: 'fixture',
		FLEET_MANIFEST_DIR: dir,
		HADOKU_STATE_DIR: dir,
		DIR: dir,
		JOB_AT: ran,
	};
	const json = spawnSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8', env });
	const human = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env });
	assert.equal(human.status, json.status, 'exit code must match between the two modes');
	assert.match(human.stderr, /job-history is losing runs in 1 repo\(s\)/);
	assert.ok(!human.stdout.trim().startsWith('{'), 'human mode must not print JSON');
});
