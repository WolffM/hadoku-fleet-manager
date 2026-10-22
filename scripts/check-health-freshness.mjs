#!/usr/bin/env node
/**
 * check-health-freshness — is the `$health` record the fleet reads still about
 * the fleet that exists?
 *
 * THE GAP THIS FILLS, MEASURED RATHER THAN IMAGINED
 * ------------------------------------------------
 * On 2026-09-26, SIX of NINE nodes carried a `$health` record dated
 * 2026-09-10 — claw-1, claw-2, claw-3, claw-5, claw-6 and hokon, all from one
 * fleet-wide run, all 15.7 days old. In that window claw-7 was decommissioned,
 * claw-8 and claw-9 joined, the tier ladder was retired, and the `cpu-thermal`
 * rule was rewritten from "how far did it rise" to "does the package track its
 * siblings" (wave 3l lane T). `resident-placement-2026-09-10.md` §1.3 filter 5
 * reads `$health` to decide whether a box may host a resident workload, so it
 * was deciding on a fleet that no longer existed.
 *
 * Nothing noticed, and the reason nothing noticed is structural rather than
 * careless: `fleet doctor` is the only thing that ever looks at `$health`, and
 * `fleet doctor` REWRITES it on every run. A facet whose only reader is its own
 * writer has no age — it is fresh whenever anyone looks, and invisible when
 * nobody does. That is the shape CLAUDE.md names as "the reader for a facet may
 * not read what the writer wrote", one level up: not a verifier that cannot
 * fail, but a record that cannot rot in public.
 *
 * So this gate is deliberately NOT a check inside `doctor --write`. It reads
 * the record `doctor` wrote, asks it exactly one question — HOW OLD ARE YOU —
 * and answers it without probing anything. It never writes. It has no opinion
 * about what the record SAYS; `doctor.mjs` owns every thermal, SMART and disk
 * judgement and this file duplicates none of them. Its whole subject is the
 * `at` stamp, which is the one field the writer cannot make true by writing.
 *
 * "I COULD NOT LOOK" IS NEVER "NOTHING IS WRONG", AND ABSENT IS NEVER QUIETER
 * THAN STALE
 * --------------------------------------------------------------------------
 * CLAUDE.md: "no gate may get EASIER to pass the worse the failure gets". A
 * freshness gate is unusually exposed to that, because the natural way to write
 * one — `if (record && ageDays > N) fail` — is green for a node with NO record
 * at all, which is the worse failure. Every way this gate can fail to get an
 * age is therefore at least as loud as an age that is too large, and
 * {@link FRESHNESS_SEVERITY} states the ordering as data so the test beside
 * this file can assert it instead of trusting the branch order:
 *
 *   fresh < stale < dated-in-the-future < absent < unreadable
 *
 * Three of those are not obvious and each one is a hole that was open until it
 * was written down:
 *
 *   - ABSENT is louder than stale. A node nothing has ever measured is strictly
 *     less known than one measured a month ago.
 *   - UNREADABLE is louder still. `measured.ts` already refuses to serve a
 *     manifest copy when the state file exists and cannot be parsed, because it
 *     might hold something newer; the same reasoning makes it the worst answer
 *     here, since it is the only one where the fleet cannot even say what it
 *     does not know.
 *   - DATED IN THE FUTURE is a failure, not a very fresh record. An `at` ahead
 *     of now can only come from a clock that is wrong, and a node whose clock
 *     runs a year fast would otherwise be PERMANENTLY fresh — the gate getting
 *     easier exactly as the box gets less trustworthy. {@link FUTURE_SKEW_MS}
 *     allows a minute for ordinary skew and nothing beyond it.
 *
 * WHY A DRAIN DOES NOT EXCUSE A STALE RECORD, AND WHY IT IS STILL NAMED
 * --------------------------------------------------------------------
 * A drained node cannot be re-measured, so excusing it is tempting. It is also
 * precisely the trap `check-queue-health` fell into on 2026-09-07: exclude a
 * category, and a real failure manufactures that category — the longer a box
 * stays out of service, the quieter its rotting record becomes, and a node
 * drained indefinitely would go permanently silent. The age of a record is a
 * fact about the record, not about the box's availability, so a drain changes
 * NOTHING about the verdict here.
 *
 * It does change what the finding SAYS. The same lesson's other half is that a
 * finding naming a node and nothing else is undiagnosable after the fact, so an
 * active drain is quoted in the `why`: "drained since X" is the difference
 * between "re-run doctor" and "the box is out for a part". Reason carried,
 * verdict unchanged.
 *
 * A GUEST IS REPORTED AND DOES NOT FAIL THE RUN
 * --------------------------------------------
 * Through `guestAdvisory` in `preflight.mjs` — the same one implementation
 * `fleet doctor` and `check-fleet-preflight` use, so three commands cannot
 * classify one box three ways. hokon is the fleet's only guest (operator,
 * 2026-09-14) and is not a placement candidate, so its record ageing is worth
 * SAYING and is not worth failing a gate over. The finding keeps its `why` and
 * still rides in `--json`; advisory means "does not fail the run", never "was
 * not observed".
 *
 * UNDER THE `--json` CONTRACT as of wave 3p (#64). `ci:health-freshness` parses
 * this stdout daily in mgmt-api's `repo-sync` profile, so stdout is a single
 * JSON document and nothing else, a non-zero exit is a FINDING rather than a
 * crash, and RENAMING THE SUBCOMMAND IS A CROSS-REPO CHANGE —
 * `scripts/lib/json-contract.mjs` holds the declaration and names the mgmt-api
 * file to fix in the same pass. It wrote its document through the shared
 * emitter from the start, which is why adding the consumer needed no change
 * here: the tail cannot be lost through a pipe (issue #33).
 *
 *   fleet health-freshness                  # every managed node
 *   fleet health-freshness --machine claw-5 # one node
 *   fleet health-freshness --json           # machine-readable
 */
import process from 'node:process';

import { createEmitter } from './lib/emit.mjs';
import { deferralFor, readDrains } from './lib/expected-down.mjs';
import { loadManifest, machineArg, selectMachines } from './lib/fleet-exec.mjs';
import {
	ADVISORY,
	BLOCKING,
	advisoryFindings,
	blockingFindings,
	guestAdvisory,
} from './lib/preflight.mjs';
// The BUILT copies, the same way `doctor-run.mjs` reaches both of these: the
// state-dir merge and the role rule are TypeScript and there is exactly one
// implementation of each.
import { measuredFacets } from '../dist/lib/measured.js';
import { guestNodeNames } from '../dist/lib/node-role.js';

/**
 * How old a `$health` record may be before this gate calls it stale.
 *
 * FOURTEEN DAYS, AND THE NUMBER IS AN ARGUMENT RATHER THAN A ROUND FIGURE.
 *
 * The six records this gate exists because of were 15.7 days old when a human
 * found them by hand; 14 is the first line inside that, so the failure that
 * motivated the gate would have been visible two days before anybody looked.
 *
 * It is deliberately SHORTER than `BOOTCAMP_STALE_DAYS` (30d, `capabilities.ts`),
 * because the two facets decay at different speeds. `$capabilities` answers
 * "what can this box do", which changes when somebody installs something.
 * `$health` answers "is this box safe to lean on", and every input to that
 * moves on its own: SMART power-on hours advance continuously, free disk moves
 * with every build, and thermals follow dust, ambient temperature and a cooler
 * that has begun to fail — claw-8 went from 58 °C to 100 °C in under five
 * seconds of load with a cooler that does not transfer heat, and nothing about
 * its capabilities changed that day.
 *
 * It is also shorter than the fleet's own rate of change. Inside the 15.7-day
 * window above the roster turned over twice (claw-7 out 2026-09-21, claw-8 in
 * the same day, claw-9 2026-09-23) and the rule that JUDGES the thermal reading
 * was rewritten. A placement decision may not be made on a record older than
 * the last time the fleet changed shape.
 *
 * There is no flag to widen it. A `--days` override would let the one caller
 * who finds the gate inconvenient turn it off, which is the "no gate may get
 * easier" rule defeated by its own user interface; the tests below reach the
 * threshold by injecting `nowMs`, not by relaxing it.
 */
export const HEALTH_STALE_DAYS = 14;

/**
 * How old the NEWEST non-guest `$health` record may be before the WRITER is
 * called stopped.
 *
 * {@link HEALTH_STALE_DAYS} judges each node, so it can only speak once a whole
 * record has aged out — and when the writer stops, every record ages out on the
 * same day. That is what happened: one hand run wrote all nine records on
 * 2026-09-26, nothing was scheduled to write them again, and the first red
 * was 15.3 days later. Fourteen days is the right patience for one box that
 * will not come idle. It is far too much for the job that writes them all.
 *
 * Since 2026-10-11 the writer is `ci:health-refresh` (`fleet doctor --cadence
 * --write`, daily at 12:00 UTC), so on a healthy fleet the newest record is
 * under a day old whenever this runs. THREE days is two missed nights plus the
 * skew between the two schedules — past one bad night, which the refresh job
 * pages about itself, and eleven days before any node's own record would.
 * It reads the newest record rather than all of them because a deferred or
 * unreachable node keeps an old one by design; only the writer stopping makes
 * EVERY record old.
 */
export const WRITER_STALE_DAYS = 3;

/** The category of the one fleet-level finding: the writer, not a node. */
export const WRITER_CATEGORY = 'health-writer';

/**
 * Has anything written `$health` lately, pure.
 *
 * @param {Array<{node: string, ageDays: number|null, at: string|null}>} verdicts
 * @param {Set<string>} guests  their records are written with no load and do
 *   not decide placement, so they cannot vouch for the writer.
 * @returns {object|null}  a BLOCKING finding, or null.
 */
export function writerVerdict(verdicts, guests, { writerStaleDays = WRITER_STALE_DAYS } = {}) {
	const dated = verdicts.filter((v) => !guests.has(v.node) && typeof v.ageDays === 'number');
	// No dated record at all: every node is already absent or unreadable, each a
	// blocking finding of its own. A second one saying the same thing adds noise.
	if (!dated.length) return null;
	const newest = dated.reduce((a, b) => (b.ageDays < a.ageDays ? b : a));
	if (newest.ageDays <= writerStaleDays) return null;
	return {
		node: '(fleet)',
		category: WRITER_CATEGORY,
		class: BLOCKING,
		status: 'writer-stopped',
		why:
			`the NEWEST non-guest $health record is ${newest.ageDays.toFixed(1)}d old ` +
			`(${newest.node}, ${newest.at}) — past ${writerStaleDays}d, so nothing has written ` +
			'$health for any node lately. That is the writer, not the boxes: check that ' +
			'ci:health-refresh is in the fleet-benchmark cron profile and what its last run said, ' +
			'before every record crosses the per-node line together.',
		ageDays: newest.ageDays,
		at: newest.at,
	};
}

/**
 * How far ahead of now an `at` may sit and still be read as a clock rounding
 * error rather than a broken clock.
 *
 * One minute. The stamp is written by whichever workstation ran `fleet doctor`,
 * not by the node, so in normal operation the skew is zero; this exists so a
 * record written during the same second a test or a run starts is not called a
 * failure. Anything further ahead is a clock that is wrong, and a wrong clock
 * that reads as FRESH is the one shape where this gate would get easier the
 * worse the node got.
 */
export const FUTURE_SKEW_MS = 60_000;

/**
 * The ordering "absent is at least as loud as stale" is made of, as DATA.
 *
 * Stated here rather than left implicit in the branch order below, because the
 * branch order is what a later edit reshuffles and the ordering is what must
 * survive it. `health-freshness.test.mjs` asserts the ordering against this
 * object and asserts that every non-fresh status blocks for a non-guest node —
 * which is a property of the whole table, not of the branch a fixture happens
 * to reach.
 */
export const FRESHNESS_SEVERITY = Object.freeze({
	fresh: 0,
	stale: 1,
	'dated-in-the-future': 2,
	absent: 3,
	unreadable: 4,
});

/** The finding category every verdict here carries. One category, five statuses. */
export const FRESHNESS_CATEGORY = 'health-record';

/**
 * `measured.ts`'s five unavailability reasons, mapped onto the two statuses
 * this gate distinguishes.
 *
 * The REASON is never discarded — it rides on the finding as `reason` and in
 * the `why` — because "the state directory is not there", "nothing has ever
 * written this facet" and "this file has a block for eight nodes and not this
 * one" are three different jobs, which is the argument `check-queue-health`
 * lost by naming a repo and nothing else.
 */
const UNAVAILABLE_STATUS = Object.freeze({
	'no-state-dir': 'absent',
	'no-file': 'absent',
	'no-record-for-node': 'absent',
	unreadable: 'unreadable',
	malformed: 'unreadable',
});

const DAY_MS = 86_400_000;

/** `2026-09-10T18:18:40.126Z` -> `15.7` days before `nowMs`, or null if unparseable. */
export function recordAgeDays(at, nowMs) {
	const ms = Date.parse(at);
	if (!Number.isFinite(ms)) return null;
	return (nowMs - ms) / DAY_MS;
}

/**
 * One node's verdict, pure.
 *
 * @param {string} node
 * @param {object} result   a `measured.ts` `MeasuredResult` for this node.
 * @param {{nowMs: number, staleDays?: number, drainWhy?: string|null}} opts
 *   `drainWhy` is quoted into the `why` and changes no verdict — see the header.
 * @returns {{node: string, category: string, class: string, status: string,
 *   why: string, ageDays: number|null, at: string|null, from: string|null,
 *   reason: string|null, severity: number}}
 */
export function freshnessVerdict(
	node,
	result,
	{ nowMs, staleDays = HEALTH_STALE_DAYS, drainWhy = null } = {}
) {
	const drain = drainWhy ? ` ${drainWhy.trim()}` : '';
	const verdict = (status, why, extra = {}) => ({
		node,
		category: FRESHNESS_CATEGORY,
		class: status === 'fresh' ? ADVISORY : BLOCKING,
		status,
		why,
		ageDays: null,
		at: null,
		from: null,
		reason: null,
		severity: FRESHNESS_SEVERITY[status],
		...extra,
	});

	if (result?.unavailable) {
		const status = UNAVAILABLE_STATUS[result.unavailable] ?? 'unreadable';
		return verdict(
			status,
			status === 'unreadable'
				? `${node}'s $health record cannot be read (${result.unavailable}) — ${result.why}. ` +
						'An unreadable record is not an absent one: it may hold a newer reading than ' +
						'anything else the fleet has, so nothing here may stand in for it. This is "I ' +
						`could not look", and it is not "nothing is wrong".${drain}`
				: `${node} has no $health record at all (${result.unavailable}) — ${result.why}. ` +
						'Nothing has run `fleet doctor --write` for this node, so filter 5 of the ' +
						'resident-placement rule has no thermal, SMART or disk reading to judge it on. ' +
						'A node nobody has measured is not a node known to be healthy.' +
						`${drain} Run \`fleet doctor --machine ${node} --write\`.`,
			{ reason: result.unavailable }
		);
	}

	const at = typeof result?.value?.at === 'string' ? result.value.at : null;
	const from = result?.from ?? null;
	const ageDays = at === null ? null : recordAgeDays(at, nowMs);

	if (ageDays === null) {
		// `measured.ts` rejects a block with an unparseable `at` as `malformed`
		// before it ever reaches here, so this branch is unreachable through that
		// reader today. It stays because the alternative is a `null` age falling
		// through to the comparison below, where `null > 14` is FALSE and the node
		// reads as fresh — the gate passing hardest on the record it understands
		// least.
		return verdict(
			'unreadable',
			`${node}'s $health record carries no usable \`at\` stamp (${at ?? 'absent'}), so its ` +
				'age cannot be established. A record whose age is unknown is not a fresh one.' +
				`${drain}`,
			{ at, from, reason: 'undated' }
		);
	}

	if (ageDays * DAY_MS < -FUTURE_SKEW_MS) {
		return verdict(
			'dated-in-the-future',
			`${node}'s $health record is stamped ${at}, which is ${Math.abs(ageDays).toFixed(1)}d in ` +
				'the FUTURE. That is a clock that is wrong, not a very fresh reading — and a record ' +
				'dated forward never ages, so left alone this node would read as current forever. ' +
				'Fix the clock on whatever wrote it and re-run `fleet doctor --write`.' +
				`${drain}`,
			{ ageDays, at, from }
		);
	}

	if (ageDays > staleDays) {
		return verdict(
			'stale',
			`${node}'s $health record is ${ageDays.toFixed(1)}d old (${at}, served from the ` +
				`${from} tree) — past ${staleDays}d. Thermals, SMART hours and free disk all move ` +
				'on their own, and resident placement reads this record to decide whether the box ' +
				'may host anything. Re-measure with `fleet doctor --machine ' +
				`${node} --write\`.${drain}`,
			{ ageDays, at, from }
		);
	}

	return verdict(
		'fresh',
		`${node}'s $health record is ${ageDays.toFixed(1)}d old (${at}, from the ${from} tree), ` +
			`within ${staleDays}d.`,
		{ ageDays, at, from }
	);
}

/**
 * Every node's verdict, pure.
 *
 * Takes the ALREADY-READ facet map so the judging half can be tested without a
 * state dir, the same split `doctor.mjs` / `doctor-run.mjs` uses.
 *
 * @param {Record<string, object>} facetNodes  node -> `MeasuredResult`.
 * @param {{nowMs?: number, staleDays?: number, drainWhy?: Record<string,string>}} opts
 */
export function freshnessVerdicts(
	facetNodes,
	{ nowMs = Date.now(), staleDays = HEALTH_STALE_DAYS, drainWhy = {} } = {}
) {
	return Object.keys(facetNodes)
		.sort()
		.map((node) =>
			freshnessVerdict(node, facetNodes[node], {
				nowMs,
				staleDays,
				drainWhy: drainWhy[node] ?? null,
			})
		);
}

/** The findings a gate reports: every verdict that is not `fresh`. */
export function freshnessFindings(verdicts) {
	return verdicts.filter((v) => v.status !== 'fresh');
}

function main() {
	const argv = process.argv.slice(2);
	const out = createEmitter({ argv: process.argv });

	if (argv.includes('--help') || argv.includes('-h')) {
		out.log('fleet health-freshness — how old is the $health record every placement rule reads');
		out.log('');
		out.log('  --machine <node>   one node instead of the whole roster');
		out.log('  --json             machine-readable verdict');
		out.log('');
		out.log(`Fails when a non-guest node's $health record is older than ${HEALTH_STALE_DAYS}d,`);
		out.log('is absent, is unreadable, or is dated in the future. Probes nothing and writes');
		out.log('nothing: `fleet doctor --write` is what refreshes the record, and ci:health-refresh');
		out.log(
			`runs it daily. Also fails when the NEWEST non-guest record is older than ${WRITER_STALE_DAYS}d:`
		);
		out.log(
			'that is the writer stopping, which would otherwise surface only at the per-node line.'
		);
		return 0;
	}

	const only = machineArg(argv);
	const manifest = loadManifest();
	const selected = selectMachines(manifest, { only });

	// ZERO NODES IS A FAILURE, NOT A CLEAN FLEET — the same refusal
	// `check-capabilities` and `check-capability-schema` make. A typo'd
	// `--machine` selects nothing, and nothing judged is byte-identical to a
	// fleet whose every record is current.
	if (!selected.length) {
		out.warn(
			`fleet health-freshness: no managed node matches ${only ?? '(any)'} — ` +
				'nothing was judged, and a run that judged nothing is not a pass.'
		);
		if (out.json) out.emit({ ok: false, reason: 'no-nodes-selected', only, findings: [] });
		return 1;
	}

	const machines = Object.fromEntries(selected);
	const facet = measuredFacets('health', machines);
	const drains = readDrains();
	const nowMs = Date.now();

	/** @type {Record<string, string>} */
	const drainWhy = {};
	for (const [name] of selected) {
		// EVERY drained node, not only the DEFERRABLE ones. `deferralFor` answers
		// "may this node be excused from a reachability finding", which is a
		// different question with a deadline attached; here the drain is only ever
		// context, so a drain past its deferral window is exactly as worth naming
		// as a fresh one — more so, since it is the one that has been out longest.
		if (!drains[name]) continue;
		const def = deferralFor(name, drains);
		drainWhy[name] =
			` This node is drained (${def.why}${def.reason ? `: ${def.reason}` : ''}), which is why ` +
			'nothing has re-measured it — a drain explains the age and does not excuse it.';
	}

	const verdicts = freshnessVerdicts(facet.nodes, { nowMs, drainWhy });
	const guests = guestNodeNames(manifest);
	// The writer verdict judges the WHOLE roster; a `--machine` run sees one
	// node and could only mistake that node for the writer.
	const writer = only ? null : writerVerdict(verdicts, guests);
	const classified = [
		...guestAdvisory(freshnessFindings(verdicts), guests),
		...(writer ? [writer] : []),
	];
	const blocking = blockingFindings(classified);
	const advisory = advisoryFindings(classified);

	for (const v of verdicts) {
		const mark = v.status === 'fresh' ? '  ok' : v.status.toUpperCase();
		out.log(
			`${mark.padStart(20)}  ${v.node.padEnd(8)}  ` +
				`${v.ageDays === null ? '   —' : `${v.ageDays.toFixed(1)}d`}  ${v.at ?? ''}`
		);
	}
	if (classified.length) {
		out.log('');
		for (const f of classified) {
			out.log(
				`${f.class === ADVISORY ? 'advisory' : 'BLOCKING'}  ${f.node}  ` +
					`${f.category}/${f.status}${f.role === 'guest' ? '  (guest)' : ''}`
			);
			out.log(`          ${f.why}`);
		}
	}
	out.log('');
	out.log(
		classified.length
			? `${blocking.length} blocking, ${advisory.length} advisory across ${verdicts.length} node(s)`
			: `✓ every one of ${verdicts.length} node(s) carries a $health record newer than ${HEALTH_STALE_DAYS}d`
	);

	if (out.json) {
		out.emit({
			ok: blocking.length === 0,
			at: new Date(nowMs).toISOString(),
			staleDays: HEALTH_STALE_DAYS,
			writerStaleDays: WRITER_STALE_DAYS,
			facetFile: facet.file.path,
			facetFileOk: facet.file.ok,
			nodes: verdicts.map((v) => v.node),
			verdicts,
			findings: classified,
			blocking: blocking.length,
			advisory: advisory.length,
			log: out.held(),
		});
	}
	return blocking.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
