/**
 * DRAIN — take a node out of service without killing what it is doing.
 *
 * "Stop giving this box new work, let it finish what it has, tell me when it is
 * idle." That is what you want before a stress test, a reseat, a disk swap, or
 * a kernel that needs a reboot.
 *
 * IT NEEDS TWO ENFORCEMENT POINTS, BECAUSE THE FLEET HAS TWO WAYS OF ASSIGNING
 * WORK, and a drain that only implements one is worse than none — it reports
 * success while the node keeps building.
 *
 *   ephemeral nodes (claw-1, claw-3): the DISPATCHER mints a runner per job, so
 *     placement can simply refuse. Clean, immediate, and nothing external has to
 *     agree.
 *
 *   standing registrations (claw-2, claw-4, claw-5, claw-6, hokon): GITHUB
 *     assigns straight to the runner by label. The dispatcher never sees those
 *     jobs and cannot gate them. The ONLY lever is the `hadoku-builder` label —
 *     "a runner with no haduku-builder label is INVISIBLE to GitHub"
 *     (fleet-loop.ts) — so a drain has to strip it.
 *
 * Five of the seven nodes are the second kind, including claw-2, which is tier0
 * and the busiest box in the fleet. A placement-only drain would have looked
 * like it worked on every one of them.
 *
 * WHY THIS IS PERSISTED AND backstop-hold IS NOT
 * ----------------------------------------------
 * runners/backstop-hold.ts is deliberately in-memory, and its reasoning is
 * sound for what it holds: it is "a statement about what this process did a few
 * seconds ago", so a restarted process correctly believes it has promoted
 * nothing.
 *
 * A drain is the opposite kind of fact. It is an OPERATOR'S INTENTION about a
 * physical machine — somebody is about to open the case — and it must outlive
 * an mgmt-api restart, a deploy, and a crash. A drain that quietly lapsed
 * because a process bounced would put jobs back on a box with its lid off.
 * So it lives on disk, in the manifest directory, beside the other operator
 * state.
 *
 * DRAINING IS NOT DRAINED. `draining` means no new work is being accepted;
 * `drained` means that AND nothing is still running. Only the second one is
 * safe to start maintenance on, and the difference is the entire point of the
 * word "soft" — so the two are never collapsed into one boolean.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { manifest, stateDir } from '../host.js';

/** One node's drain record. Reasons are required; a drain nobody can explain gets undone. */
export interface DrainRecord {
	since: string;
	reason: string;
	by: string;
}

export type DrainState = Record<string, DrainRecord>;

const FILE = 'fleet-drain.json';

/**
 * A drain lives in the STATE directory, not the manifest directory.
 *
 * The distinction is the whole bug. `manifestDir` is a path INSIDE a git
 * checkout, and there are two of those: the operator works in
 * ~/repos/hadoku_site and mgmt-api reads ~/srv/hadoku_site. So `fleet drain`
 * run by a human wrote its file into the operator's checkout and the dispatcher
 * — which resolves the other one — never saw it. Measured 2026-09-04: claw-5
 * had been drained since 21:58Z the previous evening for a DRAM fault, the file
 * existed only under ~/repos, and claw-5 went on serving jobs the entire time.
 * A drain that does not reach the dispatcher is not a soft close, it is a note
 * to nobody.
 *
 * `stateDir` is a single absolute location (~/.hadoku-mgmt) that does not depend
 * on which checkout a command was invoked from, so the CLI writes exactly where
 * the dispatcher reads. It is also where every other fact of this kind already
 * lives — job-history, the runner-health ledger and snapshot — which is the
 * company this one should always have kept.
 *
 * Note this was NOT a deploy deleting the file, the earlier reading of it:
 * `git reset --hard` does not remove untracked files and no deploy path runs
 * `git clean`. It never arrived.
 */
const drainPath = (): string => join(stateDir(), FILE);

/**
 * The pre-2026-09-04 location, read ONLY as a fallback.
 *
 * A drain is a safety fact about a physical machine, so the migration cannot be
 * "start looking in the new place and hope". Any drain an operator set before
 * the move must keep being honoured until something rewrites it, or the upgrade
 * itself would silently un-drain a box somebody is about to open.
 */
const legacyDrainPath = (): string => manifest(FILE);

/**
 * Read the drain set.
 *
 * A MISSING FILE IS AN EMPTY DRAIN, and that is correct: nothing has been taken
 * out of service. An UNREADABLE file is not — it is a question we could not
 * answer, and answering "nothing is drained" would put work back onto a node
 * somebody is holding a screwdriver over. So a parse failure THROWS, and the
 * caller decides; every caller here fails closed.
 */
export function readDrain(): DrainState {
	// New location wins; the legacy one is honoured until a write moves it.
	const path = [drainPath(), legacyDrainPath()].find((p) => existsSync(p));
	if (!path) return {};
	const raw = readFileSync(path, 'utf8');
	if (!raw.trim()) return {};
	const parsed = JSON.parse(raw) as { nodes?: DrainState };
	return parsed.nodes ?? {};
}

export function writeDrain(state: DrainState): void {
	const path = drainPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		`${JSON.stringify({ $comment: 'Nodes held out of service. `fleet drain` writes this; the dispatcher and the tier ladder both read it. Lives in the state dir, NOT a git checkout — see drain.ts.', nodes: state }, null, 2)}\n`
	);
	// Exactly one source of truth afterwards. Leaving the legacy file behind
	// would let a stale copy answer for a checkout the reader happens to be in,
	// which is the failure this move exists to end.
	const legacy = legacyDrainPath();
	if (legacy !== path && existsSync(legacy)) rmSync(legacy, { force: true });
}

/** Is this node currently held out of service? */
export function isDraining(node: string, state: DrainState = readDrain()): boolean {
	return Object.prototype.hasOwnProperty.call(state, node);
}

/**
 * Fold a drain into a node's eligibility.
 *
 * Exported separately from the state so the tier ladder and the dispatcher can
 * apply the SAME rule without either importing the other, and so it can be
 * tested without a filesystem.
 */
export function drainOverrides(
	node: string,
	wouldBeEligible: boolean,
	state: DrainState
): { eligible: boolean; reason?: string } {
	const rec = state[node];
	if (!rec) return { eligible: wouldBeEligible };
	// A drain BEATS every promotion, including the backstop's. The backstop
	// promotes to relieve a saturated fleet; if the alternative is placing work
	// on a machine somebody has opened, the queue waits.
	return { eligible: false, reason: `drained: ${rec.reason} (since ${rec.since})` };
}

/**
 * Has a draining node actually gone quiet?
 *
 * `busy` is the count of its runners GitHub reports as running a job. Zero is
 * the only value that makes maintenance safe, and it is deliberately taken from
 * the OBSERVED runner census rather than from anything this module wrote.
 *
 * `hasLiveRegistration` (#90) is a SECOND, independent observation: does
 * GitHub's own runner listing still carry a warm or JIT registration for this
 * node, regardless of whether it is currently busy? A warm listener sitting
 * IDLE is exactly as assignable as a busy one — GitHub hands it work directly,
 * without asking the dispatcher — so `busy === 0` on that registration is not
 * evidence of anything safe. claw-5 read `drained` from a busy-process probe
 * alone while `warm-claw-5-hadoku_site` sat there, idle and still live, and
 * went on to serve 23 more jobs.
 *
 *   - `true`: a registration exists. `draining`, never `drained`, whatever
 *     `busy` says.
 *   - `false`: none exists. Falls through to the `busy`-only rule exactly as
 *     before — this is what every caller that cannot check (or does not need
 *     to, because the node has no warm/JIT surface at all) gets by defaulting
 *     the parameter.
 *   - `null`: the registration listing could not be read. Fails the same
 *     direction `busy === null` already does: `unknown`, never `drained`. A
 *     check that could not look must never be read as "nothing is there".
 */
export function drainStatus(
	node: string,
	busy: number | null,
	state: DrainState = readDrain(),
	hasLiveRegistration: boolean | null = false
): 'active' | 'draining' | 'drained' | 'unknown' {
	if (!isDraining(node, state)) return 'active';
	if (hasLiveRegistration === null) return 'unknown';
	if (hasLiveRegistration) return 'draining';
	// null means the census has not looked. That is NOT drained — reporting it
	// as such is how somebody opens a case on a node that is mid-build.
	if (busy === null) return 'unknown';
	return busy > 0 ? 'draining' : 'drained';
}
