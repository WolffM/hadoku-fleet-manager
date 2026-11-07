// The promoter's decision, with no I/O: what to fast-forward `main` to, and
// which `ppe` push to revert. promote.mjs gathers the facts (git for history,
// the GitHub API for checks and push times) and acts on what this returns.
//
// Everything here is a pure function of its input so that every branch of the
// decision is a unit test (decide.test.mjs), not a reading of inline bash.

export const WINDOW_MS = 30 * 60_000;
export const QUIET_MS = 10 * 60_000;
/** Trailer a promoter revert carries, naming the red push tip it reverted. */
export const REVERTS_TRAILER = 'Reverts-Push';
export const PROMOTER_SESSION = 'ppe-promoter';
/**
 * Attempts a red push gets before it is reverted. One red is not a verdict: on
 * 11-02 5b02cdc was reverted over a timing test that failed under load on
 * claw-1 and passed everywhere else (fleet-manager#68). A red attempt below
 * this is re-run on a fresh (ephemeral) runner instead; a red at it reverts.
 */
export const MAX_ATTEMPTS = 2;

const SUCCESS = new Set(['success', 'neutral', 'skipped']);
const FAILURE = new Set(['failure', 'timed_out', 'action_required', 'startup_failure', 'error']);
// Not a verdict on the code: concurrency superseded it, or GitHub gave up on it.
const UNTESTED = new Set(['cancelled', 'stale']);

/**
 * One check run (`{status, conclusion}`) or commit status (`{state}`) as
 * success | failure | pending | missing.
 */
export function checkState(c) {
	if (!c) return 'missing';
	if ('state' in c) {
		if (c.state === 'success') return 'success';
		if (c.state === 'failure' || c.state === 'error') return 'failure';
		return 'pending';
	}
	if (c.status !== 'completed') return 'pending';
	if (SUCCESS.has(c.conclusion)) return 'success';
	if (FAILURE.has(c.conclusion)) return 'failure';
	if (UNTESTED.has(c.conclusion)) return 'missing';
	return 'pending';
}

/**
 * A commit's verdict from its required contexts' states.
 *
 * green: every required context passed. red: any failed. untested: none
 * reported at all (a commit inside a push, or a push whose run was cancelled).
 * pending: anything else, including some reported and some not yet.
 *
 * @param {Record<string, string>} states  context -> checkState()
 * @param {string[]} required
 */
export function commitVerdict(states, required) {
	const s = required.map((r) => states[r] ?? 'missing');
	if (s.includes('failure')) return 'red';
	if (s.every((x) => x === 'success')) return 'green';
	if (s.every((x) => x === 'missing')) return 'untested';
	return 'pending';
}

/** The value of the last `Key: value` trailer line in a commit message, or null. */
export function trailer(message, key) {
	const re = new RegExp(`^${key}:[ \\t]*(.+)$`, 'gim');
	let v = null;
	for (const m of message.matchAll(re)) v = m[1].trim();
	return v;
}

export const subject = (message) => message.split('\n', 1)[0].trim();
const short = (sha) => sha.slice(0, 7);

/**
 * @typedef {{
 *   sha: string, parents: string[], message: string, verdict: string, failing?: string[],
 *   run?: { id: number, attempt: number, runner: string | null } | null,  // the Actions run behind the failing (or green) required check; null = not an Actions check
 * }} Entry
 * @typedef {{
 *   chain: Entry[],          // ppe's first-parent commits not on main, NEWEST first, down to and including the newest green (or all of them)
 *   mainAhead: number,       // commits on main that ppe lacks (a bot push not yet synced)
 *   force: boolean,
 *   nowMs: number,
 *   lastMainPushMs: number | null,  // null = main not pushed inside GitHub's activity window: long ago
 *   lastPpePushMs: number | null,
 *   windowMs?: number,
 *   quietMs?: number,
 * }} Facts
 */

/**
 * @param {Facts} f
 * @returns {{
 *   promote: { sha: string, reason: string } | null,
 *   revert: { culprit: string, commits: Entry[], failing: string[], run: Entry['run'] } | null,
 *   rerun: { sha: string, run: { id: number, attempt: number, runner: string | null }, failing: string[] } | null,
 *   human: { sha: string, reason: string } | null,
 *   notes: string[],
 * }}
 */
export function decide(f) {
	const windowMs = f.windowMs ?? WINDOW_MS;
	const quietMs = f.quietMs ?? QUIET_MS;
	const notes = [];
	const out = { promote: null, revert: null, rerun: null, human: null, notes };

	const gIdx = f.chain.findIndex((e) => e.verdict === 'green');
	const green = gIdx === -1 ? null : f.chain[gIdx];
	// Everything newer than the newest green, oldest first.
	const above = (gIdx === -1 ? f.chain : f.chain.slice(0, gIdx)).slice().reverse();

	scanForRed(above, out);

	if (!green) {
		notes.push(f.chain.length ? 'no green commit on ppe above main' : 'ppe has nothing main lacks');
	} else if (f.mainAhead > 0) {
		notes.push(
			`main has ${f.mainAhead} commit(s) ppe lacks; promotion waits for sync-main-to-ppe to merge them`
		);
	} else {
		const reason = cadence(f, windowMs, quietMs);
		if (reason) out.promote = { sha: green.sha, reason };
		else
			notes.push(
				`${short(green.sha)} is green, but main moved under ${windowMs / 60_000} min ago and ppe is not yet quiet for ${quietMs / 60_000} min`
			);
	}
	return out;
}

function cadence(f, windowMs, quietMs) {
	if (f.force) return 'forced';
	if (f.lastMainPushMs === null || f.nowMs - f.lastMainPushMs >= windowMs)
		return `main last moved ${f.lastMainPushMs === null ? 'outside the activity window' : `${Math.floor((f.nowMs - f.lastMainPushMs) / 60_000)} min ago`}`;
	if (f.lastPpePushMs === null || f.nowMs - f.lastPpePushMs >= quietMs)
		return `ppe quiet for ${f.lastPpePushMs === null ? 'longer than the activity window' : `${Math.floor((f.nowMs - f.lastPpePushMs) / 60_000)} min`}`;
	return null;
}

/**
 * The first red PUSH since the newest green: its tip is the oldest red tested
 * commit, and its commits run back to the next older tested commit. CI runs
 * once per push, so that range is exactly what one push brought.
 *
 * A red the promoter already reverted is skipped (a later commit carries its
 * trailer), so a second run in the window between the revert landing and its
 * CI finishing does not revert the same push twice.
 */
function scanForRed(above, out) {
	for (let i = 0; i < above.length; i++) {
		const r = above[i];
		if (r.verdict !== 'red') continue;
		if (trailer(r.message, REVERTS_TRAILER)) {
			out.human = {
				sha: r.sha,
				reason: `the promoter's own revert ${short(r.sha)} is red: reverting the revert would only restore the push it removed`,
			};
			return;
		}
		const later = above.slice(i + 1);
		const handled = later.findIndex((e) => trailer(e.message, REVERTS_TRAILER) === r.sha);
		if (handled !== -1) {
			// Commits between the red push and its revert inherited the red; the
			// scan resumes at the revert itself.
			i = i + 1 + handled - 1;
			continue;
		}
		let start = i;
		while (start > 0 && above[start - 1].verdict === 'untested') start--;
		const commits = above.slice(start, i + 1).reverse(); // newest first, the order git reverts in
		const merge = commits.find((e) => e.parents.length > 1);
		if (merge) {
			out.human = {
				sha: r.sha,
				reason: `the red push ${short(r.sha)} contains the merge ${short(merge.sha)} (${subject(merge.message)}); a merge is not reverted unattended`,
			};
			return;
		}
		// A first red is re-run, not reverted. Only an Actions run can be re-run;
		// a red from anything else (a commit status, an app) reverts as before.
		if (r.run && r.run.attempt < MAX_ATTEMPTS) {
			out.rerun = { sha: r.sha, run: r.run, failing: r.failing ?? [] };
			out.notes.push(
				`${short(r.sha)} is red on attempt ${r.run.attempt}${r.run.runner ? ` (${r.run.runner})` : ''}: re-running its failed jobs before any revert`
			);
			return;
		}
		out.revert = { culprit: r.sha, commits, failing: r.failing ?? [], run: r.run ?? null };
		return;
	}
}

/** The message for the single commit that reverts a red push. */
export function revertMessage(revert) {
	const n = revert.commits.length;
	const lines = [
		`Revert ppe push ${short(revert.culprit)}: ${revert.failing.length ? revert.failing.join(', ') : 'required checks'} red`,
		'',
		revert.run
			? `The promoter found this push red on ppe on ${revert.run.attempt} attempt(s), the last on ${revert.run.runner ?? 'an unnamed runner'}, and reverted its ${n} commit(s), newest first:`
			: `The promoter found this push red on ppe and reverted its ${n} commit(s), newest first:`,
		'',
		...revert.commits.map(
			(e) =>
				`  ${short(e.sha)} ${subject(e.message)} (Session: ${trailer(e.message, 'Session') ?? 'none'})`
		),
		'',
		'Re-push the fix on top of this commit; never revert this revert.',
		'',
		`${REVERTS_TRAILER}: ${revert.culprit}`,
		`Session: ${PROMOTER_SESSION}`,
	];
	return lines.join('\n') + '\n';
}

/** Distinct `Session:` trailers of a revert's commits, in order. */
export function sessions(revert) {
	return [
		...new Set(revert.commits.map((e) => trailer(e.message, 'Session')).filter((s) => s !== null)),
	];
}
