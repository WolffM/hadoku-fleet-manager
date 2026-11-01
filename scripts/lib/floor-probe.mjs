/**
 * floor-probe — the decisions the forced-placement harness makes, with no IO.
 *
 * P3.2. Everything here is specified by `docs/planning/claw-floor-design-2026-09-07.md`
 * (lane F), and the section numbers in the comments below are that document's.
 * The harness proper (`scripts/floor-probe.mjs`) does the dispatching, the
 * minting and the waiting; this file holds the zone classifier, whether a
 * re-run is warranted, the mode/argv contract and what a probe is allowed to
 * cost.
 *
 * SPLIT THIS WAY FOR ONE REASON: every rule below is a claim that can be wrong,
 * and a rule that only exists inside a script that talks to GitHub and ssh's to
 * six boxes cannot be exercised. `lib/queue-health.mjs` is the same shape and
 * for the same reason — "the verdict is lib/queue-health.mjs's, so the rule that
 * decides an outage is the one the tests beside it exercise, not a second copy
 * living here".
 *
 * FURTHER SPLIT, WAVE 5Q LANE A (pure move, this file was 962 lines): the
 * candidate ranking and the demand-ledger class rule are
 * `floor-probe-ranking.mjs`; the §5 flaky rule is `floor-probe-flaky.mjs`; the
 * §7 quiet-window predicate is `floor-probe-window.mjs`; the two read-only
 * tables (`unitTable`, `nodeZoneTable`) are `floor-probe-rows.mjs`; the §6
 * shadow-dispatch safety check is `floor-probe-safety.mjs`. Each is just as
 * pure as this one — nothing moved gained a clock, a file or the network.
 *
 * NOTHING HERE READS A CLOCK, A FILE OR THE NETWORK. `now` is always an
 * argument. The one import below is the BUILT zone classifier and it reads
 * neither — see the note on it.
 */
import { classifyZone, zoneOf } from '../../dist/job-history-stats.js';

// ---------------------------------------------------------------------------
// §1.3 / master §5.5 — the zone classifier
// ---------------------------------------------------------------------------

/**
 * §5.5's zone classifier, and the `fleet` fold on top of it.
 *
 * DEFINED IN `src/job-history.ts`, RE-EXPORTED HERE, and that direction is
 * deliberate. The rule started life in this file because it was the harness's
 * alone; it is now also what `summarise` folds `NodeJobStats.failuresByZone`
 * with and therefore what `GET /fleet` puts on the wire. Two copies of one
 * question is `isLocalNode` over again — five implementations, one FQDN, only
 * one survivor — so the script half imports the built copy exactly as
 * `fleet-exec.mjs` imports the built `isLocalNode`. A source checkout that has
 * not been built fails LOUDLY on this import rather than quietly on a second
 * opinion.
 *
 * `classifyZone` is the three-zone rule §5.5 states and `warrantsForcedRerun`
 * below still asks IT, not `zoneOf`: a job the fleet's TTL killed is not a
 * placement question, and folding `fleet` into the function the rerun gate
 * consults would have changed that decision as a side effect of adding a
 * counter.
 */
export { classifyZone, zoneOf };

/**
 * Is this failure worth a forced re-run? §5.1 — runner or seam zone only.
 *
 * Returns `{ ok, zone, reason }` rather than a boolean, because a REFUSAL here
 * has to be explainable: "no probe was spent" and "no probe was warranted" look
 * identical from the outside, and the whole point of Control A is that a probe
 * is spent only where there is already reason to suspect the node.
 *
 * A CANCELLATION IS NEVER WORTH A PROBE, and this is the one place the
 * implementation departs from the master doc's zone table. That table says "or
 * no step record" is the runner zone, which is true and stays true — the ZONE is
 * unchanged. What does not follow is that a cancelled job is evidence about a
 * node. Measured over the live window, 2026-09-08: of 639 non-success records,
 * **420 are cancellations** (123 with no step record, 297 with one), against 219
 * genuine failures. Several fleet workflows set `cancel-in-progress`, so a push
 * that supersedes another cancels whatever was mid-flight — and the step it
 * happens to be standing on is arbitrary. Three of the sampled cancelled steps
 * are `Post Run actions/setup-node@v6`, `Update packages` and `Admin script
 * tests (python)`: the first classifies as the RUNNER zone purely because
 * teardown is where the supersede landed.
 *
 * The one cancellation shape the master doc does treat as evidence — claw-2 at
 * 01:49 showing `Set up runner[cancelled]` across three repos in one minute — is
 * identified by CORRELATION (three repos, one minute, one node), not by anything
 * visible in a single record. This rule sees one record at a time, so it cannot
 * make that call and does not pretend to.
 */
export function warrantsForcedRerun(record) {
	if (!record || !record.conclusion || record.conclusion === 'success') {
		return { ok: false, zone: null, reason: 'not a failure' };
	}
	const zone = classifyZone(record);
	if (record.conclusion === 'cancelled') {
		return {
			ok: false,
			zone,
			reason:
				'cancelled, not failed — cancel-in-progress supersedes account for 420 of the ' +
				'639 non-success records in the window, and the step one lands on is arbitrary',
		};
	}
	if (zone === 'content') {
		return { ok: false, zone, reason: "the consumer's own step failed" };
	}
	return { ok: true, zone, reason: null };
}

// ---------------------------------------------------------------------------
// §7 — what probing may cost
// ---------------------------------------------------------------------------

/**
 * §7 — the whole shadow allowance for one quiet-window run.
 *
 * 200 is under 5% of a single hour's 5,000-call budget even if every call
 * happened to land in the same clock hour, and it leaves the reap's measured
 * 1,620/hr untouched.
 *
 * THE FORCED RE-RUN PATH IS NOT GOVERNED BY THIS and must not be: it is a
 * POST plus the listings the failover check already makes, it fires only on a
 * genuine failure (17 in 1,030 jobs), and metering it would mean declining to
 * investigate a real fleet failure because a synthetic sweep had already spent
 * the allowance.
 */
export const SHADOW_CALL_BUDGET = 200;

/**
 * A sanity ceiling for the FORCED RE-RUN path. **This is not §7's cap.**
 *
 * §7 is explicit that the forced re-run rides the existing budget rather than
 * the shadow allowance, and the reason matters: metering it would mean declining
 * to investigate a real fleet failure because a synthetic sweep had already
 * spent the allowance. So this is not an allowance at all — it is the ceiling a
 * single re-run may not exceed however long the job takes, so a bug in the watch
 * loop cannot spin against the API. The blackout check is the part that actually
 * coordinates with the rest of the fleet, and it applies here exactly as it does
 * to the shadow path.
 */
export const RERUN_CALL_CEILING = 60;

/**
 * The calls one shadow probe makes, worst case. NOT an estimate — the harness
 * is bounded by exactly these numbers and stops when the meter says so.
 *
 * EVERY ONE OF THESE IS UNCONDITIONAL, so the ceiling IS the spend. That is the
 * distinction CLAUDE.md draws and the one the 2026-09-05 change got wrong: the
 * dispatcher's queued-runs listing sends an ETag and a 304 is genuinely free, so
 * its ceiling is not its spend; nothing here can send one, because every poll
 * below exists precisely to see state CHANGE.
 */
export const PROBE_CALLS = {
	/** POST the workflow_dispatch. */
	dispatch: 1,
	/** Finding the run id the dispatch created — it is not in the POST's reply. */
	runLookupPolls: 6,
	/** Watching the job: queued -> the runner picks it up -> completed. */
	jobPolls: 24,
	/** generate-jitconfig, plus the delete that cleans up a failed mint. */
	mint: 2,
};

export const callsPerProbe = (calls = PROBE_CALLS) =>
	calls.dispatch + calls.runLookupPolls + calls.jobPolls + calls.mint;

/** How many probes fit in the allowance. Never rounded up. */
export const maxProbesPerRun = (budget = SHADOW_CALL_BUDGET, calls = PROBE_CALLS) =>
	Math.floor(budget / callsPerProbe(calls));

/**
 * A meter, so the cap binds WITHIN a run rather than merely being asserted about
 * one.
 *
 * `FetchBudget` in job-history.ts is the same shape and for the same reason: a
 * number handed to each probe would let every probe see the full allowance and
 * spend it over again.
 */
export class CallBudget {
	constructor(limit = SHADOW_CALL_BUDGET) {
		this.limit = limit;
		this.spent = 0;
	}
	get remaining() {
		return Math.max(0, this.limit - this.spent);
	}
	/** Claim `n` calls. False once the allowance is spent — the caller STOPS. */
	take(n = 1) {
		if (this.spent + n > this.limit) return false;
		this.spent += n;
		return true;
	}
}

/**
 * The subcommand's MODE: the first argument, and only the first.
 *
 * WHY NOT `argv.find((a) => !a.startsWith('--'))`, WHICH IS WHAT THIS WAS.
 * That expression scans the WHOLE argv for the first non-flag token, so it does
 * not read a positional — it reads the first thing that is not spelled like a
 * flag, INCLUDING A FLAG'S VALUE. Measured against this command's own arguments:
 *
 *     floor-probe --unit 'WolffM/hadoku_site#lint'
 *         -> mode = "WolffM/hadoku_site#lint"   (unknown mode, exit 1)
 *     floor-probe --onto claw-6 --repo … --run …
 *         -> mode = "claw-6"                    (a NODE NAME, from a positional)
 *
 * The second one is `node-scoping.test.mjs`'s bug verbatim: `bootcamp`'s parser
 * was this exact shape, and it made `--machine=claw-7 --write` mean every node
 * including the production host. That guard flagged this file and it was RIGHT —
 * a mode was never what the expression actually read.
 *
 * So: the mode is `argv[0]`, or the fallback when the first argument is a flag
 * or absent. `git` and every other subcommand CLI works this way; a mode that
 * may appear anywhere is not a subcommand, it is a scan.
 *
 * Validation is the CALLER's: an unrecognised first argument comes back as
 * itself so the caller can say `unknown mode "…"` instead of silently falling
 * back to the default, which is how a typo becomes a table nobody asked for.
 */
export function parseMode(argv = [], fallback = 'table') {
	const first = argv[0];
	if (typeof first !== 'string' || first.startsWith('-')) return fallback;
	return first;
}

/**
 * Which flags each mode accepts. `--json` is everywhere and is not listed.
 *
 * This exists because of what the parser fix ABOVE left behind. Once the mode is
 * `argv[0]` and nothing else, `floor-probe --onto claw-6 --repo … --run …`
 * parses as no mode at all, falls back to `table`, and prints a table of the
 * busiest unit — an operator asked for a forced re-run and got an unrelated
 * report, exit 0. That is the same defect class the mode fix was for: an
 * argument that means one thing being silently read as another. Refusing is the
 * only honest answer, and it costs one map.
 */
export const MODE_FLAGS = {
	report: ['days', 'repo'],
	table: ['unit'],
	candidates: ['unit', 'timeout-sec'],
	window: [],
	probe: ['repo', 'workflow', 'job', 'node', 'ref', 'confirm', 'ignore-window'],
	rerun: ['repo', 'run', 'onto', 'confirm'],
};

/** Accepted by every mode, so never foreign. */
const UNIVERSAL_FLAGS = ['json'];

export function parseUnit(spec) {
	if (!spec) return null;
	const i = spec.lastIndexOf('#');
	if (i < 0) return null;
	return { repo: spec.slice(0, i), job: spec.slice(i + 1) };
}

/**
 * Flags in `argv` that `mode` does not accept, each with the modes that do.
 *
 * Returns `[]` for an unknown mode: the caller's "unknown mode" message is the
 * better error, and reporting every flag as foreign on top of it would bury it.
 */
export function foreignFlags(mode, argv = []) {
	const accepted = MODE_FLAGS[mode];
	if (!accepted) return [];
	const allowed = new Set([...accepted, ...UNIVERSAL_FLAGS]);
	const out = [];
	for (const a of argv) {
		if (!a.startsWith('--')) continue;
		const name = a.slice(2).split('=')[0];
		if (!name || allowed.has(name)) continue;
		const owners = Object.keys(MODE_FLAGS).filter((m) => MODE_FLAGS[m].includes(name));
		out.push({ flag: `--${name}`, owners });
	}
	return out;
}

/**
 * May the next GitHub call go out? Returns a REASON, or null for "yes".
 *
 * Pure, and separated from the caller that actually fetches, because this is the
 * rule that decides whether the harness becomes a fourth uncoordinated caller on
 * a token that has already been to zero once. `blackoutRemainingMs` is
 * `runner-health.ts`'s own `ghBlackoutRemainingMs()` at the call site — the same
 * blackout the reap and the label sweep honour, not a second opinion about it.
 *
 * A REASON, NEVER A BARE FALSE, AND NEVER ANYTHING RESEMBLING "unchanged". A
 * spent budget, a spent allowance and a call that simply failed are three
 * different jobs, and a caller that cannot tell them apart will retry the one
 * that cannot succeed. Telling a caller its cached state is still current when
 * we did not look is the failure CLAUDE.md names first.
 */
export function probeGate(budget, blackoutRemainingMs) {
	if (blackoutRemainingMs > 0) {
		return `the primary GitHub budget is spent — ${Math.ceil(blackoutRemainingMs / 1000)}s to reset`;
	}
	if (!budget.take(1)) return `the ${budget.limit}-call probe budget is spent`;
	return null;
}
