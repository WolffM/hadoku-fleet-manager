// scripts/lib/runner-env-drift.mjs — #100/#101: pure classifier for
// ~/.hadoku/runner.env drift, pulled out of deploy-ci-throttle.mjs so it can
// be unit-tested without executing the driver (which reaches real nodes over
// ssh and has no hermetic path). The message text and shape below is the
// text the driver pushed inline before this extraction — see
// scripts/deploy-ci-throttle.mjs's runnerenv block, which now calls this
// instead of inlining the three cases. No existing message changed; this
// file only adds the fourth case (no token at all).

import { mintsJitRunners } from '../../dist/lib/node-role.js';

/**
 * @param {{name: string, ephemeral: boolean, summary: string}} args
 * @returns {string | null} a drift finding, or null if nothing is wrong.
 */
export function runnerEnvDrift({ name, ephemeral, summary }) {
	// "I could not look" must never render as "nothing is wrong": if the
	// node-half's SUMMARY line carries neither token, the script never reached
	// the point where it computes them (crashed, timed out, truncated output),
	// so this node's runner.env was never actually checked. Silence here would
	// read as "fine" to every caller that only tests for the other two cases.
	if (!/runnerenv=\d/.test(summary) || !/runnerenvkeys=\d/.test(summary)) {
		return (
			`${name}: could not read runner.env state — SUMMARY carried no ` +
			`runnerenv=/runnerenvkeys= token, so the node's runner.env ` +
			`was never checked`
		);
	}
	if (ephemeral === true && /runnerenv=0/.test(summary)) {
		return (
			`${name}: declares ephemeral but has no runner.env — every JIT job ` +
			`starts with no RUNNER_TOOL_CACHE, TMPDIR or NODE_COMPILE_CACHE on disk`
		);
	}
	if (/runnerenv=1/.test(summary) && /runnerenvkeys=0/.test(summary)) {
		return (
			`${name}: runner.env exists but is missing a required key ` +
			`(RUNNER_TOOL_CACHE, ACTIONS_RUNNER_HOOK_JOB_COMPLETED, TMPDIR or ` +
			`NODE_COMPILE_CACHE) — TMPDIR/NODE_COMPILE_CACHE absent means a JIT job's ` +
			`temp and compile cache land back on tmpfs`
		);
	}
	return null;
}

/**
 * #102: --confirm's own gate. A runner whose env was written but never
 * loaded ("STALE" in ci-throttle-install.sh's own vocabulary) must not read
 * as resolved just because the pass finished without an ssh error — the
 * driver was reporting success on exactly that state before this existed.
 *
 * Pulled out of deploy-ci-throttle.mjs for the same reason {@link
 * runnerEnvDrift} was: the driver reaches real nodes over ssh and has no
 * hermetic path to execute in a test.
 *
 * `staleRemaining` is the node half's own count (ci-throttle-install.sh's
 * `stale_remaining`): a stale listener this run did NOT clear — because it
 * was busy, because the restart it attempted failed, or because nothing was
 * attempted at all (a dry run, or --no-restart). `notes` are that node's own
 * per-directory lines (STALE/BUSY/RESTART-FAILED/NEEDS-OPERATOR/...), carried
 * verbatim so the reader sees WHICH directory and WHY, not just a count —
 * "I could not look" (or "I looked and it's still broken") must never
 * collapse into a bare number.
 *
 * @param {{name: string, staleRemaining: number, notes: string[]}} args
 * @returns {string[]} zero or more findings; empty means nothing remains on
 *   this node.
 */
export function staleRemainingFindings({ name, staleRemaining, notes }) {
	if (!staleRemaining) return [];
	// The dispositions a stale directory can end this run in: left alone
	// because it was busy, or a restart was attempted and failed (for any of
	// the reasons restart_dir() can fail — sudo refused, no unit, duplicate
	// listeners, the listener never came back).
	const dispositions = notes.filter((n) =>
		/^(BUSY|RESTART-FAILED|NEEDS-OPERATOR|NO-UNIT|NO-LISTENER|DUPLICATE-LISTENERS) /.test(n)
	);
	if (dispositions.length) {
		return dispositions.map(
			(line) => `${name}: stale listener remains (written but NOT LOADED) — ${line}`
		);
	}
	// Nothing explains why — most likely nothing was attempted at all (a dry
	// run, or --no-restart). Name the directory from the node's own STALE
	// line when it printed one, rather than only a count.
	const staleLines = notes.filter((n) => n.startsWith('STALE'));
	if (staleLines.length) {
		return staleLines.map(
			(line) => `${name}: stale listener remains (written but NOT LOADED, not attempted) — ${line}`
		);
	}
	return [`${name}: ${staleRemaining} runner(s) are still written but NOT LOADED after this run`];
}

/**
 * #98: the per-node SUMMARY rules `fleet throttle --check` applies, pulled out
 * of deploy-ci-throttle.mjs for the same reason as the two above.
 *
 * EVERY RULE REQUIRES THE GOOD VALUE. Until #98's mutation pass these tested
 * for the BAD one — `/conf=0/`, `/harvest=0/`, `/jit=0/` — so a token that was
 * missing, empty or garbage matched none of them and the node passed. A node
 * half that crashed between two echoes, or a SUMMARY that lost a token to a
 * rename, read as a clean node. Now `1` passes, `0` is the finding it always
 * was, and anything else is "could not read X": a separate finding, because
 * "it is off" and "I never saw whether it is on" send the reader to different
 * places. Same for the counts: `newly`/`stale`/`nolistener` must be integers,
 * and `stale` is judged on its own — it was only computed inside `newly > 0`.
 *
 * THE CONF IS JUDGED BY VALUE, NOT PRESENCE. The node half reports what the
 * hook would ENFORCE (`conf_max`/`conf_minfree`, after the hook's own
 * fallback of a non-integer to 99/0) and the conf's sha256. A value that is
 * not the manifest's is a node enforcing a limit nobody declared; a hash that
 * differs with the values right is a conf whose other lines moved (MAX_WAIT_S,
 * RESERVE_FILE). Both mean ONE thing — "the manifest moved and this node was
 * not re-deployed" — so a node gets at most one conf-content finding, and it
 * is never folded into the shipped-file provenance check, whose mismatch
 * means something else (RENDERED_NOT_SHIPPED in script-provenance.mjs).
 *
 * @param {{
 *   name: string,
 *   m: { maxConcurrent: number, minFreeMb: number, ephemeral?: boolean },
 *   kv: Record<string, string> | null,
 *   wantConfSha: string,
 * }} args `kv` is `parseSummary(out)`; `wantConfSha` the sha256 of the conf
 *   this run renders for the node.
 * @returns {string[]} zero or more findings.
 */
export function throttleSummaryDrift({ name, m, kv, wantConfSha }) {
	if (!kv) {
		return [
			`${name}: the node half produced no SUMMARY line, so this run did not finish — ` +
				`nothing about this node was verified`,
		];
	}
	const findings = [];
	const unread = (token, what) =>
		findings.push(
			`${name}: could not read ${what} — SUMMARY carried ${token}=${kv[token] ?? '(no token)'}, ` +
				`so it was never checked`
		);

	// The hook silently runs UNLIMITED when it cannot read its own config,
	// because it never fails a job by design. So the audit has to ask whether
	// the config LOADS, not whether we wrote the .env line that points at it.
	if (kv.conf === '0') {
		findings.push(
			`${name}: the throttle hook cannot load its config — it runs with NO limit ` +
				`(MAX_CONCURRENT=99, MIN_FREE_MB=0) and never says so`
		);
	} else if (kv.conf !== '1') {
		unread('conf', 'whether the throttle hook can load its config');
	} else {
		const want = { conf_max: String(m.maxConcurrent), conf_minfree: String(m.minFreeMb) };
		const label = { conf_max: 'MAX_CONCURRENT', conf_minfree: 'MIN_FREE_MB' };
		const missing = Object.keys(want).filter((k) => !/^\d+$/.test(kv[k] ?? ''));
		const moved = Object.keys(want).filter((k) => !missing.includes(k) && kv[k] !== want[k]);
		for (const k of missing) unread(k, `the ${label[k]} the hook enforces`);
		if (moved.length) {
			findings.push(
				`${name}: the throttle hook enforces ` +
					moved.map((k) => `${label[k]}=${kv[k]} (manifest: ${want[k]})`).join(', ') +
					` — the manifest moved and this node was not re-deployed, so it runs a limit ` +
					`nobody declared (fix: fleet throttle --confirm)`
			);
		} else if (!missing.length) {
			const sha = kv.confsha;
			if (sha === undefined || sha === 'absent' || sha === 'unreadable' || sha === '') {
				unread('confsha', "the throttle conf's bytes");
			} else if (sha !== wantConfSha) {
				findings.push(
					`${name}: the node's ci-throttle.conf is not what the manifest renders for it ` +
						`(node ${sha}, rendered ${wantConfSha}) though its limits match — another line ` +
						`moved (MAX_WAIT_S or RESERVE_FILE) and this node was not re-deployed ` +
						`(fix: fleet throttle --confirm)`
				);
			}
		}
	}

	// THE SAMPLER MUST BE RUNNING, not merely present. The 2026-09-22 finding
	// (#47) was units `active`-but-silent on three claws and no sampler at all
	// on five more: a hash-only check blesses a stopped unit on the second and
	// cannot see the first at all. Whether the sampler is actually COLLECTING
	// is `fleet mem-report --check`'s to answer, not this one's.
	if (kv.harvest === '0') {
		findings.push(
			`${name}: the memory harvester unit is not active — the sampler is deployed ` +
				`but not sampling. Re-run fleet throttle --confirm (it starts the unit); ` +
				`fleet mem-report --check then verifies it is collecting, not just up`
		);
	} else if (kv.harvest !== '1') {
		unread('harvest', 'whether the memory harvester unit is active');
	}

	// `mintsJitRunners`, not `ephemeral === true`: an on-demand guest (#120) is
	// minted for exactly like a claw and fails at step one exactly the same way.
	if (mintsJitRunners(m)) {
		// An ephemeral node with no provisioner fails EVERY mint at step one, and
		// the dispatcher reports that as a mint failure on a healthy-looking box.
		if (kv.jit === '0') {
			findings.push(
				`${name}: declares ephemeral but has no ~/.hadoku/jit-provision.sh — every mint would fail`
			);
		} else if (kv.jit !== '1') {
			unread('jit', 'whether the JIT provisioner is installed');
		} else if (kv.payload === '0') {
			// The provisioner being present is not the same as the node being able
			// to mint. A payload is self-healing (jit-provision.sh fetches a release
			// when the caller supplies RUNNER_TARBALL_URL), so this is drift rather
			// than a hard failure.
			findings.push(
				`${name}: declares ephemeral and has the provisioner, but NO JIT payload ` +
					`(~/.hadoku/jit/payload/bin/Runner.Listener). Its next mint must bootstrap one ` +
					`from a runner release; if that URL cannot be resolved every mint fails at step one`
			);
		} else if (kv.payload !== '1') {
			unread('payload', 'whether the JIT payload is present');
		}
	}

	const count = (token) => (/^\d+$/.test(kv[token] ?? '') ? Number(kv[token]) : null);
	const newly = count('newly');
	const stale = count('stale');
	const nolistener = count('nolistener');
	if (newly === null) unread('newly', 'how many runners have the wrong env on disk');
	if (stale === null) unread('stale', 'how many runners have their env written but not loaded');
	if (nolistener === null) unread('nolistener', 'how many runners have no live listener');
	// `stale` is a subset of `newly` on the node side, so `wrong` is what is left
	// over — a runner whose .env is wrong, not merely unloaded.
	if (newly !== null && stale !== null && newly - stale > 0) {
		findings.push(`${name}: ${newly - stale} runner(s) have the wrong env on disk`);
	}
	// "Not wired" and "wired but not yet loaded" are different states and need
	// different messages. Judged on its own, never only when `newly > 0`: a
	// SUMMARY that lost its `newly` token must not hide a stale count beside it.
	if (stale !== null && stale > 0) {
		findings.push(
			`${name}: ${stale} runner(s) have the correct env written but NOT LOADED — ` +
				`Runner.Listener reads .env once at start, so these need a unit restart. For a ` +
				`claw's systemctl --user units the fix IS fleet throttle --confirm itself — it ` +
				`stops an idle one and lets the warm pass or the unit refill it, leaving a busy ` +
				`one alone and reported. A guest node has no passwordless sudo and is never ` +
				`reached by this command at all (role skip, above), so a stale listener there ` +
				`needs an operator.`
		);
	}
	// A .env that is byte-for-byte correct is not proof anything is listening.
	// Counted SEPARATELY from `newly` on the node side, so it never reads as
	// "wrong env on disk".
	if (nolistener !== null && nolistener > 0) {
		findings.push(
			`${name}: ${nolistener} runner dir(s) have the correct env but NO live Runner.Listener — ` +
				`neither "wrong on disk" (the env is right) nor "written but NOT LOADED" (there is no ` +
				`listener to have missed it); a stopped or crashed runner, not something --confirm ` +
				`restarts — restart_dir() refuses it (NO-LISTENER) rather than resurrecting a runner ` +
				`nothing intends to be running.`
		);
	}
	return findings;
}
