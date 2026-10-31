import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { fleetMachines } from './benchmark-inventory.mjs';
import { measuredFacets } from '../../dist/lib/measured.js';
// ONE QUESTION, ONE ANSWER — see src/lib/node-role.ts. "What may the fleet
// chain do TO this box" is asked there and nowhere else; three gates that each
// grew their own `if (node === 'hokon')` are why.
import { nodeRole } from '../../dist/lib/node-role.js';
import { errText } from './term.mjs';

/**
 * LEAD AND GRACE, AS OFFSETS FROM `--due` (#87 §2).
 *
 * `--due 30 --cadence` gives lead=25, grace=37 — the exact numbers #87 asked
 * for ("say 25 days" / "say 37") — because they are offsets from whatever
 * threshold the caller names, not hard-coded against 30. A node older than
 * `due - LEAD_OFFSET_DAYS` is inside the window the cadence may pick it from
 * and, if not picked, is reported as an ADVISORY; past `due + GRACE_OFFSET_DAYS`
 * it is a FINDING — the cadence has repeatedly failed to reach it, not merely
 * not reached it yet.
 */
export const LEAD_OFFSET_DAYS = 5;
export const GRACE_OFFSET_DAYS = 7;

/**
 * THE CADENCE'S OWN BUDGET — bounded independently of the operator-drain
 * defaults in `refresh-cycle.mjs`, because this runs unattended off a cron
 * with a real, enforced ceiling (mgmt-api's `TIMEOUT_MS` on the child
 * process, itself under the 1500s `timeout_s` in `services/cron-worker/
 * profiles.json` in hadoku_site). A `finally` does not survive a process
 * KILL — `SIGKILL`/`SIGTERM` from an exceeded `execFile` timeout abandons
 * whatever this file was doing mid-await, including the undrain in
 * `runCadence`'s `finally` — so the fix is TWO-LAYERED: stay inside a budget
 * small enough that mgmt-api's timeout is never the thing that fires
 * (this), and catch the signal if it does anyway (`cadenceSignalHandler`,
 * wired in `runCadenceCli`).
 *
 * MEASURED, NOT GUESSED. `benchmark-node.sh`'s own header says "roughly 3
 * minutes", but the actual by-hand runs disagree: `~/.hadoku-mgmt/
 * benchmark.log`'s `raw.recordedAt` deltas between consecutive nodes in the
 * SAME sequential run (claw-1→claw-2→claw-3→claw-4→claw-6 on 2026-10-04,
 * claw-8→claw-9 on 2026-09-21) are 71s, 55s, 54s, 54s and 52s — every one of
 * them a FULL pass (disk write/read, network archive, memory bandwidth all
 * present in the capture), not `--quick`. So one node, over ssh, takes
 * roughly a minute in production, not three. `CADENCE_MEASURE_TIMEOUT_MS`
 * below is still set well above that measured figure — claw-5 is known
 * 3.8x slower on CPU-bound work (fleet hardware baseline) and is the first
 * node this cadence will actually pick (~2026-10-08) — and `measureOneNode`
 * can attempt TWICE (a privileged try, then an unprivileged retry) before
 * giving up, so the worst case below budgets for both attempts at the full
 * per-attempt ceiling rather than the measured median.
 *
 * `CADENCE_WORST_CASE_MS` is exported so a test can assert the arithmetic
 * holds without this file importing a number from hadoku_site (a cross-repo
 * import the manager asked NOT to add) — `fleet-benchmark-check.ts` states
 * the same chain of reasoning on its side instead, with its own `TIMEOUT_MS`
 * citing this comment.
 */
export const CADENCE_WAIT_TIMEOUT_MS = 5 * 60_000;
export const CADENCE_MEASURE_TIMEOUT_MS = 4 * 60_000;
/** `busyCount`'s own `runOnSync` timeout (`refresh-cycle.mjs`) — fixed, cited here so the sum is honest. */
const BUSY_CHECK_BUDGET_MS = 20_000;
/** `drainCli`'s `execFileSync` timeout (`refresh-cycle.mjs`) — fixed; the SAME cap applies to drain and undrain. */
const DRAIN_CLI_BUDGET_MS = 60_000;
/** JSON emit, `writeFacet`, process start/stop — not zero, but not another whole stage either. */
const CADENCE_MARGIN_MS = 60_000;
export const CADENCE_WORST_CASE_MS =
	BUSY_CHECK_BUDGET_MS + // the one-shot busy check before committing to drain
	DRAIN_CLI_BUDGET_MS + // drain
	CADENCE_WAIT_TIMEOUT_MS + // wait-until-quiet, bounded
	CADENCE_MEASURE_TIMEOUT_MS * 2 + // measure: privileged attempt + one retry, each at the full ceiling
	DRAIN_CLI_BUDGET_MS + // undrain
	CADENCE_MARGIN_MS;

/**
 * THE BY-HAND COMMAND — ONE INVOCATION, NEVER A NODE LIST (#87 §2).
 *
 * The previous shape printed the exact nodes a report found due
 * (`fleet benchmark claw-1 claw-2 claw-4 claw-6 --write`), which grows one
 * name longer every time the fleet does and reads as a list to transcribe
 * rather than a command to run. `--due` already answers "which nodes" on the
 * day it runs — whatever has aged past the threshold — so naming them again
 * here bought nothing and cost a growing line.
 *
 * No `cd` either. Until Wave 3h this had to name a DEVELOPMENT checkout of the
 * hub repo, because `--write` landed a manifest commit and the deploy tree
 * erases writes (`lib/manifest-target.mjs`). `$benchmark` now lives in the
 * STATE DIR (`src/lib/measured.ts`), which is not a checkout and is never
 * reset — so the write needs no commit and may run from anywhere whose
 * `HADOKU_STATE_DIR` is mgmt-api's: on the mgmt-api host, that is the default.
 */
export function byHandFor(dueDays) {
	return `fleet benchmark --due ${dueDays} --write`;
}

/**
 * WHO IS DUE -- AND WHY NO CRON MEASURES THEM.
 *
 * Not "benchmark everything, every night". This loads each box on purpose and
 * writes 512MB twice per node to time the disk, and the cadence the method was
 * designed for is twice a year -- the point of the record is spotting a disk
 * that was 480MB/s and is now 300. Measuring nightly would put 365x the wear and
 * noise into a signal that moves on a scale of months.
 *
 * The nightly job was a CHECK THAT OCCASIONALLY MEASURED -- `--due 30 --max 2
 * --write --json`, where --max bounded how many boxes one night could load --
 * until the operator's decision of 2026-09-15 that NO CRON WRITES A MANIFEST.
 * It now runs `--due 30 --report --json` and measures NOTHING, ever: this
 * function is the whole of it, answered from the stored `$benchmark` records
 * (`storedBenchmarks`), and the `--report` branch exits above the only code in
 * this file that reaches a machine. `--max` still bounds the by-hand measuring
 * path below and `--report` refuses it. Coverage is reported either way, so a
 * node that keeps being skipped still escalates.
 *
 * A NODE WITH NO RECORD IS DUE. `ageDays: Infinity` for every unavailable
 * reason, so a missing state file makes EVERY claw due rather than none — the
 * direction S §2.5 requires, because a due-checker and a writer reading the
 * same file would otherwise make "nothing is due" unfalsifiable exactly when
 * the file is gone.
 *
 * NO DRAIN, AND NOW NOTHING FOR A CRON TO DRAIN FOR. A job that measures
 * nothing cannot land on a busy box at all; what remains is a person running
 * `--write`, and benchmark-node.sh already REFUSES a box that is building,
 * which is the correct fail-safe. (05:00 local is still the schedule and still
 * the fleet's quiet hour -- measured over 15 days at 2.5 jobs/day against 56 at
 * the 06:00 cron spike.) A skipped node simply stays due and is reported again
 * tomorrow. Draining would trade that harmless retry for the risk of a crashed
 * job stranding a node out of the fleet, and src/runners/drain.ts is explicit
 * that a drain must never lapse on its own.
 *
 * A GUEST IS NEVER DUE, AND IS NEVER SILENTLY DROPPED EITHER.
 * ----------------------------------------------------------
 * hokon is a guest (operator, 2026-09-14): the fleet chain may not converge it,
 * bootcamp it, repair it, or PAGE ABOUT IT. Its `$benchmark` stamp ages exactly
 * like a claw's — 12.3 d on 2026-09-16, same 2026-09-03 capture as five of the
 * claws — so without this it would have crossed `--due 30` around 2026-10-03
 * and the nightly report would have told a human to go and measure it. A
 * finding naming a guest IS paging about it.
 *
 * The exclusion is HERE, in the one writer, so the mgmt-api consumer needs no
 * role knowledge and cannot drift from this. Role is read through
 * `src/lib/node-role.ts` and nowhere else.
 *
 * But "I did not need to look" is not "nothing is wrong", so an exempted node
 * goes into `skippedByRole` WITH its role and its dates rather than
 * disappearing. Two failures stay visible that way: a guest that somehow lost
 * its role reads as a claw and shows up loudly in `due` (absence defaults to
 * `claw`, the strict direction), and a CLAW that wrongly gained `role: guest`
 * would otherwise stop being measured in silence — instead it is named, with
 * the role that exempted it, in every report.
 *
 * @returns {{ due: object[], skippedByRole: object[] }}
 */
export function dueNodes(days, limit) {
	const machines = fleetMachines();
	const stored = measuredFacets('benchmark', machines);
	const now = Date.now();
	const aged = Object.keys(machines)
		.map((n) => {
			const r = stored.nodes[n];
			const at = r.unavailable ? undefined : Date.parse(r.value.at);
			return {
				node: n,
				role: nodeRole(machines[n]),
				// WHEN, not just how long ago. A reader deciding whether to walk to a
				// box wants the date the numbers were taken on; `ageDays` alone dates
				// itself against the moment the report ran and nothing else.
				measuredAt: at === undefined ? null : new Date(at).toISOString(),
				ageDays: at === undefined ? Infinity : Math.round(((now - at) / 86400000) * 10) / 10,
			};
		})
		.filter((x) => x.ageDays > days)
		// Oldest first, so the node that has gone longest unmeasured is the one
		// that gets the single slot on a bounded run.
		.sort((a, b) => b.ageDays - a.ageDays)
		// Infinity does not survive JSON.stringify — it becomes `null` with no
		// hint that it ever meant "never". Say it once, here, so every consumer
		// reads the same `measuredAt: null` for a node with no record at all.
		.map((x) => ({ ...x, ageDays: Number.isFinite(x.ageDays) ? x.ageDays : null }));

	// EVERY AGED-OUT MACHINE LANDS IN EXACTLY ONE OF THESE TWO. Nothing is
	// dropped: `due` ∪ `skippedByRole` is the whole aged set, so a reader can
	// account for every machine the threshold selected.
	const due = [];
	const skippedByRole = [];
	for (const x of aged) {
		// `role` stays on the skipped rows and comes OFF the due ones: a due row
		// is a claw by construction, and carrying a field that is always the same
		// value invites a consumer to branch on it.
		const { role, ...row } = x;
		if (role === 'claw') due.push(row);
		else skippedByRole.push({ ...row, role });
	}
	// --max bounds LOAD, so it bounds only the list that gets loaded. Truncating
	// the exempt list would hide the fact that a node was exempted at all.
	return { due: limit ? due.slice(0, limit) : due, skippedByRole };
}

/**
 * Split the LEAD-window `due` list (nodes older than `due - LEAD_OFFSET_DAYS`)
 * into ADVISORY and FINDING (#87 §2), leaving out whichever node this run just
 * measured — its age reset to zero, and reporting on data that no longer
 * exists is exactly the stale-comment failure this codebase keeps re-finding.
 *
 *   lead < age <= grace   -> advisory: "benchmark due in Nd: node", pages nobody
 *   age > grace, or NEVER  -> finding: the cadence has repeatedly failed to
 *                             reach it (or it has no record at all) — that is
 *                             the thing worth paging about.
 *
 * Pure, and exported so this one property ("26 days is advisory, 38 is a
 * finding") is testable without a fleet, a fake ssh, or a subprocess.
 */
export function cadenceBands({ due, measuredNode, dueDays, graceDays }) {
	const advisories = [];
	const findings = [];
	for (const d of due) {
		if (d.node === measuredNode) continue;
		if (d.ageDays === null || d.ageDays > graceDays) {
			findings.push(
				d.ageDays === null
					? `${d.node}: NEVER measured — past the ${graceDays}d grace`
					: `${d.node}: benchmark ${d.ageDays}d stale — past the ${graceDays}d grace ` +
							'(the cadence has repeatedly missed it)'
			);
		} else {
			advisories.push(
				`benchmark due in ${Math.max(0, Math.round(dueDays - d.ageDays))}d: ${d.node}`
			);
		}
	}
	return { advisories, findings };
}

/**
 * ONE NODE, DRAINED AROUND THE MEASUREMENT, ALWAYS PUT BACK.
 *
 * `candidates` is the LEAD-window due list, oldest first, already stripped of
 * guests by the caller (`dueNodes` splits by role before this ever sees it) —
 * this function does not ask what a node IS, only whether it is safe to touch
 * right now. Busy and already-drained nodes are SKIPPED, not waited on: this
 * runs off a cron with a real timeout (1500s), and `waitDrained`'s own
 * 45-minute ceiling exists for an operator's drain, not for picking the
 * night's box — draining a node that is already busy and then waiting for it
 * is how a bounded nightly job becomes an unbounded one.
 *
 * UNDRAIN IS IN A `finally`, covering both a measurement that resolves and one
 * that rejects — a node this cycle drained must never be the one left out of
 * service because its measurement crashed.
 *
 * @param {object} p
 * @param {Array<{node:string, ageDays:number|null}>} p.candidates  oldest first
 * @param {object} p.deps  isDrained(node), busy(node), drain(node,{kind,reason}),
 *   waitDrained(node), undrain(node)
 * @param {(node:string) => Promise<object>} p.measure  resolves with the
 *   measured record, or REJECTS — a throw and a rejection are the same signal,
 *   which is what lets a test prove the `finally` with a fake that just throws.
 * @param {(line:string)=>void} [p.log]
 * @param {{held?: string|null}} [p.state]  `state.held` names the node WE
 *   currently hold drained, set right after a successful drain and cleared
 *   right when the undrain in `finally` is attempted — the same shape
 *   `runRefreshCycle` uses in `refresh-cycle.mjs` so a SIGNAL handler
 *   installed around this call can put the node back even if the process is
 *   killed mid-`await` (a `finally` cannot run after that; `state.held` is
 *   what lets something OUTSIDE this function recover). See
 *   `cadenceSignalHandler` / `runCadenceCli`.
 */
export async function runCadence({ candidates, deps, measure, log = () => {}, state = {} }) {
	const skipped = [];
	let picked = null;
	for (const c of candidates) {
		let held;
		try {
			held = await deps.isDrained(c.node);
		} catch (e) {
			skipped.push({ node: c.node, reason: `could not read drain state: ${errText(e)}` });
			continue;
		}
		if (held) {
			skipped.push({
				node: c.node,
				reason: 'already drained by someone else; not ours to lift, and not measured',
			});
			continue;
		}
		let busy;
		try {
			busy = await deps.busy(c.node);
		} catch {
			busy = null;
		}
		if (busy === null) {
			skipped.push({ node: c.node, reason: 'could not reach it to check for running jobs' });
			continue;
		}
		if (busy > 0) {
			skipped.push({ node: c.node, reason: `busy (${busy} job(s) running)` });
			continue;
		}
		picked = c.node;
		break;
	}
	if (!picked) return { node: null, record: null, error: null, skipped, undrained: null };

	log(`cadence: ${picked} is the most overdue idle node — draining to measure it`);
	let drained;
	try {
		drained = await deps.drain(picked, {
			kind: 'training',
			reason: 'benchmark cadence (automated); returns after measuring',
		});
	} catch (e) {
		// Mirrors refresh-cycle's own recovery: nothing to undo unless the write
		// landed before the failure surfaced.
		let landed = false;
		try {
			landed = await deps.isDrained(picked);
		} catch {
			landed = true;
		}
		if (landed) {
			try {
				await deps.undrain(picked);
			} catch {
				// Best effort; the finding below still names the drain failure.
			}
		}
		return {
			node: null,
			record: null,
			error: null,
			skipped: [...skipped, { node: picked, reason: `drain failed: ${errText(e)}` }],
			undrained: null,
		};
	}
	if (drained?.ok === false) {
		return {
			node: null,
			record: null,
			error: null,
			skipped: [...skipped, { node: picked, reason: `drain refused: ${drained.reason}` }],
			undrained: null,
		};
	}

	// WE HOLD THIS NODE FROM HERE. Named in `state` so a signal handler
	// installed around this call can put it back even if the process is
	// killed before this function's own `finally` ever runs — see the param
	// doc above and `cadenceSignalHandler`.
	state.held = picked;

	let record = null;
	let error = null;
	let undrained = false;
	let undrainReason = null;
	try {
		let w;
		try {
			w = await deps.waitDrained(picked);
		} catch (e) {
			w = { drained: false, reason: errText(e) };
		}
		if (!w?.drained) {
			error = `not drained in time: ${w?.reason ?? 'unknown'}; nothing was measured`;
		} else {
			try {
				record = await measure(picked);
			} catch (e) {
				error = `measurement failed: ${errText(e)}`;
			}
		}
	} finally {
		// Cleared BEFORE the undrain attempt, not after: once execution has
		// reached here normally (not killed), the signal handler's recovery is
		// no longer the thing that will catch a problem — an undrain failure
		// from this point on is reported as `undrainReason` below, a different,
		// already-visible finding. Mirrors `runRefreshCycle`'s `putBack`.
		state.held = null;
		try {
			const u = await deps.undrain(picked);
			undrained = u?.ok !== false;
			if (!undrained) undrainReason = u?.reason ?? 'undrain refused';
		} catch (e) {
			undrained = false;
			undrainReason = errText(e);
		}
	}

	return { node: picked, record, error, skipped, undrained, undrainReason };
}

/**
 * A SYNCHRONOUS UNDRAIN, for the one caller that cannot `await` one: a signal
 * handler. `drain-node.mjs --undo` is a local JSON read-modify-write (no ssh,
 * no network) and `execFileSync` already blocks until it exits, so this is
 * safe to call from inside `process.on('SIGTERM', ...)` even though that
 * handler is not, and cannot be, `async`.
 *
 * Exported so `cadenceSignalHandler` can be unit-tested with a fake in place
 * of this — spawning a real signal in `node --test` is exactly the kind of
 * thing the manager's note anticipated as "awkward".
 */
export function emergencyUndrainSync(node) {
	execFileSync(
		process.execPath,
		[join(dirname(dirname(fileURLToPath(import.meta.url))), 'drain-node.mjs'), node, '--undo'],
		{
			stdio: 'ignore',
			timeout: DRAIN_CLI_BUDGET_MS,
		}
	);
}

/**
 * THE BACKSTOP FOR A KILL MID-DRAIN (the manager's safety finding on this
 * lane): `runCadence`'s `finally` undrains on every path EXCEPT one — the
 * process being killed outright, which abandons whatever `await` it was in
 * and never reaches a `finally` at all. `CADENCE_WAIT_TIMEOUT_MS` and
 * `CADENCE_MEASURE_TIMEOUT_MS` are the PRIMARY fix (staying inside a budget
 * mgmt-api's own timeout never has to enforce); this is the backstop for
 * when something outside this file's control still kills it anyway — mgmt-api
 * hitting ITS OWN timeout regardless, an operator's `kill`, a redeploy.
 *
 * WHY A SIGNAL HANDLER CAN HELP AT ALL, GIVEN A SYNC CHILD CALL CANNOT BE
 * INTERRUPTED. Node defers signal delivery until the current synchronous
 * operation returns — `execFileSync` inside `measureOneNode`/`busyCount`
 * cannot be pre-empted, which is exactly why (1) the bounded budget is the
 * PRIMARY fix. But most of a drain-wait is spent in `waitUntilDrained`'s
 * `await clock.sleep(pollMs)` — a real, non-blocking timer — and a signal
 * arriving in one of those windows is delivered immediately, before the next
 * poll. That is the gap this closes.
 *
 * Pure with respect to Node's signal machinery: `undrainSync` and `exit` are
 * both injected, so a test proves the LOGIC (holds -> undrain -> exit
 * non-zero naming the signal; does not hold -> no undrain, still exits)
 * without sending itself a real signal.
 *
 * @param {{held: string|null}} state
 * @param {string} signal
 * @param {{undrainSync?: (node:string)=>void, log?: (line:string)=>void, exit?: (code:number)=>void}} [deps]
 */
export function cadenceSignalHandler(
	state,
	signal,
	{ undrainSync = emergencyUndrainSync, log = (l) => console.error(l), exit = process.exit } = {}
) {
	if (state.held) {
		const node = state.held;
		try {
			undrainSync(node);
			log(
				`benchmark: ${signal} received while ${node} was held drained for the cadence — undrained it.`
			);
		} catch (e) {
			log(
				`benchmark: ${signal} received while ${node} was held drained for the cadence — ` +
					`FAILED to undrain: ${errText(e)}. The node is STILL DRAINED; an operator must ` +
					`run \`fleet drain ${node} --undo\`.`
			);
		}
	} else {
		log(`benchmark: ${signal} received; nothing was held drained.`);
	}
	exit(1);
}
