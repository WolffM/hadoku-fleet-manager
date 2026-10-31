/**
 * `gh api repos/<repo>/actions/runners` with retry — plan §4.1 F2b.
 *
 * Shared by `reconcile-fleet-runners.mjs`'s fanned-out pool (up to 28 repos,
 * 8-wide concurrency) and `check-label-floor.mjs`'s resident-floor check
 * (1-3 repos, read one after another). Both copies retried `READ_ATTEMPTS`
 * times with the same 20s per-attempt timeout and the same 1s delay before
 * this file existed; the only real difference was ASYNC `execFile` in one and
 * SYNC `execFileSync` in the other.
 *
 * DIVERGENCE TABLE (the two copies, before this file existed):
 *
 * | copy | transport | timeout | retry delay | on exhaustion | caller shape |
 * |---|---|---|---|---|---|
 * | reconcile-fleet-runners.mjs | `execFile` (async) | 20_000ms | 1_000ms, `setTimeout` | `{ok:false, error}` | fanned out, `pool(..., 8, ...)` |
 * | check-label-floor.mjs | `execFileSync` (sync) | 20_000ms | 1_000ms, `Atomics.wait` | throws `Error(reason)` | one repo at a time, serial |
 *
 * `reconcile-fleet-runners.mjs`'s own comment explains why it is async: a
 * synchronous child blocks the WHOLE event loop for as long as it runs —
 * measured in `check-fleet-preflight.mjs`, three `Promise.all`-wrapped
 * `execFileSync` calls of 1s each still took 3s wall-clock. KEPT: the async
 * transport (the more demanding copy, plan §4.1 step 2) — `await
 * listRunners(repo, {...})` costs a single caller nothing extra, so there was
 * no reason for `check-label-floor.mjs` to keep its own, slower-under-fan-out
 * copy once one implementation covers both.
 *
 * `attempts`/`describeFailure` are INJECTED rather than imported from
 * `queue-health.mjs` directly, on purpose: this module is `access` layer
 * (plan §3.1) and `queue-health.mjs` is `domain`/observation — importing it
 * here would be an upward import across layers (`layer-guard.test.mjs`
 * refuses it; this file's own first draft tried it and was caught by that
 * guard). Both callers already import `READ_ATTEMPTS`/`describeReadFailure`
 * from `queue-health.mjs` themselves (legal: they are domain-layer) and now
 * pass them through, so the retry COUNT and the failure-description POLICY
 * stay exactly `queue-health.mjs`'s, one number and one function, same as
 * before — this module only supplies the mechanism (the transport, the
 * timeout, the delay between attempts).
 *
 * Both copies already shared `READ_ATTEMPTS` and `describeReadFailure`
 * before this file existed; the retry LOOP and the `gh api` invocation
 * itself were the only things actually duplicated, byte for byte except for
 * that sync/async axis. `check-label-floor.mjs`'s own copy passed its raw
 * `execFileSync` catch error straight to `describeReadFailure`, so on a
 * `gh api` failure whose explanatory body printed to STDOUT rather than
 * stderr (common for a 404/422 from `gh api`) the reason was half-missing
 * there — exactly the gap `reconcile-fleet-runners.mjs`'s OWN comment already
 * named and fixed for itself by joining both streams. Moving
 * `check-label-floor.mjs` onto this shared implementation picks up that fix
 * too (pinned by `check-label-floor.test.mjs`'s "STDOUT ONLY" case).
 *
 * `{ok, runners}` / `{ok:false, error}` — never throws. `check-label-floor.mjs`
 * now throws on `!ok` itself, one line at the call site, rather than inside
 * this helper.
 */
import { execFile } from 'node:child_process';

/** A read that never finishes is a read that never reports (#80). */
export const GH_RUNNERS_READ_TIMEOUT_MS = 20_000;
/** Long enough for a blip to pass, short enough to be invisible at the measured 0.13% rate. */
export const GH_RUNNERS_RETRY_DELAY_MS = 1_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One `gh api repos/<repo>/actions/runners` read, ASYNC — `execFile`,
 * deliberately, not `execFileSync`: a synchronous child process blocks the
 * WHOLE event loop for as long as it runs, which is fatal for a fanned-out
 * caller and merely unnecessary for a serial one. `execFile`'s callback does
 * not block, so a caller's own concurrency (`pool(..., 8, ...)`) is real.
 */
function ghRunnersReadOnce(repo, timeoutMs, describeFailure) {
	return new Promise((resolve) => {
		execFile(
			'gh',
			['api', `repos/${repo}/actions/runners`, '--paginate'],
			{ encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs },
			(err, stdout, stderr) => {
				if (err) {
					resolve({
						ok: false,
						reason: describeFailure(
							{
								killed: err.killed,
								signal: err.signal,
								status: err.code,
								// BOTH STREAMS, joined — not stderr alone. A 404/422 from
								// `gh api` prints its JSON body (e.g.
								// `{"message":"Resource not accessible by integration"}`) to
								// STDOUT; stderr often carries only a generic "gh: ..." line.
								// Passing stderr alone into `describeFailure` would silently
								// reopen that gap.
								stderr: [stderr, stdout]
									.map((v) => String(v ?? '').trim())
									.filter(Boolean)
									.join(' '),
								message: err.message,
							},
							timeoutMs
						),
					});
					return;
				}
				resolve({ ok: true, out: stdout });
			}
		);
	});
}

/**
 * `gh api` exits non-zero on 404. For a runner listing a 404 means "no admin
 * on that repo", a real finding this does not distinguish from any other read
 * failure — the caller sees `{ok:false, error}` either way.
 *
 * Retried per `attempts` before it is reported `ok:false` (#80) — the same
 * shape `check-fleet-preflight.mjs` and `reconcile-runner-identity.mjs` carry
 * for their own `gh` reads. Failing every attempt is still unreadable:
 * retrying is NOT tolerating, and the reason carries `attempt N/M` so a
 * failure that survived the retry says so.
 *
 * `attempts` and `describeFailure` are REQUIRED, not defaulted — see this
 * module's own doc for why they are injected rather than imported.
 */
export async function listRunners(
	repo,
	{
		attempts,
		describeFailure,
		timeoutMs = GH_RUNNERS_READ_TIMEOUT_MS,
		retryDelayMs = GH_RUNNERS_RETRY_DELAY_MS,
	}
) {
	let reason = 'no attempt was made';
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const r = await ghRunnersReadOnce(repo, timeoutMs, describeFailure);
		if (r.ok) {
			try {
				// --paginate concatenates objects; the fleet is far under one page, but
				// parse defensively so a future 100+ runner repo does not silently break.
				const runners = r.out
					.split('\n')
					.filter(Boolean)
					.flatMap((chunk) => JSON.parse(chunk).runners ?? []);
				return { ok: true, runners };
			} catch (e) {
				return { ok: false, error: `gh returned unparseable JSON: ${e.message}`.slice(0, 200) };
			}
		}
		reason = `${r.reason} (attempt ${attempt}/${attempts})`;
		if (attempt < attempts) await sleep(retryDelayMs);
	}
	return { ok: false, error: reason.slice(0, 200) };
}
