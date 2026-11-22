/**
 * bootcamp-baseline — what `fleet bootcamp` reads from node-baselines.json
 * (hadoku-fleet-manager#129). LOG-ONLY until the shadow week is read (from
 * 2026-11-29): nothing here earns, withholds or revokes a label.
 *
 * Two reads, per node bootcamp judged:
 *   - its WEAK POINTS (what qualify and doctor recorded it is measurably bad
 *     at), printed beside its labels so the run that decides labels shows them;
 *   - each idle-only MEASURED capability's figure (cargo-bevy's compile
 *     throughput, ml-cpu's memory, ...) judged against the node's own range for
 *     that figure, and learned under --write. The capability's own bar stays
 *     absolute: it is derived from the job's hard limit (cargo-bevy's 1200
 *     against the 3600 s JIT TTL), which is the kind of absolute #129 keeps.
 *     A drift is the node changing under a label it holds, and is reported.
 *
 * The quantity is `bootcamp.<capability id>`, its direction the bar's own:
 * `atLeast` means lower is worse, `atMost` higher. Tolerance 0.2 of the mean:
 * cargo-bevy's figure moved 807 -> 734 -> 923 between unrelated nodes' builds
 * of the same source, and a single node's night-to-night noise is inside that.
 */
import { judgeReading } from './node-baselines.mjs';

/**
 * PURE. One node's bootcamp reading of the store.
 *
 * @param {object} a
 * @param {string} a.node
 * @param {Record<string, { value: number|null, earned: boolean }>} a.measured `report[node].measuredIdle`
 * @param {(id: string) => { measure?: { unit?: string, atLeast?: number, atMost?: number } } | undefined} a.capability
 * @param {Record<string, object>} a.quantities this node's estimates (nodeQuantities)
 * @param {Record<string, { reason: string, since: string }>} a.weakPoints this node's weak points
 */
export function judgeBootcamp({ node, measured, capability, quantities, weakPoints }) {
	const judged = [];
	const readings = [];
	for (const [id, m] of Object.entries(measured ?? {})) {
		const bar = capability(id)?.measure;
		if (!bar || !Number.isFinite(m?.value)) continue;
		const worse = typeof bar.atMost === 'number' ? 'higher' : 'lower';
		const spec = { unit: (bar.unit ?? '').trim(), worse, rel: 0.2, abs: 0 };
		const quantity = `bootcamp.${id}`;
		const v = judgeReading(quantities[quantity], m.value, spec);
		judged.push({ capability: id, quantity, value: m.value, earned: m.earned, ...v });
		readings.push({ quantity, value: m.value, spec, drifted: v.verdict === 'drift' });
	}
	return {
		node,
		weakPoints: Object.entries(weakPoints ?? {}).map(([test, w]) => ({ test, ...w })),
		judged,
		window: { readings, weak: [], cleared: [] },
	};
}

/** For the log: one node's line, or null when there is nothing to say. */
export function describeBootcamp(j) {
	const parts = [];
	if (j.weakPoints.length) parts.push(`weak points: ${j.weakPoints.map((w) => w.test).join(', ')}`);
	for (const x of j.judged)
		parts.push(
			`${x.quantity} = ${x.value}: ${x.verdict}${x.direction ? ` (${x.direction})` : ''}` +
				(x.n ? ` vs ${x.mean} ± ${x.band} (n=${x.n})` : '')
		);
	return parts.length ? `${j.node}: ${parts.join('; ')}` : null;
}
