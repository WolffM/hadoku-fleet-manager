/**
 * Pure parsers over a probe's raw stdout — "another system's data" (§3.2 rule
 * 2), split out so an observation-layer reader can use them without reaching
 * into the lifecycle-domain module that also decides what the parsed facts
 * MEAN (wave clean-1 lane D, cut (iii)).
 *
 * `parseLoad` moved from `idle-measure.mjs` verbatim: it has zero dependency
 * on that file's verdict-carrying logic (`carryMeasurements`, `measuredValue`),
 * which stays there. `idle-measure.mjs` re-exports this name unchanged.
 */

/**
 * `LOAD <id> <n|unknown>` lines → `{ [id]: number | null }`. An id with no
 * LOAD line is ABSENT from the result, which `judgeMeasurement` reads as
 * uncounted — never as zero.
 *
 * @param {string} stdout
 * @returns {Record<string, number | null>}
 */
export function parseLoad(stdout) {
	const load = {};
	for (const line of String(stdout).split('\n')) {
		const m = /^LOAD\s+(\S+)\s+(\S+)\s*$/.exec(line.trim());
		if (m) load[m[1]] = /^\d+$/.test(m[2]) ? Number(m[2]) : null;
	}
	return load;
}
