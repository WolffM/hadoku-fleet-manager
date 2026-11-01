/**
 * The probe's declared intent — the one thing that stops the wasted competitor
 * -------------------------------------------------------------------------
 *
 * Wave 5r lane B split of dispatch-tick.ts (plan: 800-line ceiling, pure
 * move): unmodified apart from the `export`s needed to keep every name
 * re-exported from dispatch-tick.ts, since `scripts/lib/floor-probe-state.mjs`
 * (wave 5q lane A) and `probe-intent.test.ts` both import `PROBE_INTENT_DIR`/
 * `PROBE_INTENT_MAX_MS`/`readProbeIntents` from there, not from here.
 *
 * Where the forced-placement harness declares a job it is about to serve itself.
 *
 * WHAT THIS BUYS, MEASURED. `scripts/floor-probe.mjs` mints a runner on the
 * chosen node and only then dispatches, because a runner already listening gets
 * the job from GitHub in about two seconds. The dispatcher sees the same job
 * queued on its next 15 s tick and mints a SECOND runner for it —
 * `floor-probe-2026-09-08.md` §2.1: "roughly one wasted mint per probe". That
 * cost is absorbed, but it is not only a cost: all four of the eleven-probe
 * sweep's MISSES landed on a node still holding a leftover competitor from the
 * previous probe, so two idle matching runners existed and GitHub picked.
 * The probe's misses were self-inflicted and correlated.
 *
 * A DIRECTORY, ONE FILE PER PROBE, NOT AN APPEND-ONLY LEDGER. The probe has to
 * RELEASE its intent the moment it is done — an intent that lingers suppresses
 * minting for a real queued job of the same unit, and under all-JIT nothing else
 * would mint for it, so the job waits. A file per probe means release is an
 * unlink and two concurrent probes never rewrite each other's line. The probe
 * ledger is append-only for the opposite reason: nothing ever has to take a line
 * out of it.
 *
 * NOT `job-history.jsonl`, and not the probe ledger, for the reason
 * `PROBE_LEDGER_FILE` names: the in-process writer rewrites history wholesale
 * from its own window and deletes an out-of-process writer's lines. This
 * direction is the mirror image — the harness writes, this module only reads and
 * never writes — which is again the only arrangement where both can be right.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { logger, stateDir } from '../host.js';

/**
 * One declared intent. The harness writes these; nothing here writes them.
 *
 * `job` is GitHub's job NAME, because that is what the jobs listing answers with
 * and it is the wave's settled job key. `node` and `runnerName` are carried for
 * the log line and for an operator reading the directory by eye — the SUPPRESSION
 * does not consult them, because what matters is that somebody has already
 * arranged for this job to be served, not where.
 */
export interface ProbeIntent {
	repo: string;
	job: string;
	node?: string;
	runnerName?: string;
	/** Absolute epoch ms. Past it the declaration is ignored — see below. */
	expiresAtMs: number;
}

export const PROBE_INTENT_DIR = 'floor-probe-intents';

/**
 * The longest a declaration may reach into the future.
 *
 * AN INTENT IS A LICENCE TO NOT MINT, so an unbounded one is a licence to let a
 * unit queue forever. The harness's own runner lives `PROBE_TTL_SECONDS` = 900 s
 * and its watch loop is bounded well inside that, so 15 minutes covers every
 * honest declaration; anything claiming longer is a stale file, a clock skew or a
 * hand-edit, and is refused with a reason rather than honoured. This is the
 * `no gate may get EASIER to pass the worse the failure gets` rule applied to a
 * suppression: the failure mode of the mechanism must not be "mints nothing".
 *
 * SIXTEEN minutes and not fifteen, which is the harness's `PROBE_TTL_SECONDS`
 * exactly: the writer and the reader are different processes on different boxes
 * reading different clocks, and a ceiling equal to the honest TTL refuses every
 * declaration the moment the dispatcher's clock sits a millisecond behind the
 * harness's. The 60 s of slack is the tolerance, and `probe-intent.test.ts`
 * asserts the two numbers stay in this relationship.
 */
export const PROBE_INTENT_MAX_MS = 960_000;

/**
 * Separator for the `(repo, job name)` key, spelled as an ESCAPE.
 *
 * A job name can contain a space — `hadoku_site` has one called `Build variants`
 * — so a space separator makes two different keys collide in shapes nobody
 * notices until a suppression lands on the wrong job. NUL cannot appear in
 * either half.
 *
 * WRITTEN `\u0000` AND NEVER AS THE BYTE, which is not style.
 * `floor-probe-2026-09-08.md` §2.5 records seven literal NULs in
 * `scripts/lib/floor-probe.mjs` that WORKED perfectly — join and split agreed,
 * every gate passed — while making git classify the file as binary: no
 * `git diff`, no `git grep`, no code review. That file went through a full
 * review pass invisible. This very line reproduced the trap on the first
 * attempt, caught only because `grep` stopped answering about this file, and the
 * test beside it now fails on a re-introduced literal.
 */
export const INTENT_KEY_SEP = '\u0000';

/** Intents already logged this process, so a live probe is announced once. */
export const announcedIntents = new Set<string>();

/**
 * Live probe intents, from disk.
 *
 * UNREADABLE IS NO SUPPRESSION, which is the opposite of this file's usual
 * "fail toward doing nothing" and is deliberate. Everywhere else a failure here
 * means fewer mints; here a failure that produced MORE suppression would stop
 * the fleet minting for real work, and "I could not look" would render as "the
 * fleet is busy". The cost of the other direction is one wasted registration the
 * reaper already clears — exactly the cost this mechanism exists to remove, and
 * the right one to fall back to.
 */
export function readProbeIntents(nowMs: number): ProbeIntent[] {
	const dir = join(stateDir(), PROBE_INTENT_DIR);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		// ENOENT is the normal state on a fleet that is not probing.
		return [];
	}
	const live: ProbeIntent[] = [];
	for (const name of names) {
		if (!name.endsWith('.json')) continue;
		let e: Partial<ProbeIntent>;
		try {
			e = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Partial<ProbeIntent>;
		} catch {
			// One bad file is not a bad directory — same rule as loadProbeLedger.
			continue;
		}
		if (typeof e.repo !== 'string' || typeof e.job !== 'string') continue;
		if (typeof e.expiresAtMs !== 'number' || !Number.isFinite(e.expiresAtMs)) continue;
		if (e.expiresAtMs <= nowMs) continue;
		if (e.expiresAtMs - nowMs > PROBE_INTENT_MAX_MS) {
			// SAY WHY. A declaration reaching past the harness's own runner TTL is
			// the one failure of this mechanism that could stall the fleet, and a
			// silent refusal would leave an operator staring at a probe that keeps
			// losing the race for no visible reason.
			if (!announcedIntents.has(`bad:${name}`)) {
				announcedIntents.add(`bad:${name}`);
				logger.warn(
					`[dispatch-tick] ignoring probe intent ${name}: expires ` +
						`${Math.round((e.expiresAtMs - nowMs) / 1000)}s out, past the ` +
						`${PROBE_INTENT_MAX_MS / 1000}s ceiling — a stale file or a clock skew, not a probe`
				);
			}
			continue;
		}
		live.push({
			repo: e.repo,
			job: e.job,
			node: e.node,
			runnerName: e.runnerName,
			expiresAtMs: e.expiresAtMs,
		});
	}
	return live;
}

/** Tests only: the announce-once set is module state. */
export function __resetProbeIntentStateForTesting(): void {
	announcedIntents.clear();
}
