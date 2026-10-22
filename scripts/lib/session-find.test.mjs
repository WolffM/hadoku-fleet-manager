import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { procStart, projectKey } from './session-index.mjs';
import { tempDir } from './test-tmpdir.mjs';

/**
 * Enter, for real: the picker against its own tmux server (TMUX_TMPDIR), a
 * fixture HOME and a fake `claude` on PATH. The operator's `claude` session is
 * on a different socket and is never touched.
 */
const FIND = new URL('../../herdr/hadoku-sessions/find.mjs', import.meta.url).pathname;
let hasTmux = true;
try {
	execFileSync('tmux', ['-V'], { stdio: 'ignore' });
} catch {
	hasTmux = false;
}

function world(t) {
	const home = tempDir('session-find-');
	const cwd = join(home, 'repos', 'app');
	mkdirSync(cwd, { recursive: true });
	const projects = join(home, '.claude', 'projects', projectKey(cwd));
	mkdirSync(projects, { recursive: true });
	mkdirSync(join(home, '.claude-accounts', 'alice', 'sessions'), { recursive: true });
	const bin = join(home, 'bin');
	mkdirSync(bin);
	const calls = join(home, 'claude-calls');
	writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho "$PWD $*" >> '${calls}'\nexec sleep 300\n`);
	chmodSync(join(bin, 'claude'), 0o755);
	const env = {
		HOME: home,
		PATH: `${bin}:${process.env.PATH}`,
		TMUX_TMPDIR: join(home, 'tmux'),
		XDG_STATE_HOME: join(home, 'state'),
	};
	mkdirSync(env.TMUX_TMPDIR);
	const tmux = (...a) => execFileSync('tmux', a, { env, encoding: 'utf8' }).trim();
	tmux('new-session', '-d', '-s', 'claude', '-x', '120', '-y', '40');
	// A login shell rebuilds PATH from /etc/profile and would drop the fake
	// claude, so new windows get a plain sh that keeps the server's PATH.
	tmux('set-option', '-g', 'default-command', 'exec sh');
	t.after(() => tmux('kill-server'));
	const session = (id, text) =>
		writeFileSync(
			join(projects, `${id}.jsonl`),
			`${JSON.stringify({
				type: 'user',
				message: { content: text },
				cwd,
				timestamp: new Date().toISOString(),
			})}\n`
		);
	const find = (...a) =>
		execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', FIND, ...a], {
			env,
			encoding: 'utf8',
		}).trim();
	return { home, cwd, env, tmux, session, find, calls };
}

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

test(
	'session-find: Enter on a dead session resumes it in a new claude window, in its own directory',
	{ skip: !hasTmux },
	async (t) => {
		const w = world(t);
		w.session(ID1, 'migrate the tunnel config');
		assert.match(w.find('--enter', 'tunnel'), /^resuming 1{8}-.* in claude pane %\d+$/);
		let got = '';
		for (let i = 0; i < 50 && !got; i++) {
			await new Promise((r) => setTimeout(r, 100));
			try {
				got = readFileSync(w.calls, 'utf8');
			} catch (err) {
				if (err.code !== 'ENOENT') throw err;
			}
		}
		assert.equal(got.trim(), `${w.cwd} --resume ${ID1}`);
	}
);

test(
	'session-find: Enter on a live session jumps to its pane and never resumes it again',
	{ skip: !hasTmux },
	(t) => {
		const w = world(t);
		w.session(ID2, 'herdr panes for the fleet');
		const pane = w.tmux(
			'new-window',
			'-d',
			'-P',
			'-F',
			'#{window_id}.#{pane_id}',
			'-t',
			'claude:',
			'sleep 300'
		);
		const pid = Number(w.tmux('display-message', '-p', '-t', pane.split('.')[1], '#{pane_pid}'));
		writeFileSync(
			join(w.home, '.claude-accounts', 'alice', 'sessions', `${pid}.json`),
			JSON.stringify({
				pid,
				procStart: procStart(pid),
				sessionId: ID2,
				tmux: `claude:${pane}`,
				status: 'idle',
			})
		);
		const json = JSON.parse(w.find('--json', 'herdr'));
		assert.equal(json.sessions[0].enter, `jump to claude:${pane}`);
		assert.match(
			w.find('--enter', 'herdr'),
			new RegExp(`^selected claude:${pane.replace('.', '\\.')}`)
		);
		assert.equal(w.tmux('display-message', '-p', '-t', 'claude', '#{window_id}.#{pane_id}'), pane);
		assert.throws(() => readFileSync(w.calls, 'utf8'), /ENOENT/, 'claude was never started');
	}
);

test(
	'session-find: a session filed under another directory is refused, not resumed somewhere wrong',
	{ skip: !hasTmux },
	(t) => {
		const w = world(t);
		const moved = join(w.home, '.claude', 'projects', '-somewhere-else');
		mkdirSync(moved);
		writeFileSync(
			join(moved, `${ID1}.jsonl`),
			`${JSON.stringify({ type: 'user', message: { content: 'renamed repo work' }, cwd: w.cwd, timestamp: new Date().toISOString() })}\n`
		);
		assert.match(w.find('--enter', 'renamed'), /^cannot resume: filed under -somewhere-else/);
		assert.throws(() => readFileSync(w.calls, 'utf8'), /ENOENT/);
	}
);
