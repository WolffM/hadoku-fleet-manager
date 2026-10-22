/**
 * Reading and recording an IDLE-ONLY measurement (2026-10-10) — the half of
 * "capabilities are earned properly" that is not the drain.
 *
 * `capability-probe.sh` prints, after each idle-only measurement, how busy the
 * node was while it measured: `LOAD <id> <most live Runner.Worker seen>`, or
 * `unknown`. That line is the OBSERVED state — the drain is only how bootcamp
 * tries to get a zero, and a reader that trusted the drain instead of the
 * count would be reading its own writer's intent (AGENTS.md).
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

/**
 * The `$capabilities.measurements` facet: for each idle-only capability, the
 * idle measurement that DECIDED its current verdict — `{ value, idle: true,
 * earned, at }` — so a reader can tell an earn taken on a quiet node from one
 * recorded before 2026-10-10 (no entry at all).
 *
 * THE ENTRY MOVES ONLY WHEN THE VERDICT DOES, and that is issue #59, not
 * laziness. `cargo-bevy` prints a fresh throughput figure on every pass; a
 * record that carried the latest figure would change on every run, every
 * change is a commit on hadoku_site, and every commit there redeploys mgmt-api.
 * So a fresh idle measurement that reaches the SAME verdict as the recorded
 * one keeps the recorded entry byte-for-byte — its `value` and `at` still
 * describe a real idle measurement, the one that established the verdict. The
 * latest figure is on the run's stdout.
 *
 * A capability this run did NOT judge (measured under load, a guest, a node
 * that never went quiet) keeps its previous entry, or has none: an unjudged
 * run writes nothing new about it.
 *
 * @param {{ measurements?: Record<string, { value: number|null, idle: boolean, earned: boolean, at: string }> } | undefined} prev
 * @param {Record<string, { value: number | null, earned: boolean }>} judged  idle-only ids judged IDLE this run
 * @param {string} at
 * @returns {Record<string, { value: number|null, idle: boolean, earned: boolean, at: string }>}
 */
export function carryMeasurements(prev, judged, at) {
	const before =
		prev?.measurements && typeof prev.measurements === 'object' ? prev.measurements : {};
	const out = { ...before };
	for (const [id, now] of Object.entries(judged)) {
		const old = before[id];
		if (old && old.idle === true && old.earned === now.earned) continue;
		out[id] = { value: now.value, idle: true, earned: now.earned, at };
	}
	return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** The FIRST number in a probe detail, as `meetsBar` reads it; `null` if none. */
export function measuredValue(detail) {
	const n = Number(/-?\d+(\.\d+)?/.exec(String(detail ?? ''))?.[0]);
	return Number.isFinite(n) ? n : null;
}
