/**
 * HOW `fleet qualify` JUDGES A NODE AGAINST ITSELF (hadoku-fleet-manager#129,
 * operator decision 2026-11-21: "the fleet's hardware is fixed as it stands").
 *
 * Each qualification test still judges its reading against the operator's bars
 * (qualify-bars.mjs) and the ledger keeps that verdict. What changes is what a
 * missed bar MEANS:
 *
 *   - a bar that measures the HARDWARE (temperature, disk latency and
 *     throughput, memory with /tmp full, HTTPS latency) is the node's measured
 *     limit. A miss is recorded as a WEAK POINT (lib/node-baselines.mjs), shown,
 *     never a finding, because no bar the box cannot meet may keep a gate red.
 *   - a bar where an absolute IS the requirement stays a finding on any node.
 *     Each is listed below with its reason.
 *
 * Then every quantity a test measured is judged against that node's own
 * learned range. Outside it is a DRIFT finding, in either direction (the claw
 * changed, or the estimate was wrong), and the range re-learns at the reading.
 * Drift is new, so it rides ci:qualify, which is advisory in hadoku_site's
 * ADVISORY_JOBS (AGENTS.md "A new gate starts quiet").
 */
import { judgeReading } from './node-baselines.mjs';

/**
 * Tests whose every failure is a finding whatever the hardware, and why.
 * A test not named here or in RELATIVE has no node-relative reading: its
 * failure stays a finding, so a new test is absolute until someone decides.
 */
export const ABSOLUTE_TESTS = Object.freeze({
	'busy-counters': 'a counter that cannot see a job is a code or role bug; no hardware explains it',
	'floor-ci': 'the provisioning floor is software every node is given; a missing tool is a fault',
	'floor-admin':
		'security updates, SMART monitoring and unit health are configuration every node carries',
	'reboot-requalify':
		'a unit that fails after a reboot, or a runner PATH that loses a tool, is a fault on any box',
});

const num = (x) => (Number.isFinite(x) ? x : null);
const firstStep = (m) => (Array.isArray(m?.steps) && m.steps[0]?.k === 1 ? m.steps[0] : null);

/**
 * Tests whose bars measure the hardware. `absolute(result)` returns the parts
 * of a failure that stay findings (empty: the failure is a weak point);
 * `quantities(metrics)` returns what the node's own range is learned from.
 *
 * Tolerances (`rel` of the mean, `abs` in the unit) are each measurement's own
 * night-to-night noise: the band before a history exists to show spread.
 */
export const RELATIVE = Object.freeze({
	'disk-sync-writes': {
		absolute: () => [],
		quantities: (m) => [
			{
				// Keyed by writer count: k is the node's maxConcurrent, and a p99 at
				// k=3 is not the same quantity as one at k=1.
				quantity: `disk.randSyncP99Ms.k${m?.k ?? '?'}`,
				value: num(m?.rand?.p99Ms),
				spec: { unit: 'ms', worse: 'higher', rel: 0.5, abs: 5 },
			},
			{
				quantity: 'disk.sustainedMbps',
				value: num(m?.sustainedMbps),
				spec: { unit: 'MB/s', worse: 'lower', rel: 0.25, abs: 10 },
			},
			{
				quantity: 'disk.holdRatio',
				value: num(m?.holdRatio),
				spec: { unit: '', worse: 'lower', rel: 0.25, abs: 0.1 },
			},
		],
	},
	'concurrency-ramp': {
		// An emulated unit that EXITED non-zero (not one cut off at its deadline)
		// is the emulator or the unit failing, which is a fault on any node.
		absolute: (r) =>
			(r.metrics?.steps ?? []).flatMap((s) =>
				(s.reasons ?? [])
					.filter((x) => /^a unit exited /.test(x))
					.map((x) => `concurrency-ramp k=${s.k}: ${x}`)
			),
		quantities: (m) => [
			{
				quantity: 'ramp.ceiling',
				value: num(m?.ceiling),
				spec: { unit: 'jobs', worse: 'lower', rel: 0, abs: 0.5 },
			},
			{
				quantity: 'ramp.k1.packageTempC',
				value: num(firstStep(m)?.tempMax),
				spec: { unit: '°C', worse: 'higher', rel: 0, abs: 6 },
			},
			{
				quantity: 'ramp.k1.cpuPressureP90Pct',
				value: num(firstStep(m)?.cpuP90),
				spec: { unit: '%', worse: 'higher', rel: 0.5, abs: 5 },
			},
			{
				quantity: 'cpu.hashRate',
				value: num(m?.hashRate),
				spec: { unit: 'MB/s', worse: 'lower', rel: 0.2, abs: 0 },
			},
		],
	},
	'tmpfs-headroom': {
		absolute: () => [],
		quantities: (m) => [
			{
				quantity: 'mem.availWithTmpFullMb',
				value: num(m?.fullAvailMb),
				spec: { unit: 'MiB', worse: 'lower', rel: 0.2, abs: 256 },
			},
		],
	},
	'network-soak': {
		// Latency is the link; a name that does not resolve, a fetch that fails,
		// or a dual-homed node losing its wired address or route is a network
		// FAULT (dhcpcd, DNS, a lease), whatever the link is.
		absolute: (r) => {
			const m = r.metrics ?? {};
			const bars = m.bars ?? {};
			const out = [];
			const dns = Object.values(m.dnsFailures ?? {}).reduce((a, b) => a + b, 0);
			if (dns > (bars.dnsFailures ?? 0)) out.push(`network-soak: ${dns} DNS failure(s)`);
			if ((m.https?.failed ?? 0) > (bars.httpsFailures ?? 0))
				out.push(`network-soak: ${m.https.failed} HTTPS fetch(es) failed`);
			if (m.lostAddrSamples) out.push(`network-soak: wired address lost in ${m.lostAddrSamples}`);
			if (m.lostRouteSamples) out.push(`network-soak: default route lost in ${m.lostRouteSamples}`);
			return out;
		},
		quantities: (m) => [
			{
				quantity: 'net.httpsP95Sec',
				value: num(m?.https?.p95Sec),
				spec: { unit: 's', worse: 'higher', rel: 0.5, abs: 0.25 },
			},
		],
	},
});

const fmt = (x) => (Number.isFinite(x) ? Number(x.toPrecision(4)) : x);

/**
 * PURE. One window's results judged against the node's own range.
 *
 * @param {object} a
 * @param {string} a.node
 * @param {{ id: string, status: string, reason: string, metrics?: object }[]} a.results
 * @param {Record<string, object>} a.quantities this node's stored estimates, quantity → entry
 * @returns {{
 *   findings: { node: string, test: string, kind: 'absolute'|'drift', reason: string }[],
 *   weak: { test: string, reason: string }[],
 *   cleared: string[],
 *   readings: { quantity: string, value: number, spec: object, drifted: boolean }[],
 *   judged: { test: string, quantity: string, value: number, verdict: string,
 *     direction?: string, mean?: number, sd?: number, n?: number, band?: number }[],
 * }}
 */
export function judgeWindow({ node, results, quantities }) {
	const findings = [];
	const weak = [];
	const cleared = [];
	const readings = [];
	const judged = [];
	for (const r of results) {
		const rel = RELATIVE[r.id];
		if (r.status === 'fail') {
			const hard = rel
				? rel.absolute(r)
				: [
						ABSOLUTE_TESTS[r.id]
							? `${r.id}: ${r.reason}`
							: `${r.id}: ${r.reason} (no node-relative policy, so the bar is absolute)`,
					];
			for (const reason of hard) findings.push({ node, test: r.id, kind: 'absolute', reason });
			if (rel && !hard.length) weak.push({ test: r.id, reason: r.reason });
		} else if (r.status === 'pass' && rel) cleared.push(r.id);
		// A could-not-look measured nothing whole: its numbers teach the range nothing.
		if (!rel || r.status === 'could-not-look') continue;
		for (const q of rel.quantities(r.metrics ?? {})) {
			if (q.value === null) continue;
			const v = judgeReading(quantities[q.quantity], q.value, q.spec);
			judged.push({ test: r.id, quantity: q.quantity, value: q.value, ...v });
			readings.push({ ...q, drifted: v.verdict === 'drift' });
			if (v.verdict === 'drift')
				findings.push({
					node,
					test: r.id,
					kind: 'drift',
					reason:
						`${r.id}: ${q.quantity} ${fmt(q.value)}${q.spec.unit ? ` ${q.spec.unit}` : ''} is ${v.direction} than ` +
						`${node}'s range ${fmt(v.mean)} ± ${fmt(v.band)} (n=${v.n}); the range re-learns at the new reading`,
				});
		}
	}
	return { findings, weak, cleared, readings, judged };
}
