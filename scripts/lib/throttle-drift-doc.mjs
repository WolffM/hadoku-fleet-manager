/**
 * throttle-drift-doc.mjs — classifies `deploy-ci-throttle.mjs --check`'s own
 * `drift` array into a GateDoc's `findings`/`unreadable` halves (wave 5i
 * lane B).
 *
 * PULLED OUT FOR THE SAME REASON `runner-env-drift.mjs` was (see that file's
 * own header): `deploy-ci-throttle.mjs` reaches real nodes over ssh and has
 * no hermetic path to execute in a test, so the one new piece of logic this
 * migration adds — turning a `drift` string into a `{ node, kind, reason }`
 * finding or a `{ node, why }` unreadable — lives here instead, where it can
 * be unit-tested as a pure function.
 *
 * Every `drift` entry is built as `` `${node}: ...` `` by `deploy-ci-throttle.mjs`
 * itself, `runner-env-drift.mjs` or `script-provenance.mjs` — never
 * reformatted here, just classified and the leading node name lifted back
 * out.
 *
 * "I COULD NOT LOOK", MATCHED BY THE MESSAGE ITSELF rather than re-threading
 * a `{ unreadable }` flag through every one of those files' push sites (out
 * of scope for this gate's own migration — `runner-env-drift.mjs` and
 * `script-provenance.mjs` are shared with other consumers). Every one of
 * those files' own "could not look" messages already carries one of these
 * markers by construction — `could not read`, `could not hash`, `could not
 * be reached`, `was never checked`, or `nothing about ... was
 * verified/checked` (`fileDrift`'s unreadable branch via `provenanceDrift`,
 * `runnerEnvDrift`'s first branch, `throttleSummaryDrift`'s own `unread()`
 * helper and its no-SUMMARY branch, the standing-env "never reached the
 * rule" case, and the obsolete-file-unreadable case) — so matching the
 * prose is exactly as reliable as matching a flag these functions don't
 * carry, without changing either shared module.
 */

const UNREADABLE_DRIFT =
	/could not read|could not hash|could not be reached|was never checked|nothing about .* was (verified|checked)|never reached the standing-env rule/i;

/**
 * @param {string[]} entries `drift`, as `deploy-ci-throttle.mjs --check` built it.
 * @returns {{ findings: {node: string|null, kind: string, reason: string}[],
 *             unreadable: {node: string|null, why: string}[] }}
 */
export function classifyDrift(entries) {
	const findings = [];
	const unreadable = [];
	for (const entry of entries) {
		const node = /^(\S+): /.exec(entry)?.[1] ?? null;
		if (UNREADABLE_DRIFT.test(entry)) unreadable.push({ node, why: entry });
		else findings.push({ node, kind: 'throttle-drift', reason: entry });
	}
	return { findings, unreadable };
}
