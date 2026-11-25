/**
 * IS THIS NODE RELIABLE ENOUGH TO HOST A SERVICE? Judged from what the fleet
 * OBSERVED of it, never from what anyone declared.
 *
 * On 2026-11-03 claw-4's NIC flapped 633 times in 1h43m and the node dropped
 * off the network with pygmalion and archivebot on it. It still carried
 * `service-host`, which is earned on capability alone (toolchain, tunnel,
 * state root). Operator, the same day: "keep a high bar for what a PM2 host
 * demands … flaky or inconsistent claws lose the ability to pm2 host."
 *
 * The evidence is `capacity-samples.jsonl`: one row per node per 5-minute
 * tick, written by the in-process sampler from the fleet's own verdicts
 * (src/capacity-sample.ts). A sample is DOWN when its state is unreachable,
 * offline or sick and the node is not drained: a planned reboot drains, so it
 * does not count (the same reading as the converger's, ffc06cd). An OUTAGE is
 * OUTAGE_MIN_SAMPLES or more down samples in a row; a single down tick is a
 * probe blip whose minutes count but which is not an outage. A gap in the
 * samples (mgmt-api down) ends a run, which can only split an outage in two:
 * never easier to pass.
 *
 * Two bars, and the gap between them is the hysteresis:
 *   EARN  may be given a NEW service slice.
 *   KEEP  a slice it already holds stays placeable. Failing KEEP makes that
 *         slice unplaceable, and a service with a standby moves to it.
 * claw-4 after the cable (95 min, one outage) fails EARN and passes KEEP: it
 * keeps what it hosts and is given nothing new until the outage ages out.
 *
 * Fewer than MIN_EVIDENCE_MS of samples is `null` on both bars, "could not
 * judge": a placement treats it as cannot-tell and refuses, and a held slice
 * is not faulted for it. Unknown never earns.
 *
 * PURE: rows in, verdicts out. collect-offers reads the store.
 */

export const SAMPLE_MS = 5 * 60_000;
export const RELIABILITY_WINDOW_MS = 14 * 86_400_000;
export const MIN_EVIDENCE_MS = 72 * 3_600_000;
export const OUTAGE_MIN_SAMPLES = 2;
export const EARN = Object.freeze({ downMin: 30, outages: 1 });
export const KEEP = Object.freeze({ downMin: 240, outages: 3 });

const DOWN_STATES = new Set(['unreachable', 'offline', 'sick']);
/** Two samples further apart than this are not consecutive. */
const GAP_MS = 2 * SAMPLE_MS;

const isDown = (r) => DOWN_STATES.has(r.state) && !r.drained;
const hhmm = (iso) => `${iso.slice(5, 10)} ${iso.slice(11, 16)}Z`;

/**
 * One node's verdict from its own rows (oldest first, already inside the window).
 * @returns {{earn: boolean|null, keep: boolean|null, downMin: number|null,
 *   outages: {start: string, min: number}[], evidenceH: number, why: string}}
 */
export function judgeNode(rows) {
	const evidenceH = Math.round(((rows.length * SAMPLE_MS) / 3_600_000) * 10) / 10;
	if (rows.length * SAMPLE_MS < MIN_EVIDENCE_MS) {
		return {
			earn: null,
			keep: null,
			downMin: null,
			outages: [],
			evidenceH,
			why: `${evidenceH} h of samples in the window; ${MIN_EVIDENCE_MS / 3_600_000} h are needed to judge`,
		};
	}
	let down = 0;
	const outages = [];
	let run = null;
	let prevAt = null;
	const close = () => {
		if (run && run.n >= OUTAGE_MIN_SAMPLES) outages.push({ start: run.start, min: run.n * 5 });
		run = null;
	};
	for (const r of rows) {
		const at = Date.parse(r.at);
		if (prevAt !== null && at - prevAt > GAP_MS) close();
		prevAt = at;
		if (!isDown(r)) {
			close();
			continue;
		}
		down++;
		if (run) run.n++;
		else run = { start: r.at, n: 1 };
	}
	close();
	const downMin = down * 5;
	const passes = (bar) => downMin <= bar.downMin && outages.length <= bar.outages;
	const earn = passes(EARN);
	const keep = passes(KEEP);
	const seen =
		`${downMin} min down, ${outages.length} outage(s)` +
		(outages.length ? ` (${outages.map((o) => `${hhmm(o.start)} ${o.min} min`).join(', ')})` : '') +
		` in ${evidenceH} h of samples`;
	const why = earn
		? seen
		: keep
			? `${seen}; a new slice needs ≤ ${EARN.downMin} min and ≤ ${EARN.outages} outage in 14 d`
			: `${seen}; a held slice needs ≤ ${KEEP.downMin} min and ≤ ${KEEP.outages} outages in 14 d`;
	return { earn, keep, downMin, outages, evidenceH, why };
}

/**
 * Every node's verdict. `read` is a CapacitySampleStore read
 * (`{rows, unreadableLines, exists}`), or `{error}` when the file could not be
 * read at all. A node with no rows gets the not-enough-evidence verdict.
 * @returns {(node: string) => ReturnType<typeof judgeNode>}
 */
export function reliabilityOf(read, nowMs) {
	if (read.error || !read.exists) {
		const why = read.error
			? `capacity samples unreadable: ${read.error}`
			: 'no capacity samples recorded yet';
		return () => ({ earn: null, keep: null, downMin: null, outages: [], evidenceH: 0, why });
	}
	const since = nowMs - RELIABILITY_WINDOW_MS;
	const byNode = new Map();
	for (const r of read.rows) {
		const at = Date.parse(r.at);
		if (!(at > since && at <= nowMs)) continue;
		if (!byNode.has(r.node)) byNode.set(r.node, []);
		byNode.get(r.node).push(r);
	}
	const memo = new Map();
	return (node) => {
		if (!memo.has(node)) {
			const rows = (byNode.get(node) ?? []).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
			memo.set(node, judgeNode(rows));
		}
		return memo.get(node);
	};
}

/**
 * HOW LONG HAS THIS NODE BEEN UNREACHABLE, RIGHT NOW? Counted in samples, for
 * the converger's question "is a standby that did not answer this probe
 * actually gone?". On 2026-11-24 claw-9 was saturated by CI (4/4, three heavy,
 * load ~26) and missed one 30 s offer probe at 19:17Z. The converger read that
 * one miss as a dead standby, declared a second on claw-8, then ended claw-9's
 * proven slice when it answered at 19:26Z: archivebot was left with no
 * guaranteed standby for hours. A node is not gone until the sampler has seen
 * it down OUTAGE_MIN_SAMPLES ticks in a row, the same bar an outage is.
 *
 * Unlike an outage, a DRAINED down sample counts here: a drain explains why a
 * node is down, not that it is still there.
 *
 * Returns node -> the trailing run of down samples, or null "could not look":
 * unreadable samples, none for the node, or a newest sample older than two
 * ticks (the sampler itself is not running). A caller treats null as no
 * evidence of a blip, never as proof the node is up.
 * @returns {(node: string) => number|null}
 */
export function downStreakOf(read, nowMs) {
	if (read.error || !read.exists) return () => null;
	const byNode = new Map();
	for (const r of read.rows) {
		const at = Date.parse(r.at);
		if (!(at <= nowMs) || nowMs - at > RELIABILITY_WINDOW_MS) continue;
		if (!byNode.has(r.node)) byNode.set(r.node, []);
		byNode.get(r.node).push({ at, down: DOWN_STATES.has(r.state) });
	}
	return (node) => {
		const rows = (byNode.get(node) ?? []).sort((a, b) => a.at - b.at);
		if (!rows.length || nowMs - rows.at(-1).at > GAP_MS) return null;
		let n = 0;
		for (let i = rows.length - 1; i >= 0 && rows[i].down; i--) {
			if (i < rows.length - 1 && rows[i + 1].at - rows[i].at > GAP_MS) break;
			n++;
		}
		return n;
	};
}
