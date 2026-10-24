/**
 * fleet-source — another repo's SHIPPED files, read without anybody's checkout.
 *
 * A PUBLISHED SUBPATH EXPORT (`@wolffm/fleet-manager/fleet-source`), and the one
 * definition of "the fleet's shipped code" for BOTH repos: hadoku_site's
 * `scripts/admin/lib/fleet-checkouts.mjs` adapts this rather than keeping its own
 * (fleet-manager#7, hadoku_site#483). fleet-manager cannot import hadoku_site, so
 * this package is the only place one copy can live.
 *
 * WHY. The cross-repo gates used to read sibling clones under `REPOS_DIR`, which
 * meant they audited whatever a disk happened to hold. On 2026-10-24
 * `check:label-floor` read `~/repos/secretProject` — CRLF phantom-dirty and 1627
 * commits behind — and reported a parse failure in a file that was fine on
 * GitHub. Several other gates read `origin/main` of the clone instead, which is
 * better and still not enough: that ref is only as fresh as the last fetch
 * somebody ELSE ran, a failed fetch fell back to "auditing the last known
 * origin/main", and on a cron host with no `~/repos` there is no clone at all.
 *
 * THE CONTRACT.
 *   - The ref is the remote's `HEAD` — its default branch — fetched into
 *     `refs/fleet/shipped`. Never a working tree, never `REPOS_DIR`.
 *   - The source is a blobless bare mirror per repo under `FLEET_SOURCE_CACHE`,
 *     and THIS MODULE FETCHES IT. A fetch it made itself within
 *     `FLEET_SOURCE_MAX_AGE_S` is reused, so one audit pass costs one fetch per
 *     repo rather than one per gate; nothing else's fetch is ever trusted.
 *   - Blobs come down in ONE batch per read set and stay in the mirror, so an
 *     unchanged file is never fetched twice. Git protocol, not REST: none of it
 *     spends the 5000/hr API budget runner-health lives on.
 *   - Unreadable is a finding. `READ_ATTEMPTS` tries, then `UnreadableRepo` with
 *     the reason. A failed fetch over an old mirror is UNREADABLE, not "last
 *     known": a stale read is the bug this module exists to remove.
 *   - Every text read has CRLF and lone CR normalised to LF (fleet-manager#5),
 *     here, so no gate can forget to.
 *
 * Every git child has its `GIT_*` environment stripped: run from a hook,
 * `GIT_DIR` would point it at the hook's repository (lib/hook-safe-tests.test.mjs).
 */
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { READ_ATTEMPTS } from './queue-health.mjs';
import { normalizeEol } from './yaml-comments.mjs';

/** Where the shipped commit lands in each mirror. */
export const SHIPPED_REF = 'refs/fleet/shipped';

const DEFAULT_URL = 'https://github.com/{repo}.git';
const DEFAULT_MAX_AGE_S = 300;
const FETCH_TIMEOUT_MS = 180_000;
/** The mirror's own record of its last successful fetch. */
const STAMP = 'fleet-source-fetched';

/** A repo whose shipped files could not be read, and why. */
export class UnreadableRepo extends Error {
	/** @param {string} repo @param {string} reason */
	constructor(repo, reason) {
		super(`${repo}: shipped files unreadable — ${reason}`);
		this.name = 'UnreadableRepo';
		this.repo = repo;
		this.reason = reason;
	}
}

/** The mirror cache root. */
export function cacheDir() {
	return process.env.FLEET_SOURCE_CACHE || join(homedir(), '.cache', 'hadoku', 'fleet-source');
}

/** @param {string} repo `owner/name` */
function remoteUrl(repo) {
	const [owner, name] = repo.split('/');
	return (process.env.FLEET_SOURCE_URL || DEFAULT_URL)
		.replaceAll('{repo}', repo)
		.replaceAll('{owner}', owner)
		.replaceAll('{name}', name);
}

function maxAgeMs() {
	const raw = process.env.FLEET_SOURCE_MAX_AGE_S;
	const n = raw === undefined || raw === '' ? DEFAULT_MAX_AGE_S : Number(raw);
	return Number.isFinite(n) && n >= 0 ? n * 1000 : DEFAULT_MAX_AGE_S * 1000;
}

const GIT_ENV = Object.freeze({
	...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
	GIT_TERMINAL_PROMPT: '0',
});

/** First line of a child's failure — the part that says which job it is. */
function reasonOf(err) {
	const text = String(err?.stderr || err?.message || err).trim();
	const lines = text
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);
	return (lines.find((l) => /^(fatal|error):/.test(l)) ?? lines[0] ?? 'unknown failure').slice(
		0,
		240
	);
}

/**
 * @param {string} dir
 * @param {string[]} args
 * @param {{ input?: string | Buffer, buffer?: boolean, network?: boolean }} [opts]
 */
function git(dir, args, opts = {}) {
	const pre = ['-C', dir];
	// The gh credential helper, for an https remote only: the same token the
	// gates' own `gh api` calls already hold, so a new cron host needs no second
	// credential. Cleared first so a host-wide helper cannot answer instead.
	if (opts.network && /^https:/.test(remoteUrl('x/y'))) {
		pre.push('-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential');
	}
	const out = execFileSync('git', [...pre, ...args], {
		env: opts.network ? GIT_ENV : { ...GIT_ENV, GIT_NO_LAZY_FETCH: '1' },
		input: opts.input,
		...(opts.buffer ? {} : { encoding: 'utf8' }),
		stdio: ['pipe', 'pipe', 'pipe'],
		maxBuffer: 1024 * 1024 * 1024,
		timeout: opts.network ? FETCH_TIMEOUT_MS : 60_000,
	});
	return out;
}

/** @param {() => unknown} fn @returns {string | null} the last reason, or null on success */
function attempt(fn) {
	let last = null;
	for (let i = 0; i < READ_ATTEMPTS; i++) {
		try {
			fn();
			return null;
		} catch (err) {
			last = reasonOf(err);
		}
	}
	return last;
}

/** The mirror for `repo`, created if absent. */
function ensureMirror(repo) {
	const dir = join(cacheDir(), ...repo.split('/')) + '.git';
	if (!existsSync(join(dir, 'HEAD'))) {
		// Built aside and renamed in, so a second process never sees half a repo.
		const tmp = `${dir}.tmp-${process.pid}`;
		rmSync(tmp, { recursive: true, force: true });
		mkdirSync(dirname(dir), { recursive: true });
		execFileSync('git', ['init', '-q', '--bare', tmp], { env: GIT_ENV, stdio: 'pipe' });
		git(tmp, ['config', 'remote.origin.promisor', 'true']);
		git(tmp, ['config', 'remote.origin.partialclonefilter', 'blob:none']);
		git(tmp, ['config', 'extensions.partialclone', 'origin']);
		try {
			renameSync(tmp, dir);
		} catch {
			rmSync(tmp, { recursive: true, force: true }); // another process won the race
		}
	}
	// Set every time, so a changed FLEET_SOURCE_URL takes effect on the next read.
	git(dir, ['config', 'remote.origin.url', remoteUrl(repo)]);
	return dir;
}

function stampAgeMs(dir) {
	try {
		return Date.now() - statSync(join(dir, STAMP)).mtimeMs;
	} catch {
		return Infinity;
	}
}

/** Fetch the default branch unless this module already did, recently. */
function refresh(repo, dir, { fetch }) {
	const hasRef = () => {
		try {
			git(dir, ['rev-parse', '--verify', '--quiet', `${SHIPPED_REF}^{commit}`]);
			return true;
		} catch {
			return false;
		}
	};
	if (!fetch) {
		if (!hasRef())
			throw new UnreadableRepo(repo, 'no fetch was allowed and the mirror holds no shipped ref');
		return;
	}
	if (stampAgeMs(dir) < maxAgeMs() && hasRef()) return;
	const started = Date.now();
	const failure = attempt(() =>
		git(
			dir,
			['fetch', '--quiet', '--no-tags', '--filter=blob:none', 'origin', `+HEAD:${SHIPPED_REF}`],
			{ network: true }
		)
	);
	if (failure) {
		// Two gates fetching one mirror at once: the loser fails on the ref lock
		// while the winner's fetch is exactly as good. Accepted only if that fetch
		// STARTED after ours did — never an older one.
		if (stampAgeMs(dir) <= Date.now() - started && hasRef()) return;
		throw new UnreadableRepo(repo, `fetch from ${remoteUrl(repo)} failed: ${failure}`);
	}
	writeFileSync(join(dir, STAMP), new Date().toISOString() + '\n');
}

/**
 * The tree at the shipped commit: path -> { oid, mode }. Blobs only — a
 * submodule (`commit`) is another repo, not a file of this one.
 */
function readTree(dir, sha) {
	const out = git(dir, ['ls-tree', '-r', '-z', '--full-tree', sha]);
	const tree = new Map();
	for (const rec of out.split('\0')) {
		if (!rec) continue;
		const tab = rec.indexOf('\t');
		const [mode, type, oid] = rec.slice(0, tab).split(' ');
		if (type === 'blob') tree.set(rec.slice(tab + 1), { oid, mode });
	}
	return tree;
}

/** Which of `oids` the mirror does not hold yet. */
function missingOids(dir, oids) {
	if (!oids.length) return [];
	const out = git(dir, ['cat-file', '--batch-check=%(objectname)'], {
		input: oids.join('\n') + '\n',
	});
	return out
		.split('\n')
		.filter((l) => l.endsWith(' missing'))
		.map((l) => l.split(' ')[0]);
}

/** Raw blob bytes for `oids`, from one `cat-file --batch`. */
function catBlobs(dir, oids) {
	const buf = /** @type {Buffer} */ (
		git(dir, ['cat-file', '--batch'], { input: oids.join('\n') + '\n', buffer: true })
	);
	const blobs = new Map();
	let at = 0;
	while (at < buf.length) {
		const nl = buf.indexOf(0x0a, at);
		const [oid, type, size] = buf.subarray(at, nl).toString('utf8').split(' ');
		if (type === 'missing') throw new Error(`object ${oid} missing after fetch`);
		const len = Number(size);
		blobs.set(oid, buf.subarray(nl + 1, nl + 1 + len));
		at = nl + 1 + len + 1;
	}
	return blobs;
}

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

/** One handle per repo per process: a gate asking twice pays once. */
const handles = new Map();

/**
 * The shipped state of `repo` (`owner/name`). Throws `UnreadableRepo` when it
 * cannot be read; callers turn that into a finding carrying `.reason`.
 *
 * `fetch: false` reads the mirror as it stands — an operator's offline re-run,
 * opted into by flag, never a default.
 *
 * @param {string} repo
 * @param {{ fetch?: boolean }} [opts]
 */
export function shipped(repo, { fetch = true } = {}) {
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new UnreadableRepo(repo, 'not an owner/name slug');
	const key = `${cacheDir()}\0${repo}\0${fetch}`;
	if (handles.has(key)) return handles.get(key);

	let dir;
	let sha;
	let tree;
	try {
		dir = ensureMirror(repo);
		refresh(repo, dir, { fetch });
		sha = git(dir, ['rev-parse', `${SHIPPED_REF}^{commit}`]).trim();
		tree = readTree(dir, sha);
	} catch (err) {
		if (err instanceof UnreadableRepo) throw err;
		throw new UnreadableRepo(repo, reasonOf(err));
	}

	/** path -> normalised text, for paths read so far. */
	const texts = new Map();
	/** oid -> raw bytes. */
	const bytes = new Map();

	/** Bring every blob behind `paths` into `bytes`, with ONE fetch for the missing. */
	function load(paths) {
		const oids = [...new Set(paths.map((p) => tree.get(p)?.oid).filter((o) => o && !bytes.has(o)))];
		if (!oids.length) return;
		// ONE fetch for every missing blob, oids on stdin: a whole-repo read of
		// thousands of files is one round trip and never overruns argv.
		const missing = missingOids(dir, oids);
		if (missing.length) {
			const failure = attempt(() =>
				git(dir, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--stdin', 'origin'], {
					network: true,
					input: missing.join('\n') + '\n',
				})
			);
			if (failure) throw new UnreadableRepo(repo, `blob fetch failed: ${failure}`);
		}
		try {
			for (const [oid, buf] of catBlobs(dir, oids)) bytes.set(oid, buf);
		} catch (err) {
			throw new UnreadableRepo(repo, reasonOf(err));
		}
	}

	const handle = {
		repo,
		/** The shipped commit. */
		sha,
		/** Is `path` a file at the shipped commit? */
		has: (path) => tree.has(path),
		/**
		 * Files at or under `prefix` (a directory, or a file path), sorted.
		 * `''` lists the whole tree.
		 */
		list(prefix = '') {
			const p = prefix.replace(/\/+$/, '');
			return [...tree.keys()].filter((f) => !p || f === p || f.startsWith(p + '/')).sort();
		},
		/** Normalised text of each path; `null` for a path not in the tree. */
		readMany(paths) {
			load(paths);
			const out = new Map();
			for (const p of paths) {
				if (!texts.has(p)) {
					const entry = tree.get(p);
					texts.set(p, entry ? normalizeEol(bytes.get(entry.oid).toString('utf8')) : null);
				}
				out.set(p, texts.get(p));
			}
			return out;
		},
		/** Normalised text of one path, or `null` when it is not in the tree. */
		read(path) {
			return handle.readMany([path]).get(path);
		},
		/**
		 * The workflow files GitHub runs: `.github/workflows/*.yml|yaml`, direct
		 * children only, as `{ file, text }` sorted by name.
		 */
		workflows() {
			const files = handle
				.list('.github/workflows')
				.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f));
			const texts = handle.readMany(files);
			return files.map((f) => ({ file: f.slice('.github/workflows/'.length), text: texts.get(f) }));
		},
		/** Whether the repo ships a `.github/workflows` directory at all. */
		hasWorkflowsDir: () => handle.list('.github/workflows').length > 0,
		/**
		 * Unix seconds of the newest commit at or before `sha` touching `path`, or
		 * null when none does. History is in the mirror; no blob is needed.
		 */
		lastCommitSec(path) {
			const out = git(dir, ['log', '-1', '--format=%ct', sha, '--', path]).trim();
			return /^\d+$/.test(out) ? Number(out) : null;
		},
		/**
		 * A clean copy of the shipped tree on disk, for a scanner whose logic is
		 * shaped around the filesystem. Text files are written normalised; binary
		 * files as they are. `include` narrows which paths are written (and so
		 * which blobs are fetched). Rewritten on every call: it is a view of the
		 * mirror, not a checkout anybody edits.
		 *
		 * @param {{ include?: (path: string) => boolean }} [opts]
		 */
		materialize({ include = () => true } = {}) {
			const root = join(cacheDir(), 'trees', ...repo.split('/'));
			const paths = [...tree.entries()]
				.filter(([p, e]) => e.mode !== '120000' && include(p))
				.map(([p]) => p);
			load(paths);
			const tmp = `${root}.tmp-${process.pid}`;
			rmSync(tmp, { recursive: true, force: true });
			mkdirSync(tmp, { recursive: true });
			for (const p of paths) {
				const buf = bytes.get(tree.get(p).oid);
				const abs = join(tmp, p);
				mkdirSync(dirname(abs), { recursive: true });
				writeFileSync(abs, isBinary(buf) ? buf : normalizeEol(buf.toString('utf8')));
			}
			rmSync(root, { recursive: true, force: true });
			renameSync(tmp, root);
			return root;
		},
	};
	handles.set(key, handle);
	return handle;
}

/**
 * `shipped(repo)`, or `{ unreadable: reason }` — the shape most gates want,
 * since an unreadable repo is a finding they report and move past.
 *
 * @param {string} repo
 * @param {{ fetch?: boolean }} [opts]
 * @returns {ReturnType<typeof shipped> | { unreadable: string }}
 */
export function tryShipped(repo, opts) {
	try {
		return shipped(repo, opts);
	} catch (err) {
		if (err instanceof UnreadableRepo) return { unreadable: err.reason };
		throw err;
	}
}

/**
 * Every repo in `repos`, split into the readable and the unreadable. The
 * unreadable list is what a gate reports; it is never dropped.
 *
 * @param {string[]} repos
 * @param {{ fetch?: boolean }} [opts]
 */
export function shippedMany(repos, opts) {
	const out = { repos: new Map(), unreadable: [] };
	for (const repo of repos) {
		const h = tryShipped(repo, opts);
		if ('unreadable' in h) out.unreadable.push({ repo, reason: h.unreadable });
		else out.repos.set(repo, h);
	}
	return out;
}

/** Test seam: forget per-process handles (a fixture remote moved). */
export function forgetHandles() {
	handles.clear();
}

/** The mirrors present in the cache, as `owner/name`. Diagnostic only. */
export function cachedRepos() {
	const root = cacheDir();
	if (!existsSync(root)) return [];
	const out = [];
	for (const owner of readdirSync(root)) {
		if (owner === 'trees') continue;
		for (const m of readdirSync(join(root, owner))) {
			if (m.endsWith('.git')) out.push(`${owner}/${m.slice(0, -4)}`);
		}
	}
	return out.sort();
}
