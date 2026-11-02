/**
 * job-metrics-primitives — the two unit/statistics helpers every other
 * job-metrics-*.mjs module builds on.
 *
 * Moved out of job-metrics.mjs (wave shrink-1 lane D), body unchanged.
 */

/** Bytes -> MB, integer. Reported in MB everywhere; bytes are for the record. */
export function mb(bytes) {
	return typeof bytes === 'number' && Number.isFinite(bytes) ? Math.round(bytes / 1048576) : null;
}

export function percentile(values, q) {
	const v = values.filter((n) => typeof n === 'number' && Number.isFinite(n)).sort((a, b) => a - b);
	if (!v.length) return null;
	return v[Math.min(Math.floor(q * v.length), v.length - 1)];
}
