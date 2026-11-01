/**
 * Owner + edge constants for the identity-model gate (split of
 * scripts/lib/identity-rules.mjs, wave 5q lane C, pure move): the module that
 * owns the registry row, the edge-router boundary where stamping a user is
 * legitimate, this gate's own self-exclusions, and the edge-mount table G6
 * reads. Nothing here decides anything — every export is a literal or a
 * regex, read by the rule functions in identity-checks.mjs and the
 * orchestration in identity-rules.mjs.
 */

/** The module that owns the model. Everything below is measured against it. */
export const OWNER_MODULE = 'workers/shared/identity.ts';
export const OWNER_IMPORT = '@wolffm/worker-utils/identity';

/**
 * THE identity boundary. edge-router resolves the credential and stamps
 * `X-User-Id` having first deleted any client-supplied copy — that is R1, and
 * it is the reason every other worker may treat the header's presence as proof.
 * So G5 does not apply inside it: stamping the header IS its job.
 *
 * A rule rather than an allowlist entry, because it is a DEFINITION. Four files
 * in there legitimately set the header today and an exemption list would need
 * touching every time a fifth appears, which teaches the wrong thing about why
 * they are allowed.
 */
export const IDENTITY_BOUNDARY = 'workers/edge-router/src/';

/**
 * This checker's own source, BY BASENAME. Its patterns necessarily spell out
 * every construct it hunts, so scanning itself reports itself.
 *
 * It held the string `'fleet identity-model'` — the COMMAND name — and was
 * compared against a repo-relative path, so it never once matched and the
 * exclusion was decorative. Nothing noticed while the file lived in
 * `hadoku_site/scripts/admin` and no check happened to match its text; G7 does
 * match it, which is what surfaced the dead guard. A guard that cannot fire
 * reads as coverage, so this is a basename now and pinned by a test.
 */
export const SELF = 'check-identity-model.mjs';
/**
 * This gate's own REGRESSION TEST, excluded for the same reason as SELF and
 * more so: it is built out of deliberate violations.
 *
 * Eleven fixtures live in it as template literals — `body.userId`,
 * `c.req.valid('json')`, resolvers with and without bindings — because that is
 * how you test a checker. Scanned as code they are indistinguishable from the
 * thing they exist to catch, so the gate reported its own test suite and
 * `ci:identity-model` stayed red for two days.
 *
 * It fired as G7 first. Widening the test-file pattern to `.mjs` silenced that
 * one, and G3 then reported the SAME FILE at a different line — because the
 * scan loop computes `isTest` and applies it to G5 alone. Excluding the file is
 * what closes the class; skipping G3 for every test in the fleet would have
 * blinded a real rule to fix one file.
 *
 * A fixture is not evidence. Fourth occurrence of that in this repo.
 */
export const SELF_TEST = 'check-identity-model.test.mjs';

// ── G6 ───────────────────────────────────────────────────────────────────────
/**
 * Where edge-router mounts each worker that READS `X-User-Id`.
 *
 * R1 lets a worker treat the header's presence as proof of identity — but only
 * if the edge actually stamps it. `injectSessionKey` is not a substitute: that
 * stamps `X-User-Key`, a CREDENTIAL, and keying reads on one is the thing the
 * identity model exists to undo.
 *
 * This gate exists because the gap shipped. watchparty-stats-api's /me and
 * /matches were moved onto the edge identity on 2026-08-28 while their proxy
 * config still had only `injectSessionKey: true`, so the worker saw no
 * X-User-Id at all and 401'd every signed-in player. Nothing caught it —
 * `check:header-fleet` is about UI headers, not this.
 *
 * The env-var names are not derivable from the directory (`prompt-api` mounts
 * as PROMPT_WORKER_BASE), so the mapping is explicit — and a reader with NO
 * entry is a hard failure, which is what stops the table rotting: adding a
 * worker that reads the header forces you to say where it is mounted.
 */
export const EDGE_MOUNTS = {
	'cdn-api': 'CDN_API_BASE',
	'prefs-api': 'PREFS_API_BASE',
	'watchparty-stats-api': 'WATCHPARTY_STATS_API_BASE',
};

/**
 * Reads the header (a consumer), as opposed to setting it (G5's business).
 * Hono's `c.req.header(...)` and the Fetch API's `headers.get(...)` — the
 * latter also as `c.req.raw.headers.get(...)` — are the same read, and a worker
 * written against plain `Request` used to be invisible here.
 */
export const READS_USER_ID = /(?:\breq\.header|\bheaders\.get)\(\s*['"`]X-User-Id['"`]/i;

export const EDGE_INDEX = 'workers/edge-router/src/index.ts';
