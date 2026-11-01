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
import process from 'node:process';
import { pathToFileURL } from 'node:url';
// WHERE `$benchmark` LIVES — the state dir since Wave 3h, through the one
// reader/writer that merges it with the manifest's copy while the migration is
// in flight. See src/lib/measured.ts; the BUILT copy, for the reason
// `lib/paths.mjs` gives.
import { measuredFacets, writeFacet } from '../dist/lib/measured.js';
import { backstopNodeNames } from '../dist/lib/node-role.js';
import { createEmitter } from './lib/emit.mjs';
import { ARGV_SPECS } from './lib/argv-specs.mjs';
import { parseStrict } from './lib/argv.mjs';
import {
	byHandFor,
	cadenceBands,
	cadenceSignalHandler,
	CADENCE_MEASURE_TIMEOUT_MS,
	CADENCE_WAIT_TIMEOUT_MS,
	dueNodes,
	GRACE_OFFSET_DAYS,
	LEAD_OFFSET_DAYS,
	runCadence,
} from './lib/benchmark-cadence.mjs';
import {
	coverageFindings,
	coverageJson,
	coverageOf,
	decideRecord,
	degradedFinding,
	fleetMachines,
	fleetNodes,
	ROWS,
} from './lib/benchmark-inventory.mjs';
import { measureOneNode } from './lib/benchmark-measure.mjs';
// THE SAME DRAIN `ci:toolchain-refresh` (#69) USES, reused rather than
// reimplemented: `drain`/`undrain`/`isDrained` already wrap drain-node.mjs
// and `waitUntilDrained` the wait-until-quiet poll; `busyCount` is the
// one-shot "is it busy right now" question the cadence asks BEFORE
// committing to a drain-wait on a node that is already busy — see
// `runCadence` below for why that distinction matters on a cron with a
// 1500s timeout. Imported from `lib/drain-wait.mjs` rather than
// `lib/refresh-cycle.mjs` (which still re-exports every one of these for
// its OTHER callers): this file is observation, refresh-cycle.mjs is
// lifecycle, and the two domains may not import each other directly —
// `drain-wait.mjs` is the shared stratum both may reach (wave clean-2
// lane C, cut (iii) layer debt).
//
// `waitUntilDrained` is called with an explicit `timeoutMs` rather than
// through a `waitDrained` wrapper that bakes in `DRAIN_TIMEOUT_MS` (45
// minutes), sized for an OPERATOR'S drain where "it eventually comes back"
// is the only promise. The cadence runs inside a 1500s cron; see
// `CADENCE_WAIT_TIMEOUT_MS` below for the bounded call this file makes
// instead, with the same `busyCount` and a fresh clock.
import { busyCount, drain, isDrained, undrain, waitUntilDrained } from './lib/drain-wait.mjs';
import { BOLD, YELLOW, RESET } from './lib/term.mjs';

// F10: the raw escapes and errText live once in scripts/lib/term.mjs; this
// file keeps its own short names (BOLD/YEL/OFF) rather than renaming every
// `${YEL}`/`${OFF}` below.
const YEL = YELLOW;
const OFF = RESET;

/**
 * THE CLI GLUE FOR `--cadence`: validates the flag combination, wires
 * `runCadence` to the REAL fleet (the live manifest, `drain`/`undrain`/
 * `isDrained`/`busyCount`, and `measureOneNode` over ssh), bands the rest of
 * the lead window into advisories/findings, persists what it measured, and
 * exits.
 *
 * Everything decision-shaped above this function is pure and tested directly;
 * this is the one place that touches argv, a real node, and stdout, which is
 * why it is untested on its own — same division as `drain-wait.mjs` itself.
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
	const backstops = backstopNodeNames({ machines });
	const leadDays = Math.max(1, dueDays - LEAD_OFFSET_DAYS);
	const graceDays = dueDays + GRACE_OFFSET_DAYS;
	// Every CLAW aged past the lead window, oldest first — the backstop already split
	// into skippedByRole by dueNodes, same split --report relies on.
	const leadAged = dueNodes(leadDays, null);

	// A FRESH CLOCK, used only with the explicit `timeoutMs` below — never the
	// unbounded (45-minute) `DRAIN_TIMEOUT_MS` default, which this cron-bound
	// file must NOT wait out. `busyCount` is the same prober either way.
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
				isDrained: (n) => isDrained(n),
				busy: (n) => busyCount(n),
				drain: (n, opts) => drain(n, opts),
				// BOUNDED (the manager's safety finding on this lane): `--cadence`
				// runs off a cron with a real, enforced ceiling; see
				// `CADENCE_WAIT_TIMEOUT_MS`'s own comment for the full budget.
				waitDrained: (n) =>
					waitUntilDrained({ node: n, busy: busyCount, clock, timeoutMs: CADENCE_WAIT_TIMEOUT_MS }),
				undrain: (n) => undrain(n),
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
	const covFindings = coverageFindings(cov, backstops);

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

/**
 * EVERYTHING BELOW THIS LINE TOUCHES `process.argv`, STDOUT, OR THE FLEET.
 *
 * Run only when this file is the CLI entry point (the guard at the bottom of
 * the file), so that `runCadence`, `cadenceBands` and the other pure functions
 * above can be imported by a test without that import ALSO parsing argv,
 * ssh-ing to a node, or writing a state file — the same reason
 * `check-health-freshness.mjs` is shaped this way. `benchmark-fleet.test.mjs`
 * still drives the real CLI as a subprocess for everything that is cheapest
 * to prove end-to-end (the table, `--from`,
 * `--write`); the cadence's drain/undrain/busy dependencies are the part no
 * subprocess can safely fake without a real ssh target, so THOSE are proven by
 * importing `runCadence` directly and injecting fixtures, the same way
 * `refresh-cycle.test.mjs` proves `runRefreshCycle`.
 */
async function main() {
	const args = process.argv.slice(2);
	// F8 (plan §4.1): strict, from the one spec argv-specs.mjs declares. The
	// spec's usage carries a `{BY_HAND_FOR_30}` placeholder — see job-rollups.mjs's
	// matching `{SETTLE_HOURS}` note on why a pure data module does not import a
	// build artifact just to interpolate one line into its own help text.
	const SPEC = {
		...ARGV_SPECS['benchmark-fleet.mjs'],
		usage: ARGV_SPECS['benchmark-fleet.mjs'].usage.replace('{BY_HAND_FOR_30}', byHandFor(30)),
	};
	const parsed = parseStrict(SPEC, args);
	const hasFlag = parsed.has;
	// One stdout discipline, shared — see lib/emit.mjs.
	const emitter = createEmitter();
	const log = emitter.log;

	const JSON_OUT = hasFlag('--json');
	const WRITE = hasFlag('--write') && !hasFlag('--scan');
	const passthru = [hasFlag('--quick') && '--quick', hasFlag('--force') && '--force'].filter(
		Boolean
	);
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
	const FROM = parsed.value('--from');
	if (hasFlag('--from') && !FROM) {
		console.error('benchmark: --from needs a file path');
		process.exit(2);
	}
	// EVERY FLAG THAT TAKES A VALUE HIDES A NODE-SHAPED ARGUMENT BEHIND IT, and the
	// positional args ARE the node list, so each value must be excluded by index or
	// it is read as a machine name. `--due 30` tried to ssh to a host called 30.
	// `parsed.positionals` (F8) is this exact exclusion, built once from the
	// spec's own `valued` list rather than a second, hand-kept copy of it.
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
	const SCAN = hasFlag('--scan');
	const named = parsed.positionals;

	if (SCAN && !named.length) {
		console.error('scan: needs at least one host — fleet scan <host> [host...]');
		process.exit(2);
	}
	const DUE_DAYS = parsed.value('--due') === null ? null : Number(parsed.value('--due'));
	const MAX_NODES = parsed.value('--max') === null ? null : Number(parsed.value('--max'));
	if (DUE_DAYS !== null && !Number.isFinite(DUE_DAYS)) {
		console.error('benchmark: --due needs a number of days');
		process.exit(2);
	}

	const CADENCE = hasFlag('--cadence');
	if (CADENCE) {
		await runCadenceCli({
			dueDays: DUE_DAYS,
			jsonOut: JSON_OUT,
			passthru,
			force: hasFlag('--force'),
			refuseIf: {
				report: hasFlag('--report'),
				scan: SCAN,
				from: FROM,
				named,
				max: MAX_NODES,
				write: hasFlag('--write'),
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
	 * nothing written anywhere. The backstop is read here like every other row: a
	 * date out of a file is not a probe.
	 *
	 * IT REFUSES `--max` RATHER THAN HONOURING IT. `--max` bounds how many boxes
	 * one night may LOAD, and a report loads none — applying it here would truncate
	 * the list of due nodes, so the further behind the fleet fell the quieter this
	 * would get. No gate may get easier to pass the worse the failure gets.
	 *
	 * IT REQUIRES `--due`. "Due" is meaningless without a threshold, and defaulting
	 * one would make the answer depend on a number nobody typed.
	 */
	const REPORT = hasFlag('--report');
	if (REPORT) {
		const refuse = (msg) => {
			console.error(`benchmark: ${msg}`);
			process.exit(2);
		};
		if (hasFlag('--write'))
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
		// THE BACKSTOP IS NOT PAGED ABOUT THROUGH COVERAGE EITHER. Excluding it from
		// `due` and then naming it in `findings` as never-measured or stale would
		// route the same page down the other pipe — `findings` is exactly what the
		// cron turns into an alert. Nothing is lost: a backstop a threshold selected
		// is in `skippedByRole` above with its dates, `measuredAt: null` included.
		const backstops = backstopNodeNames({ machines: fleetMachines() });
		const f = coverageFindings(c, backstops);
		const byHand = byHandFor(DUE_DAYS);
		const line = (d) =>
			`  ${d.node.padEnd(10)}${d.measuredAt ? `${d.measuredAt}  (${d.ageDays}d)` : 'NEVER measured'}`;
		const exempt = skippedByRole.length
			? `\n\nnot due — exempt by role (not ranked for routing):\n` +
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
		// unless it is the backstop, which no speed rank reads.
		process.exit(c.never.some((n) => !backstops.has(n)) ? 1 : 0);
	}

	// THE MEASURING PATH GETS THE SAME ROLE EXCLUSION: this is the branch that
	// sshes a box and loads it, and the backstop is the production host as well as
	// unranked. An OPERATOR naming it positionally (`fleet benchmark hokon --write`)
	// is unaffected — `named` bypasses this entirely.
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
			const decided = decideRecord(node, r, { stored, force: hasFlag('--force') });
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

// RUN ONLY AS THE CLI ENTRY POINT — the same guard `check-health-freshness.mjs`
// uses, and the reason `runCadence`, `cadenceBands` and the other pure
// functions above can be imported by a test without that import also parsing
// argv, ssh-ing to a node, or writing a state file.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
