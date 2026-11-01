/**
 * A NODE'S CI PRESSURE, as the dispatcher last saw it: `slices[].ci` and
 * `offers.ranked[].ci` in `fleet hosting-placement` (reader draft §5b.3, a
 * RANKING input for the tenant, never a bar).
 *
 * Read from the dispatcher's decision log (src/runners/decision-log.ts): each
 * row's `capacity[]` is every candidate node's figures at that decision. The
 * newest row naming a node, if it is younger than {@link CI_FRESH_MS}, is that
 * node's pressure. No extra ssh, and no row is invented: a node no recent row
 * names reads `null`, which means UNMEASURED, not idle. The dispatcher writes
 * a row only when it decides something, so a quiet fleet reads null too.
 *
 * `load1` is null: nothing persisted carries a node's load, and a value this
 * reader made up would be read as measured.
 *
 * Day files are named by UTC day and appended in pass order, so this reads
 * today's file backwards from its end and stops at the first row older than
 * the window, crossing into yesterday's only when the window does. A day file
 * runs to tens of MB; it is never loaded whole.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

/** A capacity row older than this says nothing about the node now. */
export const CI_FRESH_MS = 5 * 60_000;
const CHUNK = 64 * 1024;

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Every line of `path`, newest first, read from the end in chunks. Stops when `visit` returns false. */
function eachLineBackwards(path, visit) {
	const fd = openSync(path, 'r');
	try {
		let pos = fstatSync(fd).size;
		let carry = '';
		const buf = Buffer.alloc(CHUNK);
		while (pos > 0) {
			const len = Math.min(CHUNK, pos);
			pos -= len;
			readSync(fd, buf, 0, len, pos);
			// latin1 is one char per byte, so a UTF-8 character split across a chunk
			// edge stays whole bytes in `carry`; each complete line is decoded as UTF-8.
			const text = buf.toString('latin1', 0, len) + carry;
			const lines = text.split('\n');
			carry = lines.shift();
			for (let i = lines.length - 1; i >= 0; i--)
				if (lines[i] && visit(Buffer.from(lines[i], 'latin1').toString('utf8')) === false) return;
		}
		if (carry) visit(Buffer.from(carry, 'latin1').toString('utf8'));
	} finally {
		closeSync(fd);
	}
}

/**
 * Each node in `nodes` → `{ jobs, heavyJobs, max, load1, cores, at }` from the
 * newest fresh capacity row naming it, or null. `why` is set when a day file
 * that exists could not be read; every node it would have answered is null.
 *
 * @param {object} i
 * @param {string} i.dir       decisionLogDir(stateDir())
 * @param {string[]} i.nodes
 * @param {object|null} i.manifest  for `machines[n].cores`
 * @param {number} i.nowMs
 * @param {number} [i.freshMs]
 * @returns {{ byNode: Map<string, object|null>, why: string|null }}
 */
export function readCiPressure({ dir, nodes, manifest, nowMs, freshMs = CI_FRESH_MS }) {
	const byNode = new Map(nodes.map((n) => [n, null]));
	const wanted = new Set(nodes);
	const sinceMs = nowMs - freshMs;
	const days = [utcDay(nowMs)];
	if (utcDay(sinceMs) !== days[0]) days.push(utcDay(sinceMs));
	let why = null;
	let stale = false;
	for (const day of days) {
		if (!wanted.size || stale) break;
		const path = join(dir, `${day}.jsonl`);
		if (!existsSync(path)) continue;
		try {
			eachLineBackwards(path, (line) => {
				let r;
				try {
					r = JSON.parse(line);
				} catch {
					return true; // a torn tail, as readDecisions counts it: not a row
				}
				const t = Date.parse(r?.at);
				if (!Number.isFinite(t)) return true;
				if (t < sinceMs) {
					stale = true;
					return false;
				}
				if (t > nowMs) return true;
				for (const c of r.capacity ?? []) {
					if (!wanted.has(c?.node)) continue;
					wanted.delete(c.node);
					byNode.set(c.node, {
						jobs: c.busy,
						heavyJobs: c.heavyJobs ?? 0,
						max: c.max,
						load1: null,
						cores: manifest?.machines?.[c.node]?.cores ?? null,
						at: r.at,
					});
				}
				return wanted.size > 0;
			});
		} catch (err) {
			why = `the dispatch decision log ${path} is unreadable: ${err.message}`;
			break;
		}
	}
	return { byNode, why };
}
