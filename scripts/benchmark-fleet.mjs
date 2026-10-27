#!/usr/bin/env node
/**
 * benchmark-fleet — run benchmark-node.sh on every claw and put the answers
 * side by side.
 *
 * WHY A FLEET-WIDE TABLE AND NOT A PER-NODE REPORT
 * ------------------------------------------------
 * Every capacity decision in fleet-runner-manifest.json is COMPARATIVE, and the
 * $why prose says so outright: claw-2 is capped lower than claw-1 "at identical
 * core count" because it has less RAM; claw-3 is "the inverse of claw-2", most
 * RAM and fewest cores. Those are sentences about a FLEET, written by holding
 * several machines in one head at once. A per-node report cannot support that.
 * A column per node can.
 *
 * WHAT IT DOES NOT DO: decide anything. It measures and tabulates. The number
 * that actually bounds a node — maxConcurrent — depends on measured p95 job
 * memory, on thermals under real work, and on whether the box is the production
 * host. None of those is a column here, and inventing one from a spec sheet is
 * how claw-2 came to OOM-kill two jobs. See `fleet mem-report`.
 *
 * `--cadence` (wave 3x, #87) IS one exception to "decides nothing": at most
 * once a night it picks the single most-overdue idle claw, drains it, measures
 * it, writes it, and undrains it — reversing the 2026-09-15 "no cron measures"
 * decision under the operator's 2026-10-04 "i would prefer if that was
 * automated". One node a night staggers the fleet on its own, so a batch that
 * was all measured together never ages out and re-synchronises into one page
 * for five boxes at once (the shape #87 was filed against). `--report` keeps
 * its 2026-09-15 behaviour byte-for-byte for anyone still calling it.
 *
 * @guards scripts/benchmark-node.sh
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
// WHERE `$benchmark` LIVES — the state dir since Wave 3h, through the one
// reader/writer that merges it with the manifest's copy while the migration is
// in flight. See src/lib/measured.ts; the BUILT copy, for the reason
// `lib/paths.mjs` gives.
import { measuredFacets, writeFacet } from '../dist/lib/measured.js';
// ONE QUESTION, ONE ANSWER — see src/lib/node-role.ts. "What may the fleet
// chain do TO this box" is asked there and nowhere else; three gates that each
// grew their own `if (node === 'hokon')` are why.
import { guestNodeNames, nodeRole } from '../dist/lib/node-role.js';
import { manifest } from './lib/paths.mjs';
import { isLocalNode, sshDestination } from './lib/fleet-exec.mjs';
import { createEmitter } from './lib/emit.mjs';
// THE SAME DRAIN `ci:toolchain-refresh` (#69) USES, reused rather than
// reimplemented: `createLiveDeps()` already wraps drain-node.mjs and the
// wait-until-quiet poll; `busyCount` is the one-shot "is it busy right now"
// question the cadence asks BEFORE committing to a drain-wait on a node that
// is already busy — see `runCadence` below for why that distinction matters
// on a cron with a 1500s timeout.
//
// `waitUntilDrained` is imported DIRECTLY rather than through
// `createLiveDeps().waitDrained` — that wrapper bakes in `DRAIN_TIMEOUT_MS`
// (45 minutes), sized for an OPERATOR'S drain where "it eventually comes
// back" is the only promise. The cadence runs inside a 1500s cron; see
// `CADENCE_WAIT_TIMEOUT_MS` below for the bounded call this file makes
// instead, with the same `busyCount` and a fresh clock.
import { busyCount, createLiveDeps, waitUntilDrained } from './lib/refresh-cycle.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'benchmark-node.sh');
const BOLD = '\x1b[1m';
const YEL = '\x1b[33m';
const OFF = '\x1b[0m';
/** "Twice a year" cadence, unchanged — the `never`/`stale` coverage bands. */
const STALE_DAYS = 200;
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
const LEAD_OFFSET_DAYS = 5;
const GRACE_OFFSET_DAYS = 7;

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

const errText = (e) => (e instanceof Error ? e.message : String(e));

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
function byHandFor(dueDays) {
	return `fleet benchmark --due ${dueDays} --write`;
}

function fleetMachines() {
	const doc = JSON.parse(readFileSync(manifest('fleet-runner-manifest.json'), 'utf8'));
	return doc.machines ?? {};
}

function fleetNodes() {
	return Object.keys(fleetMachines());
}

/**
 * Every node's stored `$benchmark`, merged — the state dir first, the manifest's
 * copy while the migration is in flight. `src/lib/measured.ts` is the one
 * answer; nothing in this file reads either tree directly any more.
 *
 * WHY DUE AND COVERAGE READ THE FACET AND NOT `fleet-benchmarks.json`. Until
 * Wave 3h they read the run ledger beside the manifest. That was measured
 * before this change (S §6's hard requirement, executed against a fixture of
 * the live manifest with every `$benchmark` stripped and the live ledger
 * beside it): `--due 30 --report --json` answered `due: [], ok: true`. The
 * facet was gone and the gate read the fleet as freshly measured, because the
 * ledger it actually consulted still was. After the manifest edit that is the
 * PRODUCTION state, and it would have stayed green until the ledger's newest
 * runs aged past the threshold, while no node had a record anywhere a reader
 * looks. The `at` stamp on the record a reader is served is the only honest
 * age.
 */
function storedBenchmarks() {
	return measuredFacets('benchmark', fleetMachines());
}

/**
 * One sentence per node with no usable record, saying WHICH kind of absence.
 * "Never measured" and "the record exists and cannot be read" are different
 * jobs, and the second must not be dressed as the first.
 */
function noRecordFinding(node, result) {
	return result.unavailable === 'unreadable' || result.unavailable === 'malformed'
		? `${node}: benchmark record UNREADABLE (${result.unavailable}) — ${result.why}`
		: `${node}: NEVER measured — no benchmark record (${result.unavailable})`;
}

// ── COVERAGE ACROSS RUNS, NOT JUST THIS ONE ────────────────────────────────
// A node skipped for being busy is a normal outcome for ONE run and a silent
// gap across many. claw-2 carries 39% of all fleet jobs, is therefore almost
// never idle, and had never once been measured — while every run that skipped
// it exited 0 and printed a table that looked complete. hokon had never been
// measured either, for an entirely different reason (it refuses ssh to itself),
// and the file looked equally healthy both ways.
//
// Per-run reporting cannot catch either case, because neither is a failure of
// any single run. Only the stored record knows. "I could not look" must never
// render as "nothing is wrong" — so a node whose record is UNAVAILABLE, for any
// of measured.ts's five reasons, lands in `never` and fails the run.
// STALE_DAYS is declared at the top of the file (the "twice a year" cadence).

function coverageOf(measured) {
	const stored = storedBenchmarks();
	const never = [];
	const stale = [];
	/** node -> the finding sentence for a node in `never`. */
	const why = new Map();
	for (const n of Object.keys(stored.nodes)) {
		// This invocation has not been persisted yet; it counts as fresh.
		if (measured[n]) continue;
		const r = stored.nodes[n];
		if (r.unavailable) {
			never.push(n);
			why.set(n, noRecordFinding(n, r));
			continue;
		}
		const days = Math.round((Date.now() - Date.parse(r.value.at)) / 86400000);
		if (days > STALE_DAYS) stale.push({ node: n, days });
	}
	return { never, stale, why };
}

/** The findings a coverage result implies, `skip` excepted (guests). */
function coverageFindings(c, skip = new Set()) {
	return [
		...c.never.filter((n) => !skip.has(n)).map((n) => c.why?.get(n) ?? `${n}: NEVER measured`),
		...c.stale
			.filter((x) => !skip.has(x.node))
			.map((x) => `${x.node}: last measured ${x.days}d ago`),
	];
}

/** The emitted shape of `coverage` — the internal `why` map stays internal. */
const coverageJson = (c, scoped) => ({ never: c.never, stale: c.stale, scoped });

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

/** `key value` lines between BENCH-BEGIN and BENCH-END. */
function parse(text) {
	const lines = text.split('\n');
	const b = lines.findIndex((l) => l.startsWith('BENCH-BEGIN'));
	if (b === -1) throw new Error('no BENCH-BEGIN — the script did not run');
	const e = lines.findIndex((l, i) => i > b && l.startsWith('BENCH-END'));
	// A record with no END is TRUNCATED, and a half-measured box must not read
	// as a fully measured one.
	if (e === -1) throw new Error('BENCH-BEGIN with no BENCH-END — truncated');
	const out = {};
	for (const line of lines.slice(b + 1, e)) {
		const s = line.trim();
		if (!s) continue;
		const sp = s.indexOf(' ');
		if (sp === -1) continue;
		const v = s.slice(sp + 1).trim();
		out[s.slice(0, sp)] = v.startsWith('unknown') ? null : v;
	}
	return out;
}

/**
 * MEASURE ONE NODE, RETURNING A RESULT RATHER THAN EXITING OR MUTATING AN
 * OUTER ARRAY — the one piece of this file with a real transport (ssh, local
 * sudo, a capture file), extracted so BOTH the multi-node `--due`/`--write`
 * loop and the single-node `--cadence` path call the exact same ssh/sudo
 * fallback chain rather than keeping two copies to drift.
 *
 * `{ ok: true, record }` on success. On failure, `{ ok: false, reason }`, with
 * `aborted: true` when the node declined on purpose (busy, builder busy) —
 * the caller treats that differently from a real failure — and `fatal: true`
 * only for `--from`, where a wrong-host or aborted capture has no "next node"
 * to fall through to and the ORIGINAL behaviour was to exit(2) immediately.
 *
 * `timeoutMs` (default 420_000, the original hard-coded figure) bounds EACH
 * ssh/sudo attempt below — up to two may run (a privileged try, then an
 * unprivileged retry), so the worst case is roughly double this. `--cadence`
 * passes `CADENCE_MEASURE_TIMEOUT_MS`, well under the default, because it
 * runs inside a bounded cron rather than a by-hand `--write`.
 *
 * @returns {{ok:true, record:object} | {ok:false, reason:string, aborted?:boolean, fatal?:boolean}}
 */
function measureOneNode(
	node,
	{ from = null, jsonOut = false, passthru = [], timeoutMs = 420_000 } = {}
) {
	if (from) {
		// A CAPTURE MUST PROVE IT IS THE BOX IT IS BEING FILED UNDER. The record
		// carries its own hostname; without checking it, a stale file or a
		// copy-paste from another node writes one machine's numbers into
		// another's row, and every comparison built on this file is then wrong
		// in a way nothing can see.
		const r = parse(readFileSync(from, 'utf8'));
		if (r.hostname && !isLocalNode(node, r.hostname) && r.hostname !== node) {
			return {
				ok: false,
				fatal: true,
				reason: `${from} was captured on '${r.hostname}', not '${node}'`,
			};
		}
		if (r.aborted) {
			return { ok: false, fatal: true, reason: `that capture aborted — ${r.aborted}` };
		}
		if (!jsonOut) process.stderr.write(`  ${node} ... ingested from ${from}\n`);
		return { ok: true, record: r };
	}
	if (!jsonOut) process.stderr.write(`  benchmarking ${node} ... `);
	try {
		// THE LOCAL HOST CANNOT BE REACHED BY SSH, AND THAT IS WHY hokon HAD NO
		// ROW. mgmt-api runs on hokon and hokon refuses ssh to itself, so this
		// loop's one transport failed for it on every run since the script was
		// written — `ssh hokon` is "Connection refused", which lands in the
		// generic catch below and prints as a FAILED node. The result was not a
		// visible gap but an invisible one: the production host, the box every
		// other node is compared against, was structurally unmeasurable while
		// the table it is missing from renders perfectly.
		//
		// This is the same trap as the fast loop reading hokon as permanently
		// saturated. `isLocalNode` is the one place that question is asked —
		// see src/lib/node-identity.ts and the guard test beside it.
		//
		// LOCALLY, sudo MUST BE `-n`. The ssh path can afford bare `sudo` because
		// the claws are provisioned NOPASSWD; hokon is not, and an interactive
		// sudo under BatchMode does not prompt — it hangs or dies. `-n` fails
		// fast instead, and benchmark-node.sh already degrades correctly without
		// root: every field that needs it (dmidecode's memory type and speed,
		// smartctl's health) is emitted as `unk` WITH THE REASON, which is the
		// difference between a measured gap and a silent one.
		const local = isLocalNode(node);
		const argv = local
			? ['sh', '-s', '--', ...passthru]
			: [
					'-o',
					'BatchMode=yes',
					'-o',
					'ConnectTimeout=8',
					sshDestination(node, 'admin'),
					'sudo',
					'sh',
					'-s',
					'--',
					...passthru,
				];
		const spawn = (cmd, a) =>
			execFileSync(cmd, a, {
				input: readFileSync(SCRIPT),
				encoding: 'utf8',
				timeout: timeoutMs,
				maxBuffer: 8 << 20,
			});
		let out;
		if (local) {
			try {
				out = spawn('sudo', ['-n', ...argv]);
			} catch {
				// -n failed, so this host is not NOPASSWD. An OPERATOR at a
				// terminal can simply type the password, and on hokon they must:
				// / /home /var and /srv are one LVM device, none of them
				// user-writable, so the dd test has no unprivileged path at all
				// and the disk row is blank without root.
				//
				// sudo reads the password from /dev/tty, not stdin, so the script
				// on stdin does not conflict with the prompt — but the prompt
				// itself must reach the terminal, hence stderr: 'inherit'.
				let prompted = false;
				if (!jsonOut && process.stderr.isTTY) {
					try {
						process.stderr.write('\n    (needs root for the disk test) ');
						out = execFileSync('sudo', argv, {
							input: readFileSync(SCRIPT),
							encoding: 'utf8',
							timeout: timeoutMs,
							maxBuffer: 8 << 20,
							stdio: ['pipe', 'pipe', 'inherit'],
						});
						prompted = true;
					} catch {
						// Declined or wrong password — fall through, do not fail.
					}
				}
				if (!prompted) {
					// Unattended, or the operator declined. Measure what does not
					// need root rather than leaving the production host blank.
					if (!jsonOut) process.stderr.write('(unprivileged) ');
					out = spawn('bash', ['-s', '--', ...passthru]);
				}
			}
		} else {
			try {
				out = spawn('ssh', argv);
			} catch (err) {
				// A BOX THAT IS NOT IN THE FLEET YET HAS NO NOPASSWD SUDO. The
				// claws are provisioned with it; a candidate machine is not, so
				// `ssh host sudo sh -s` fails outright and the whole scan reads
				// as an unreachable node. Retry unprivileged rather than report
				// nothing: benchmark-node.sh already marks every root-only field
				// as unk WITH its reason, which is the honest degraded answer.
				const stdout = typeof err.stdout === 'string' ? err.stdout : err.stdout?.toString?.();
				if (stdout && stdout.includes('BENCH-BEGIN')) throw err;
				if (!jsonOut) process.stderr.write('(unprivileged) ');
				out = spawn('ssh', [
					'-o',
					'BatchMode=yes',
					'-o',
					'ConnectTimeout=8',
					sshDestination(node, 'admin'),
					'sh',
					'-s',
					'--',
					...passthru,
				]);
			}
		}
		const r = parse(out);
		if (r.aborted) {
			// NOT marked `aborted: true` — benchmark-node.sh always exits 2 on an
			// abort, so execFileSync always THROWS for this case and the catch
			// block below is where a real abort is actually detected. This branch
			// is defensive only; kept to match the pre-extraction behaviour
			// exactly rather than claim a certainty about every future shell.
			if (!jsonOut) process.stderr.write(`skipped (${r.aborted})\n`);
			return { ok: false, reason: r.aborted };
		}
		if (!jsonOut) process.stderr.write('ok\n');
		return { ok: true, record: r };
	} catch (err) {
		// A DELIBERATE REFUSAL IS NOT A FAILURE. benchmark-node.sh exits 2 when
		// the node is building, and execFileSync throws on any non-zero status —
		// so the `aborted` check above never ran and claw-2, which had correctly
		// declined to be loaded while running two jobs, was reported as
		// "FAILED — Command failed: ssh ...". That reads as an unreachable node
		// and sends someone to debug ssh.
		//
		// The script's own output is on the error object; parse it before
		// deciding what happened.
		const stdout = typeof err.stdout === 'string' ? err.stdout : err.stdout?.toString?.();
		if (stdout) {
			try {
				const r = parse(stdout);
				if (r.aborted) {
					if (!jsonOut) process.stderr.write(`skipped — ${r.aborted}\n`);
					return { ok: false, reason: r.aborted, aborted: true };
				}
			} catch {
				// Not a record at all; fall through to the generic failure below.
			}
		}
		const why = String(err.message).split('\n')[0];
		if (!jsonOut) process.stderr.write(`FAILED — ${why}\n`);
		return { ok: false, reason: why };
	}
}

/**
 * A DEGRADED RUN MUST NOT ERASE WHAT A BETTER ONE MEASURED.
 *
 * $benchmark is replaced wholesale, so a run that could not measure a facet
 * would otherwise overwrite the facet with null and the evidence is simply
 * gone. That is not hypothetical: hokon has no passwordless sudo, so ANY
 * unattended run there falls back to unprivileged and comes back with no disk
 * timings, no SMART and no DIMM data -- silently deleting the numbers an
 * operator had to type a password to obtain. "I could not look" would become
 * "there is nothing there", which is the inversion this repo keeps
 * re-learning.
 *
 * Promoted to the top level (wave 3x) so `--cadence`'s single-node write can
 * share this guard with the multi-node `--write` path below rather than
 * reimplementing it.
 */
function lostFacets(before, after, path = '') {
	if (!before || typeof before !== 'object') return [];
	const lost = [];
	for (const [k, v] of Object.entries(before)) {
		const n = after?.[k];
		const at = path ? `${path}.${k}` : k;
		if (v && typeof v === 'object') lost.push(...lostFacets(v, n, at));
		else if (v !== null && v !== undefined && v !== '' && (n === null || n === undefined))
			lost.push(at);
	}
	return lost;
}

/**
 * Decide whether a freshly measured record is safe to persist over whatever is
 * already stored for `node`. Pure: builds the candidate inventory entry and
 * compares it against the stored one, but writes nothing — the caller calls
 * `writeFacet` only when this says `ok`.
 */
export function decideRecord(node, r, { stored, force = false }) {
	const next = inventoryEntry(r);
	const prev = stored.nodes[node];
	const lost = lostFacets(prev && !prev.unavailable ? prev.value : null, next);
	if (lost.length && !force) return { ok: false, lost, rooted: r['capture.root'] ?? null };
	return { ok: true, record: next };
}

/**
 * The finding for a record decideRecord refused, naming the fields (#121).
 *
 * It used to say "needs a rooted capture" for ANY lost field. claw-9's capture
 * ran under sudo and was refused anyway, so the advice sent the reader after a
 * cause that was not there. Root is advised only when the capture SAYS it ran
 * unprivileged (`capture.root no`, from benchmark-node.sh); otherwise the
 * finding states what happened and leaves the cause to the field list.
 */
export function degradedFinding({ node, lost, rooted }) {
	const fields =
		lost.slice(0, 6).join(', ') + (lost.length > 6 ? ` (+${lost.length - 6} more)` : '');
	if (rooted === 'no')
		return `${node}: needs a rooted capture — this run ran unprivileged and could not measure ${lost.length} field(s): ${fields}`;
	return `${node}: ${lost.length} field(s) went from a value to unmeasured, so the stored record was kept: ${fields}`;
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
	execFileSync(process.execPath, [join(HERE, 'drain-node.mjs'), node, '--undo'], {
		stdio: 'ignore',
		timeout: DRAIN_CLI_BUDGET_MS,
	});
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

/**
 * THE CLI GLUE FOR `--cadence`: validates the flag combination, wires
 * `runCadence` to the REAL fleet (the live manifest, `createLiveDeps()`,
 * `busyCount`, and `measureOneNode` over ssh), bands the rest of the lead
 * window into advisories/findings, persists what it measured, and exits.
 *
 * Everything decision-shaped above this function is pure and tested directly;
 * this is the one place that touches argv, a real node, and stdout, which is
 * why it is untested on its own — same division as `createLiveDeps()` itself.
 */
async function runCadenceCli({ dueDays, jsonOut, passthru, force, refuseIf, log, emitter }) {
	const refuse = (msg) => {
		console.error(`benchmark: ${msg}`);
		process.exit(2);
	};
	if (refuseIf.report) refuse('--cadence and --report are mutually exclusive.');
	if (refuseIf.scan)
		refuse(
			'--cadence measures a fleet node on its own schedule; it has nothing to say about --scan.'
		);
	if (refuseIf.from)
		refuse('--cadence measures the node it picks itself; --from has nothing to attach to.');
	if (refuseIf.named.length)
		refuse(
			'--cadence picks its own node so a batch never re-synchronises; naming one defeats ' +
				'that — use `fleet benchmark <node> --write` instead.'
		);
	if (refuseIf.max !== null)
		refuse('--cadence measures at most one node by construction; --max does not apply.');
	if (refuseIf.write)
		refuse('--cadence always records what it measures; --write is implicit, not optional.');
	if (dueDays === null)
		refuse('--cadence needs --due N — the lead and grace windows are measured from it.');

	const machines = fleetMachines();
	const guests = guestNodeNames({ machines });
	const leadDays = Math.max(1, dueDays - LEAD_OFFSET_DAYS);
	const graceDays = dueDays + GRACE_OFFSET_DAYS;
	// Every CLAW aged past the lead window, oldest first — guests already split
	// into skippedByRole by dueNodes, same split --report relies on.
	const leadAged = dueNodes(leadDays, null);

	const liveDeps = createLiveDeps();
	// A FRESH CLOCK, not `createLiveDeps()`'s — that one is private to its own
	// `waitDrained`, which is exactly the unbounded (45-minute) call this file
	// must NOT make. `busyCount` is the same prober either way.
	const clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

	// `state.held` is the node WE hold drained, named for `cadenceSignalHandler`
	// below — a process KILL abandons `runCadence`'s own `finally`, so this is
	// what lets something OUTSIDE that call recover. Cleared by `runCadence`
	// itself once it reaches its own undrain attempt normally.
	const state = { held: null };
	const onSignal = (signal) => cadenceSignalHandler(state, signal);
	process.on('SIGTERM', onSignal);
	process.on('SIGINT', onSignal);

	let outcome;
	try {
		outcome = await runCadence({
			candidates: leadAged.due,
			deps: {
				isDrained: (n) => liveDeps.isDrained(n),
				busy: (n) => busyCount(n),
				drain: (n, opts) => liveDeps.drain(n, opts),
				// BOUNDED (the manager's safety finding on this lane): `--cadence`
				// runs off a cron with a real, enforced ceiling; see
				// `CADENCE_WAIT_TIMEOUT_MS`'s own comment for the full budget.
				waitDrained: (n) =>
					waitUntilDrained({ node: n, busy: busyCount, clock, timeoutMs: CADENCE_WAIT_TIMEOUT_MS }),
				undrain: (n) => liveDeps.undrain(n),
			},
			measure: (n) => {
				const res = measureOneNode(n, {
					jsonOut,
					passthru,
					timeoutMs: CADENCE_MEASURE_TIMEOUT_MS,
				});
				if (!res.ok) throw new Error(res.reason);
				return res.record;
			},
			log: (l) => {
				if (!jsonOut) process.stderr.write(`${l}\n`);
			},
			state,
		});
	} finally {
		process.off('SIGTERM', onSignal);
		process.off('SIGINT', onSignal);
	}

	const results = {};
	const failures = [];
	const degraded = [];
	const unsaved = [];
	let measuredNode = null;

	if (outcome.node && outcome.record) {
		const stored = measuredFacets('benchmark', machines);
		const decided = decideRecord(outcome.node, outcome.record, { stored, force });
		if (decided.ok) {
			const w = writeFacet(
				'benchmark',
				{ [outcome.node]: decided.record },
				{ extra: { [outcome.node]: { raw: outcome.record } } }
			);
			if (w.ok) {
				measuredNode = outcome.node;
				results[outcome.node] = outcome.record;
				if (!jsonOut)
					log(`\nbenchmark recorded for ${outcome.node} in ${w.path}; logged to ${w.logPath}`);
			} else {
				unsaved.push(`${w.path}: ${w.reason} — ${w.why}`);
			}
		} else {
			degraded.push({ node: outcome.node, lost: decided.lost, rooted: decided.rooted });
		}
	} else if (outcome.node && outcome.error) {
		failures.push({ node: outcome.node, why: outcome.error });
	}
	if (outcome.node && outcome.undrained === false) {
		failures.push({
			node: outcome.node,
			why: `STILL DRAINED after the cadence: ${outcome.undrainReason ?? 'undrain failed'}`,
		});
	}

	const { advisories, findings: bandFindings } = cadenceBands({
		due: leadAged.due,
		measuredNode,
		dueDays,
		graceDays,
	});
	// "I could not look" must never read as "nothing is wrong", even for a node
	// still comfortably inside the lead window — see AGENTS.md.
	const unreachableFindings = outcome.skipped
		.filter((s) => /could not (reach|read)|drain (failed|refused)/.test(s.reason))
		.map((s) => `${s.node}: could not look — ${s.reason}`);

	const cov = coverageOf(measuredNode ? { [measuredNode]: true } : {});
	const covFindings = coverageFindings(cov, guests);

	const findings = [
		...bandFindings,
		...unreachableFindings,
		...covFindings,
		...unsaved,
		...degraded.map(degradedFinding),
		...failures.map((f) => `${f.node}: ${f.why}`),
	];

	const out = {
		at: new Date().toISOString(),
		mode: 'cadence',
		measured: measuredNode,
		results,
		failures,
		skipped: outcome.skipped,
		coverage: coverageJson(cov, false),
		due: leadAged.due,
		skippedByRole: leadAged.skippedByRole,
		advisories,
		degraded,
		byHand: byHandFor(dueDays),
		findings,
		ok: findings.length === 0,
	};
	if (jsonOut) {
		emitter.emit(out);
	} else {
		log(
			measuredNode
				? `cadence measured ${measuredNode}`
				: `cadence measured nothing this run${
						outcome.skipped.length
							? ` — ${outcome.skipped.map((s) => `${s.node}: ${s.reason}`).join('; ')}`
							: ''
					}`
		);
		if (advisories.length) log(`\nadvisory:\n  ${advisories.join('\n  ')}`);
		if (findings.length) log(`\n${YEL}findings:${OFF}\n  ${findings.join('\n  ')}`);
	}
	process.exit(out.ok ? 0 : 1);
}

// `rootDisk`, `rootDiskField`, `ROWS`, `liveIface`, `liveLinkSpeed` and
// `inventoryEntry` below are pure table/record builders, kept at module scope
// (not nested in `main()`) because `decideRecord` above calls `inventoryEntry`
// and `decideRecord` is shared with `runCadenceCli`. See the comment above
// `async function main()` for why everything STATEFUL starts there instead.
const rootDisk = (r) => {
	const k = Object.keys(r).find(
		(x) => /^disk\..*\.mountpoints$/.test(x) && (r[x] || '').includes('/')
	);
	return k ? k.split('.')[1] : null;
};
/**
 * A SMART FIGURE BELONGS TO A DEVICE, AND THIS TABLE NAMES ONE — the root disk.
 *
 * The `disk hours` and `disk realloc` rows used to read
 * `find(r, /^disk\..*\.powerOnHours$/)`: the FIRST matching key in enumeration
 * order, which is `/sys/block/*` in alphabetical order and therefore `sda`
 * whatever `/` is actually on. The `root disk` row directly above them resolves
 * its device from `mountpoints`, so on any box where root is not the first disk
 * those rows described TWO DIFFERENT DRIVES in one column with nothing saying
 * so.
 *
 * claw-9 is the live case and the reason this is a fix rather than a tidy-up:
 * root is `sdb`, a 240G SSD at 29888 hours with 7 reallocated sectors, while
 * `sda` is a 1TB spinner at 31450 hours with 0. The table printed the SSD's
 * model beside the HDD's age and the HDD's zero — the root disk's 7 reallocs
 * appeared nowhere, and the column was read as one drive in a wave brief.
 *
 * One resolver, one device: `rootDisk(r)`, which is the same answer
 * `inventoryEntry`'s `rootDisk` block has always used. A field the root disk
 * does not report is `—`, never another disk's value.
 */
const rootDiskField = (r, field) => {
	const d = rootDisk(r);
	return (d ? r[`disk.${d}.${field}`] : null) ?? '—';
};

const ROWS = [
	['cpu', (r) => (r['cpu.model'] || '').replace(/\(R\)|\(TM\)|CPU|@.*/g, '').trim()],
	['cores / threads', (r) => `${r['cpu.cores'] ?? '?'} / ${r['cpu.threads'] ?? '?'}`],
	['max MHz', (r) => r['cpu.mhzMax'] ?? '—'],
	[
		'RAM',
		(r) =>
			`${Math.round((+r['mem.totalKb'] || 0) / 1048576)}G ${r['mem.type'] ?? ''} ${r['mem.speedMTs'] ?? ''}`,
	],
	[
		'mem bandwidth',
		(r) =>
			r['bench.memBandwidthBps'] ? `${(r['bench.memBandwidthBps'] / 1e9).toFixed(2)} GB/s` : '—',
	],
	[
		'cpu 1-core',
		(r) =>
			r['bench.cpuSha512SingleKBps']
				? `${Math.round(parseFloat(r['bench.cpuSha512SingleKBps']) / 1024)} MB/s`
				: '—',
	],
	[
		'cpu all-core',
		(r) =>
			r['bench.cpuSha512AllCoreKBps']
				? `${Math.round(parseFloat(r['bench.cpuSha512AllCoreKBps']) / 1024)} MB/s`
				: '—',
	],
	['disk write', (r) => r['bench.diskWrite.root'] ?? '—'],
	['disk read', (r) => r['bench.diskRead.root'] ?? '—'],
	[
		'root disk',
		(r) => {
			const n = rootDisk(r);
			if (!n) return '—';
			return `${r[`disk.${n}.model`] ?? n}${r[`disk.${n}.rotational`] === '1' ? ' SPIN' : ' ssd'}`;
		},
	],
	// THE ROOT DISK'S, not the first disk's — see rootDiskField.
	['disk hours', (r) => rootDiskField(r, 'powerOnHours')],
	['disk realloc', (r) => rootDiskField(r, 'reallocated')],
	[
		'net to archive',
		(r) =>
			r['bench.netArchiveBps'] ? `${(r['bench.netArchiveBps'] / 125000).toFixed(0)} Mbit/s` : '—',
	],
	// The interface that is UP, not the first in sort order — see liveLinkSpeed.
	['link speed', (r) => liveLinkSpeed(r) ?? '—'],
	['GPU', (r) => `${r['gpu.driver'] ?? '—'}${r['gpu.nvencAv1Capable'] === 'yes' ? ' av1' : ''}`],
	['idle -> load C', (r) => `${r['thermal.idleC'] ?? '?'} -> ${r['thermal.loadedC'] ?? '?'}`],
	['PCIe errors', (r) => r['stability.aerCorrectable'] ?? '—'],
	[
		'failed units',
		// THE NAMES BEHIND THE COUNT (#87 §4), not only the count — a dead runner
		// unit and something benign both read "1" without them.
		(r) => {
			const n = r['stability.failedUnits'];
			if (n == null) return '—';
			const names = r['stability.failedUnitNames'];
			return names ? `${n} (${names})` : n;
		},
	],
	['OOM kills', (r) => r['stability.oomKills'] ?? '—'],
	['uptime days', (r) => (r.uptimeSec ? Math.round(r.uptimeSec / 86400) : '—')],
];

/**
 * The INVENTORY entry: what this node IS, as measured, with the date it was
 * measured on it.
 *
 * It lived in the manifest beside $measured until Wave 3h; it now lives in
 * `<stateDir>/benchmark.json` (`src/lib/measured.ts`), because re-measuring is
 * not an editorial act and a commit per measurement bought nothing.
 *
 * TIMESTAMPED, because every figure here decays. A disk that read 480MB/s in
 * September is not evidence about the same disk in March, and `at` is what lets
 * a reader tell a current measurement from a stale one. `benchmark.log` keeps
 * the series — every write, with the raw capture — and this keeps the latest.
 */
/**
 * THE INTERFACE THIS BOX IS ACTUALLY ON: one with carrier, falling back to any
 * that reports a link speed at all.
 *
 * Named separately from the speed it carries because EVERY per-interface figure
 * has to come from the SAME interface. `linkSpeed` was moved off first-match
 * key order when claw-1's unplugged enp4s0 outranked the wlp5s0 it really runs
 * on; `duplex` was left on `find()` in the same pass and kept reporting the
 * dead port's — the same defect, one field over.
 */
function liveIface(r) {
	const ifaces = [
		...new Set(
			Object.keys(r)
				.filter((k) => k.startsWith('net.'))
				.map((k) => k.split('.')[1])
		),
	];
	const up = ifaces.filter((i) => r[`net.${i}.carrier`] === '1' && r[`net.${i}.linkSpeed`]);
	return up[0] ?? ifaces.find((i) => r[`net.${i}.linkSpeed`]) ?? null;
}

/** The linkSpeed of an interface with carrier, falling back to any. */
function liveLinkSpeed(r) {
	const pick = liveIface(r);
	return pick ? r[`net.${pick}.linkSpeed`] : null;
}

function inventoryEntry(r) {
	const disk = rootDisk(r);
	// A MEASURED ZERO IS A VALUE (#121). This was `Number(...) || null`, which
	// stored every 0 as null: no record in benchmark.json ever held a zero, so
	// "no OOM kills" and "could not look" read the same, and lostFacets then
	// refused claw-9 for two nights because its AER count went 34 -> 0 after a
	// reboot — the box got healthier and the guard read it as a lost field.
	// Null now means only what parse() makes null: an `unknown` or no digits.
	const num = (v) => {
		if (v == null) return null;
		const digits = String(v).replace(/[^0-9.]/g, '');
		if (digits === '') return null;
		const n = Number(digits);
		return Number.isFinite(n) ? n : null;
	};
	// A RATE CARRIES A UNIT, AND num() THREW IT AWAY. dd reports in whatever
	// unit fits, so a slow disk says "184 MB/s" and a fast one says "1.9 GB/s" —
	// and stripping the non-digits scored the fast one as 1.9. The bug hit ONLY
	// the fastest disks in the fleet, because only they cross into GB/s: hokon's
	// root disk was recorded at 1.9 MB/s, the slowest number in the file, when it
	// is the quickest device we own at ~1900. A comparison table is exactly where
	// that inversion does its damage.
	const rateMBps = (v) => {
		if (v == null) return null;
		const m = String(v).match(/([0-9.]+)\s*([kMGT]?)B\/s/i);
		if (!m) return num(v);
		const n = Number(m[1]);
		if (!Number.isFinite(n)) return null;
		// dd counts in SI, so GB/s is 1e9 B/s, not 2^30.
		const scale = { k: 1 / 1000, m: 1, g: 1000, t: 1_000_000 };
		return Math.round(n * (scale[m[2].toLowerCase()] ?? 1));
	};
	return {
		at: new Date().toISOString(),
		by: 'fleet benchmark',
		cpu: {
			model: r['cpu.model'] ?? null,
			// PHYSICAL cores and threads, separately. The manifest's own `cores`
			// field is really threads — claw-1 is 4c/8t and recorded as cores: 8 —
			// so recording both is the only way to tell which any future reader
			// meant.
			cores: num(r['cpu.cores']),
			threads: num(r['cpu.threads']),
			maxMhz: num(r['cpu.mhzMax']),
			governor: r['cpu.governor'] ?? null,
			avx2: r['cpu.flag.avx2'] === 'yes',
			aes: r['cpu.flag.aes'] === 'yes',
			// sha512: the RANKING number, because SHA-NI does not touch it. See
			// benchmark-node.sh for the measurements that settled this.
			sha512SingleMBps: r['bench.cpuSha512SingleKBps']
				? Math.round(parseFloat(r['bench.cpuSha512SingleKBps']) / 1024)
				: null,
			sha512AllCoreMBps: r['bench.cpuSha512AllCoreKBps']
				? Math.round(parseFloat(r['bench.cpuSha512AllCoreKBps']) / 1024)
				: null,
			shaNi: r['cpu.flag.shaNi'] === 'yes',
			// SHA-NI accelerated where present. Kept for history and as the
			// cheapest SHA-NI detector; NOT comparable across vendors.
			sha256SingleMBps: r['bench.cpuSha256SingleKBps']
				? Math.round(parseFloat(r['bench.cpuSha256SingleKBps']) / 1024)
				: null,
			sha256AllCoreMBps: r['bench.cpuSha256AllCoreKBps']
				? Math.round(parseFloat(r['bench.cpuSha256AllCoreKBps']) / 1024)
				: null,
		},
		memory: {
			totalKb: num(r['mem.totalKb']),
			type: r['mem.type'] ?? null,
			speedMTs: num(r['mem.speedMTs']),
			sticks: num(r['mem.sticks']),
			slots: num(r['mem.slots']),
			swapKb: num(r['mem.swapTotalKb']),
			// STREAM triad, chosen 2026-09-07 (P1.4) because it accounts for
			// write-allocate traffic and two other methods do not — see
			// benchmark-node.sh's memory-bandwidth section for the comparison.
			bandwidthMBps: r['bench.memBandwidthBps']
				? Math.round(parseFloat(r['bench.memBandwidthBps']) / 1_000_000)
				: null,
			bandwidthMethod: r['bench.memBandwidthMethod'] ?? null,
		},
		rootDisk: disk
			? {
					device: disk,
					model: r[`disk.${disk}.model`] ?? null,
					kind: r[`disk.${disk}.kind`] ?? null,
					rotational: r[`disk.${disk}.rotational`] === '1',
					sizeBytes: num(r[`disk.${disk}.sizeBytes`]),
					scheduler: r[`disk.${disk}.scheduler`] ?? null,
					writeMBps: rateMBps(r['bench.diskWrite.root']),
					readMBps: rateMBps(r['bench.diskRead.root']),
					smartHealth: r[`disk.${disk}.smartHealth`] ?? null,
					powerOnHours: num(r[`disk.${disk}.powerOnHours`]),
					// ATA and NVMe express wear differently and BOTH are kept. A null
					// means the drive does not report that measure, NOT that the
					// measure is zero — claw-3 reported no disk hours at all until
					// the NVMe log format was parsed.
					reallocatedSectors: num(r[`disk.${disk}.reallocated`]),
					pendingSectors: num(r[`disk.${disk}.pendingSectors`]),
					wearLeveling: num(r[`disk.${disk}.wearLeveling`]),
					percentageUsed: num(r[`disk.${disk}.percentageUsed`]),
					availableSparePct: num(r[`disk.${disk}.availableSparePct`]),
					mediaErrors: num(r[`disk.${disk}.mediaErrors`]),
					unsafeShutdowns: num(r[`disk.${disk}.unsafeShutdowns`]),
					tempC: num(r[`disk.${disk}.tempC`]),
				}
			: null,
		// EVERY drive, not only the one / is on. claw-4 has a second 1TB disk
		// that nothing looking at / would ever mention.
		disks: [
			...new Set(
				Object.keys(r)
					.filter((k) => /^disk\.[^.]+\.model$/.test(k))
					.map((k) => k.split('.')[1])
			),
		].map((d) => ({
			device: d,
			model: r[`disk.${d}.model`],
			kind: r[`disk.${d}.kind`] ?? null,
			rotational: r[`disk.${d}.rotational`] === '1',
			sizeBytes: num(r[`disk.${d}.sizeBytes`]),
			mountpoints: r[`disk.${d}.mountpoints`],
			smartHealth: r[`disk.${d}.smartHealth`] ?? null,
			powerOnHours: num(r[`disk.${d}.powerOnHours`]),
		})),
		gpu: {
			driver: r['gpu.driver'] ?? null,
			count: num(r['gpu.count']),
			device: r['gpu.1.device'] ?? null,
			// Silicon generation, not "is there a GPU". A GTX 745 has an NVENC
			// block and no AV1 encoder at all, which is why av1-nvenc probes `no`
			// on hardware that plainly has a GPU.
			av1Encode: r['gpu.nvencAv1Capable'] === 'yes',
		},
		network: {
			// THE INTERFACE THAT IS ACTUALLY UP. First-match key order put claw-1's
			// unplugged enp4s0 ahead of the wlp5s0 it really runs on — so the fleet
			// table showed a dead port's non-answer as that node's network.
			//
			// BOTH fields come off that one interface. `duplex` stayed on the
			// first-match reader after `linkSpeed` was fixed, so a wifi node
			// reported the speed of its wireless link beside the duplex of an
			// unplugged socket. A wireless interface emits no duplex at all
			// (benchmark-node.sh only emits it when the kernel has one), and `—`
			// for "this link has no duplex" is the honest answer; another device's
			// `full` is not.
			linkSpeed: liveLinkSpeed(r),
			duplex: (() => {
				const i = liveIface(r);
				return (i ? r[`net.${i}.duplex`] : null) ?? '—';
			})(),
			archiveMbits: r['bench.netArchiveBps'] ? Math.round(r['bench.netArchiveBps'] / 125000) : null,
		},
		thermal: {
			idleC: num(r['thermal.idleC']),
			loadedC: num(r['thermal.loadedC']),
			// WHERE the number came from, and whether to believe it. Both AMD
			// boxes read 0 until 2026-09-03 because only thermal_zone was
			// consulted, and claw-5 now reads ~20C loaded because k10temp on
			// family 15h is a relative offset. A temperature with no provenance
			// is what let both of those pass as measurements.
			source: r['thermal.loadedC.source'] ?? r['thermal.idleC.source'] ?? null,
			suspect: r['thermal.loadedC.suspect'] ?? null,
		},
		stability: {
			aerCorrectable: num(r['stability.aerCorrectable']),
			failedUnits: num(r['stability.failedUnits']),
			// THE NAMES BEHIND THE COUNT (#87 §4): a count alone cannot tell a dead
			// runner unit from something benign without ssh-ing in — the exact gap
			// that left claw-3 and claw-6's `failed units: 1` undiagnosable on
			// 2026-10-04. Comma-joined by benchmark-node.sh; `[]` (not null) when
			// the count is genuinely zero.
			failedUnitNames: r['stability.failedUnitNames']
				? r['stability.failedUnitNames'].split(',').filter(Boolean)
				: [],
			oomKills: num(r['stability.oomKills']),
			uptimeSec: num(r.uptimeSec),
		},
		chassis: {
			vendor: r['dmi.sys_vendor'] ?? null,
			product: r['dmi.product_name'] ?? null,
			board: r['dmi.board_name'] ?? null,
			bios: r['dmi.bios_version'] ?? null,
		},
	};
}

/**
 * EVERYTHING BELOW THIS LINE TOUCHES `process.argv`, STDOUT, OR THE FLEET.
 *
 * Run only when this file is the CLI entry point (the guard at the bottom of
 * the file), so that `runCadence`, `cadenceBands` and the other pure functions
 * above can be imported by a test without that import ALSO parsing argv,
 * ssh-ing to a node, or writing a state file — the same reason
 * `check-version-ahead.mjs` and `check-health-freshness.mjs` are shaped this
 * way. `benchmark-fleet.test.mjs` still drives the real CLI as a subprocess
 * for everything that is cheapest to prove end-to-end (the table, `--from`,
 * `--write`); the cadence's drain/undrain/busy dependencies are the part no
 * subprocess can safely fake without a real ssh target, so THOSE are proven by
 * importing `runCadence` directly and injecting fixtures, the same way
 * `refresh-cycle.test.mjs` proves `runRefreshCycle`.
 */
async function main() {
	const args = process.argv.slice(2);
	const has = (f) => args.includes(f);
	// One stdout discipline, shared — see lib/emit.mjs. Created BEFORE the help
	// block, which is itself a stdout write; the emitter reads process.argv and
	// lets --help win over --json for exactly that reason.
	const emitter = createEmitter();
	const log = emitter.log;

	if (has('--help') || has('-h')) {
		log(
			[
				'fleet benchmark [node...] [--quick] [--force] [--write] [--json]',
				'fleet benchmark --due N --report [--json]   who is due; touches nothing',
				'fleet benchmark --due N --cadence [--json]  measure the ONE most-overdue idle',
				'                                             claw; drains, measures, writes, undrains',
				'fleet scan <host...> [--quick] [--json]   any box, fleet member or not',
				'',
				'  no nodes    every machine in the fleet manifest',
				'  --quick     skip the disk and network timings (inventory only)',
				'  --force     benchmark even a node that is currently building',
				'  --write     record each node in <stateDir>/benchmark.json and append a line',
				'              to <stateDir>/benchmark.log. No commit: the state dir is no checkout.',
				'  --from F    ingest a capture instead of running: sudo sh benchmark-node.sh > F',
				'  --json      machine-readable output',
				'  --due N     only nodes whose benchmark record is older than N days. A node',
				'              with NO record — no state file, nothing in the manifest — is due.',
				'  --max N     measure at most N nodes this run (bounds the load)',
				'  --report    LIST the nodes due against --due and stop. No ssh, no load,',
				'              no write. Needs --due; refuses --max and --write.',
				'  --cadence   measure exactly ONE node this run: the most-overdue claw that is',
				'              idle and not already held by someone else. Drains it the way',
				'              `ci:toolchain-refresh` does, waits for it to go quiet, measures,',
				'              writes, undrains — always, even if the measurement fails. Needs',
				'              --due; refuses --report/--scan/--from/--max/a named node/--write',
				'              (it always writes what it measures).',
				'',
				'  --due never selects a GUEST: the fleet chain does not act on one, and a',
				'  finding naming it is paging about it. Exempt machines are reported in',
				'  `skippedByRole` rather than dropped. Naming one positionally still',
				'  measures it — a person asking is not the fleet chain acting.',
				'',
				'It loads each box on purpose — thermals and throttling are only',
				'observable under load — so it skips nodes running CI unless forced.',
				'',
				'The cadence runs nightly in the quiet hour (operator, 2026-10-04, reversing',
				'the 2026-09-15 "no cron measures"): one node a night, so a batch measured',
				'together never ages out together. A node still inside the lead window but',
				'not picked this run is an ADVISORY; past the grace it is a FINDING. Catch up',
				'on everything else by hand, on the mgmt-api host:',
				`  ${byHandFor(30)}`,
			].join('\n')
		);
		process.exit(0);
	}

	const valueOf = (f) => {
		const i = args.indexOf(f);
		return i === -1 ? null : (args[i + 1] ?? null);
	};
	const JSON_OUT = has('--json');
	const WRITE = has('--write') && !has('--scan');
	const passthru = [has('--quick') && '--quick', has('--force') && '--force'].filter(Boolean);
	// INGEST A CAPTURE THE OPERATOR TOOK BY HAND.
	//
	// hokon has no passwordless sudo (the claws do, deliberately) and its disk test
	// has no unprivileged path -- /, /home, /var and /srv are one LVM device, none
	// user-writable -- so the only way to measure it is a person typing a password.
	// Without this, that measurement had nowhere to go: the numbers scrolled past
	// in a terminal and the fleet file stayed blank.
	//
	// Reuses parse() and inventoryEntry() rather than reimplementing the record
	// shape, so an ingested node is indistinguishable from a measured one.
	const fromIdx = args.indexOf('--from');
	const FROM = fromIdx !== -1 ? args[fromIdx + 1] : null;
	if (fromIdx !== -1 && !FROM) {
		console.error('benchmark: --from needs a file path');
		process.exit(2);
	}
	// EVERY FLAG THAT TAKES A VALUE HIDES A NODE-SHAPED ARGUMENT BEHIND IT, and the
	// positional args ARE the node list, so each value must be excluded by index or
	// it is read as a machine name. `--due 30` tried to ssh to a host called 30.
	//
	// A set rather than per-flag tests, because the per-flag form was already wrong
	// once: `i !== fromIdx + 1` with no --from present is `i !== 0`, which silently
	// dropped the FIRST node and turned a one-box run into a whole-fleet one. A new
	// value-taking flag now only has to be named here.
	// SCAN IS THE SAME MEASUREMENT AIMED SOMEWHERE ELSE.
	//
	// `fleet scan <host>` answers "what is this machine" for a box that is not in
	// the manifest -- a candidate before enrollment, or anything else reachable
	// over ssh. It is deliberately the same code path: the node half already runs
	// anywhere, and a second implementation would be a second set of readers to
	// keep honest, which is how the fleet ended up with five isLocalNode()s.
	//
	// The only differences are the ones that MUST differ: hosts come from argv and
	// never from the roster, and it refuses to write, because a machine that is not
	// in the manifest has no row to update and one that IS should be measured by
	// `benchmark` with its coverage and staleness rules applied.
	const SCAN = has('--scan');
	const VALUE_FLAGS = ['--from', '--due', '--max'];
	const flagValueIdx = new Set();
	for (const f of VALUE_FLAGS) {
		const i = args.indexOf(f);
		if (i !== -1) flagValueIdx.add(i + 1);
	}
	const named = args.filter((a, i) => !a.startsWith('--') && !flagValueIdx.has(i));

	if (SCAN && !named.length) {
		console.error('scan: needs at least one host — fleet scan <host> [host...]');
		process.exit(2);
	}
	const DUE_DAYS = valueOf('--due') === null ? null : Number(valueOf('--due'));
	const MAX_NODES = valueOf('--max') === null ? null : Number(valueOf('--max'));
	if (DUE_DAYS !== null && !Number.isFinite(DUE_DAYS)) {
		console.error('benchmark: --due needs a number of days');
		process.exit(2);
	}

	const CADENCE = has('--cadence');
	if (CADENCE) {
		await runCadenceCli({
			dueDays: DUE_DAYS,
			jsonOut: JSON_OUT,
			passthru,
			force: has('--force'),
			refuseIf: {
				report: has('--report'),
				scan: SCAN,
				from: FROM,
				named,
				max: MAX_NODES,
				write: has('--write'),
			},
			log,
			emitter,
		});
		return; // runCadenceCli always exits the process itself
	}

	/**
	 * WHICH NODES ARE DUE — ANSWERED WITHOUT TOUCHING ONE.
	 *
	 * `ci:fleet-benchmark` ran `--due 30 --max 2 --write --json` nightly from
	 * `~/srv`. Since 0.22.129 the writer REFUSES a deploy tree, so the first night
	 * a node actually aged out (~2026-10-03) the job would have failed on
	 * `deploy-tree` having measured nothing — the cron would have reported its own
	 * breakage in place of the fleet's answer, nightly, until someone read a log.
	 *
	 * THIS DESCRIBES `--report` SPECIFICALLY, and `--report`'s behaviour has not
	 * changed: it still answers from the stored records alone and exits before
	 * touching a machine. The 2026-09-15 "no cron writes a manifest" decision it
	 * documents is the reason `--report` exists at all, but it is no longer the
	 * whole story — `--cadence` (wave 3x, #87) is a SEPARATE, later decision that
	 * a bounded, idle-only, one-node-a-night write is worth the page it replaces.
	 * See `runCadenceCli` for that path; this comment is kept because `--report`
	 * itself is unchanged and still needs explaining.
	 *
	 * So this path answers exactly one question, from the stored records alone
	 * (`storedBenchmarks`), and then EXITS — above the measurement loop, which is the only code in
	 * this file that reaches a machine. No ssh, no sudo, no `dd`, no load, and
	 * nothing written anywhere. hokon is a guest and is read here like every other
	 * row: a date out of a file is not a probe.
	 *
	 * IT REFUSES `--max` RATHER THAN HONOURING IT. `--max` bounds how many boxes
	 * one night may LOAD, and a report loads none — applying it here would truncate
	 * the list of due nodes, so the further behind the fleet fell the quieter this
	 * would get. No gate may get easier to pass the worse the failure gets.
	 *
	 * IT REQUIRES `--due`. "Due" is meaningless without a threshold, and defaulting
	 * one would make the answer depend on a number nobody typed.
	 */
	const REPORT = has('--report');
	if (REPORT) {
		const refuse = (msg) => {
			console.error(`benchmark: ${msg}`);
			process.exit(2);
		};
		if (has('--write'))
			refuse(
				'--report and --write are mutually exclusive. --report reads the stored ' +
					'benchmark records and writes nothing; --write measures and records.'
			);
		if (SCAN)
			refuse('--report reads the fleet manifest, so it has nothing to say about --scan hosts');
		if (MAX_NODES !== null)
			refuse(
				'--report does not take --max. --max bounds how many boxes a run may LOAD, ' +
					'and a report loads none — capping it would hide due nodes exactly when there ' +
					'are most of them.'
			);
		if (DUE_DAYS === null)
			refuse('--report needs --due N — "due" has no meaning without a threshold');

		const inScope = (n) => !named.length || named.includes(n);
		const aged = dueNodes(DUE_DAYS, null);
		const dueList = aged.due.filter((d) => inScope(d.node));
		const skippedByRole = aged.skippedByRole.filter((d) => inScope(d.node));
		// Only a FULL-FLEET report can speak to fleet coverage, exactly as above.
		const c = named.length ? { never: [], stale: [] } : coverageOf({});
		// A GUEST MAY NOT BE PAGED ABOUT THROUGH COVERAGE EITHER. Excluding it from
		// `due` and then naming it in `findings` as never-measured or stale would
		// route the same page down the other pipe — `findings` is exactly what the
		// cron turns into an alert. Nothing is lost: any guest a threshold selected
		// is in `skippedByRole` above with its dates, `measuredAt: null` included.
		const guests = guestNodeNames({ machines: fleetMachines() });
		const f = coverageFindings(c, guests);
		const byHand = byHandFor(DUE_DAYS);
		const line = (d) =>
			`  ${d.node.padEnd(10)}${d.measuredAt ? `${d.measuredAt}  (${d.ageDays}d)` : 'NEVER measured'}`;
		const exempt = skippedByRole.length
			? `\n\nnot due — exempt by role (the fleet chain does not act on these):\n` +
				skippedByRole.map((d) => `${line(d)}  [${d.role}]`).join('\n')
			: '';
		if (JSON_OUT) {
			emitter.emit({
				at: new Date().toISOString(),
				// SAME SHAPE AS A MEASURING RUN, with one field saying which it was. A
				// consumer that has to handle two different shapes from one subcommand
				// is a consumer that will eventually mis-read one of them.
				mode: 'report',
				results: {},
				failures: [],
				coverage: coverageJson(c, named.length > 0),
				due: dueList,
				// Aged out, and exempt anyway. `due` ∪ `skippedByRole` is every machine
				// the threshold selected, so nothing vanishes between them.
				skippedByRole,
				degraded: [],
				byHand,
				findings: f,
				ok: f.length === 0,
			});
		} else if (dueList.length) {
			log(
				`${dueList.length} node(s) due against ${DUE_DAYS}d:\n` +
					dueList.map(line).join('\n') +
					`\n\nNo cron measures — measure by hand, on the mgmt-api host:\n  ${byHand}` +
					exempt +
					(f.length ? `\n\n${YEL}findings:${OFF}\n  ${f.join('\n  ')}` : '')
			);
		} else {
			log(
				`nothing due — every node measured within ${DUE_DAYS}d` +
					exempt +
					(f.length ? `\n${YEL}findings:${OFF}\n  ${f.join('\n  ')}` : '')
			);
		}
		// A due node is not this command's failure — it is the ANSWER, and the cron
		// turns it into its own finding. A node that has NEVER been measured is a
		// different thing: a hole in the comparison every capacity decision in the
		// manifest is made from, and it exits non-zero like the measuring path does —
		// unless it is a guest, which this command has nothing to say about.
		process.exit(c.never.some((n) => !guests.has(n)) ? 1 : 0);
	}

	// THE MEASURING PATH GETS THE SAME ROLE EXCLUSION, and it matters more here
	// than in the report: this is the branch that sshes a box and loads it. Before
	// 2026-09-16 `--due 30 --max 2 --write` would have picked hokon up on the first
	// night its stamp aged out and run benchmark-node.sh on a guest. An OPERATOR
	// naming it positionally (`fleet benchmark hokon --write`) is unaffected —
	// `named` bypasses this entirely, which is correct: a person asking is not the
	// fleet chain acting.
	const aged = DUE_DAYS === null ? null : dueNodes(DUE_DAYS, MAX_NODES);
	const due = aged ? aged.due : null;
	const skippedByRole = aged ? aged.skippedByRole : [];
	const nodes = named.length ? named : due ? due.map((d) => d.node) : fleetNodes();
	if (due && !nodes.length) {
		// Nothing aged out. Say so in the shape the caller asked for and stop before
		// loading a single box.
		// SAME SHAPE AS A FULL RUN. No cron reaches here any more — `--report` exits
		// above — so this is the by-hand `--due N` path finding nothing aged out. The
		// shape is kept identical anyway: a consumer that has to handle two different
		// shapes from one subcommand is a consumer that will eventually mis-read one
		// of them.
		const c = coverageOf({});
		const f = coverageFindings(c);
		const out = {
			at: new Date().toISOString(),
			results: {},
			failures: [],
			coverage: coverageJson(c, false),
			due: [],
			// Nothing to measure MAY mean the only aged-out machines were exempt by
			// role. Carried here too, so both paths hand a consumer one shape.
			skippedByRole,
			degraded: [],
			findings: f,
			ok: f.length === 0,
		};
		if (JSON_OUT) emitter.emit(out);
		else
			log(
				`nothing due — every node measured within ${DUE_DAYS}d` +
					(f.length ? `\n${YEL}findings:${OFF}\n  ${f.join('\n  ')}` : '')
			);
		process.exit(c.never.length ? 1 : 0);
	}
	if (!nodes.length) {
		console.error('benchmark: no nodes. The manifest is the roster.');
		process.exit(1);
	}

	const results = {};
	const failures = [];
	/** Nodes whose $benchmark was NOT refreshed because this run measured less. */
	const degraded = [];
	/**
	 * Why this run's numbers were not recorded.
	 *
	 * A REFUSED WRITE IS A FINDING, not a crash. The benchmark cron reads this
	 * script's JSON and treats a non-zero exit as a finding
	 * (`lib/json-contract.mjs`), so a write that could not be kept has to arrive
	 * through `findings` like every other one — "I could not look" must never
	 * render as "nothing is wrong", and neither must "I could not keep it". Since
	 * Wave 3h the only refusal left is `measured.ts`'s: a state file that exists and
	 * is unreadable or malformed is never overwritten.
	 */
	const unsaved = [];
	for (const node of nodes) {
		const res = measureOneNode(node, { from: FROM, jsonOut: JSON_OUT, passthru });
		// A CAPTURE THAT NAMES THE WRONG BOX, OR ONE THAT ABORTED, IS FATAL HERE —
		// --from is a single deliberate ingestion, so there is no "next node" to
		// fall through to. Only `measureOneNode`'s `--from` branch sets `fatal`.
		if (res.fatal) {
			console.error(`benchmark: ${res.reason}`);
			process.exit(2);
		}
		if (!res.ok) {
			failures.push({ node, why: res.reason, ...(res.aborted ? { skipped: true } : {}) });
			continue;
		}
		results[node] = res.record;
	}

	// Only a FULL-FLEET run can speak to fleet coverage. `fleet benchmark claw-2`
	// is a deliberate single-node run and must not report the other six as gaps.
	const cov = named.length ? { never: [], stale: [] } : coverageOf(results);

	const names = Object.keys(results);
	if (!JSON_OUT && names.length) {
		const w = Math.max(17, ...ROWS.map((r) => r[0].length + 1));
		const cw = Math.max(15, ...names.map((n) => n.length + 2));
		log(`\n${BOLD}${'metric'.padEnd(w)}${names.map((n) => n.padEnd(cw)).join('')}${OFF}`);
		log('-'.repeat(w + cw * names.length));
		for (const [label, fmt] of ROWS) {
			const cells = names.map((n) =>
				String(fmt(results[n]) ?? '—')
					.slice(0, cw - 1)
					.padEnd(cw)
			);
			log(label.padEnd(w) + cells.join(''));
		}
	}

	// A node that could not be measured is REPORTED, never omitted. An absent
	// column and a healthy column must not look alike.
	if (failures.length && !JSON_OUT) {
		const skipped = failures.filter((f) => f.skipped);
		const broken = failures.filter((f) => !f.skipped);
		if (skipped.length) {
			log(`\n${YEL}skipped (busy — re-run in a quiet window):${OFF}`);
			for (const f of skipped) log(`  ${f.node}: ${f.why}`);
		}
		if (broken.length) {
			log(`\n${YEL}not measured:${OFF}`);
			for (const f of broken) log(`  ${f.node}: ${f.why}`);
		}
	}

	if (WRITE) {
		// THE STATE DIR, NOT THE MANIFEST, AND NO COMMIT (Wave 3h, `src/lib/measured.ts`).
		//
		// Until then this wrote `$benchmark` into the manifest AND appended the run
		// to `fleet-benchmarks.json` beside it, and landed both as one hadoku_site
		// commit — which is why it had to refuse the deploy tree
		// (`lib/manifest-target.mjs`): a write there read back true and was gone at
		// the next publish. The state dir is not a checkout and nothing resets it, so
		// that refusal no longer applies here; it still applies to `bootcamp` and
		// `enroll`, whose facets stay in the manifest.
		//
		// `fleet-benchmarks.json` is no longer appended. It stays in the git-backed
		// tree as the record of every run up to the move; the series continues in
		// `<stateDir>/benchmark.log`, one line per node per write with the raw
		// capture, append-only and never rotated — which is a longer history than the
		// ledger's rolling twelve runs ever was.
		const machines = fleetMachines();
		const stored = measuredFacets('benchmark', machines);
		// A DEGRADED RUN MUST NOT ERASE WHAT A BETTER ONE MEASURED. See
		// `decideRecord`/`lostFacets` (top of file, shared with `--cadence`) for the
		// guard; hokon has no passwordless sudo, so ANY unattended run there falls
		// back to unprivileged and comes back with no disk timings, no SMART and no
		// DIMM data -- silently deleting the numbers an operator had to type a
		// password to obtain. "I could not look" would become "there is nothing
		// there", which is the inversion this repo keeps re-learning.
		const records = {};
		const raw = {};
		for (const [node, r] of Object.entries(results)) {
			if (!machines[node]) continue;
			const decided = decideRecord(node, r, { stored, force: has('--force') });
			if (!decided.ok) {
				degraded.push({ node, lost: decided.lost, rooted: decided.rooted });
				log(
					`\n${YEL}${node}: not overwriting $benchmark — this run measured less than the stored one${OFF}\n` +
						`  lost: ${decided.lost.slice(0, 6).join(', ')}${decided.lost.length > 6 ? ` (+${decided.lost.length - 6} more)` : ''}\n` +
						(decided.rooted === 'no'
							? '  re-run with root (hokon: sudo sh scripts/benchmark-node.sh > F, then --from F), or --force'
							: '  the capture ran as root; if the field genuinely went away, --force replaces the record')
				);
				continue;
			}
			records[node] = decided.record;
			raw[node] = { raw: r };
		}
		if (Object.keys(records).length) {
			const w = writeFacet('benchmark', records, { extra: raw });
			if (w.ok) {
				log(
					`\nbenchmark recorded for ${w.written.length} node(s) in ${w.path}; logged to ${w.logPath}`
				);
			} else {
				log(`\n${YEL}benchmark NOT recorded${OFF} — ${w.reason}: ${w.why}`);
				unsaved.push(`${w.path}: ${w.reason} — ${w.why}`);
			}
		}
	}
	// A busy node is a normal outcome, not a failed run. Only something that could
	// not be measured for a reason worth investigating sets a non-zero status.
	// FINDINGS ARE THE PRODUCT, and they are emitted AFTER persistence so the JSON
	// describes what the run actually did rather than what it was about to do. A
	// node the guard refused to overwrite is a finding too: it means the stored
	// record still holds older, better numbers and only an operator can refresh
	// them — silence there is how hokon sat unmeasured for the life of this script.
	const findings = [
		...unsaved,
		...coverageFindings(cov),
		...degraded.map(degradedFinding),
		...failures.filter((f) => !f.skipped).map((f) => `${f.node}: ${f.why}`),
	];

	if (JSON_OUT) {
		emitter.emit({
			at: new Date().toISOString(),
			results,
			failures,
			coverage: coverageJson(cov, named.length > 0),
			due: due ?? null,
			skippedByRole,
			degraded,
			findings,
			ok: findings.length === 0,
		});
	} else if (cov.never.length || cov.stale.length || degraded.length || unsaved.length) {
		log(`\n${YEL}benchmark findings:${OFF}`);
		for (const f of findings) log(`  ${f}`);
		log('  a busy node is skipped by design and stays due; it is picked up next run');
	}

	// A busy node is a normal outcome, not a failed run. A node that has NEVER been
	// measured is not — it is a hole in the comparison every capacity decision in
	// the manifest is made from. Parseable stdout wins over the exit code, per
	// scripts/lib/json-contract.mjs.
	process.exit(
		failures.some((f) => !f.skipped) || cov.never.length || degraded.length || unsaved.length
			? 1
			: 0
	);
}

// RUN ONLY AS THE CLI ENTRY POINT — the same guard `check-version-ahead.mjs`
// and `check-health-freshness.mjs` use, and the reason `runCadence`,
// `cadenceBands` and the other pure functions above can be imported by a test
// without that import also parsing argv, ssh-ing to a node, or writing a
// state file.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
