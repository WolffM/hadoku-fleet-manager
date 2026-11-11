/**
 * WHERE `fleet qualify` REMEMBERS WHAT IT FOUND — `qualify-results.json` in the
 * state directory, beside `job-proofs.json`.
 *
 * NOT THE MANIFEST (#59): a result changes every run, and a manifest write is a
 * hadoku_site commit that redeploys mgmt-api. The one qualification output that
 * IS manifest, a derived `maxConcurrent`, is written by lane Q6 through the site
 * writer, only when it changes.
 *
 * Keyed `node::testId`, two entries each, as the proof ledger: `last` (the most
 * recent result, whatever it said, so a regression shows) and `lastPass` (so
 * "when did this last qualify" survives a later fail). A could-not-look is
 * recorded in `last` and never touches `lastPass`.
 *
 * SOLE WRITER: this module (f3-one-writer.json). A missing file is an empty
 * ledger; an UNREADABLE one is said and never overwritten, because writing over
 * a file nobody could parse erases every other node's history.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from '../../dist/lib/atomic-json.js';

export const QUALIFY_RESULTS_FILE = 'qualify-results.json';

export const resultKey = (node, testId) => `${node}::${testId}`;

/** `{ok:true, results}` or `{ok:false, reason}`. */
export function readQualifyResults(dir) {
	const path = join(dir, QUALIFY_RESULTS_FILE);
	if (!existsSync(path)) return { ok: true, results: {} };
	try {
		const doc = JSON.parse(readFileSync(path, 'utf8'));
		if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
			return { ok: false, reason: `${path} is not a JSON object` };
		}
		return { ok: true, results: doc };
	} catch (err) {
		return { ok: false, reason: `${path}: ${err.message}` };
	}
}

/**
 * PURE. The ledger after one window's results.
 *
 * @param {Record<string, any>} results
 * @param {string} node
 * @param {{ id: string, status: string, reason: string, metrics?: object }[]} window
 * @param {string} at ISO time the window finished
 */
export function mergeQualifyResults(results, node, window, at) {
	const next = { ...results };
	for (const r of window) {
		const key = resultKey(node, r.id);
		const entry = { at, status: r.status, reason: r.reason, metrics: r.metrics ?? {} };
		const prev = next[key] ?? {};
		next[key] = { last: entry, lastPass: r.status === 'pass' ? entry : (prev.lastPass ?? null) };
	}
	return next;
}

/** Record one window. `{ok:true}` or `{ok:false, reason}`; never throws, never silent. */
export function recordQualifyResults(dir, node, window, at) {
	const read = readQualifyResults(dir);
	if (!read.ok) return { ok: false, reason: read.reason };
	if (!window.length) return { ok: true };
	try {
		const next = mergeQualifyResults(read.results, node, window, at);
		writeFileAtomic(join(dir, QUALIFY_RESULTS_FILE), `${JSON.stringify(next, null, 2)}\n`);
		return { ok: true };
	} catch (err) {
		return { ok: false, reason: `${join(dir, QUALIFY_RESULTS_FILE)}: ${err.message}` };
	}
}
