// I/O shared by promote.mjs and sync.mjs (scripts/ppe/): git over HTTPS with the App push
// token mgmt-api mints, the GitHub REST API with the job's own token, and the job summary.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A read or write we could not make. Never a verdict about the code. */
export class CouldNotLook extends Error {}

/**
 * The token the promoter and the sync push with: a one-hour `hadoku-fleet-gates`
 * installation token, scoped by GitHub to this repo and to contents +
 * workflows write, minted by mgmt-api for this repo's service key. `url` is
 * that verb (hadoku_site `routes/repo-actions.ts`), named by the workflow: a
 * hostname is a fact about one deployment, not this package's.
 *
 * NOT the job's GITHUB_TOKEN, for two reasons. A push with it triggers no
 * workflow (a promotion must fire publish.yml, a revert must fire CI), and
 * GitHub refuses it across any `.github/workflows/` change, because that
 * token can never hold `workflows`. That was 13 of 556 commits to 2026-11-16.
 * It replaced the `ppe-promoter` deploy key, which vanished on 2026-11-15
 * and stalled every promotion until it was re-minted by hand.
 */
export async function fetchPushToken({ url, serviceKey, fetchImpl = fetch }) {
	let res;
	try {
		res = await fetchImpl(url, {
			method: 'POST',
			headers: { 'X-User-Key': serviceKey, 'User-Agent': 'fleet-manager-ppe' },
		});
	} catch (err) {
		throw new CouldNotLook(`push token: ${url} unreachable (${err.message})`);
	}
	const body = await res.json().catch(() => null);
	if (!res.ok || typeof body?.token !== 'string' || !body.token) {
		throw new CouldNotLook(
			`push token: HTTP ${res.status} ${body?.error ?? '(no usable token in the answer)'}`
		);
	}
	// Masked before anything can print it: git's own errors echo nothing of the
	// header, but a future log line might.
	if (process.env.GITHUB_ACTIONS === 'true') process.stdout.write(`::add-mask::${body.token}\n`);
	return body.token;
}

/**
 * Environment for every git call. Every GIT_* is dropped first: a hook or a
 * runner that exported GIT_DIR would point git at another repo. A push token
 * goes in as an `http.extraheader` config entry from the environment, never
 * in the remote URL or argv, so neither `ps` nor a git error can show it.
 */
export function gitEnv(pushToken) {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
	);
	env.GIT_TERMINAL_PROMPT = '0';
	if (pushToken) {
		const basic = Buffer.from(`x-access-token:${pushToken}`).toString('base64');
		env.GIT_CONFIG_COUNT = '1';
		env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
		env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`;
	}
	env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 'github-actions[bot]';
	env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL =
		'41898282+github-actions[bot]@users.noreply.github.com';
	return env;
}

export function makeGit(cwd, env) {
	const run = (args, opts = {}) =>
		execFileSync('git', args, {
			cwd,
			env,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			...opts,
		});
	/** git, returning stdout; a failure is CouldNotLook with git's own stderr. */
	const git = (args) => {
		try {
			return run(args);
		} catch (err) {
			throw new CouldNotLook(`git ${args[0]} failed: ${String(err.stderr || err.message).trim()}`);
		}
	};
	/** git, returning {ok, out, err} instead of throwing: for pushes and merges that may be refused. */
	git.try = (args) => {
		try {
			return { ok: true, out: run(args), err: '' };
		} catch (err) {
			return { ok: false, out: String(err.stdout ?? ''), err: String(err.stderr || err.message) };
		}
	};
	return git;
}

/**
 * A partial clone holding only `main` and `ppe` as o/main and o/ppe.
 * `tree:0` fetches commits alone, so deciding costs no trees or blobs; a
 * revert or merge pulls the ones it touches on demand from the promisor.
 */
export function openRepo({ remote, pushToken, branches }) {
	const env = gitEnv(pushToken);
	const dir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'ppe-repo-'));
	const git = makeGit(dir, env);
	git(['init', '-q']);
	git(['remote', 'add', 'origin', remote]);
	const heads = git(['ls-remote', '--heads', 'origin', ...branches.map((b) => `refs/heads/${b}`)]);
	for (const b of branches) {
		if (!heads.includes(`\trefs/heads/${b}\n`))
			throw new CouldNotLook(`the remote has no branch '${b}'`);
	}
	git(['config', 'remote.origin.promisor', 'true']);
	git(['config', 'remote.origin.partialclonefilter', 'tree:0']);
	fetchBranches(git, branches);
	return { git, dir };
}

export function fetchBranches(git, branches) {
	git([
		'fetch',
		'-q',
		'--no-tags',
		'--filter=tree:0',
		'origin',
		...branches.map((b) => `+refs/heads/${b}:refs/remotes/o/${b}`),
	]);
}

/**
 * Trees, before a revert or a merge. A tree:0 clone fetches a missing tree one
 * round trip at a time, which a large repo's checkout turns into thousands;
 * `--refetch` is needed because the commits are already here, and git would
 * otherwise tell the server it has their trees too. Blobs still arrive on
 * demand, batched by the checkout.
 */
export function hydrate(git, branches) {
	git(['config', 'remote.origin.partialclonefilter', 'blob:none']);
	git([
		'fetch',
		'-q',
		'--no-tags',
		'--refetch',
		'--filter=blob:none',
		'origin',
		...branches.map((b) => `+refs/heads/${b}:refs/remotes/o/${b}`),
	]);
}

/** A GitHub REST client with the job's token. Any non-2xx is CouldNotLook. */
export function makeApi({
	token,
	repo,
	base = process.env.GITHUB_API_URL || 'https://api.github.com',
}) {
	let calls = 0;
	async function call(method, path, body) {
		calls++;
		const url = path.startsWith('http')
			? path
			: `${base}${path.replace('{repo}', `repos/${repo}`)}`;
		let resp;
		try {
			resp = await fetch(url, {
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: 'application/vnd.github+json',
					'X-GitHub-Api-Version': '2022-11-28',
					'User-Agent': 'fleet-manager-ppe',
					...(body ? { 'Content-Type': 'application/json' } : {}),
				},
				body: body ? JSON.stringify(body) : undefined,
				signal: AbortSignal.timeout(20_000),
			});
		} catch (err) {
			throw new CouldNotLook(`${method} ${path}: ${err.message}`);
		}
		const text = await resp.text();
		if (!resp.ok) {
			let message = text.slice(0, 200);
			try {
				message = JSON.parse(text).message ?? message;
			} catch {
				// not JSON: the raw text is the reason
			}
			const left = resp.headers.get('x-ratelimit-remaining');
			throw new CouldNotLook(
				`${method} ${path}: HTTP ${resp.status} ${message}${left === '0' ? ' (rate limit spent)' : ''}`
			);
		}
		try {
			return text ? JSON.parse(text) : null;
		} catch {
			throw new CouldNotLook(`${method} ${path}: unparseable body`);
		}
	}
	return {
		get: (path) => call('GET', path),
		post: (path, body) => call('POST', path, body),
		get calls() {
			return calls;
		},
	};
}

/** Open an issue unless an open one with the same title already exists. */
export async function reportIssue(api, title, body) {
	const open = await api.get('/{repo}/issues?state=open&per_page=100');
	const dup = open.find((i) => i.title === title && !i.pull_request);
	if (dup) return { url: dup.html_url, reused: true };
	const made = await api.post('/{repo}/issues', { title, body });
	return { url: made.html_url, reused: false };
}

export function summary(markdown, env = process.env) {
	if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

export function setOutput(name, value, env = process.env) {
	if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

export const log = (msg) => process.stdout.write(`${msg}\n`);
export const fail = (msg) => process.stdout.write(`::error::${msg}\n`);
export const notice = (msg) => process.stdout.write(`::notice::${msg}\n`);
