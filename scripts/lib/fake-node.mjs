/**
 * A fleet node that lives in a temp directory — for tests that must run the
 * REAL node-side scripts end to end (#1).
 *
 * The registration test has to prove that a freshly minted standing runner
 * passes `throttle --check` and `slice --check` with no follow-up. Those
 * checks are shell that reads systemd, the process table and the cgroup tree,
 * so asserting on the reconciler's script TEXT would prove only that the text
 * says the right thing — the fourth way a comment has been read as evidence in
 * this repo. Here the drivers run unmodified and their node halves execute,
 * over an `ssh` that is really `bash -s` under a fixture $HOME.
 *
 * WHAT IS FAKED, AND WHY THAT IS ENOUGH:
 *   - `systemctl` is a small state machine over the same files the real one
 *     reads: unit files and drop-ins under the fixture's
 *     ~/.config/systemd/user. A unit's cgroup is decided AT START from the
 *     drop-ins present at that moment, and does not move until the next
 *     start. That is the property the 10-23 incident turned on: the drop-in
 *     came after the start, so the unit stayed in app.slice.
 *   - `pgrep` answers from that state: a started runner unit has a listener
 *     at <dir>/bin/Runner.Listener whose pid is a REAL `sleep`, so the
 *     throttle check's /proc start-time comparison reads a real kernel value.
 *   - `sudo` runs its command unprivileged, which is safe because every path
 *     the installers write as root has a seam (SYS_DIR, USER_CONF_DIR,
 *     CGROUP_ROOT) pointed into the fixture.
 *   - `systemd-run`, `loginctl`, `ps` refuse. `df` reports plenty of disk.
 *   - apt (`unattended-upgrade`, `apt-get -s`, `apt-config shell`) answers
 *     from the conf files under the APT_CONF_D seam, with one pending
 *     security update that the dry run selects only when an origin pins
 *     `label=Debian-Security` — so `fleet apt-security` is judged against the
 *     conf it wrote, through the same probe a claw runs. Unfaked, a test would
 *     run the HOST's apt.
 *
 * NOTHING REACHES THE HOST. The fakes are first on PATH for every node-side
 * command, and none of them consults the real systemd or process table. A
 * fixture $HOME alone is not isolation; it was not on 10-06 or 10-10.
 */
import { execFileSync } from 'node:child_process';
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The fakes: real shell files beside this one, so bash parses them, not JS. */
const FAKES = join(dirname(fileURLToPath(import.meta.url)), 'fake-node');

/**
 * A runner tarball: `config.sh` registers (writes `.runner` and seeds `.env`
 * the way the real one does) and `run.sh` exists to be named by the unit.
 */
function seedRunnerTarball(home, version) {
	const src = mkdtempSync(join(tmpdir(), 'fake-runner-src-'));
	writeFileSync(
		join(src, 'config.sh'),
		'#!/usr/bin/env bash\n' +
			'echo \'{"agentId":1,"agentName":"fixture"}\' > .runner\n' +
			'echo "LANG=C.UTF-8" > .env\n'
	);
	writeFileSync(join(src, 'run.sh'), '#!/usr/bin/env bash\nexec sleep 600\n');
	mkdirSync(join(src, 'bin'));
	chmodSync(join(src, 'config.sh'), 0o755);
	chmodSync(join(src, 'run.sh'), 0o755);
	const cache = join(home, '.cache', 'gh-runner');
	mkdirSync(cache, { recursive: true });
	execFileSync('tar', ['czf', join(cache, `runner-${version}.tar.gz`), '-C', src, '.']);
	rmSync(src, { recursive: true, force: true });
}

/**
 * Build one fake node. `bin` goes first on the CALLER's PATH (it carries the
 * `ssh`); `env` is what the caller's child processes need to reach the node.
 */
export function createFakeNode({ runnerVersion }) {
	const root = mkdtempSync(join(tmpdir(), 'fake-node-'));
	const home = join(root, 'home');
	const nodeBin = join(root, 'node-bin');
	const callerBin = join(root, 'caller-bin');
	const state = join(root, 'systemd-state');
	const nodeTmp = join(root, 'tmp');
	for (const d of [home, nodeBin, callerBin, state, nodeTmp, join(root, 'cgroup')]) {
		mkdirSync(d, { recursive: true });
	}
	const put = (dir, name, fake = name) => {
		copyFileSync(join(FAKES, fake), join(dir, name));
		chmodSync(join(dir, name), 0o755);
	};
	for (const name of [
		'systemctl',
		'pgrep',
		'sudo',
		'df',
		'unattended-upgrade',
		'apt-get',
		'apt-config',
	])
		put(nodeBin, name);
	for (const name of ['systemd-run', 'loginctl', 'ps', 'curl']) put(nodeBin, name, 'refuse');
	put(callerBin, 'ssh');
	seedRunnerTarball(home, runnerVersion);
	return {
		root,
		home,
		callerBin,
		env: {
			FAKE_NODE_HOME: home,
			FAKE_NODE_BIN: nodeBin,
			FAKE_NODE_ROOT: root,
			FAKE_NODE_TMP: nodeTmp,
			FAKE_STATE: state,
			FAKE_REAL_PATH: process.env.PATH ?? '',
		},
		/** Every unit start, in order: `START <unit> slice=<slice>`. */
		starts: () =>
			existsSync(join(state, 'starts.log'))
				? readFileSync(join(state, 'starts.log'), 'utf8').trim().split('\n').filter(Boolean)
				: [],
		/** Calls the fake did not model — a test should assert this is empty. */
		unhandled: () =>
			existsSync(join(state, 'calls.log'))
				? readFileSync(join(state, 'calls.log'), 'utf8')
						.split('\n')
						.filter((l) => l.startsWith('UNHANDLED'))
				: [],
		cleanup() {
			const pids = join(state, 'pids');
			if (existsSync(pids)) {
				for (const p of readFileSync(pids, 'utf8').split('\n').filter(Boolean)) {
					try {
						process.kill(Number(p));
					} catch (err) {
						// ESRCH: the unit was stopped and its listener already reaped.
						if (err?.code !== 'ESRCH') throw err;
					}
				}
			}
			rmSync(root, { recursive: true, force: true });
		},
		/** The user units the fake knows about, for diagnostics. */
		units: () =>
			existsSync(join(home, '.config', 'systemd', 'user'))
				? readdirSync(join(home, '.config', 'systemd', 'user'))
				: [],
	};
}
