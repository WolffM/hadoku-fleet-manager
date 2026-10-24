/**
 * Strip YAML comments, so PROSE ABOUT a rule cannot satisfy or violate the rule.
 *
 * Two gates in this fleet have now been fooled the same way, in opposite
 * directions, and both times the comment was written to be helpful:
 *
 *   - `reconcile-repo-policy.mjs` matched `author_association` against raw
 *     source, so a workflow could clear a security rule by MENTIONING it. Every
 *     guarded workflow in the fleet explains itself in a comment directly above
 *     the guard, so deleting the guard and keeping the comment kept the repo
 *     green.
 *   - `targetsSelfHostedFleet` matched `self-hosted` against raw source. On
 *     2026-08-30 three repos were moved OFF the fleet and annotated with a
 *     comment saying, in as many words, that `self-hosted,hadoku-builder` here
 *     queues forever. The reconciler read that as evidence they wanted fleet
 *     runners, planned nine registration pairs, blew the safety cap, and paged
 *     @here — for three repos whose workflows say `ubuntu-latest`.
 *
 * The rule is the same one `check-gate-coverage.mjs` enforces for cron
 * profiles: only executable content may be evidence.
 *
 * LINE-BASED and deliberately simple. `#` opens a comment only at the start of
 * a line or after whitespace, so a `#` inside a token — `ubuntu-latest#1`, a URL
 * fragment, a colour literal — is left alone. Newlines are preserved so a line
 * number in a finding still points where the reader expects.
 *
 * It does NOT parse YAML, so a `#` inside a quoted scalar is stripped too. That
 * is the safe direction for an evidence test: the worst case is a rule failing
 * to fire on a value that mentions it inside a string, never a comment making a
 * rule fire or clear.
 */
/**
 * `\r\n` and a lone `\r` become `\n`. Every reader here splits on `\n` and
 * anchors on `$`, so a CRLF line keeps a trailing `\r` and a key never matches:
 * a CRLF working tree of secretProject read as a workflow with NO jobs
 * (fleet-manager#5). A Windows-edited or `core.autocrlf` clone is an ordinary
 * thing for `REPOS_DIR` to hold, so it is normalised where workflow text comes
 * in, not left to each reader.
 */
export function normalizeEol(text) {
	return text.replace(/\r\n?/g, '\n');
}

export function stripYamlComments(body) {
	return normalizeEol(body)
		.split('\n')
		.map((line) => line.replace(/(^|\s)#.*$/, '$1'))
		.join('\n');
}
