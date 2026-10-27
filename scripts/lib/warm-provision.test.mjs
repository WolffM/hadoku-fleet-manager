/**
 * warm-provision.sh, executed — the node half of the warm cache of one.
 *
 * WHY THIS RUNS THE SCRIPT INSTEAD OF GREPPING IT
 * -----------------------------------------------
 * Issue #7's whole history is a script that read correctly and did not work.
 * It failed on every node for as long as it existed with
 * `./config.sh: No such file or directory`, was fixed by seeding a runner
 * ROOT, and then failed on every node that has never held a standing
 * registration — the normal case under all-JIT — with
 * `no runner install to source a payload from`. Neither failure is visible in
 * the source; both are visible the instant it is run against a $HOME that
 * looks like a real claw's.
 *
 * So this builds one: a `~/.hadoku/jit/payload` holding a FAKE
 * `bin/Runner.Listener` that answers `--version` and `configure` the way the
 * real binary does, and nothing else. That is deliberately the poorest node
 * the fleet can produce — no `~/actions-runner*`, no runner root, no
 * `config.sh` anywhere — because that is claw-1, claw-3 and claw-5 today.
 *
 * The fake listener is a shell script rather than a stub that records nothing:
 * it writes `.runner`/`.credentials` on a successful configure and refuses
 * without `--url`/`--token`, so "registered" here means the same file-system
 * outcome the caller (`mintWarmListener`) checks for on a real node.
 *
 * IT ALSO REFUSES WHEN `.runner` ALREADY EXISTS — issue #17. The real
 * `Runner.Listener` throws exactly `Cannot configure the runner because it
 * is already configured. To reconfigure the runner, run 'config.cmd remove'
 * or './config.sh remove' first.` from `ConfigurationManager.IsConfigured()`,
 * checked before any network call and NOT affected by `--replace` (confirmed
 * against actions/runner's source: `--replace` only governs a SERVER-side
 * name collision, reached after this local check already passed). Every
 * earlier version of this fake let `configure` succeed unconditionally, so a
 * test running it twice could not tell a script that resets `.runner` first
 * from one that does not — it would have stayed green through issue #17
 * exactly the way `warm-canary` did. This is what makes "a second provision
 * reuses the slot" below an actual regression test instead of one that
 * happens to pass.
 *
 * AND WHEN `.runner_migrated` EXISTS WITH NO `.runner` — issue #17's THIRD
 * diagnosis. `IsConfigured()` is `_configFilePath.Exists ||
 * _migratedConfigFilePath.Exists` (`ConfigurationStore.cs`): either file is
 * sufficient, and claw-3/4/5 broke on exactly this shape — `.runner_migrated`
 * left behind by a prior RESET that only knew to remove `.runner`. A fake
 * that only checked `.runner` would pass the earlier two diagnoses' fixes
 * while staying blind to the one this lane exists to close.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// The text production sends (src/runners/node-script.ts): the payload library,
// then the minter, run as `bash -c <text> warm-provision.sh`.
const { nodeScriptText } = await import('../../dist/runners/node-script.js');
const SCRIPT_ARGV = ['-c', nodeScriptText('warm-provision.sh'), 'warm-provision.sh'];

/**
 * A stand-in for `bin/Runner.Listener` that behaves like the real one for the
 * two invocations this script makes. `configure` appends its full argv to
 * `$HOME/configure-argv` so a test can assert on the flags that were actually
 * passed — `--disableupdate` in particular, which is a data-loss guard rather
 * than a preference.
 */
const FAKE_LISTENER = `#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "2.336.0"; exit 0; fi
if [ "\${1:-}" = "configure" ]; then
  # ConfigurationManager.IsConfigured(): checked FIRST, unconditional on
  # --replace — see the header note above. A real slot with a leftover
  # .runner OR .runner_migrated refuses here, before any of the flags below
  # are even parsed — issue #17's third diagnosis: EITHER file is sufficient.
  if [ -f .runner ] || [ -f .runner_migrated ]; then
    echo "Cannot configure the runner because it is already configured. To reconfigure the runner, run 'config.cmd remove' or './config.sh remove' first." >&2
    exit 1
  fi
  # Test-only knob: widens the window a concurrent second provision would
  # have to land in, so the lock test below exercises real contention rather
  # than two calls that happen not to overlap.
  [ -n "\${FAKE_CONFIGURE_SLEEP:-}" ] && sleep "$FAKE_CONFIGURE_SLEEP"
  printf '%s\\n' "$*" >> "$HOME/configure-argv"
  url=""; tok=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --url) url="$2"; shift 2 ;;
      --token) tok="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  [ -n "$url" ] && [ -n "$tok" ] || { echo "Must supply --url and --token" >&2; exit 1; }
  printf '{"agentName":"fake"}' > .runner
  printf '{"scheme":"OAuth"}' > .credentials
  exit 0
fi
echo "unsupported: $*" >&2
exit 1
`;

/** A directory holding a runner tree — payload-shaped or install-shaped. */
function writeRunnerTree(dir, { root = false } = {}) {
	mkdirSync(join(dir, 'bin'), { recursive: true });
	mkdirSync(join(dir, 'externals'), { recursive: true });
	writeFileSync(join(dir, 'bin', 'Runner.Listener'), FAKE_LISTENER);
	chmodSync(join(dir, 'bin', 'Runner.Listener'), 0o755);
	writeFileSync(join(dir, 'externals', 'node20'), 'x');
	if (root) {
		// A standing install also carries the root-level scripts. Present here
		// only to prove they are NOT what registration depends on any more.
		for (const f of ['config.sh', 'run.sh', 'env.sh']) {
			writeFileSync(join(dir, f), '#!/usr/bin/env bash\nexit 9\n');
			chmodSync(join(dir, f), 0o755);
		}
	}
	return dir;
}

/**
 * What `fleet throttle --confirm` leaves on a node for a STANDING runner.
 *
 * Three keys, in the order `scripts/lib/standing-runner-env.sh` writes them,
 * because a warm listener is a standing registration and gets exactly what
 * every other standing runner gets. The hook path is the real one the deploy
 * writes (`$HOME/.hadoku/ci-throttle.sh`) so the N+1 test below can EXECUTE
 * whatever the slot's `.env` ends up naming rather than a path this test chose.
 */
function writeStandingEnv(home, extra = []) {
	mkdirSync(join(home, '.hadoku'), { recursive: true });
	writeFileSync(
		join(home, '.hadoku', 'standing.env'),
		[
			`ACTIONS_RUNNER_HOOK_JOB_STARTED=${home}/.hadoku/ci-throttle.sh`,
			'RUNNER_TOOL_CACHE=/opt/hostedtoolcache',
			`ACTIONS_RUNNER_HOOK_JOB_COMPLETED=${home}/.hadoku/job-metrics.sh`,
			...extra,
			'',
		].join('\n')
	);
	return home;
}

/** A $HOME shaped like an all-JIT claw: a payload, a deployed throttle, nothing else. */
function jitOnlyHome() {
	const home = mkdtempSync(join(tmpdir(), 'warm-provision-'));
	writeRunnerTree(join(home, '.hadoku', 'jit', 'payload'));
	mkdirSync(join(home, '.hadoku', 'warm'), { recursive: true });
	// The JIT slot's env, deliberately WITHOUT the job-started hook. It is still
	// here because jit-provision.sh reads it — and because the whole point of
	// this lane is that the warm path must NOT be built from it.
	writeFileSync(join(home, '.hadoku', 'runner.env'), 'RUNNER_TOOL_CACHE=/opt/hostedtoolcache\n');
	return writeStandingEnv(home);
}

function provision(home, env = {}) {
	return execFileSync('bash', SCRIPT_ARGV, {
		encoding: 'utf8',
		env: {
			PATH: process.env.PATH,
			HOME: home,
			REG_TOKEN: 'AREGTOKEN',
			URL: 'https://github.com/WolffM/hadoku_site',
			REPO: 'WolffM/hadoku_site',
			NAME: 'warm-claw-1-hadoku_site',
			LABELS: 'self-hosted,hadoku-builder',
			RESET: '1',
			...env,
		},
	});
}

const execFileP = promisify(execFile);

/** Same as `provision`, but returns a promise instead of blocking — the only
 *  way to make two provisions genuinely overlap in one test. */
function provisionAsync(home, env = {}) {
	return execFileP('bash', SCRIPT_ARGV, {
		encoding: 'utf8',
		env: {
			PATH: process.env.PATH,
			HOME: home,
			REG_TOKEN: 'AREGTOKEN',
			URL: 'https://github.com/WolffM/hadoku_site',
			REPO: 'WolffM/hadoku_site',
			NAME: 'warm-claw-1-hadoku_site',
			LABELS: 'self-hosted,hadoku-builder',
			RESET: '1',
			...env,
		},
	}).then(
		(r) => r.stdout,
		// execFile rejects on a non-zero exit; every WARM-FAIL/WARM-READY path
		// here exits 0, so a rejection is a real crash, not a script outcome —
		// but the concurrency test wants the stdout even so it can tell the two
		// apart, so surface it rather than losing it in the rejection.
		(err) => err.stdout ?? Promise.reject(err)
	);
}

const homes = [];
function take(home) {
	homes.push(home);
	return home;
}
test.after(() => {
	for (const h of homes) rmSync(h, { recursive: true, force: true });
});

void test('a node with only a JIT payload registers — no standing install, no runner root', () => {
	const home = take(jitOnlyHome());
	// The precondition that made every fill fail in production: nothing on this
	// node carries a config.sh, anywhere.
	assert.equal(existsSync(join(home, 'actions-runner')), false);
	assert.equal(existsSync(join(home, '.hadoku', 'warm', 'root')), false);

	const out = provision(home);

	assert.match(out, /WARM-READY /, out);
	const slot = join(home, '.hadoku', 'warm', 'listener');
	assert.ok(existsSync(join(slot, '.runner')), '.runner was not written');
	assert.ok(existsSync(join(slot, '.credentials')), '.credentials was not written');
	// The marker IS the record of which repo this node is warm for (§12.8, B9).
	assert.equal(readFileSync(join(home, '.hadoku', 'warm', 'repo'), 'utf8'), 'WolffM/hadoku_site');
});

void test('the slot is HARDLINKED to the payload, not a second 670 MB copy', () => {
	const home = take(jitOnlyHome());
	provision(home);
	const payload = statSync(join(home, '.hadoku', 'jit', 'payload', 'bin', 'Runner.Listener'));
	const slot = statSync(join(home, '.hadoku', 'warm', 'listener', 'bin', 'Runner.Listener'));
	assert.equal(slot.ino, payload.ino, 'slot and payload must share one inode');
});

void test('registration passes --disableupdate — the hardlink is a data-loss hazard without it', () => {
	const home = take(jitOnlyHome());
	provision(home);
	const argv = readFileSync(join(home, 'configure-argv'), 'utf8');
	// A self-updating standing runner rewrites the payload behind every JIT
	// slot on the node, because they are all one inode (see jit-provision.sh).
	assert.match(argv, /--disableupdate/, argv);
	// And it must NOT be ephemeral: that is the entire difference between this
	// path and generate-jitconfig, which has no non-ephemeral mode at all.
	assert.doesNotMatch(argv, /--ephemeral/, argv);
	assert.match(argv, /--replace/, argv);
	assert.match(argv, /--labels self-hosted,hadoku-builder/, argv);
});

void test('no .path is written — an ssh-captured PATH would pin every warm job to it', () => {
	const home = take(jitOnlyHome());
	provision(home);
	// env.sh's `echo $PATH > .path` under a non-interactive ssh captured
	// `/usr/local/bin:/usr/bin:/bin:/usr/games` on claw-4 and handed it to every
	// job. A JIT slot has no .path and the whole fleet runs on those.
	assert.equal(existsSync(join(home, '.hadoku', 'warm', 'listener', '.path')), false);
});

const slotEnv = (home) =>
	readFileSync(join(home, '.hadoku', 'warm', 'listener', '.env'), 'utf8')
		.split('\n')
		.filter((l) => l.trim() !== '');

void test('the tool cache is written into the slot, exactly once across two provisions', () => {
	const home = take(jitOnlyHome());
	provision(home);
	provision(home);
	const hits = slotEnv(home).filter((l) => l.startsWith('RUNNER_TOOL_CACHE='));
	assert.deepEqual(hits, ['RUNNER_TOOL_CACHE=/opt/hostedtoolcache']);
});

void test('a warm listener gets BOTH hooks — it is a STANDING runner, not a JIT slot (#11)', () => {
	// The bug: this script built `.env` from `~/.hadoku/runner.env`, which is the
	// JIT SLOT's env and deliberately carries no ACTIONS_RUNNER_HOOK_JOB_STARTED.
	// A JIT slot is bounded by the dispatcher's admission check and by
	// systemd-run's MemoryMax/RuntimeMaxSec; a warm listener is bounded by
	// NOTHING but this hook. So it ran unthrottled, and the node cap that every
	// other standing runner obeys was bypassed on the warm path.
	const home = take(jitOnlyHome());
	provision(home);
	const env = slotEnv(home);
	assert.deepEqual(env, [
		`ACTIONS_RUNNER_HOOK_JOB_STARTED=${home}/.hadoku/ci-throttle.sh`,
		'RUNNER_TOOL_CACHE=/opt/hostedtoolcache',
		`ACTIONS_RUNNER_HOOK_JOB_COMPLETED=${home}/.hadoku/job-metrics.sh`,
	]);
});

void test('the env is COPIED from standing.env, never rebuilt from runner.env', () => {
	// The one-writer property, asserted rather than assumed: whatever
	// `fleet throttle` renders is what the slot gets. Here standing.env names a
	// tool cache that runner.env does not, so a script that still read
	// runner.env — or that reconstructed the keys itself — produces the wrong
	// value and fails this.
	const home = take(jitOnlyHome());
	writeStandingEnv(home);
	writeFileSync(
		join(home, '.hadoku', 'standing.env'),
		'ACTIONS_RUNNER_HOOK_JOB_STARTED=/somewhere/hook.sh\nRUNNER_TOOL_CACHE=/opt/other-cache\n'
	);
	provision(home);
	assert.deepEqual(slotEnv(home), [
		'ACTIONS_RUNNER_HOOK_JOB_STARTED=/somewhere/hook.sh',
		'RUNNER_TOOL_CACHE=/opt/other-cache',
	]);
});

void test('a key this script has never heard of is carried, and de-duped, on its own', () => {
	// The de-dupe reads its key list OUT OF standing.env rather than naming
	// keys, so the day `fleet throttle` adds a fourth this script needs no edit
	// and cannot drift into declaring a different set. Naming them here would
	// be the second writer this lane exists to kill.
	const home = take(jitOnlyHome());
	writeStandingEnv(home, ['SOME_FUTURE_KEY=v1']);
	provision(home);
	writeStandingEnv(home, ['SOME_FUTURE_KEY=v2']);
	provision(home, {
		REPO: 'WolffM/hadoku-rally',
		URL: 'https://github.com/WolffM/hadoku-rally',
		NAME: 'warm-claw-1-hadoku-rally',
	});
	const hits = slotEnv(home).filter((l) => l.startsWith('SOME_FUTURE_KEY='));
	assert.deepEqual(hits, ['SOME_FUTURE_KEY=v2'], 'the stale value must not survive');
});

void test('no standing.env: the fill FAILS rather than registering an unthrottled listener', () => {
	// "I could not look" must never render as "nothing is wrong". A node that has
	// not had `fleet throttle --confirm` run on it since this shipped has no
	// standing.env, and the previous version printed WARM-WARN and registered
	// anyway — producing a live standing runner with no cap on a node that
	// declares one, indistinguishable downstream from a healthy fill. Refusing
	// makes it a failed fill the backoff slows and `throttle --check` names.
	const home = take(jitOnlyHome());
	rmSync(join(home, '.hadoku', 'standing.env'));
	const out = provision(home);
	assert.match(out, /WARM-FAIL no .*standing\.env/, out);
	assert.match(out, /fleet throttle --confirm/, out);
	assert.doesNotMatch(out, /WARM-READY/, out);
	// Nothing registered, and no marker claiming this node is warm.
	assert.equal(existsSync(join(home, 'configure-argv')), false);
	assert.equal(existsSync(join(home, '.hadoku', 'warm', 'repo')), false);
});

void test('a truncated standing.env is a refusal too — an empty env is not an env', () => {
	const home = take(jitOnlyHome());
	writeFileSync(join(home, '.hadoku', 'standing.env'), '# only a comment\n');
	const out = provision(home);
	assert.match(out, /WARM-FAIL .*declares no KEY=value lines/, out);
	assert.equal(existsSync(join(home, 'configure-argv')), false);
});

// --- the OTHER half of the one writer --------------------------------------
//
// `standing.env` is rendered on the node by scripts/lib/standing-runner-env.sh,
// which `deploy-ci-throttle.mjs` appends after `ci-throttle-install.sh` so it
// runs in the same shell and can publish that script's OWN `$LINE`/`$TCLINE`/
// `$MLINE`. Those two facts are what make it one writer rather than two, and
// both are asserted here: the rule is EXECUTED the way the payload executes it,
// and the variable names it publishes are pinned against the node half that
// derives them.

const STANDING_RULE = join(ROOT, 'scripts', 'lib', 'standing-runner-env.sh');
const NODE_HALF_SRC = readFileSync(join(ROOT, 'scripts', 'ci-throttle-install.sh'), 'utf8');

/** Run the rule exactly as the appended payload does, and return its report. */
function runStandingRule(home, { apply = 1, vars = {} } = {}) {
	const v = {
		LINE: `ACTIONS_RUNNER_HOOK_JOB_STARTED=${home}/.hadoku/ci-throttle.sh`,
		TCLINE: 'RUNNER_TOOL_CACHE=/opt/hostedtoolcache',
		MLINE: `ACTIONS_RUNNER_HOOK_JOB_COMPLETED=${home}/.hadoku/job-metrics.sh`,
		TMPLINE: `TMPDIR=${home}/runner-tmp`,
		COMPLINE: `NODE_COMPILE_CACHE=${home}/.cache/node-compile-cache`,
		...vars,
	};
	return execFileSync('bash', [STANDING_RULE], {
		encoding: 'utf8',
		env: { PATH: process.env.PATH, HOME: home, APPLY: String(apply), ...v },
	}).trim();
}

void test('the standing-env rule publishes exactly the lines the walker writes', () => {
	const home = take(mkdtempSync(join(tmpdir(), 'standing-env-')));
	assert.equal(runStandingRule(home), 'STANDING-ENV ok');
	assert.equal(
		readFileSync(join(home, '.hadoku', 'standing.env'), 'utf8'),
		`ACTIONS_RUNNER_HOOK_JOB_STARTED=${home}/.hadoku/ci-throttle.sh\n` +
			'RUNNER_TOOL_CACHE=/opt/hostedtoolcache\n' +
			`ACTIONS_RUNNER_HOOK_JOB_COMPLETED=${home}/.hadoku/job-metrics.sh\n` +
			`TMPDIR=${home}/runner-tmp\n` +
			`NODE_COMPILE_CACHE=${home}/.cache/node-compile-cache\n`
	);
});

void test('the rule reports absent / stale / ok as three different facts, and APPLY=0 writes nothing', () => {
	const home = take(mkdtempSync(join(tmpdir(), 'standing-env-')));
	mkdirSync(join(home, '.hadoku'), { recursive: true });
	// --check runs with APPLY=0. A verifier that writes what it then reads
	// cannot fail, so this must report and never repair.
	assert.equal(runStandingRule(home, { apply: 0 }), 'STANDING-ENV absent');
	assert.equal(existsSync(join(home, '.hadoku', 'standing.env')), false);

	runStandingRule(home);
	// A node deployed by an OLDER package: the file is there and does not say
	// what this package would write. That is not the same finding as absent.
	assert.equal(
		runStandingRule(home, { apply: 0, vars: { TCLINE: 'RUNNER_TOOL_CACHE=/opt/moved' } }),
		'STANDING-ENV stale'
	);
	assert.equal(runStandingRule(home, { apply: 0 }), 'STANDING-ENV ok');
});

void test('the rule and the node half name the SAME variables — one derivation, two destinations', () => {
	// The rule can only be the second destination of one derivation for as long
	// as it publishes the very variables ci-throttle-install.sh writes into a
	// standing runner's own `.env`. A rename there and nowhere else would leave
	// this rule writing empty lines under `set -u`-clean expansion of
	// names nothing sets any more, and every warm listener silently unwired.
	// COMMENTS BLANKED FIRST. The rule's own header names all five variables in
	// prose, so a raw match scores the documentation as the behaviour — the
	// fourth time a COMMENT would have been read as evidence in this repo, and
	// caught here by mutation-testing the pin rather than by reading it. Same
	// whole-line-only stripper script-provenance.test.mjs uses, and for the same
	// reason: under-blanking can only make this demand more, never less.
	const rule = readFileSync(STANDING_RULE, 'utf8')
		.split('\n')
		.map((l) => (/^\s*#/.test(l) ? '' : l))
		.join('\n');
	const written =
		/printf '%s\\n%s\\n%s\\n%s\\n%s\\n' "\$(\w+)" "\$(\w+)" "\$(\w+)" "\$(\w+)" "\$(\w+)" >>"\$env_file"/.exec(
			NODE_HALF_SRC
		);
	assert.ok(
		written,
		'ci-throttle-install.sh no longer writes five variables into a standing runner .env ' +
			'with the printf this pin matches — the shape changed, so standing.env may now be ' +
			'rendered from something the walker does not use.'
	);
	for (const name of written.slice(1)) {
		assert.match(
			rule,
			new RegExp(`\\$${name}\\b`),
			`ci-throttle-install.sh writes $${name} into a standing runner's .env and ` +
				`standing-runner-env.sh does not publish it, so a warm listener would not get it.`
		);
	}
});

// --- the throttle actually holds on the warm path --------------------------

/** Deploy the REAL hook and a rendered conf, the way `fleet throttle` does. */
function deployThrottle(home, { maxConcurrent, maxWaitS = 1 }) {
	copyFileSync(join(ROOT, 'scripts', 'ci-throttle.sh'), join(home, '.hadoku', 'ci-throttle.sh'));
	chmodSync(join(home, '.hadoku', 'ci-throttle.sh'), 0o755);
	writeFileSync(
		join(home, '.hadoku', 'ci-throttle.conf'),
		`MAX_CONCURRENT=${maxConcurrent}\nMIN_FREE_MB=0\nMAX_WAIT_S=${maxWaitS}\n`
	);
	return home;
}

/**
 * Run whatever the warm slot's OWN `.env` names as the job-started hook.
 *
 * The path is read back out of the file this script wrote — not spelled here —
 * so the test proves the wiring, not a path the test chose. `others` is the
 * number of OTHER Runner.Worker processes on the node; the hook takes it from
 * CI_THROTTLE_TEST_OTHERS because /proc has no way to seat N fake workers.
 */
function runJobStartedHook(home, others) {
	const line = slotEnv(home).find((l) => l.startsWith('ACTIONS_RUNNER_HOOK_JOB_STARTED='));
	assert.ok(line, 'the warm slot has no ACTIONS_RUNNER_HOOK_JOB_STARTED at all');
	const hook = line.slice('ACTIONS_RUNNER_HOOK_JOB_STARTED='.length);
	try {
		const stdout = execFileSync('bash', [hook], {
			encoding: 'utf8',
			env: {
				PATH: process.env.PATH,
				HOME: home,
				CI_THROTTLE_TEST_OTHERS: String(others),
			},
		});
		return { code: 0, out: stdout };
	} catch (err) {
		return { code: err.status, out: (err.stdout ?? '') + (err.stderr ?? '') };
	}
}

void test('the N+1st job at a warm listener is REFUSED — the cap holds on the warm path', () => {
	// The done-when for §A: drive N+1 jobs at a warm listener and see the
	// refusal. N here is MAX_CONCURRENT=2, so a job arriving with 2 others
	// already resident is the third — over the line — and ADR 1751 turns the
	// hook's non-zero exit into a failed job with an annotation.
	//
	// This is the safety-guarding test for this lane, and it is end to end on
	// purpose: `standing.env` is rendered by the REAL standing-runner-env.sh,
	// warm-provision.sh builds the slot's `.env` from it, and the hook the test
	// then executes is whichever path THAT file names. So it fails if the rule
	// stops publishing the hook line, if warm-provision stops copying it, if it
	// points somewhere wrong, or if the hook ever starts admitting on a
	// confirmed breach.
	const home = take(deployThrottle(jitOnlyHome(), { maxConcurrent: 2 }));
	rmSync(join(home, '.hadoku', 'standing.env'));
	assert.equal(runStandingRule(home), 'STANDING-ENV ok');
	assert.match(provision(home), /WARM-READY /);

	const under = runJobStartedHook(home, 1);
	assert.equal(under.code, 0, `a job under the cap must start: ${under.out}`);

	const over = runJobStartedHook(home, 2);
	assert.equal(over.code, 1, `the N+1st job must be refused, got exit 0: ${over.out}`);
	assert.match(over.out, /REFUSING the job/, over.out);
	assert.match(over.out, /::error::ci-throttle: refused/, over.out);
});

void test('a second provision reuses the slot and re-registers for the new repo', () => {
	const home = take(jitOnlyHome());
	provision(home);
	const first = statSync(join(home, '.hadoku', 'warm', 'listener', 'bin', 'Runner.Listener')).ino;
	const out = provision(home, {
		REPO: 'WolffM/hadoku-rally',
		URL: 'https://github.com/WolffM/hadoku-rally',
		NAME: 'warm-claw-1-hadoku-rally',
	});
	assert.match(out, /WARM-READY /, out);
	assert.equal(readFileSync(join(home, '.hadoku', 'warm', 'repo'), 'utf8'), 'WolffM/hadoku-rally');
	assert.equal(
		statSync(join(home, '.hadoku', 'warm', 'listener', 'bin', 'Runner.Listener')).ino,
		first,
		'a rotate must not rebuild the slot'
	);
	const argv = readFileSync(join(home, 'configure-argv'), 'utf8').trim().split('\n');
	assert.equal(argv.length, 2, 'both provisions registered');
});

void test('a slot poisoned with a leftover .runner/.credentials still registers — issue #17', () => {
	// The exact starting shape #17 describes: a slot whose bin/externals are
	// already built (as every real fill leaves them) but whose identity files
	// belong to a PRIOR registration — the fake listener's own "already
	// configured" refusal (see the header note) means this test fails loudly
	// if RESET stops running, or stops running BEFORE configure, or is ever
	// made conditional on the slot needing to be rebuilt.
	const home = take(jitOnlyHome());
	provision(home); // builds the slot for real, .runner/.credentials included
	const slot = join(home, '.hadoku', 'warm', 'listener');
	assert.ok(existsSync(join(slot, '.runner')), 'setup: first provision did not leave a .runner');

	// Simulate a second repo's rotate landing on the same, already-configured
	// slot — the shape that broke on claw-3/claw-4/claw-5 starting
	// 2026-09-08T23:04:30Z.
	const out = provision(home, {
		REPO: 'WolffM/hadoku-rally',
		URL: 'https://github.com/WolffM/hadoku-rally',
		NAME: 'warm-claw-1-hadoku-rally',
	});
	assert.match(out, /WARM-READY /, out);
	assert.doesNotMatch(out, /already configured/, out);
	assert.equal(readFileSync(join(home, '.hadoku', 'warm', 'repo'), 'utf8'), 'WolffM/hadoku-rally');
});

void test("a slot poisoned with ONLY .runner_migrated still registers — issue #17's exact observed shape", () => {
	// claw-3/4/5, 2026-09-09: RESET removed .runner/.credentials/
	// .credentials_rsaparams but the deny-list never named .runner_migrated,
	// so it survived every RESET across two deployed fixes. Runner.Listener's
	// own IsConfigured() treats .runner_migrated as sufficient evidence of
	// configuration on its own — no .runner required — so this is the shape
	// that actually broke, not the leftover-.runner shape the test above
	// already covers.
	const home = take(jitOnlyHome());
	provision(home); // builds the slot for real, .runner/.credentials included
	const slot = join(home, '.hadoku', 'warm', 'listener');
	rmSync(join(slot, '.runner'));
	rmSync(join(slot, '.credentials'));
	writeFileSync(join(slot, '.runner_migrated'), '{"agentName":"fake"}');
	assert.equal(existsSync(join(slot, '.runner')), false, 'setup: .runner must be absent');
	assert.ok(existsSync(join(slot, '.runner_migrated')), 'setup: .runner_migrated must be present');

	const out = provision(home, {
		REPO: 'WolffM/hadoku-rally',
		URL: 'https://github.com/WolffM/hadoku-rally',
		NAME: 'warm-claw-1-hadoku-rally',
	});
	assert.match(out, /WARM-READY /, out);
	assert.doesNotMatch(out, /already configured/, out);
	assert.equal(readFileSync(join(home, '.hadoku', 'warm', 'repo'), 'utf8'), 'WolffM/hadoku-rally');
	assert.equal(
		existsSync(join(slot, '.runner_migrated')),
		false,
		'RESET must clear .runner_migrated, not just .runner'
	);
});

void test('RESET clears leftover state by ALLOW-list, not by naming files it knows about', () => {
	// The deny-list failed once by omission (.runner_migrated). An allow-list
	// of what belongs in a fresh slot (bin, externals, _work, .env) fails safe
	// against whatever identity file the runner invents NEXT, without this
	// script ever learning its name — the fix this handoff asked to consider
	// instead of naming a fifth, sixth, seventh file by hand.
	const home = take(jitOnlyHome());
	provision(home);
	const slot = join(home, '.hadoku', 'warm', 'listener');
	writeFileSync(join(slot, '.some_future_identity_file'), 'x');
	provision(home, {
		REPO: 'WolffM/hadoku-rally',
		URL: 'https://github.com/WolffM/hadoku-rally',
		NAME: 'warm-claw-1-hadoku-rally',
	});
	assert.equal(existsSync(join(slot, '.some_future_identity_file')), false);
});

void test('RESET keeps _work — the checkout cache the slot exists to reuse', () => {
	const home = take(jitOnlyHome());
	provision(home);
	const slot = join(home, '.hadoku', 'warm', 'listener');
	mkdirSync(join(slot, '_work'), { recursive: true });
	writeFileSync(join(slot, '_work', 'marker'), 'x');
	provision(home, {
		REPO: 'WolffM/hadoku-rally',
		URL: 'https://github.com/WolffM/hadoku-rally',
		NAME: 'warm-claw-1-hadoku-rally',
	});
	assert.ok(existsSync(join(slot, '_work', 'marker')), '_work must survive RESET');
});

void test('two provisions racing the same slot serialize instead of corrupting it', () => {
	// Not the failure this repo could reproduce from a stale root any more
	// (RESET already covers that — see the test above), but the ONE remaining
	// way two calls to Runner.Listener configure can interleave: a second
	// writer starting before the first has finished. Without the flock in
	// warm-provision.sh, B's `rm -f .runner` can land, then A's `configure`
	// can finish and WRITE `.runner`, and only THEN does B's own `configure`
	// run — B's local "already configured" check runs at process start and
	// never rechecks, so it sees A's file and refuses, exactly #17's error.
	const home = take(jitOnlyHome());
	const slow = provisionAsync(home, { FAKE_CONFIGURE_SLEEP: '0.4' });
	// Give A a moment to acquire the lock first, so this deterministically
	// exercises B waiting on it rather than a coin flip over which starts
	// first.
	const fast = new Promise((res) => setTimeout(res, 100)).then(() =>
		provisionAsync(home, {
			REPO: 'WolffM/hadoku-rally',
			URL: 'https://github.com/WolffM/hadoku-rally',
			NAME: 'warm-claw-1-hadoku-rally',
		})
	);
	return Promise.all([slow, fast]).then(([a, b]) => {
		assert.match(a, /WARM-READY /, `A: ${a}`);
		assert.match(b, /WARM-READY /, `B: ${b}`);
		assert.doesNotMatch(a, /already configured/, a);
		assert.doesNotMatch(b, /already configured/, b);
		// B ran second (it waited on the lock) and is the last writer, so the
		// marker and the identity files must reflect B's repo, not a mix of
		// both — the signature of a race that DID interleave.
		assert.equal(
			readFileSync(join(home, '.hadoku', 'warm', 'repo'), 'utf8'),
			'WolffM/hadoku-rally'
		);
		const argv = readFileSync(join(home, 'configure-argv'), 'utf8').trim().split('\n');
		assert.equal(argv.length, 2, 'both configure calls ran, serialized');
	});
});

void test('the 0.22.49 runner root is removed — nothing calls config.sh any more', () => {
	const home = take(jitOnlyHome());
	// What the previous fix seeded on claw-4: a whole second tree kept only to
	// hold a config.sh. Left in place it is hundreds of MB of hardlink names and
	// a standing invitation to believe registration still goes through it.
	writeRunnerTree(join(home, '.hadoku', 'warm', 'root'), { root: true });
	provision(home);
	assert.equal(existsSync(join(home, '.hadoku', 'warm', 'root')), false);
});

void test('a node with a standing install but no payload builds one from it', () => {
	const home = writeStandingEnv(take(mkdtempSync(join(tmpdir(), 'warm-provision-'))));
	writeRunnerTree(join(home, 'actions-runner-hadoku_site'), { root: true });
	const out = provision(home);
	assert.match(out, /WARM-READY /, out);
	assert.ok(existsSync(join(home, '.hadoku', 'jit', 'payload', 'bin', 'Runner.Listener')));
});

void test('a node with a standing install whose config.sh is broken still registers', () => {
	// The install's root scripts all `exit 9`. If registration still went
	// through config.sh this would fail, so this is the assertion that the
	// dependency is genuinely gone rather than merely unused on a payload-only
	// node.
	const home = writeStandingEnv(take(mkdtempSync(join(tmpdir(), 'warm-provision-'))));
	writeRunnerTree(join(home, 'actions-runner-hadoku_site'), { root: true });
	assert.match(provision(home), /WARM-READY /);
});

void test('a node with NOTHING and no tarball URL fails loudly, naming both sources', () => {
	const home = take(mkdtempSync(join(tmpdir(), 'warm-provision-')));
	const out = provision(home);
	assert.match(
		out,
		/WARM-FAIL no runner install to source a payload from, and no RUNNER_TARBALL_URL/
	);
	assert.doesNotMatch(out, /WARM-READY/);
});

void test('a missing input fails before any I/O, naming the input', () => {
	const home = take(jitOnlyHome());
	const out = provision(home, { REG_TOKEN: '' });
	assert.match(out, /WARM-FAIL missing REG_TOKEN/);
	assert.equal(existsSync(join(home, '.hadoku', 'warm', 'listener')), false);
});

void test("a configure that fails is WARM-FAIL, carrying the binary's own reason", () => {
	const home = take(jitOnlyHome());
	// GitHub rejecting an expired registration token is the realistic shape of
	// this: the binary exits non-zero and says why on stderr. The script must
	// surface that reason rather than claim a registration it does not have —
	// `catch {}`-style silence here makes a rate limit, an expired token and a
	// deleted repo indistinguishable (CLAUDE.md, \"say WHY\").
	writeFileSync(
		join(home, '.hadoku', 'jit', 'payload', 'bin', 'Runner.Listener'),
		'#!/usr/bin/env bash\n' +
			'[ "$1" = --version ] && { echo 2.336.0; exit 0; }\n' +
			'echo "Response status code does not indicate success: 404" >&2\nexit 1\n'
	);
	chmodSync(join(home, '.hadoku', 'jit', 'payload', 'bin', 'Runner.Listener'), 0o755);
	const out = provision(home);
	assert.match(out, /WARM-FAIL Runner\.Listener configure did not register/, out);
	assert.match(out, /warm-config Response status code does not indicate success: 404/, out);
	assert.doesNotMatch(out, /WARM-READY/);
	// And nothing may be left claiming this node is warm for that repo.
	assert.equal(existsSync(join(home, '.hadoku', 'warm', 'repo')), false);
});

void test('a payload that will not execute is refused before any registration attempt', () => {
	const home = take(jitOnlyHome());
	// A truncated payload is the shape jit-provision.sh's staging dance exists
	// to prevent; if one arrives anyway, nothing may be registered against it.
	writeFileSync(join(home, '.hadoku', 'jit', 'payload', 'bin', 'Runner.Listener'), '');
	chmodSync(join(home, '.hadoku', 'jit', 'payload', 'bin', 'Runner.Listener'), 0o755);
	const out = provision(home);
	assert.match(out, /WARM-FAIL payload will not execute/);
	assert.equal(existsSync(join(home, 'configure-argv')), false);
});

void test('a slot .env already holding the old TMPDIR=/tmp converges to exactly one TMPDIR=/NODE_COMPILE_CACHE= line after two merges (#100/#101)', () => {
	const home = take(jitOnlyHome());
	// Deploy carries the new keys (standing.env already has them, as
	// standing-runner-env.sh now writes).
	writeStandingEnv(home, [
		`TMPDIR=${home}/runner-tmp`,
		`NODE_COMPILE_CACHE=${home}/.cache/node-compile-cache`,
	]);
	provision(home); // builds the slot for real via hardlink from payload

	// Simulate a slot left over from before the fix: an explicit stale
	// TMPDIR=/tmp plus an unrelated key the merge must not touch.
	const envFile = join(home, '.hadoku', 'warm', 'listener', '.env');
	writeFileSync(envFile, 'TMPDIR=/tmp\nSOME_OTHER_KEY=v\n');

	provision(home); // merge #1 after the corruption
	provision(home); // merge #2 — must not duplicate, must still be exactly one

	const lines = readFileSync(envFile, 'utf8').trim().split('\n');
	const tmpdirLines = lines.filter((l) => l.startsWith('TMPDIR='));
	const compileLines = lines.filter((l) => l.startsWith('NODE_COMPILE_CACHE='));
	assert.equal(tmpdirLines.length, 1, lines.join('|'));
	assert.equal(compileLines.length, 1, lines.join('|'));
	assert.equal(tmpdirLines[0], `TMPDIR=${home}/runner-tmp`);
	assert.equal(lines.filter((l) => l.startsWith('SOME_OTHER_KEY=')).length, 1);
});
