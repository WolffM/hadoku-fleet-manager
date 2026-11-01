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
 *
 * Split of this file (wave 5q lane C, pure move) to reach the 1,000-line test
 * ceiling: the shared harness (`withSite`, `run`, `GATE`, …) moved to
 * `lib/identity-model-fixtures.mjs`; the rest of the suite, starting at the
 * "#98: blind spots found by mutation-testing this gate" divider, moved to
 * `check-identity-model-blindspots.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	GATE,
	REPO_GIT_DIR,
	RESOLVER,
	VIA_EDGE,
	KV_BINDING,
	EDGE_BINDING,
	withRemotes,
	siteWith,
	gitIn,
	withBareSite,
	run,
	withSite,
	siteWithRemote,
	advanceRemote,
} from './lib/identity-model-fixtures.mjs';

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

// fleet-manager#40: G9 shipped with no FIXES entry, so every G9 failure printed
// "Fix — undefined" — on hadoku_site's lint, the first time anyone saw one.
// Read statically: every check id a rule module can emit must have fix text.
test('every check id the rules can emit has a FIXES entry', () => {
	const lib = join(dirname(fileURLToPath(import.meta.url)), 'lib');
	const emitted = new Set();
	for (const f of readdirSync(lib).filter((n) => /^identity-.*\.mjs$/.test(n))) {
		for (const m of readFileSync(join(lib, f), 'utf8').matchAll(/\badd\(\s*'(G\d+[a-z]?)'/g)) {
			emitted.add(m[1]);
		}
	}
	const gate = readFileSync(GATE, 'utf8');
	const fixesBody = gate.slice(
		gate.indexOf('const FIXES = {'),
		gate.indexOf('\n};', gate.indexOf('const FIXES = {'))
	);
	const fixed = new Set([...fixesBody.matchAll(/^\t(G\d+[a-z]?):/gm)].map((m) => m[1]));
	// Not vacuous: G1..G8 plus G9a/b/c are all emitted today.
	assert.ok(emitted.size >= 11, `found only ${[...emitted]} — the emit pattern no longer matches`);
	const missing = [...emitted].filter((c) => !fixed.has(c)).sort();
	assert.deepEqual(missing, [], `checks with no FIXES entry: ${missing.join(', ')}`);
});
