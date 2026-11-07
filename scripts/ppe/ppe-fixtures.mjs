// Test fixtures for promote.test.mjs and sync.test.mjs: a real bare remote
// (file://, with partial clone allowed, as GitHub allows it) and a stand-in
// GitHub API that serves check runs from a table and records issues.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every GIT_* dropped: run from inside a hook, an inherited GIT_DIR would
// point these commands at the repository the hook was invoked for.
const env = {
	...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
	GIT_AUTHOR_NAME: 'fixture',
	GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
	GIT_COMMITTER_NAME: 'fixture',
	GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
	GIT_CONFIG_NOSYSTEM: '1',
	HOME: mkdtempSync(join(tmpdir(), 'ppe-home-')),
};

export const git = (cwd, ...args) =>
	execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

/** A bare origin and a work clone with one commit on main and ppe. */
export function makeRepo() {
	const root = mkdtempSync(join(tmpdir(), 'ppe-fixture-'));
	const bare = join(root, 'origin.git');
	const work = join(root, 'work');
	git(root, 'init', '-q', '--bare', '-b', 'main', bare);
	git(bare, 'config', 'uploadpack.allowFilter', 'true');
	git(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
	git(root, 'init', '-q', '-b', 'main', work);
	git(work, 'remote', 'add', 'origin', bare);
	writeFileSync(join(work, 'a.txt'), 'base\n');
	git(work, 'add', '.');
	git(work, 'commit', '-q', '-m', 'base');
	git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main', 'HEAD:refs/heads/ppe');
	return { root, bare, work, url: `file://${bare}` };
}

/** Commit a file change on the work clone's HEAD; returns the sha. */
export function commit(work, file, content, message) {
	writeFileSync(join(work, file), content);
	git(work, 'add', '.');
	git(work, 'commit', '-q', '-m', message);
	return git(work, 'rev-parse', 'HEAD');
}

export const remoteSha = (bare, branch) => git(bare, 'rev-parse', `refs/heads/${branch}`);
export const readFile = (bare, rev, path) => git(bare, 'show', `${rev}:${path}`);

/**
 * A stand-in for api.github.com. `state.checks[sha]` is a conclusion
 * ('success'|'failure'|'cancelled'|'in_progress'); `state.fail` makes every
 * path matching it answer 500. Each check is an Actions job unless
 * `state.notActions` is set: `state.attempts[sha]` is its run attempt (default
 * 1), and `state.history[sha]` lists every attempt's conclusion, oldest first.
 * A re-run request is recorded in `state.reruns`, a ledger comment in
 * `state.comments`.
 */
export async function fakeApi(state) {
	state.issues ??= [];
	state.calls = [];
	state.required ??= ['check'];
	state.attempts ??= {};
	state.history ??= {};
	state.reruns = [];
	state.comments ??= [];
	const shas = Object.keys(state.checks ?? {});
	const jobId = (sha) => 1000 + shas.indexOf(sha);
	const shaOfRun = (runId) => shas[Number(runId) - 5000];
	const server = createServer((req, res) => {
		let body = '';
		req.on('data', (d) => (body += d));
		req.on('end', () => {
			const url = new URL(req.url, 'http://x');
			const path = url.pathname;
			state.calls.push(`${req.method} ${path}`);
			const send = (code, obj) => {
				res.writeHead(code, { 'content-type': 'application/json' });
				res.end(JSON.stringify(obj));
			};
			if (state.fail && state.fail.test(path)) return send(500, { message: 'fixture outage' });
			let m;
			if ((m = path.match(/\/rules\/branches\/(.+)$/)))
				return send(
					200,
					state.ruleset === false
						? []
						: [
								{
									type: 'required_status_checks',
									parameters: {
										required_status_checks: state.required.map((context) => ({ context })),
									},
								},
							]
				);
			if (path.match(/\/branches\/[^/]+$/))
				return send(200, { name: 'main', protection: { enabled: false } });
			if ((m = path.match(/\/commits\/([0-9a-f]+)\/check-runs$/))) {
				const c = state.checks[m[1]];
				const runs = !c
					? []
					: [
							c === 'in_progress'
								? { id: jobId(m[1]), name: 'check', status: 'in_progress', conclusion: null }
								: { id: jobId(m[1]), name: 'check', status: 'completed', conclusion: c },
						];
				return send(200, { total_count: runs.length, check_runs: runs });
			}
			if ((m = path.match(/\/actions\/jobs\/(\d+)$/))) {
				const sha = shas[Number(m[1]) - 1000];
				if (state.notActions || !sha) return send(404, { message: 'Not Found' });
				return send(200, {
					run_id: 5000 + shas.indexOf(sha),
					run_attempt: state.attempts[sha] ?? 1,
					runner_name: `jit-claw-${state.attempts[sha] ?? 1}-fixture`,
				});
			}
			if ((m = path.match(/\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/))) {
				const sha = shaOfRun(m[1]);
				const conclusion = (state.history[sha] ?? [])[Number(m[2]) - 1] ?? null;
				return send(200, {
					jobs: [{ name: 'check', runner_name: `jit-claw-${m[2]}-fixture`, conclusion }],
				});
			}
			if ((m = path.match(/\/actions\/runs\/(\d+)\/rerun-failed-jobs$/)) && req.method === 'POST') {
				state.reruns.push(shaOfRun(m[1]));
				return send(201, {});
			}
			if ((m = path.match(/\/issues\/(\d+)\/comments$/))) {
				if (req.method === 'POST') {
					state.comments.push({ issue: Number(m[1]), ...JSON.parse(body) });
					return send(201, {});
				}
				return send(
					200,
					state.comments.filter((c) => c.issue === Number(m[1]))
				);
			}
			if (path.match(/\/commits\/[0-9a-f]+\/status$/))
				return send(200, { state: 'pending', statuses: [] });
			if (path.endsWith('/activity')) {
				const ref = url.searchParams.get('ref');
				const ms = state.activity?.[ref];
				return send(200, ms === undefined ? [] : [{ timestamp: new Date(ms).toISOString() }]);
			}
			if (path.endsWith('/issues') && req.method === 'GET') return send(200, state.issues);
			if (path.endsWith('/issues') && req.method === 'POST') {
				const issue = { ...JSON.parse(body), html_url: `https://issue/${state.issues.length + 1}` };
				state.issues.push(issue);
				return send(201, issue);
			}
			send(404, { message: `fixture has no ${path}` });
		});
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const { port } = server.address();
	return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

/** Env for main(), with output files the test can read back. */
export function actionEnv(repo, base, extra = {}) {
	const out = join(repo.root, `out-${Math.random().toString(36).slice(2)}`);
	writeFileSync(out, '');
	return {
		env: {
			GITHUB_REPOSITORY: 'o/r',
			GITHUB_TOKEN: 'fixture-token',
			GITHUB_API_URL: base,
			PPE_REMOTE: repo.url,
			GITHUB_OUTPUT: out,
			...extra,
		},
		outputs: () =>
			Object.fromEntries(
				readFileSync(out, 'utf8')
					.split('\n')
					.filter(Boolean)
					.map((l) => l.split(/=(.*)/s).slice(0, 2))
			),
	};
}
