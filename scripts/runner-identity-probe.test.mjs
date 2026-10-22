/**
 * runner-identity-probe.sh — a listener that is not an install is not reported
 * (#103 item 2b).
 *
 * `fleet identity` on hokon reported two UNCONFIGURED LISTENERS at
 * `/tmp/runner-drift-XXXXXX/actions-runner-x` on 2026-10-08: the fake listeners
 * `lib/runner-env-drift.test.mjs` spawns, caught by the probe's listener union
 * while CI happened to be running on the same box. The union exists to catch
 * an install whose directory the glob misses, so it must keep doing that — for
 * a path under the runner user's $HOME — and drop everything else.
 *
 * NODE-SIDE SCRIPT, FIXTURE HOME. `pgrep` and `systemctl` are stubs driven by
 * files under the fixture $HOME, so the probe never reads this machine's real
 * process table or user units; `HOME` and `TMPDIR` point inside one mkdtemp
 * root, removed after each test. Nothing here spawns git.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROBE = join(dirname(fileURLToPath(import.meta.url)), 'runner-identity-probe.sh');

/**
 * `pgrep -af` prints one line per listener in $HOME/.fake/listeners; `pgrep -f
 * ^<dir>/bin/Runner.Listener` succeeds when that dir is listed. Anything else
 * finds nothing — fail closed.
 */
const PGREP = `#!/usr/bin/env bash
list="$HOME/.fake/listeners"
[ -f "$list" ] || exit 1
case "$1" in
-af) i=100; while IFS= read -r p; do echo "$i $p/bin/Runner.Listener run"; i=$((i + 1)); done < "$list"; exit 0 ;;
-f) want="\${2#^}"; while IFS= read -r p; do [ "$p/bin/Runner.Listener" = "$want" ] && exit 0; done < "$list"; exit 1 ;;
esac
exit 1
`;

function fixture(listeners) {
	const root = mkdtempSync(join(tmpdir(), 'identity-probe-'));
	const home = join(root, 'home');
	// TMPDIR UNDER $HOME, on purpose: a claw whose /tmp is tmpfs may point it
	// there, and a fixture made with os.tmpdir() then sits inside $HOME.
	const tmp = join(home, 'tmp');
	const bin = join(root, 'bin');
	for (const d of [join(home, '.fake'), tmp, bin]) mkdirSync(d, { recursive: true });
	writeFileSync(join(bin, 'pgrep'), PGREP, { mode: 0o755 });
	writeFileSync(join(bin, 'systemctl'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
	const dirs = listeners({ root, home, tmp });
	for (const d of dirs) mkdirSync(join(d, 'bin'), { recursive: true });
	writeFileSync(join(home, '.fake', 'listeners'), dirs.join('\n') + '\n');
	return { root, home, tmp, bin, dirs };
}

function probe(fx) {
	const out = execFileSync('bash', [PROBE], {
		env: { PATH: `${fx.bin}:/usr/bin:/bin`, HOME: fx.home, TMPDIR: fx.tmp },
		encoding: 'utf8',
	});
	return out
		.split('\n')
		.filter((l) => l.startsWith('RUNNER '))
		.map((l) => l.split(' ')[1])
		.sort();
}

test('#103: a listener under $HOME that the glob misses is still reported — the union keeps its job', () => {
	const fx = fixture(({ home }) => [join(home, 'odd-place', 'runner')]);
	try {
		assert.deepEqual(probe(fx), [join(fx.home, 'odd-place', 'runner')]);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});

test('#103: a listener outside $HOME, or in a temp dir, is NOT an install and is not reported', () => {
	const fx = fixture(({ root, home, tmp }) => [
		join(home, 'odd-place', 'runner'),
		// The 2026-10-08 shape: a test's fake listener outside the runner's home.
		join(root, 'runner-drift-abc', 'actions-runner-x'),
		// The same fixture where TMPDIR sits under $HOME.
		join(tmp, 'runner-drift-def', 'actions-runner-x'),
	]);
	try {
		assert.deepEqual(probe(fx), [join(fx.home, 'odd-place', 'runner')]);
	} finally {
		rmSync(fx.root, { recursive: true, force: true });
	}
});
