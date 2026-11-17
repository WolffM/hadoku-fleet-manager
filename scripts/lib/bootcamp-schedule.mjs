/**
 * WHEN `fleet bootcamp` RUNS ITS IDLE-ONLY BENCHMARKS — once a week per node,
 * on a weekday of its own (operator, 2026-11-11).
 *
 * `ci:bootcamp` runs nightly (hadoku_site f160c9faf, 2026-11-04) so the
 * `$capabilities` record placement reads never goes stale. Until this module,
 * every one of those runs also ran `cargo-bevy`'s all-core compile benchmark
 * on every node: a full-CPU minute beside whatever CI the node was running,
 * and a drain of up to 20 minutes to re-take it whenever a job was there. The
 * benchmark measures hardware, and hardware does not change nightly. The
 * presence probes (is the tool still there, does it still run) stay nightly.
 *
 * THE SLOT IS DERIVED, NOT DECLARED. Every machine in the manifest, sorted by
 * name, takes weekday `index % 7` (UTC, the cron's clock). Ten nodes fill each
 * day with one or two and never more, which a hash of the name cannot promise.
 * Adding a node can move others to a new day; one week then runs a node twice
 * or waits eight days, which is harmless. The slot uses the WHOLE fleet, never
 * the run's `--machine` scope, so a node's day does not depend on who asked.
 *
 * DUE regardless of the day:
 *   - `--measure`, the operator asking for a measurement now;
 *   - a node with no recorded measurement for that capability. A new node is
 *     benchmarked at its first bootcamp, never left waiting up to a week.
 *
 * A node that is not due keeps its record. That is a SCHEDULE, not a finding:
 * the judge carries the previous verdict (bootcamp-judge.mjs `deferred`), so
 * no label moves and the run stays green.
 *
 * A MISSED SLOT IS RETRIED NIGHTLY until it lands (operator, 2026-11-11). A
 * slot night the node spends busy or unreachable is INCONCLUSIVE, and without
 * a retry its record would wait another week. The ledger below remembers when
 * each node was last measured idle; a node whose last measurement is older
 * than its most recent slot day is overdue and is measured every night until
 * one succeeds. On the slot day itself that is the same test, so one rule
 * covers both.
 *
 * THE LEDGER IS STATE, NOT THE MANIFEST. `$capabilities.measurements[].at`
 * moves only when a verdict does (#59: a fresh figure on every run made every
 * run a commit, and every commit an mgmt-api redeploy), so it cannot say when
 * a node was last measured. `benchmark-measured.json` sits beside
 * `job-proofs.json` in the state directory, which nothing redeploys.
 *
 * A node the ledger has never seen (the first nights after this shipped, or a
 * ledger that was deleted) is treated as measured before its last slot was
 * due, so it waits for its own weekday. Reading "unknown" as "overdue" would
 * benchmark the whole fleet on one night, which this module exists to stop.
 * An UNREADABLE ledger is said, and the run falls back to weekday-only.
 *
 * ONE BUSY NIGHT IS A WARNING; A STREAK IS THE FINDING (fleet-manager#109).
 * A measurement the node was too busy to take quietly keeps the previous
 * record and is retried the next night, so a single miss says nothing is
 * wrong with the node. Every `--write` miss was a finding until 2026-11-17,
 * and hokon's one busy Tuesday paged. The ledger now also carries the miss
 * streak, `missed: { since, last, nights }`, counted in distinct UTC days so
 * a rerun the same day does not advance it. `INCONCLUSIVE_PAGE_AFTER`
 * consecutive nights is a finding: a node that is never idle is a real fact
 * about it. A run that cannot read or write the ledger cannot count, so it
 * treats every miss as a finding, as before.
 *
 * A pending miss also makes the node DUE every night until it lands, even
 * with no idle measurement on record. Without that, a node the ledger had
 * never seen (hokon on 2026-11-17) missed its slot and waited a whole week.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomicSync } from '../../dist/lib/atomic-json.js';

export const BENCHMARK_LEDGER_FILE = 'benchmark-measured.json';
/** Consecutive inconclusive nights before an idle-only measurement is a finding. */
export const INCONCLUSIVE_PAGE_AFTER = 3;
const DAY_MS = 86_400_000;

/** Weekday names, indexed by `Date#getUTCDay`. */
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * The UTC weekday (0 = Sunday) `node` runs its benchmark on, or null for a
 * node the manifest does not list.
 *
 * @param {string} node
 * @param {string[]} fleet every machine name in the manifest
 */
export function benchmarkWeekday(node, fleet) {
	const i = [...fleet].sort().indexOf(node);
	return i < 0 ? null : i % 7;
}

/** The next UTC date (YYYY-MM-DD) after `nowMs` whose weekday is `day`. */
function nextOn(day, nowMs) {
	const now = new Date(nowMs);
	const ahead = (day - now.getUTCDay() + 7) % 7 || 7;
	return new Date(nowMs + ahead * DAY_MS).toISOString().slice(0, 10);
}

/** Start (00:00 UTC, ms) of the most recent day on or before `nowMs` whose weekday is `day`. */
function lastSlotStart(day, nowMs) {
	const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
	return today - ((new Date(nowMs).getUTCDay() - day + 7) % 7) * DAY_MS;
}

/** `{ok:true, ledger}` — a missing file is an empty ledger, an unreadable one is NOT. */
export function readBenchmarkLedger(dir) {
	const path = join(dir, BENCHMARK_LEDGER_FILE);
	if (!existsSync(path)) return { ok: true, ledger: {} };
	try {
		const doc = JSON.parse(readFileSync(path, 'utf8'));
		if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
			return { ok: false, reason: `${path} is not a JSON object` };
		}
		return { ok: true, ledger: doc };
	} catch (err) {
		return { ok: false, reason: `${path}: ${err.message}` };
	}
}

/**
 * When `node` was last measured idle, in ms: the OLDEST of its idle-only ids,
 * or null when the ledger lacks any of them.
 */
export function lastMeasuredMs(ledger, node, idleOnly) {
	const times = idleOnly.map((id) => Date.parse(ledger?.[node]?.[id]?.at ?? ''));
	return times.some((t) => !Number.isFinite(t)) ? null : Math.min(...times);
}

/**
 * The longest pending miss streak among `node`'s idle-only ids, or null when
 * none is pending. A pending miss makes the node due tonight (`benchmarkPlan`).
 */
export function pendingMiss(ledger, node, idleOnly) {
	const misses = idleOnly.map((id) => ledger?.[node]?.[id]?.missed).filter(Boolean);
	return misses.length ? misses.reduce((a, b) => (b.nights > a.nights ? b : a)) : null;
}

/**
 * Record this run's idle measurements and misses. `measured` is node -> ids
 * judged idle, which clears any miss streak; `missed` is node -> ids this run
 * could not measure quietly, which starts or advances one (at most once per
 * UTC day). Returns `{ok:true, wrote, streaks}`, `streaks` being node -> id ->
 * the miss record now on disk, or `{ok:false, reason}`; never throws, never
 * overwrites a ledger it could not read (that would erase every other node).
 */
export function recordBenchmarks(dir, measured, nowMs, missed = {}) {
	const read = readBenchmarkLedger(dir);
	if (!read.ok) return { ok: false, reason: read.reason };
	const at = new Date(nowMs).toISOString();
	const day = at.slice(0, 10);
	const next = { ...read.ledger };
	const streaks = {};
	let wrote = 0;
	let changed = false;
	for (const [node, ids] of Object.entries(measured)) {
		if (!ids.length) continue;
		next[node] = { ...next[node] };
		for (const id of ids) next[node][id] = { at };
		wrote++;
		changed = true;
	}
	for (const [node, ids] of Object.entries(missed)) {
		for (const id of ids) {
			if (measured[node]?.includes(id)) continue;
			const entry = next[node]?.[id] ?? {};
			const prev = entry.missed;
			const miss = !prev
				? { since: at, last: day, nights: 1 }
				: prev.last === day
					? prev
					: { ...prev, last: day, nights: prev.nights + 1 };
			if (miss !== prev) {
				next[node] = { ...next[node], [id]: { ...entry, missed: miss } };
				changed = true;
			}
			(streaks[node] ??= {})[id] = miss;
		}
	}
	if (!changed) return { ok: true, wrote: 0, streaks };
	try {
		writeFileAtomicSync(join(dir, BENCHMARK_LEDGER_FILE), `${JSON.stringify(next, null, 2)}\n`);
		return { ok: true, wrote, streaks };
	} catch (err) {
		return { ok: false, reason: `${join(dir, BENCHMARK_LEDGER_FILE)}: ${err.message}` };
	}
}

/**
 * Which of `idleOnly` this run measures on `node`, and which it defers.
 *
 * @param {object} args
 * @param {string} args.node
 * @param {object} args.machine the node's manifest entry
 * @param {string[]} args.fleet every machine name in the manifest
 * @param {string[]} args.idleOnly the registry's idle-only measured capabilities
 * @param {number} args.nowMs
 * @param {number|null} [args.measuredMs] last idle measurement (`lastMeasuredMs`); null when unknown
 * @param {{since: string, nights: number}|null} [args.missed] a pending miss (`pendingMiss`)
 * @param {boolean} [args.force] `--measure`
 * @returns {{ measure: boolean, weekday: string|null, deferred: {id: string, nextOn: string}[], why: string }}
 */
export function benchmarkPlan({
	node,
	machine,
	fleet,
	idleOnly,
	nowMs,
	measuredMs = null,
	missed = null,
	force = false,
}) {
	const day = benchmarkWeekday(node, fleet);
	const weekday = day === null ? null : WEEKDAYS[day];
	if (!idleOnly.length) return { measure: false, weekday, deferred: [], why: 'nothing to measure' };
	if (force) return { measure: true, weekday, deferred: [], why: '--measure' };
	const recorded = machine?.$capabilities?.measurements ?? {};
	const missing = idleOnly.filter((id) => !recorded[id]);
	if (missing.length)
		return {
			measure: true,
			weekday,
			deferred: [],
			why: `no measurement on record: ${missing.join(', ')}`,
		};
	if (day === null) return { measure: true, weekday, deferred: [], why: 'not in the manifest' };
	const slot = lastSlotStart(day, nowMs);
	const isSlotDay = slot === Math.floor(nowMs / DAY_MS) * DAY_MS;
	if (missed && !isSlotDay)
		return {
			measure: true,
			weekday,
			deferred: [],
			why:
				`inconclusive ${missed.nights} night(s) since ${missed.since.slice(0, 10)}; ` +
				'retrying nightly until it lands',
		};
	// Unknown is "measured before the last slot came due": wait for the weekday.
	if (measuredMs === null ? isSlotDay : measuredMs < slot) {
		const slotDate = new Date(slot).toISOString().slice(0, 10);
		return {
			measure: true,
			weekday,
			deferred: [],
			why: isSlotDay
				? `its weekday (${weekday})`
				: `missed its ${weekday} ${slotDate} benchmark (last measured ` +
					`${new Date(measuredMs).toISOString().slice(0, 10)}); retrying nightly until it lands`,
		};
	}
	const next = nextOn(day, nowMs);
	return {
		measure: false,
		weekday,
		deferred: idleOnly.map((id) => ({ id, nextOn: next })),
		why: `measured ${weekday}s; next ${next}`,
	};
}
