/**
 * expected-down — is this node unreachable ON PURPOSE?
 *
 * THE PROBLEM THIS SOLVES. Every reachability gate in this repo fails on a
 * machine it cannot reach, and that is correct: "I could not look" must never
 * render as "nothing is wrong." But it cannot tell a node that DIED from one a
 * human deliberately powered off. claw-8 was shut down on 2026-09-09 with a
 * failed cooler, drained, with a written reason — and `provision --verify-only`,
 * `toolchain` and `preflight` all went red and would have stayed red for as
 * long as the replacement part was on order.
 *
 * Permanently red gates are not a safety property. They are how an operator
 * learns to stop reading gates, and then the real failure arrives into a channel
 * nobody trusts. That is the actual risk being managed here.
 *
 * WHY THIS DOES NOT MAKE THE GATE EASIER THE WORSE THINGS GET
 * ----------------------------------------------------------
 * That rule is written in CLAUDE.md and it was bought with an outage, so it gets
 * argued explicitly rather than assumed:
 *
 *   1. ONLY AN EXPLICIT, DATED, HUMAN DECISION DEFERS. `kind: maintenance`
 *      means "a human took it out and a human puts it back" (drain-node.mjs).
 *      An undrained node that vanishes still fails, loudly, exactly as before.
 *
 *   2. `kind: training` DOES NOT DEFER. A node in bootcamp is earning its
 *      labels, which means it is supposed to be RUNNING. If it is unreachable
 *      that is a real fault, and deferring it would hide the one case where
 *      unreachability is most surprising.
 *
 *   3. A DRAIN THAT CANNOT BE DATED DOES NOT DEFER. Without a parseable
 *      `since` there is no way to bound the deferral, and an unbounded
 *      deferral is exactly the silencer this must not become.
 *
 *   4. THE DEFERRAL EXPIRES. Past DEFER_DAYS the node fails again, and the
 *      finding says how long it has been dark. This is the same shape as the
 *      age band in queue-health (`ZOMBIE_SECONDS`): the passage of time must
 *      make a gate STRICTER, never more forgiving. Without it, `fleet drain`
 *      becomes a way to delete a machine from every gate forever.
 *
 * So the deferral is narrow: a human said so, in writing, recently, for a node
 * held out of service. Everything else fails.
 *
 * NOT ONLY REACHABILITY. `reconcile-runner-identity` asks the same question
 * about a REGISTRATION rather than an ssh: a drained node keeps its persistent
 * registrations, so draining claw-8 turned 27 repos into 27 registered-no-install
 * findings and pinned that gate red. The four rules above are what let the same
 * helper answer both; a registration-side caller must add its OWN narrowing on
 * top (there, a registration that claims to be `online` is never deferred,
 * drained or not — a drained node cannot also be serving).
 *
 * WHAT A CALLER MUST DO WITH THE THROW. `readDrains()` throws rather than
 * returning `{}` when the file exists and cannot be read or parsed, and a caller
 * must render that as a FINDING, not as "nothing is drained". Defaulting to
 * "nothing is drained" is the strict direction, which is exactly why it is
 * tempting — but it silently re-attributes every deferred finding to the fleet
 * when the thing that broke was one file. "I could not look" is its own answer.
 *
 * NOTE ON THE FILE READ. `fleet-drain.json` is opened in six other places with
 * slightly divergent logic (drain-node, traffic-status, check-label-floor,
 * check-warm-canary, floor-probe, src/runners/drain.ts). That is the shape that
 * gave `isLocalNode()` five implementations and only one that survived an FQDN.
 * They are not consolidated here — that is a separate change — but new callers
 * should use `readDrains()` rather than adding a seventh.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { manifest, stateDir } from './paths.mjs';
import { effectiveDrains, parseDrainDoc, pruneDrainDoc } from '../../dist/runners/drain.js';

/**
 * How long a deliberate power-off may suppress a reachability finding.
 *
 * A week is long enough to order and fit a part, and short enough that a node
 * quietly forgotten in the drain file resurfaces while someone still remembers
 * why it went in.
 */
export const DEFER_DAYS = 7;

/** Where `fleet drain` writes. New location wins; the pre-2026-09-04 copy is honoured. */
export function drainFilePath() {
	return [join(stateDir(), 'fleet-drain.json'), manifest('fleet-drain.json')].find((c) =>
		existsSync(c)
	);
}

/**
 * The whole drain file — current records, planned ones, and lapsed ones a
 * writer has not pruned yet. A parse failure THROWS. Reporting "nothing is
 * drained" from a corrupt file would silently un-defer every node, which is the
 * safe direction here, but it would also silently un-DRAIN them everywhere else
 * that reads this file.
 */
export function readDrainDoc() {
	const p = drainFilePath();
	return p ? parseDrainDoc(readFileSync(p, 'utf8')) : { nodes: {}, planned: [] };
}

/**
 * The one script-side WRITE, shared by `fleet drain` and `fleet hosting`.
 * Lapsed records are pruned on the way out. Always to the state dir; the
 * legacy copy is removed so exactly one file answers afterwards.
 */
export function writeDrainDoc(doc) {
	const p = join(stateDir(), 'fleet-drain.json');
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(
		p,
		`${JSON.stringify({ $comment: 'Nodes held out of service. The fast loop and the dispatcher both read this. Lives in the state dir, NOT a git checkout.', ...pruneDrainDoc(doc) }, null, 2)}\n`
	);
	const legacy = manifest('fleet-drain.json');
	if (legacy !== p && existsSync(legacy)) rmSync(legacy, { force: true });
}

/**
 * The canonical read: what is held RIGHT NOW. A lease past its `until` is gone
 * and a planned drain past its `from` is in force — `effectiveDrains` in
 * src/runners/drain.ts, the same function the dispatcher reads through, so a
 * script and the dispatcher can never disagree about whether a lease ended.
 */
export function readDrains(now = Date.now()) {
	return effectiveDrains(readDrainDoc(), now);
}

/**
 * Should an unreachable `node` be deferred rather than failed?
 *
 * @returns {{deferred: boolean, why: string, since?: string, ageDays?: number,
 *            reason?: string, kind?: string}}
 *          `deferred: false` always carries a `why` the caller can print, so a
 *          node that is drained but NOT deferrable does not look identical to
 *          one that was never drained.
 */
export function deferralFor(node, drains, now = Date.now()) {
	const rec = (drains ?? {})[node];
	if (!rec) return { deferred: false, why: 'not drained' };

	const kind = rec.kind ?? 'maintenance';
	if (kind !== 'maintenance') {
		return { deferred: false, kind, why: `drained as '${kind}', which is expected to be RUNNING` };
	}

	const since = Date.parse(rec.since ?? '');
	if (!Number.isFinite(since)) {
		return {
			deferred: false,
			kind,
			why: 'drain has no parseable `since`, so it cannot be bounded',
		};
	}

	const ageDays = (now - since) / 86_400_000;
	if (ageDays > DEFER_DAYS) {
		return {
			deferred: false,
			kind,
			since: rec.since,
			ageDays,
			reason: rec.reason,
			why: `drained ${ageDays.toFixed(0)} days ago, past the ${DEFER_DAYS}-day deferral — is it coming back?`,
		};
	}

	return {
		deferred: true,
		kind,
		since: rec.since,
		ageDays,
		reason: rec.reason,
		why: `drained for maintenance ${ageDays < 1 ? 'today' : `${ageDays.toFixed(0)}d ago`}`,
	};
}

/** One line a gate can print for a deferred node, so it is VISIBLE, not silent. */
export function deferralNote(node, d) {
	const r = d.reason ? ` — ${String(d.reason).split('.')[0]}` : '';
	return `expected down: ${node} ${d.why}${r}`;
}
