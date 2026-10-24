/**
 * G7 + the self-exclusion, over a throwaway site root.
 *
 * The gate is a CLI, so it is exercised as one: build a minimal hadoku_site
 * shape in a temp dir, point HADOKU_SITE_ROOT at it, and read the exit code.
 * Anything less would be asserting on the regexes rather than on the gate.
 *
 * Every case here is a MUTATION that must fail. A gate that cannot fail reads
 * as coverage, which is the defect the SELF fix below actually was: it compared
 * a repo-relative path against the string 'fleet identity-model' — the command
 * name — so the exclusion never fired for the life of the file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanGitEnv } from './lib/test-git-identity.mjs';
import { fixtureRemotes, poisonedClone } from './lib/fleet-source-fixture.mjs';

/**
 * Run `fn(repos, remotes)` with the gate's reader pointed at fresh fixture
 * remotes (lib/fleet-source-fixture.mjs) and `repos` an EMPTY REPOS_DIR: a
 * sibling is its SHIPPED tree, never a checkout (fleet-manager#7). `run()`
 * spreads process.env, so the FLEET_SOURCE_* variables reach the gate.
 */
function withRemotes(fn) {
	const remotes = fixtureRemotes('idm-remotes-');
	const repos = join(remotes.root, 'repos');
	mkdirSync(repos, { recursive: true });
	const saved = {};
	for (const [k, v] of Object.entries(remotes.env)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	try {
		return fn(repos, remotes);
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		remotes.cleanup();
	}
}

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'check-identity-model.mjs');

/** Any real .git directory, to stand in for the one a hook would export. */
const REPO_GIT_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), '.git');

const RESOLVER = `
import { resolveGrantee, isIdentityError } from '@wolffm/worker-utils/identity';
export async function handler(c) {
	const out = await resolveGrantee(c.env, { name: c.req.query('name') });
	return isIdentityError(out) ? null : out.userId;
}
`;

const VIA_EDGE = `
import { resolveGranteeVia, isIdentityError } from '@wolffm/worker-utils/identity';
export async function handler(c) {
	const out = await resolveGranteeVia(c.env.EDGE, { serviceKey: c.env.K, name: 'x' });
	return isIdentityError(out) ? null : out.userId;
}
`;

const KV_BINDING = '[[kv_namespaces]]\nbinding = "SESSIONS_KV"\nid = "abc"\n';
const EDGE_BINDING = '[[services]]\nbinding = "EDGE"\nservice = "edge-router"\n';

/** A site root holding one worker: its source, and its wrangler.toml. */
function siteWith(source, toml) {
	const root = mkdtempSync(join(tmpdir(), 'idmodel-'));
	mkdirSync(join(root, 'scripts', 'admin'), { recursive: true });
	writeFileSync(join(root, 'scripts', 'admin', 'identity-model-allowlist.json'), '{"allowed":[]}');
	mkdirSync(join(root, 'workers', 'demo-api', 'src'), { recursive: true });
	writeFileSync(join(root, 'workers', 'demo-api', 'src', 'routes.ts'), source);
	writeFileSync(join(root, 'workers', 'demo-api', 'wrangler.toml'), `name = "demo-api"\n${toml}`);
	return root;
}

/**
 * Run git against a throwaway repo, with every inherited GIT_* variable cleared.
 *
 * `-C <dir>` DOES NOT OVERRIDE `GIT_DIR`. Git hooks export GIT_DIR (and often
 * GIT_INDEX_FILE), so a `git add` in a test that inherits the parent env runs
 * against THE REAL REPOSITORY no matter what `-C` says — and since its cwd holds
 * none of the repo's files, it stages a deletion of every one of them.
 *
 * That is not hypothetical: the first cut of the ignored-artifact test below
 * staged 306 deletions in this repo the moment it ran under the pre-push hook.
 * `pnpm run check` passed standalone (no GIT_DIR in the env) and failed from the
 * hook, which reads as a flaky suite rather than as a test corrupting the index.
 */
function gitIn(dir, args) {
	// `cleanGitEnv()` is the fleet's one answer here: every GIT_* variable removed
	// (so an inherited GIT_DIR cannot redirect this at the real repo) AND the
	// fixture identity supplied through GIT_AUTHOR_*/GIT_COMMITTER_*. Never
	// `git config user.email` — that is a WRITE to a config file whose location
	// `cwd` does not decide, and it is how 59 commits on main came to be authored
	// by a fixture. `hook-safe-tests` fails the build on it.
	execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore', env: cleanGitEnv(), cwd: dir });
}

/**
 * A minimal site root holding nothing but the manifest dir the gate boots
 * against. `siteWith` also plants a demo worker; these cases are about WHERE the
 * walk looks, so they need an empty repo to put one file into.
 */
function bareSite() {
	const root = mkdtempSync(join(tmpdir(), 'idm-reach-'));
	mkdirSync(join(root, 'scripts', 'admin'), { recursive: true });
	writeFileSync(join(root, 'scripts', 'admin', 'identity-model-allowlist.json'), '{"allowed":[]}');
	return root;
}

/** `bareSite` + cleanup, mirroring `withSite`. */
function withBareSite(fn) {
	const root = bareSite();
	try {
		fn(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** Exit code + output of one gate run against `root`. */
function run(root, { REPOS_DIR, extra = [] } = {}) {
	try {
		// BOTH streams, on BOTH paths. Warnings that do not fail the run — a stale
		// checkout, a missing sibling — go to stderr, so capturing stdout only on
		// success made them invisible to any test asserting on an exit-0 run, which
		// is exactly the class of output most in need of one.
		const res = spawnSync('node', [GATE, ...extra], {
			env: { ...process.env, HADOKU_SITE_ROOT: root, ...(REPOS_DIR ? { REPOS_DIR } : {}) },
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		if (res.error) throw res.error;
		return { code: res.status ?? 0, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
	} catch (err) {
		return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
	}
}

function withSite(source, toml, fn) {
	const root = siteWith(source, toml);
	try {
		fn(run(root));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test('G7 fails a resolver whose worker binds neither registry nor edge', () => {
	withSite(RESOLVER, '', (r) => {
		assert.equal(r.code, 1);
		assert.match(r.out, /G7/);
		assert.match(r.out, /binds neither SESSIONS_KV nor edge-router/);
	});
});

test('G7 accepts a SESSIONS_KV binding', () => {
	withSite(RESOLVER, KV_BINDING, (r) => assert.equal(r.code, 0, r.out));
});

test('G7 accepts an edge service binding for the direct resolver too', () => {
	// Both genuinely resolve. The gate does not pretend they are equivalent —
	// the KV grant is far broader — but it must not push a consumer toward the
	// broader one to get green.
	withSite(RESOLVER, EDGE_BINDING, (r) => assert.equal(r.code, 0, r.out));
});

test('a COMMENTED-OUT binding does not count', () => {
	// wrangler.toml files here carry commented-out example bindings verbatim, so
	// this is the realistic mutation, not a contrived one. It also pins that the
	// TOML stripper is used and not `blankComments`, which eats the document.
	withSite(RESOLVER, `# ${KV_BINDING.replaceAll('\n', '\n# ')}`, (r) => {
		assert.equal(r.code, 1);
		assert.match(r.out, /G7/);
	});
});

test('resolveGranteeVia needs the edge binding, and KV does not satisfy it', () => {
	withSite(VIA_EDGE, KV_BINDING, (r) => {
		assert.equal(r.code, 1);
		assert.match(r.out, /no \[\[services\]\] binding to edge-router/);
	});
	withSite(VIA_EDGE, EDGE_BINDING, (r) => assert.equal(r.code, 0, r.out));
});

test('G3 sees an owner read off the body through OPTIONAL chaining', () => {
	// The dot and the `?.` are the same read of the same untrusted field. The
	// pattern used to anchor on a literal dot, so `body?.userId` was exempt
	// while `body.userId` two lines away was reported — an escape hatch nobody
	// chose, in the one rule that would have caught both identity incidents.
	const SRC = `
export async function handler(c) {
	const body = c.req.valid('json');
	return body?.userId;
}
`;
	withSite(SRC, KV_BINDING, ({ code, out }) => {
		assert.equal(code, 1, `expected a G3 finding, got:\n${out}`);
		assert.match(out, /G3/);
		assert.match(out, /userId/);
	});
});

test('the gate does not report ITSELF when scanned as a sibling repo', () => {
	// THE REGRESSION PATH, and the only one that reproduces it. The gate is
	// reached as a sibling (`--fleet`), where a `scripts/` file DOES become a G7
	// candidate via SIBLING_WORKERS; in a non-fleet scan the same file is never
	// a candidate at all, so a fixture without --fleet passes either way. This
	// test asserted exactly that nothing for its first draft — reverting the fix
	// left it green, which is how the vacuity was found.
	const root = siteWith(RESOLVER, KV_BINDING);
	try {
		writeFileSync(
			join(root, 'scripts', 'admin', 'fleet-runner-coverage.json'),
			JSON.stringify({ repos: ['WolffM/hadoku-fleet-manager'], facets: {} })
		);
		withRemotes((repos, remotes) => {
			// A sibling repo shipping a copy of the gate's own source.
			remotes.push('WolffM/hadoku-fleet-manager', {
				'scripts/check-identity-model.mjs': readFileSync(GATE, 'utf8'),
			});
			const r = run(root, { REPOS_DIR: repos, extra: ['--fleet'] });
			assert.equal(r.code, 0, r.out);
			assert.doesNotMatch(r.out, /check-identity-model/);
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// This gate's own regression test is built out of DELIBERATE violations —
// eleven fixtures, as template literals, because that is how you test a checker.
// Scanned as code they are indistinguishable from the thing they catch, and on
// 2026-09-03/04 the gate reported its own test suite and held ci:identity-model
// red for two days: first as G7, then — after the test-file pattern was widened
// to .mjs — as G3 on the same file at a different line, because the scan loop
// applies its `isTest` flag to G5 alone.
//
// A fixture is not evidence. This pins the exclusion so the class cannot return
// through a third rule.
test('the gate does not report a file named like its own regression test', () => {
	const root = mkdtempSync(join(tmpdir(), 'idmodel-self-'));
	try {
		mkdirSync(join(root, 'scripts', 'admin'), { recursive: true });
		writeFileSync(
			join(root, 'scripts', 'admin', 'identity-model-allowlist.json'),
			'{"allowed":[]}'
		);
		mkdirSync(join(root, 'workers', 'demo-api', 'src'), { recursive: true });
		writeFileSync(join(root, 'workers', 'demo-api', 'wrangler.toml'), 'name = "demo-api"\n');
		// The same shape that was reported: a body-owner fixture inside a template
		// literal, in a file with the gate-test basename.
		writeFileSync(
			join(root, 'workers', 'demo-api', 'src', 'check-identity-model.test.mjs'),
			'const SRC = `\nexport async function handler(c) {\n' +
				"\tconst body = c.req.valid('json');\n\treturn body.userId;\n}\n`;\n"
		);
		const r = run(root);
		assert.equal(r.code, 0, `the gate flagged its own test fixture:\n${r.out}`);
		assert.doesNotMatch(r.out, /G3/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('a REAL worker taking an owner from the body is still reported', () => {
	// The exclusion must be about the FILE, not about the pattern. If widening it
	// silenced G3 generally, this would pass silently and the rule would be dead.
	withSite(
		"export async function handler(c) {\n\tconst body = c.req.valid('json');\n\treturn body.userId;\n}\n",
		KV_BINDING,
		(r) => {
			assert.equal(r.code, 1);
			assert.match(r.out, /G3/);
		}
	);
});

// ── G8 ───────────────────────────────────────────────────────────────────────
//
// The hole these close: until G8, a credential read from the KEY HEADER and
// stored as ownership reported CLEAN. G2 catches the case where the COLUMN is
// named for a credential (`user_key`), which is the easy half — the half that
// actually happened twice is a column correctly named `user_id` holding a
// credential, and no shape check can see it after the fact because a credential
// and a userId are both v4 UUIDs. Verified against the live fleet on 2026-09-23:
// the gate reported "clean" on exactly this mutation.

test('G8 catches a credential read straight into an ownership identifier', () => {
	const SRC = `
export async function handler(c, db) {
	const userId = c.req.header('X-User-Key') ?? '';
	await db.prepare('INSERT INTO rows (user_id) VALUES (?)').bind(userId).run();
}
`;
	withSite(SRC, KV_BINDING, ({ code, out }) => {
		assert.equal(code, 1, `expected a G8 finding, got:\n${out}`);
		assert.match(out, /G8/);
		assert.match(out, /rotation will detach every row/);
	});
});

test('G8 follows a credential LAUNDERED through a neutral name into storage', () => {
	// The column is right, the variable name is innocent, and the value is a
	// credential. This is the shape of both historic incidents.
	const SRC = `
export async function handler(c, db) {
	const raw = c.req.header('X-User-Key') ?? '';
	await db.prepare('INSERT INTO rows (user_id) VALUES (?)').bind(raw).run();
}
`;
	withSite(SRC, KV_BINDING, ({ code, out }) => {
		assert.equal(code, 1, `expected a G8 finding, got:\n${out}`);
		assert.match(out, /G8/);
		assert.match(out, /`raw` is read from a credential/);
	});
});

test('G8 catches a MASKED credential used as a storage key', () => {
	// R7 is explicit that masking does not help: a truncated credential is still
	// key-derived and still detaches on rotation. The nested slice() call is why
	// the pattern scopes to the statement rather than the argument list.
	const SRC =
		`
export async function handler(c, kv) {
	const raw = c.req.header('X-User-Key') ?? '';
	await kv.put(` +
		'`' +
		`prefs:\${raw.slice(0, 8)}` +
		'`' +
		`, '{}');
}
`;
	withSite(SRC, KV_BINDING, ({ code, out }) => {
		assert.equal(code, 1, `expected a G8 finding, got:\n${out}`);
		assert.match(out, /G8/);
	});
});

test('G8 does NOT flag forwarding a credential to another service', () => {
	// Reading a credential is legal — a worker may need to pass it upstream. Only
	// letting it become OWNERSHIP is the defect. A rule that flagged the read
	// itself would be unusable and would be silenced within a week.
	const SRC = `
export async function handler(c) {
	const key = c.req.header('X-User-Key') ?? '';
	return fetch('https://upstream.example/api', { headers: { 'X-User-Key': key } });
}
`;
	withSite(SRC, KV_BINDING, ({ code, out }) => assert.equal(code, 0, out));
});

test('G8 does NOT flag a MASKED credential in a log line', () => {
	// The false positive the first cut produced, against mgmt-api's secrets-auth:
	// `logger.warn(\`… ${key.slice(0, 8)}…\`)`. A log is the one place masking a
	// credential is CORRECT, and it is the opposite of storage. Any `${name}`
	// interpolation counting as a write is what made this fire, so the rule keys
	// on the storage call instead.
	const SRC =
		`
export async function handler(c, logger) {
	const provided = (c.req.header('X-User-Key') || '').trim();
	if (!provided) return null;
	logger.warn(` +
		'`' +
		`caller=\${provided.slice(0, 8)}… rejected` +
		'`' +
		`);
	return null;
}
`;
	withSite(SRC, KV_BINDING, ({ code, out }) => assert.equal(code, 0, out));
});

// ── reach: the denylist walk, embedded schemas, and git as the exclusion list ─
//
// Until 2026-09-24 the scan named its roots. Four repos keep their code
// somewhere else — `server/`, `apps/`, `api/` — so each was walked as ZERO
// FILES and contributed zero findings while holding live credential-keyed
// ownership, which is the "nothing reads as clean" failure the contract's §6 is
// about. These pin the inversion.

test('a schema in a NON-standard root is found — the roots list is gone', () => {
	withBareSite((root) => {
		mkdirSync(join(root, 'server', 'catalog'), { recursive: true });
		writeFileSync(
			join(root, 'server', 'catalog', 'schema.sql'),
			'CREATE TABLE clip_upvotes (\n  voter_key TEXT NOT NULL\n);\n'
		);
		const r = run(root);
		assert.equal(r.code, 1, `expected a G2 finding, got:\n${r.out}`);
		assert.match(r.out, /G2/);
		assert.match(r.out, /voter_key/);
	});
});

test('G2 reads a schema EMBEDDED in code — a template literal or a Python string', () => {
	// Two live schemas are written this way and both were invisible: watchparty's
	// stats.sqlite (TS template literal) and dataplatform's catalog (Python string
	// constant). Between them, twelve credential-keyed columns G2 never saw.
	const PY_SCHEMA = [
		'SCHEMA = ' + '"'.repeat(3),
		'CREATE TABLE clips (',
		'  creator_key TEXT NOT NULL',
		');',
		'"'.repeat(3),
	].join('\n');
	for (const [name, body] of [
		[
			'db.ts',
			'db.exec(`\n  CREATE TABLE tierlist_votes (\n    friend_key TEXT NOT NULL\n  );\n`);\n',
		],
		['_migrations.py', PY_SCHEMA],
	]) {
		withBareSite((root) => {
			mkdirSync(join(root, 'apps', 'server'), { recursive: true });
			writeFileSync(join(root, 'apps', 'server', name), body);
			const r = run(root);
			assert.equal(r.code, 1, `${name}: expected a G2 finding, got:\n${r.out}`);
			assert.match(r.out, /G2/);
		});
	}
});

test('a GITIGNORED build artifact is not scanned', () => {
	// Walking whole repos immediately found hadoku_site's `public/mf/**` bundles —
	// contact-ui and watchparty compiled INTO this repo — and reported findings no
	// fix here could clear, on line numbers that move with every rebuild. Git
	// already states what is not source, in every repo, maintained by whoever
	// added the build step.
	withBareSite((root) => {
		gitIn(root, ['init', '-q']);
		mkdirSync(join(root, 'public', 'mf'), { recursive: true });
		writeFileSync(join(root, '.gitignore'), 'public/mf\n');
		writeFileSync(
			join(root, 'public', 'mf', 'bundle.js'),
			'CREATE TABLE t (voter_key TEXT NOT NULL);\n'
		);
		gitIn(root, ['add', '.gitignore', 'scripts']);
		const r = run(root);
		assert.equal(r.code, 0, `the ignored bundle must not be scanned, got:\n${r.out}`);
	});
});

test('a repo that is NOT a checkout still gets scanned — degraded, never blind', () => {
	// trackedFiles() returns null when git cannot answer, and the walk must then
	// fall back to SKIP_DIRS rather than treating "no tracked files" as "no files".
	withBareSite((root) => {
		mkdirSync(join(root, 'src'), { recursive: true });
		writeFileSync(join(root, 'src', 'schema.sql'), 'CREATE TABLE t (voter_key TEXT NOT NULL);\n');
		const r = run(root);
		assert.equal(r.code, 1, `expected the finding without git, got:\n${r.out}`);
		assert.match(r.out, /G2/);
	});
});

test('a virtualenv is never walked', () => {
	withBareSite((root) => {
		mkdirSync(join(root, '.venv', 'lib', 'site-packages'), { recursive: true });
		writeFileSync(
			join(root, '.venv', 'lib', 'site-packages', 'dep.py'),
			'SCHEMA = "CREATE TABLE t (user_key TEXT NOT NULL);"\n'
		);
		const r = run(root);
		assert.equal(r.code, 0, `a dependency's schema is not ours, got:\n${r.out}`);
	});
});

test('G2 knows the person nouns that actually occur — voter, viewer, author, creator', () => {
	// The pattern listed friend|user|owner|account|player|member|grantee|winner,
	// so dataplatform's seven columns would have passed even once the scan could
	// see them. Infrastructure keys must stay exempt.
	withBareSite((root) => {
		mkdirSync(join(root, 'src'), { recursive: true });
		writeFileSync(
			join(root, 'src', 'schema.sql'),
			'CREATE TABLE a (viewer_key TEXT NOT NULL, cache_key TEXT, idempotency_key TEXT, sort_key TEXT);\n'
		);
		const r = run(root);
		assert.equal(r.code, 1, `expected viewer_key to fail, got:\n${r.out}`);
		assert.match(r.out, /viewer_key/);
		assert.doesNotMatch(r.out, /cache_key|idempotency_key|sort_key/);
	});
});

test('G8 flags a credential landing in a PROVENANCE column', () => {
	// contact-ui writes created_by/changed_by/blocked_by/whitelisted_by from the
	// caller's raw key, and its migrations call them "Admin key or identifier".
	const SRC = `
export async function handler(c, db) {
	const changedBy = c.req.header('X-User-Key') ?? 'admin';
	await db.prepare('INSERT INTO t (created_by) VALUES (?)').bind(changedBy).run();
}
`;
	withSite(SRC, KV_BINDING, ({ code, out }) => {
		assert.equal(code, 1, `expected a G8 finding, got:\n${out}`);
		assert.match(out, /G8/);
	});
});

test('G8 does NOT flag an honest provenance literal', () => {
	const SRC = `
export async function handler(db) {
	await db.prepare('INSERT INTO t (created_by) VALUES (?)').bind('system').run();
}
`;
	withSite(SRC, KV_BINDING, ({ code, out }) => assert.equal(code, 0, out));
});

test('the scan still sees a repo when GIT_DIR is inherited — as it is from a hook', () => {
	// `-C` sets the working directory; GIT_DIR names the repository; GIT_DIR wins.
	// Hooks export it, and hadoku_site's pre-commit runs this gate — so an
	// inherited GIT_DIR made trackedFiles() ask the HOOK'S repo which of a
	// sibling's files are tracked. The answer is "none", every file is skipped,
	// and the repo is scanned as zero files: exactly the blindness this change
	// removed, one layer down and quieter, because the run still looks clean.
	//
	// Pinned separately from the cases above because they only fail this way when
	// something outside the suite sets the variable.
	withBareSite((root) => {
		mkdirSync(join(root, 'server'), { recursive: true });
		writeFileSync(
			join(root, 'server', 'schema.sql'),
			'CREATE TABLE t (voter_key TEXT NOT NULL);\n'
		);
		let out = '';
		let code = 0;
		try {
			out = execFileSync('node', [GATE], {
				env: { ...process.env, HADOKU_SITE_ROOT: root, GIT_DIR: join(REPO_GIT_DIR) },
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch (err) {
			code = err.status ?? 1;
			out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
		}
		assert.equal(code, 1, `a hook-set GIT_DIR must not blind the scan, got:\n${out}`);
		assert.match(out, /voter_key/);
	});
});

test('a git repo with NOTHING committed is not read as "no files"', () => {
	// An empty tracked-file list is indistinguishable from a repo whose files are
	// all ignored, and treating it as the latter skips every file and reports
	// clean. So an empty answer means "git could not tell me", exactly as a null
	// one does, and the walk falls back to SKIP_DIRS. Same rule the allowlist
	// reader already states about an empty vault snapshot: refuse to audit
	// against nothing rather than call nothing clean.
	withBareSite((root) => {
		gitIn(root, ['init', '-q']);
		mkdirSync(join(root, 'server'), { recursive: true });
		writeFileSync(
			join(root, 'server', 'schema.sql'),
			'CREATE TABLE t (voter_key TEXT NOT NULL);\n'
		);
		const r = run(root);
		assert.equal(r.code, 1, `an empty index must not blind the scan, got:\n${r.out}`);
		assert.match(r.out, /voter_key/);
	});
});

// ── checkout freshness ───────────────────────────────────────────────────────
//
// The twin of missingCheckouts: "could I look?" vs "did I look at TODAY'S code?".
// On 2026-09-24 an ad-hoc fleet audit read ~/repos/hadoku_site as it stood after
// the 13:00 repos:main-sync, 30 commits back, and reported 16 violations — one in
// a file whose fix was already on origin/main.

/** A site root wired to a local bare remote, with one commit pushed to main. */
function siteWithRemote() {
	const remote = mkdtempSync(join(tmpdir(), 'idm-remote-'));
	gitIn(remote, ['init', '--bare', '-q', '--initial-branch=main']);
	const root = bareSite();
	gitIn(root, ['init', '-q', '--initial-branch=main']);
	gitIn(root, ['add', '-A']);
	gitIn(root, ['commit', '-qm', 'base']);
	gitIn(root, ['remote', 'add', 'origin', remote]);
	gitIn(root, ['push', '-q', 'origin', 'HEAD:main']);
	return { root, remote };
}

/** Land one more commit on the remote, so `root` falls behind. */
function advanceRemote(remote) {
	const other = mkdtempSync(join(tmpdir(), 'idm-clone-'));
	gitIn(other, ['clone', '-q', remote, '.']);
	writeFileSync(join(other, 'later.txt'), 'newer\n');
	gitIn(other, ['add', '-A']);
	gitIn(other, ['commit', '-qm', 'later']);
	gitIn(other, ['push', '-q', 'origin', 'HEAD:main']);
	rmSync(other, { recursive: true, force: true });
}

test('a checkout BEHIND origin is reported, and does not fail the run', () => {
	// Not fatal on purpose. repos:main-sync sets the precedent — repos it cannot
	// safely ff are reported, not failed — and the nightly window makes strictness
	// actively wrong: main-sync runs minutes before the audits, so a bot push in
	// between puts a repo one commit behind. A daily false alarm is how a real one
	// stops being read.
	const { root, remote } = siteWithRemote();
	try {
		advanceRemote(remote);
		const r = run(root);
		assert.equal(r.code, 0, `staleness must not fail a clean run, got:\n${r.out}`);
		assert.match(r.out, /BEHIND origin/);
		assert.match(r.out, /partly about old code/);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(remote, { recursive: true, force: true });
	}
});

test('the CLEAN verdict line itself carries the caveat', () => {
	// The banner is not enough: the ✓ line is what gets quoted into a digest or a
	// commit message, and "clean across 28 repos" is the exact sentence that was
	// wrong on 2026-09-24.
	const { root, remote } = siteWithRemote();
	try {
		advanceRemote(remote);
		const r = run(root);
		const verdict = r.out.split('\n').find((l) => l.includes('identity model clean'));
		assert.ok(verdict, `expected a clean verdict line in:\n${r.out}`);
		assert.match(verdict, /BUT 1 checkout\(s\) were behind origin/);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(remote, { recursive: true, force: true });
	}
});

test('--allow-stale suppresses the check entirely', () => {
	const { root, remote } = siteWithRemote();
	try {
		advanceRemote(remote);
		const r = run(root, { extra: ['--allow-stale'] });
		assert.equal(r.code, 0, r.out);
		assert.doesNotMatch(r.out, /BEHIND origin/);
		assert.doesNotMatch(r.out, /old code/);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(remote, { recursive: true, force: true });
	}
});

test('a checkout AHEAD of origin is not stale — unpushed work is normal', () => {
	// The files on disk are NEWER than the remote, not older. Reporting mid-work
	// local commits as "old code" would fire on every developer every day, which is
	// the fastest way to have the real signal ignored.
	const { root, remote } = siteWithRemote();
	try {
		writeFileSync(join(root, 'wip.txt'), 'local\n');
		gitIn(root, ['add', '-A']);
		gitIn(root, ['commit', '-qm', 'wip']);
		const r = run(root);
		assert.equal(r.code, 0, r.out);
		assert.doesNotMatch(r.out, /BEHIND origin/);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(remote, { recursive: true, force: true });
	}
});

test('a repo with no commits yet is unknown, not stale', () => {
	// `rev-parse HEAD` fails before the remote is ever consulted, so this covers
	// the first of the two unknown paths and not the second.
	withBareSite((root) => {
		gitIn(root, ['init', '-q']);
		const r = run(root);
		assert.equal(r.code, 0, r.out);
		assert.doesNotMatch(r.out, /BEHIND origin/);
	});
});

test('an UNREACHABLE remote is unknown, not stale', () => {
	// The offline path, which is the one that matters operationally: a lookup that
	// FAILED must not be reported as a lookup that came back "behind". Claiming
	// staleness from a failed lookup invents a fact; claiming freshness hides one.
	//
	// The no-commits case above does not reach here — it returns at `rev-parse
	// HEAD` — so without this test the catch branch was never exercised and a
	// mutation turning it into `behind` passed unnoticed.
	withBareSite((root) => {
		gitIn(root, ['init', '-q', '--initial-branch=main']);
		gitIn(root, ['add', '-A']);
		gitIn(root, ['commit', '-qm', 'base']);
		gitIn(root, ['remote', 'add', 'origin', '/nonexistent/unreachable.git']);
		const r = run(root);
		assert.equal(r.code, 0, r.out);
		assert.doesNotMatch(r.out, /BEHIND origin/);
	});
});

test('staleness rides alongside real findings rather than replacing them', () => {
	const { root, remote } = siteWithRemote();
	try {
		mkdirSync(join(root, 'server'), { recursive: true });
		writeFileSync(
			join(root, 'server', 'schema.sql'),
			'CREATE TABLE t (voter_key TEXT NOT NULL);\n'
		);
		gitIn(root, ['add', '-A']);
		gitIn(root, ['commit', '-qm', 'schema']);
		gitIn(root, ['push', '-q', 'origin', 'HEAD:main']);
		advanceRemote(remote);
		const r = run(root);
		assert.equal(r.code, 1, `a real violation still fails, got:\n${r.out}`);
		assert.match(r.out, /voter_key/);
		assert.match(r.out, /BEHIND origin/);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(remote, { recursive: true, force: true });
	}
});

test('G5 fails non-edge code that stamps X-User-Name — the display half is edge-only too', () => {
	// Added with the header itself (2026-09-24). A roster label asserting "this
	// caller is <name>" is only trustworthy if the edge said it; a worker setting
	// the header on an outbound request re-creates the forgery the strip exists
	// to remove, one layer in.
	const SRC = `
export async function forwardToUpstream(name) {
	return fetch('https://upstream.example/api', { headers: { 'X-User-Name': name } });
}
`;
	withSite(SRC, KV_BINDING, ({ code, out }) => {
		assert.equal(code, 1, `expected a G5 finding, got:\n${out}`);
		assert.match(out, /G5/);
	});
});

test('G5 does NOT flag a worker READING X-User-Name — reading is how a roster labels a seat', () => {
	const SRC = `
export async function handler(c) {
	const label = c.req.header('X-User-Name') ?? 'player';
	return { label };
}
`;
	withSite(SRC, KV_BINDING, ({ code, out }) => assert.equal(code, 0, out));
});

// ── #98: blind spots found by mutation-testing this gate ──────────────────────
//
// Every case below was a REAL violation that exited 0 on 2026-10-10. Each is
// the minimal mutation that proved it; each must fail.

/** A bare site holding `files` ({relPath: content}), run once. */
function runFiles(files, { extra = [], allow = null, coverage = null, REPOS_DIR } = {}) {
	const root = bareSite();
	try {
		for (const [rel, body] of Object.entries(files)) {
			mkdirSync(join(root, dirname(rel)), { recursive: true });
			writeFileSync(join(root, rel), body);
		}
		if (allow) {
			writeFileSync(
				join(root, 'scripts', 'admin', 'identity-model-allowlist.json'),
				JSON.stringify({ allowed: allow })
			);
		}
		if (coverage) {
			writeFileSync(
				join(root, 'scripts', 'admin', 'fleet-runner-coverage.json'),
				JSON.stringify(coverage)
			);
		}
		return run(root, { extra, REPOS_DIR });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/**
 * Why a run is NOT a `check` finding matching `pattern`, or null when it is.
 * Returned rather than asserted so each test's own `assert` is visible to the
 * vacuity guard.
 */
function missedCheck(r, check, pattern) {
	if (r.code !== 1) return `expected a ${check} finding, got exit ${r.code}:\n${r.out}`;
	if (!new RegExp(`\\b${check}\\b`).test(r.out)) return `no ${check} in:\n${r.out}`;
	if (pattern && !pattern.test(r.out)) return `no finding matching ${pattern}:\n${r.out}`;
	return null;
}

/** The JSON document a `--json` run printed. stderr follows it in `out`. */
function jsonDoc(r) {
	return JSON.parse(r.out.slice(0, r.out.indexOf('\n}') + 2));
}

const handler = (body) => `export async function handler(c) {\n${body}\n}\n`;

/** A sibling repo shipping `files`, with an EMPTY REPOS_DIR beside it. */
function withSibling(name, files, fn) {
	withRemotes((repos, remotes) => {
		remotes.push(`WolffM/${name}`, files);
		fn(repos);
	});
}

// ── G3 ──

test('G3: an owner DESTRUCTURED straight out of the body is reported — no tainted name needed', () => {
	// The destructure rule sat after `if (!tainted.size) return`, and a file
	// whose only body read was the destructure had no tainted name.
	assert.equal(
		missedCheck(
			runFiles({
				'src/a.ts': handler('\tconst { userId } = await c.req.json();\n\treturn userId;'),
			}),
			'G3',
			/`userId` is an owner destructured out of the request body/
		),
		null
	);
});

test('G3: an owner destructured out of a tainted NAME is reported', () => {
	assert.equal(
		missedCheck(
			runFiles({
				'src/a.ts': handler(
					'\tconst body = await c.req.json();\n\tconst { ownerId: who } = body;\n\treturn who;'
				),
			}),
			'G3',
			/`ownerId` is an owner destructured/
		),
		null
	);
});

test('G3: an ALIAS of the body carries the taint', () => {
	assert.equal(
		missedCheck(
			runFiles({
				'src/a.ts': handler(
					'\tconst body = await c.req.json();\n\tconst input = body;\n\treturn input.userId;'
				),
			}),
			'G3',
			/`input\.userId`/
		),
		null
	);
});

test('G3: a BRACKET read of the owner field is the same read', () => {
	assert.equal(
		missedCheck(
			runFiles({
				'src/a.ts': handler("\tconst body = await c.req.json();\n\treturn body['userId'];"),
			}),
			'G3',
			/`body\.userId`/
		),
		null
	);
});

test('G3: a FORM body (parseBody, formData) is a body too', () => {
	assert.equal(
		missedCheck(
			runFiles({
				'src/a.ts': handler('\tconst form = await c.req.parseBody();\n\treturn form.owner;'),
			}),
			'G3',
			/`form\.owner`/
		),
		null
	);
	assert.equal(
		missedCheck(
			runFiles({
				'src/a.ts': handler("\tconst fd = await c.req.formData();\n\treturn fd.get('userId');"),
			}),
			'G3',
			/`fd\.userId`/
		),
		null
	);
});

// ── G1 ──

for (const [shape, src] of [
	['generics', 'export interface Row<T> {\n\tkey: T;\n\tretiredAt?: number;\n}\n'],
	['extends', 'interface Row extends Base {\n\tretiredAt?: number;\n}\n'],
	['an intersection', 'type Row = Base & {\n\tretiredAt?: number;\n};\n'],
	['a quoted key', "interface Row {\n\t'retiredAt'?: number;\n}\n"],
]) {
	test(`G1: the registry row is found behind ${shape}`, () => {
		assert.equal(
			missedCheck(runFiles({ 'src/types.ts': src }), 'G1', /re-declares the key-registry row/),
			null
		);
	});
}

test('G1: a brace-less alias does not reach into the next declaration', () => {
	for (const src of [
		'type Id = string\nexport function f(x: Id) {\n\treturn { retiredAt: 1 };\n}\n',
		'type Id = string\nexport class Clock {\n\tretiredAt: number = 0;\n}\n',
	]) {
		const r = runFiles({ 'src/types.ts': src });
		assert.equal(r.code, 0, r.out);
	}
});

// ── G2 ──

for (const [shape, sql] of [
	['a one-line table', 'CREATE TABLE t (id TEXT PRIMARY KEY, voter_key TEXT NOT NULL);'],
	['a VARCHAR column', 'CREATE TABLE t (\n  id INTEGER,\n  voter_key VARCHAR(64)\n);'],
	['a UUID column', 'CREATE TABLE t (\n  id INTEGER,\n  voter_key UUID\n);'],
	['backtick quoting', 'CREATE TABLE `t` (\n  id INTEGER,\n  `voter_key` CHAR(36)\n);'],
	['bracket quoting', 'CREATE TABLE [t] (\n  id INTEGER,\n  [voter_key] TEXT\n);'],
	['no trailing semicolon', 'CREATE TABLE t (\n  id INTEGER,\n  voter_key BOOLEAN\n)'],
	['ADD without COLUMN', 'CREATE TABLE t (id INTEGER);\nALTER TABLE t ADD voter_key TEXT;'],
]) {
	test(`G2: a credential column is found in ${shape}`, () => {
		assert.equal(missedCheck(runFiles({ 'src/schema.sql': sql }), 'G2', /voter_key/), null);
	});
}

test('G2: a table that parses to ZERO columns is reported, not read as clean', () => {
	// The second shape is why constraint clauses are skipped: `PRIMARY KEY (id)`
	// counted as a column named PRIMARY would make an unreadable table look read.
	for (const sql of [
		'CREATE TABLE t (${COLUMNS});\n',
		'CREATE TABLE t (${COLUMNS}, PRIMARY KEY (id));\n',
	]) {
		assert.equal(
			missedCheck(runFiles({ 'src/schema.sql': sql }), 'G2', /parsed to ZERO columns/),
			null
		);
	}
});

test('G2: a constraint clause is not a column, and a rename still retires one', () => {
	const r = runFiles({
		'src/schema.sql':
			'CREATE TABLE t (id TEXT, voter_key TEXT, PRIMARY KEY (id), UNIQUE (voter_key));\n' +
			'ALTER TABLE t RENAME COLUMN voter_key TO voter_user_id;\n',
	});
	assert.equal(r.code, 0, r.out);
});

// ── allowlist ──

test('allowlist: without `count` an entry still exempts every finding in its file', () => {
	const r = runFiles(
		{ 'src/schema.sql': 'CREATE TABLE t (voter_key TEXT, viewer_key TEXT);' },
		{ allow: [{ check: 'G2', file: 'src/schema.sql', why: 'fixture' }] }
	);
	assert.equal(r.code, 0, r.out);
});

test('allowlist: a `count` is a ceiling — a NEW violation in the file surfaces', () => {
	const allow = [{ check: 'G2', file: 'src/schema.sql', why: 'fixture', count: 1 }];
	const one = runFiles({ 'src/schema.sql': 'CREATE TABLE t (voter_key TEXT);' }, { allow });
	assert.equal(one.code, 0, one.out);
	assert.equal(
		missedCheck(
			runFiles(
				{ 'src/schema.sql': 'CREATE TABLE t (voter_key TEXT, viewer_key TEXT);' },
				{ allow }
			),
			'G2',
			/allowlisted for 1, 2 found/
		),
		null
	);
});

test('allowlist: a malformed `count` is refused', () => {
	const r = runFiles(
		{ 'src/a.ts': 'export const x = 1;\n' },
		{ allow: [{ check: 'G2', file: 'src/a.ts', why: 'fixture', count: 'two' }] }
	);
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /"count" must be a positive integer/);
});

test('allowlist: a SITE entry does not exempt the same path in a sibling, and goes stale', () => {
	// The unprefixed lookup let `G2 src/schema.sql` exempt `src/schema.sql` in
	// every sibling — and the sibling's hit kept the site entry looking live.
	withSibling('sib', { 'src/schema.sql': 'CREATE TABLE t (voter_key TEXT);' }, (repos) => {
		const r = runFiles(
			{ 'src/ok.ts': 'export const x = 1;\n' },
			{
				extra: ['--fleet', '--json', '--allow-stale'],
				allow: [{ check: 'G2', file: 'src/schema.sql', why: 'fixture' }],
				coverage: { repos: ['WolffM/sib'], facets: {} },
				REPOS_DIR: repos,
			}
		);
		assert.equal(r.code, 1, r.out);
		const doc = jsonDoc(r);
		assert.ok(
			doc.violations.some((v) => v.file === 'sib:src/schema.sql'),
			`the sibling's violation must be reported:\n${r.out}`
		);
		assert.deepEqual(doc.staleExemptions, ['G2 src/schema.sql']);
	});
});

test('allowlist: a `count` above what was found is stale on a complete scan', () => {
	withSibling('sib', { 'src/ok.ts': 'export const x = 1;\n' }, (repos) => {
		const r = runFiles(
			{ 'src/schema.sql': 'CREATE TABLE t (voter_key TEXT);' },
			{
				extra: ['--fleet', '--allow-stale'],
				allow: [{ check: 'G2', file: 'src/schema.sql', why: 'fixture', count: 3 }],
				coverage: { repos: ['WolffM/sib'], facets: {} },
				REPOS_DIR: repos,
			}
		);
		assert.equal(r.code, 1, r.out);
		assert.match(r.out, /count is 3 but only 1 found; lower it/);
	});
});

test('--json: a bad allowlist entry still emits a parseable document', () => {
	// It exited with a stderr line only, so the cron parsed nothing and read a
	// finding as "the checker broke" — the --json contract.
	const root = bareSite();
	try {
		writeFileSync(
			join(root, 'scripts', 'admin', 'identity-model-allowlist.json'),
			JSON.stringify({ allowed: [{ check: 'G2' }] })
		);
		const res = spawnSync('node', [GATE, '--json'], {
			env: { ...process.env, HADOKU_SITE_ROOT: root },
			encoding: 'utf8',
		});
		assert.equal(res.status, 1);
		const doc = JSON.parse(res.stdout);
		assert.deepEqual(doc.violations, []);
		assert.match(doc.error, /needs "check", "file" and "why"/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── fleet reach ──

test('--fleet with an EMPTY roster fails — scanning only the site is not a fleet audit', () => {
	const r = runFiles(
		{ 'src/ok.ts': 'export const x = 1;\n' },
		{ extra: ['--fleet', '--json', '--allow-stale'], coverage: { repos: [], facets: {} } }
	);
	assert.equal(r.code, 1, r.out);
	assert.match(jsonDoc(r).rosterError, /EMPTY roster/);
});

test('a TRACKED build/ directory is scanned — git, not the denylist, says what is source', () => {
	withBareSite((root) => {
		gitIn(root, ['init', '-q']);
		mkdirSync(join(root, 'build'), { recursive: true });
		writeFileSync(join(root, 'build', 'schema.sql'), 'CREATE TABLE t (voter_key TEXT);\n');
		gitIn(root, ['add', '-A']);
		const r = run(root, { extra: ['--allow-stale'] });
		assert.equal(r.code, 1, `a tracked build/ file must be read, got:\n${r.out}`);
		assert.match(r.out, /voter_key/);
	});
});

// ── G4 ──

for (const [shape, src] of [
	['ownerId', "export const f = { ownerId: 'hadoku' };\n"],
	['a quoted key', "export const f = { 'userId': 'hadoku' };\n"],
]) {
	test(`G4: a display-name literal is found under ${shape}`, () => {
		assert.equal(
			missedCheck(runFiles({ 'src/f.ts': src }), 'G4', /`hadoku` is a display name/),
			null
		);
	});
}

test('G4: a bare `owner` literal (a repo owner, a seat side) is not an identity claim', () => {
	// Measured fleet-wide 2026-10-10: 63 `owner: '<word>'` literals, none an identity.
	const r = runFiles({
		'src/f.ts':
			"export const a = { owner: 'apache', repo: 'x' };\nexport const s = { owner: 'them' };\n",
	});
	assert.equal(r.code, 0, r.out);
});

// ── G5 ──

for (const [shape, src] of [
	['a header tuple', "export const h = new Headers([['X-User-Id', id]]);\n"],
	['a bracket assignment', "export function f(h, id) {\n\th['x-user-id'] = id;\n}\n"],
]) {
	test(`G5: ${shape} stamps the header`, () => {
		assert.equal(missedCheck(runFiles({ 'src/f.ts': src }), 'G5', /sets X-User-Id/i), null);
	});
}

// #109: an inbound sanitizer that degrades an unproven request to the floor.
// The shape is hadoku_site's templates/*/edge-auth.ts, verbatim where it counts.
const SANITIZER = `export function sanitizeHeaders(headers) {
	if (edgeVouched(headers)) return;
	headers['x-hadoku-tier'] = 'public';
	headers['x-hadoku-content-level'] = '1';
	delete headers['x-user-id'];
	delete headers['x-user-key'];
}
`;

test('G5: degrading an unproven request to x-hadoku-tier=public is not a stamp', () => {
	const r = runFiles({ 'src/edge-auth.ts': SANITIZER });
	assert.equal(r.code, 0, r.out);
});

for (const [shape, src] of [
	['a method call', 'h.set(\'X-Hadoku-Tier\', "public");\n'],
	['an object literal', "export const h = { 'X-Hadoku-Tier': 'public' };\n"],
	['a header tuple', "export const h = new Headers([['X-Hadoku-Tier', 'public']]);\n"],
]) {
	test(`G5: a public downgrade is not a stamp as ${shape}`, () => {
		const r = runFiles({ 'src/f.ts': src });
		assert.equal(r.code, 0, r.out);
	});
}

for (const [what, src] of [
	// The bare-local opt-out in the same templates: a computed tier is a GRANT.
	[
		'a computed tier',
		"export function f(headers) {\n\theaders['x-hadoku-tier'] = CONFIG.devTier;\n}\n",
	],
	['a non-public literal tier', "export const h = { 'X-Hadoku-Tier': 'admin' };\n"],
	[
		'a nullish-assigned user',
		"export function f(headers) {\n\theaders['x-user-id'] ??= 'local-dev';\n}\n",
	],
	['an or-assigned user name', "export function f(h) {\n\th['X-User-Name'] ||= name;\n}\n"],
	['an and-assigned tier', "export function f(h) {\n\th['x-hadoku-tier'] &&= t;\n}\n"],
	['a value that merely starts with public', "export const h = { 'X-Hadoku-Tier': publicTier };\n"],
	['a user id set to public', "export function f(h) {\n\th['x-user-id'] = 'public';\n}\n"],
	[
		'a user stamped beside a public tier',
		"export const h = { 'X-Hadoku-Tier': 'public', 'X-User-Id': uid };\n",
	],
	[
		'a comparison, not an assignment',
		"export const ok = (h) => h['x-hadoku-tier'] == 'public' || (h['x-hadoku-tier'] = t);\n",
	],
]) {
	test(`G5: ${what} is still a stamp`, () => {
		assert.equal(missedCheck(runFiles({ 'src/f.ts': src }), 'G5'), null);
	});
}

test('G5: a list of header NAMES (a strip-list) is not a stamp', () => {
	const r = runFiles({ 'src/f.ts': "export const STRIP = ['X-User-Id', 'X-Hadoku-Tier'];\n" });
	assert.equal(r.code, 0, r.out);
});

test("G5: the edge-router exemption is hadoku_site's path, not any sibling's", () => {
	withSibling(
		'sib',
		{ 'workers/edge-router/src/x.ts': "export const h = { 'X-User-Id': 'u-1' };\n" },
		(repos) => {
			const r = runFiles(
				{ 'src/ok.ts': 'export const x = 1;\n' },
				{
					extra: ['--fleet', '--allow-stale'],
					coverage: { repos: ['WolffM/sib'], facets: {} },
					REPOS_DIR: repos,
				}
			);
			assert.equal(missedCheck(r, 'G5', /sib:workers\/edge-router\/src\/x\.ts/), null);
		}
	);
});

// ── G6 ──

test('G6: a worker reading X-User-Id through headers.get() is a reader', () => {
	assert.equal(
		missedCheck(
			runFiles({
				'workers/edge-router/src/index.ts': 'export default {};\n',
				'workers/demo-api/src/a.ts': handler("\treturn c.req.raw.headers.get('X-User-Id');"),
			}),
			'G6',
			/demo-api reads X-User-Id but has no EDGE_MOUNTS entry/
		),
		null
	);
});

test('G6: a base mounted twice must inject on EVERY mount, not the last one read', () => {
	const EDGE =
		'app.get("/a", (c) => proxyRequest(c, { baseUrl: c.env.CDN_API_BASE }));\n' +
		'app.get("/b", (c) => proxyRequest(c, { baseUrl: c.env.CDN_API_BASE, injectUserId: true }));\n';
	assert.equal(
		missedCheck(
			runFiles({
				'workers/edge-router/src/index.ts': EDGE,
				'workers/cdn-api/src/a.ts': handler("\treturn c.req.header('X-User-Id');"),
			}),
			'G6',
			/cdn-api reads X-User-Id but c\.env\.CDN_API_BASE lacks injectUserId/
		),
		null
	);
});

// ── G7 ──

test('G7: an ALIASED resolver import is still a resolver', () => {
	const SRC =
		"import { resolveGrantee as rg } from '@wolffm/worker-utils/identity';\n" +
		handler("\treturn rg(c.env, { name: 'x' });");
	withSite(SRC, '', (r) =>
		assert.equal(missedCheck(r, 'G7', /binds neither SESSIONS_KV nor edge-router/), null)
	);
});

for (const [shape, toml] of [
	['an [env.*] kv table', '[[env.staging.kv_namespaces]]\nbinding = "SESSIONS_KV"\nid = "abc"\n'],
	['a d1 table', '[[d1_databases]]\nbinding = "SESSIONS_KV"\ndatabase_id = "abc"\n'],
	[
		'an [env.*] services table',
		'[[env.staging.services]]\nbinding = "EDGE"\nservice = "edge-router"\n',
	],
]) {
	test(`G7: a binding under ${shape} does not count`, () => {
		withSite(RESOLVER, toml, (r) => assert.equal(missedCheck(r, 'G7', /binds neither/), null));
	});
}

test('G7: an inline top-level kv_namespaces array binds the registry', () => {
	withSite(RESOLVER, 'kv_namespaces = [{ binding = "SESSIONS_KV", id = "abc" }]\n', (r) =>
		assert.equal(r.code, 0, r.out)
	);
	withSite(RESOLVER, 'kv_namespaces = [\n  { binding = "SESSIONS_KV", id = "abc" },\n]\n', (r) =>
		assert.equal(r.code, 0, r.out)
	);
});

/**
 * #113: G7 binds to the IMPORT, not the spelling. hadoku-watchparty defines its
 * own `resolveRegistryName` (a whoami wrapper, no registry anywhere near it)
 * and calls it from a route; matching the bare name reported both files and
 * kept `ci:identity-model` red for six days. A sibling with no SIBLING_WORKERS
 * entry is used on purpose: any call G7 counted there is a hard finding.
 * MUTATION: match `REGISTRY_READER_NAMES` by name again and this goes red.
 */
test('G7: a LOCAL function sharing a resolver name is not a resolver (#113)', () => {
	withSibling(
		'hadoku-watchparty',
		{
			'apps/server/src/middleware/adminAuth.ts':
				'export async function resolveRegistryName(req) {\n\treturn req.headers.get("x-user-name");\n}\n' +
				'export async function other(req) {\n\treturn resolveRegistryName(req);\n}\n',
			'apps/server/src/http/routes/tierlist.ts':
				"import { resolveRegistryName } from '../../middleware/adminAuth.js';\n" +
				handler('\treturn resolveRegistryName(c.req);'),
		},
		(repos) => {
			const r = runFiles(
				{ 'src/ok.ts': 'export const x = 1;\n' },
				{
					extra: ['--fleet', '--allow-stale'],
					coverage: { repos: ['WolffM/hadoku-watchparty'], facets: {} },
					REPOS_DIR: repos,
				}
			);
			assert.equal(r.code, 0, r.out);
			assert.doesNotMatch(r.out, /G7/);
		}
	);
});

/**
 * The other half, or #113's fix is a false NEGATIVE: hadoku-task re-exports the
 * readers from its own `share-registry.ts` so its call sites keep one import
 * path, and a call through that module is a real registry read that needs a
 * binding. Same no-entry sibling, so being SEEN is the finding.
 */
for (const [shape, registry, more = {}] of [
	[
		'a named re-export',
		"export { resolveRegistryName, isIdentityError } from '@wolffm/worker-utils/identity';\n",
	],
	['a star re-export', "export * from '@wolffm/worker-utils/identity';\n"],
	[
		'an import then export',
		"import { resolveRegistryName } from '@wolffm/worker-utils/identity';\nexport { resolveRegistryName };\n",
	],
	[
		'two hops',
		"export { resolveRegistryName } from './inner';\n",
		{
			'worker/src/routes/inner.ts':
				"export { resolveRegistryName } from '@wolffm/worker-utils/identity';\n",
		},
	],
]) {
	test(`G7: a resolver reached through ${shape} in a local module IS a resolver`, () => {
		withSibling(
			'sib',
			{
				...more,
				'worker/src/routes/share-registry.ts': registry,
				'worker/src/routes/share-grants.ts':
					"import { resolveRegistryName as who } from './share-registry';\n" +
					handler('\treturn who(c.env, c.req);'),
			},
			(repos) => {
				const r = runFiles(
					{ 'src/ok.ts': 'export const x = 1;\n' },
					{
						extra: ['--fleet', '--allow-stale'],
						coverage: { repos: ['WolffM/sib'], facets: {} },
						REPOS_DIR: repos,
					}
				);
				assert.equal(
					missedCheck(
						r,
						'G7',
						/sib:worker\/src\/routes\/share-grants\.ts:\d+.*no SIBLING_WORKERS entry/
					),
					null
				);
			}
		);
	});
}

test('G7: a NAMESPACE import of the identity module is still a resolver', () => {
	const SRC =
		"import * as identity from '@wolffm/worker-utils/identity';\n" +
		handler("\treturn identity.resolveGrantee(c.env, { name: 'x' });");
	withSite(SRC, '', (r) =>
		assert.equal(missedCheck(r, 'G7', /binds neither SESSIONS_KV nor edge-router/), null)
	);
});

// ── G8 ──

test('G8: a credential DESTRUCTURED out of its holder is tainted', () => {
	const SRC = `
export async function handler(c, db) {
	const { credential } = c.get('authContext');
	await db.prepare('INSERT INTO t (created_by) VALUES (?)').bind(credential).run();
}
`;
	withSite(SRC, KV_BINDING, (r) =>
		assert.equal(missedCheck(r, 'G8', /`credential` is read from a credential/), null)
	);
});

// e2e edge simulators stamp identity on purpose (2026-10-11): cardtable
// `e2e/edge.ts`, bomberman `e2e/edge-stub.mjs`. The directory exempts; a name
// that merely looks like a helper does not.
const E2E_STAMP = "export const h = { 'X-Hadoku-Tier': 'admin', 'X-User-Id': 'u1' };\n";

test('G5: an e2e/ edge simulator is a test, not a stamp', () => {
	for (const rel of ['e2e/edge.ts', 'e2e/edge-stub.mjs', 'apps/web/e2e/edge.ts']) {
		const r = runFiles({ [rel]: E2E_STAMP });
		assert.equal(r.code, 0, `${rel}:\n${r.out}`);
	}
});

test('G5: a file that only NAMES e2e is still shipped code', () => {
	for (const rel of ['src/e2e-helper.ts', 'src/edge.stub.ts']) {
		assert.equal(missedCheck(runFiles({ [rel]: E2E_STAMP }), 'G5'), null, rel);
	}
});

// ── fleet-manager#7: siblings are read SHIPPED, never off REPOS_DIR ──

test('#7: an unreadable roster repo is a missing checkout, with the reason', () => {
	withRemotes((repos, remotes) => {
		remotes.push('WolffM/sib', { 'src/ok.ts': 'export const x = 1;\n' });
		const r = runFiles(
			{ 'src/ok.ts': 'export const x = 1;\n' },
			{
				extra: ['--fleet', '--allow-stale'],
				coverage: { repos: ['WolffM/sib', 'WolffM/never-pushed'], facets: {} },
				REPOS_DIR: repos,
			}
		);
		assert.equal(r.code, 1, r.out);
		assert.match(r.out, /WolffM\/never-pushed: fetch from .* failed/);
	});
});

/**
 * A LOCAL CLONE CANNOT CHANGE THE VERDICT. The baseline holds a clone under
 * REPOS_DIR that matches the shipped branch, with that branch as its origin.
 * Then it is replaced by one that is CRLF, BEHIND (its last commit holds a
 * schema the remote never shipped) and DIRTY (an uncommitted G3 read). The
 * `--fleet` verdict must not move. Revert the gate to scanning REPOS_DIR and
 * the poisoned run reports the dirty file.
 */
test('#7: a CRLF, stale, dirty clone under REPOS_DIR does not change the verdict', () => {
	withRemotes((repos, remotes) => {
		const files = { 'src/ok.ts': 'export const x = 1;\n' };
		remotes.push('WolffM/sib', files);
		const runIt = () =>
			runFiles(
				{ 'src/ok.ts': 'export const x = 1;\n' },
				{
					extra: ['--fleet', '--json', '--allow-stale'],
					coverage: { repos: ['WolffM/sib'], facets: {} },
					REPOS_DIR: repos,
				}
			);
		const clone = poisonedClone(repos, 'WolffM/sib', files);
		gitIn(clone, ['remote', 'add', 'origin', remotes.remote('WolffM/sib')]);
		const baseline = runIt();
		assert.equal(baseline.code, 0, baseline.out);

		rmSync(clone, { recursive: true, force: true });
		poisonedClone(
			repos,
			'WolffM/sib',
			{ ...files, 'src/schema.sql': 'CREATE TABLE t (voter_key TEXT);' },
			{
				crlf: true,
				edit: {
					'src/wip.ts': handler('\tconst { userId } = await c.req.json();\n\treturn userId;'),
				},
			}
		);
		const poisoned = runIt();
		assert.equal(poisoned.code, baseline.code, poisoned.out);
		assert.deepEqual(jsonDoc(poisoned).violations, jsonDoc(baseline).violations);
		assert.equal(jsonDoc(poisoned).scanned, 2, 'the sibling must have been scanned');
	});
});
