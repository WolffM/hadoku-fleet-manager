/**
 * floor-probe's §6 shadow-dispatch safety rule — split out of `floor-probe.mjs`
 * (wave 5q lane A, pure move) so that file reaches the 800-line ceiling. No IO
 * here either; see that file's own header for why the split exists at all.
 */

// ---------------------------------------------------------------------------
// §6 — never a consumer's only attempt
// ---------------------------------------------------------------------------

/**
 * Things a workflow must not do if the harness is going to dispatch it.
 *
 * A REFUSAL LIST, NOT AN APPROVAL LIST, and the distinction is the whole safety
 * argument. The primary control is that the operator names the workflow: this
 * command is operator-invoked, single repo, no cron. This backstop exists
 * because the one workflow anybody would reach for first — hadoku-pygmalion's
 * `redeploy.yml`, which holds the `test` job issue #3 is actually about — ends
 * in a `dispatch-redeploy` job that POSTs `repository_dispatch: redeploy_service`
 * to hadoku_site and takes the production pygmalion service down and back up.
 * A "shadow" run that redeploys prod is not a shadow run.
 *
 * `tests.yml` in the same repo runs the SAME timing-sensitive test with no
 * deploy on the end, which is why the probe aims there.
 */
const UNSAFE_TOKENS = [
	{ re: /repository_dispatch/i, why: 'triggers or sends a repository_dispatch' },
	{ re: /\/dispatches\b/i, why: 'POSTs to a dispatches endpoint' },
	{ re: /\bpm2\s+(restart|start|stop|reload)/i, why: 'touches a live PM2 service' },
	{ re: /\b(npm|pnpm|yarn)\s+publish\b/i, why: 'publishes a package' },
];

/**
 * May the harness dispatch this workflow as a shadow run?
 *
 * `body` is the workflow yaml WITH ITS COMMENTS ALREADY BLANKED — see
 * `blank-comments.mjs`. This repo has read a COMMENT as evidence three separate
 * times, and every one of the tokens above appears in prose in at least one
 * fleet workflow. A raw grep would refuse `tests.yml`, whose only mention of a
 * dispatch is a comment pointing at the workflow this list exists to refuse.
 */
export function shadowSafety(body) {
	const src = String(body ?? '');
	if (!/^\s*workflow_dispatch\s*:/m.test(src)) {
		return { ok: false, reason: 'no workflow_dispatch trigger — it cannot be dispatched at all' };
	}
	// Remove the trigger itself before looking for the dangerous kind: every
	// dispatchable workflow contains the word.
	const withoutTrigger = src.replace(/workflow_dispatch/g, '');
	for (const { re, why } of UNSAFE_TOKENS) {
		if (re.test(withoutTrigger)) return { ok: false, reason: why };
	}
	return { ok: true, reason: null };
}
