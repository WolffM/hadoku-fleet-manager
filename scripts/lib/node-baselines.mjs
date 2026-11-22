/**
 * WHAT EACH NODE NORMALLY MEASURES — `node-baselines.json` in the state
 * directory (hadoku-fleet-manager#129, operator decision 2026-11-21).
 *
 * The fleet's hardware is fixed as it stands. A gate therefore judges a claw
 * against its OWN measured range, not a fixed bar the box may never meet: a
 * reading outside that range is a finding (the claw changed, or the estimate
 * was wrong), and the range then moves to the new reality, so a degraded claw
 * is judged by what it does now instead of staying red forever.
 *
 * Two records, one file:
 *   quantities  `node::quantity` → { mean, sd, n, unit, worse, lastValue,
 *               updatedAt, lastDrift? }. One entry per measured quantity per
 *               node; `fleet qualify` feeds it today (lib/qualify-baseline.mjs).
 *   weakPoints  node → testId → { reason, since, lastSeen }. What a node is
 *               measurably bad at: a bar it does not meet, recorded and shown,
 *               never paged and never an operator task.
 *
 * THE ESTIMATE is an exponentially weighted mean and variance whose weight
 * never falls below 1/BASELINE_WINDOW, so the newest readings always count and
 * a slow drift is followed without an alert. A reading outside the band (see
 * `bandOf`) re-seeds the estimate AT the reading, keeping the old spread: the
 * node is judged by what it does now from the next reading on.
 *
 * SOLE WRITER: this module (f3-one-writer.json). A missing file is an empty
 * store; an UNREADABLE one is said and never overwritten, because writing over
 * a file nobody could parse erases every other node's history.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomicSync } from '../../dist/lib/atomic-json.js';

export const NODE_BASELINES_FILE = 'node-baselines.json';

/**
 * The fewest readings an estimate weighs as: a reading is never worth less than
 * 1/8 of the estimate. Eight qualification windows is roughly three months at
 * one node a night, long enough that one odd night does not move the range far,
 * short enough that a claw that really changed is followed within a season.
 */
export const BASELINE_WINDOW = 8;
/** Standard deviations a reading may sit from the mean before it is drift. */
export const DRIFT_SDS = 3;

export const baselineKey = (node, quantity) => `${node}::${quantity}`;

const round = (x) => (Number.isFinite(x) ? Number(x.toPrecision(5)) : x);

/** `{ok:true, store}` or `{ok:false, reason}`. A missing file is an empty store. */
export function readNodeBaselines(dir) {
	const path = join(dir, NODE_BASELINES_FILE);
	if (!existsSync(path)) return { ok: true, store: { quantities: {}, weakPoints: {} } };
	try {
		const doc = JSON.parse(readFileSync(path, 'utf8'));
		if (!doc || typeof doc !== 'object' || Array.isArray(doc))
			return { ok: false, reason: `${path} is not a JSON object` };
		return {
			ok: true,
			store: { quantities: doc.quantities ?? {}, weakPoints: doc.weakPoints ?? {} },
		};
	} catch (err) {
		return { ok: false, reason: `${path}: ${err.message}` };
	}
}

/**
 * PURE. How far a reading may sit from an estimate before it is drift: the
 * widest of DRIFT_SDS standard deviations, the quantity's relative tolerance of
 * the mean, and its absolute tolerance. The two tolerances are the
 * measurement's own noise, which a short history cannot yet show as spread
 * (one reading has sd 0); they come from the quantity's spec.
 *
 * @param {{ mean: number, sd: number }} entry
 * @param {{ rel?: number, abs?: number }} spec
 */
export function bandOf(entry, spec) {
	return Math.max(
		DRIFT_SDS * (entry.sd ?? 0),
		(spec.rel ?? 0) * Math.abs(entry.mean),
		spec.abs ?? 0
	);
}

/**
 * PURE. One reading against a node's estimate.
 *
 * @param {object|null|undefined} entry the stored estimate, or none yet
 * @param {number} value
 * @param {{ worse: 'higher'|'lower', rel?: number, abs?: number }} spec
 * @returns {{ verdict: 'learning'|'within'|'drift', direction?: 'worse'|'better',
 *   mean?: number, sd?: number, n?: number, band?: number }}
 */
export function judgeReading(entry, value, spec) {
	if (!entry || !(entry.n > 0) || !Number.isFinite(entry.mean)) return { verdict: 'learning' };
	const band = bandOf(entry, spec);
	const delta = value - entry.mean;
	const base = { mean: entry.mean, sd: entry.sd ?? 0, n: entry.n, band: round(band) };
	if (Math.abs(delta) <= band) return { verdict: 'within', ...base };
	const worse = spec.worse === 'higher' ? delta > 0 : delta < 0;
	return { verdict: 'drift', direction: worse ? 'worse' : 'better', ...base };
}

/**
 * PURE. The estimate after one reading. A drift re-seeds at the reading and
 * keeps the old spread, recording where it came from; anything else is one
 * exponentially weighted step.
 *
 * @param {object|null|undefined} entry
 * @param {number} value
 * @param {{ unit?: string, worse: 'higher'|'lower' }} spec
 * @param {string} at ISO time of the reading
 * @param {boolean} drifted
 */
export function learnReading(entry, value, spec, at, drifted) {
	const head = { unit: spec.unit ?? '', worse: spec.worse, lastValue: value, updatedAt: at };
	if (!entry || !(entry.n > 0) || !Number.isFinite(entry.mean))
		return { ...head, mean: round(value), sd: 0, n: 1 };
	if (drifted)
		return {
			...head,
			mean: round(value),
			sd: entry.sd ?? 0,
			n: 1,
			lastDrift: { at, from: entry.mean, to: value },
		};
	const n = Math.min(entry.n + 1, BASELINE_WINDOW);
	const a = 1 / n;
	const delta = value - entry.mean;
	const variance = (1 - a) * ((entry.sd ?? 0) ** 2 + a * delta * delta);
	return {
		...head,
		mean: round(entry.mean + a * delta),
		sd: round(Math.sqrt(variance)),
		n,
		...(entry.lastDrift ? { lastDrift: entry.lastDrift } : {}),
	};
}

/**
 * PURE. The store after one node's window.
 *
 * @param {{ quantities: object, weakPoints: object }} store
 * @param {string} node
 * @param {{ readings: { quantity: string, value: number, spec: object, drifted: boolean }[],
 *   weak: { test: string, reason: string }[], cleared: string[] }} window
 * @param {string} at
 */
export function mergeNodeBaselines(store, node, window, at) {
	const quantities = { ...store.quantities };
	for (const r of window.readings) {
		const key = baselineKey(node, r.quantity);
		quantities[key] = learnReading(quantities[key], r.value, r.spec, at, r.drifted);
	}
	const mine = { ...(store.weakPoints?.[node] ?? {}) };
	for (const id of window.cleared) delete mine[id];
	for (const w of window.weak)
		mine[w.test] = { reason: w.reason, since: mine[w.test]?.since ?? at, lastSeen: at };
	const weakPoints = { ...store.weakPoints };
	if (Object.keys(mine).length) weakPoints[node] = mine;
	else delete weakPoints[node];
	return { quantities, weakPoints };
}

/** Record one node's window. `{ok:true}` or `{ok:false, reason}`; never throws, never silent. */
export function recordNodeBaselines(dir, node, window, at) {
	const read = readNodeBaselines(dir);
	if (!read.ok) return { ok: false, reason: read.reason };
	if (!window.readings.length && !window.weak.length && !window.cleared.length) return { ok: true };
	const path = join(dir, NODE_BASELINES_FILE);
	try {
		const next = mergeNodeBaselines(read.store, node, window, at);
		writeFileAtomicSync(path, `${JSON.stringify(next, null, 2)}\n`);
		return { ok: true };
	} catch (err) {
		return { ok: false, reason: `${path}: ${err.message}` };
	}
}

/** PURE. One node's estimates, quantity → entry. */
export function nodeQuantities(store, node) {
	const prefix = `${node}::`;
	return Object.fromEntries(
		Object.entries(store.quantities ?? {})
			.filter(([k]) => k.startsWith(prefix))
			.map(([k, v]) => [k.slice(prefix.length), v])
	);
}

/**
 * PURE. One node's weak points for a status reader, oldest first: `null` with
 * the reason when the store is unreadable, never an empty list, because "no
 * weak points" and "could not look" are different answers.
 *
 * @param {{ ok: boolean, store?: object, reason?: string }} read readNodeBaselines' answer
 * @param {string} node
 * @returns {{ weakPoints: { test: string, reason: string, since: string, lastSeen: string }[] | null,
 *   why?: string }}
 */
export function nodeWeakPoints(read, node) {
	if (!read.ok) return { weakPoints: null, why: read.reason };
	const mine = read.store.weakPoints?.[node] ?? {};
	return {
		weakPoints: Object.entries(mine)
			.map(([test, w]) => ({ test, ...w }))
			.sort(
				(a, b) => String(a.since).localeCompare(String(b.since)) || a.test.localeCompare(b.test)
			),
	};
}
