/**
 * PER-NODE PERFORMANCE OVER A WINDOW, from `perf-sample-store` rows. PURE: the
 * caller reads the rows.
 *
 * Point-in-time readings (ping, pressure, load, memory, temperature) summarize
 * as p50 / p95 / max over the window. Counters (link bytes and errors, disk
 * sectors and I/O time) are differenced between CONSECUTIVE measured rows of
 * ONE boot: a delta across a reboot, or across a counter that went backwards,
 * is not a measurement and is skipped.
 *
 *   lan       controller -> node round trip; the path every service is served over
 *   gateway   node -> its own gateway; the node's link apart from the controller's
 *   lossPct   packets lost / sent over every burst in the window
 *   disk      read/write MB/s, utilisation (% of wall time the disk was busy),
 *             and await (ms per completed I/O) between samples
 *
 * `unmeasured` counts rows where the node could not be probed: a window of
 * them is a node we could not look at, never a quiet one.
 */

const SECTOR_BYTES = 512;

const round = (n, places = 2) => (n === null ? null : Math.round(n * 10 ** places) / 10 ** places);

/** Nearest-rank percentile; null for no values. */
export function pct(values, p) {
	const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
	if (!v.length) return null;
	return v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
}

/** `{ p50, p95, max }` of the values, rounded. */
export function spread(values) {
	return { p50: round(pct(values, 50)), p95: round(pct(values, 95)), max: round(pct(values, 100)) };
}

function pingSummary(bursts) {
	const b = bursts.filter(Boolean);
	if (!b.length) return null;
	const sent = b.reduce((s, x) => s + x.sent, 0);
	const received = b.reduce((s, x) => s + x.received, 0);
	return {
		bursts: b.length,
		rttP50Ms: spread(b.map((x) => x.p50Ms)),
		rttP95Ms: spread(b.map((x) => x.p95Ms)),
		jitterMs: spread(b.map((x) => x.jitterMs)),
		lossPct: sent ? round(((sent - received) / sent) * 100) : null,
		// A burst that lost every packet: the path was down for that sample.
		deadBursts: b.filter((x) => x.received === 0).length,
	};
}

/** Every per-interval rate between consecutive rows of one boot. */
function intervals(rows) {
	const out = [];
	for (let k = 1; k < rows.length; k++) {
		const a = rows[k - 1];
		const b = rows[k];
		if (!a.bootId || a.bootId !== b.bootId) continue;
		const dt = (Date.parse(b.at) - Date.parse(a.at)) / 1000;
		if (!(dt > 0)) continue;
		const d = (pick) => {
			const x = pick(a);
			const y = pick(b);
			return typeof x === 'number' && typeof y === 'number' && y >= x ? y - x : null;
		};
		const reads = d((r) => r.disk?.reads);
		const writes = d((r) => r.disk?.writes);
		const ioWaitMs = (() => {
			const rm = d((r) => r.disk?.readMs);
			const wm = d((r) => r.disk?.writeMs);
			return rm === null || wm === null ? null : rm + wm;
		})();
		const ops = reads === null || writes === null ? null : reads + writes;
		const ioMs = d((r) => r.disk?.ioMs);
		const rs = d((r) => r.disk?.readSectors);
		const ws = d((r) => r.disk?.writeSectors);
		const rx = d((r) => r.link?.rxBytes);
		const tx = d((r) => r.link?.txBytes);
		out.push({
			readMBps: rs === null ? null : (rs * SECTOR_BYTES) / 1e6 / dt,
			writeMBps: ws === null ? null : (ws * SECTOR_BYTES) / 1e6 / dt,
			utilPct: ioMs === null ? null : Math.min(100, (ioMs / (dt * 1000)) * 100),
			awaitMs: ops ? ioWaitMs / ops : null,
			rxMbps: rx === null ? null : (rx * 8) / 1e6 / dt,
			txMbps: tx === null ? null : (tx * 8) / 1e6 / dt,
			rxErrors: d((r) => r.link?.rxErrors),
			txErrors: d((r) => r.link?.txErrors),
			rxDropped: d((r) => r.link?.rxDropped),
			carrierChanges: d((r) => r.link?.carrierChanges),
		});
	}
	return out;
}

const sum = (xs) => {
	const v = xs.filter((x) => typeof x === 'number');
	return v.length ? v.reduce((a, b) => a + b, 0) : null;
};

/** One node's window. `rows` are that node's, oldest first. */
export function summarizeNode(node, rows) {
	const measured = rows.filter((r) => r.ok);
	const last = measured.at(-1) ?? null;
	const iv = intervals(measured);
	const boots = new Set(measured.map((r) => r.bootId).filter(Boolean));
	return {
		node,
		samples: rows.length,
		unmeasured: rows.length - measured.length,
		lastAt: rows.at(-1)?.at ?? null,
		lastWhy: rows.at(-1)?.ok === false ? rows.at(-1).why : null,
		boots: boots.size,
		link: last
			? {
					kind: last.link?.kind ?? null,
					iface: last.link?.iface ?? null,
					speedMbps: last.link?.speedMbps ?? null,
					wifiSignalDbm: last.link?.wifi
						? spread(measured.map((r) => r.link?.wifi?.signalDbm))
						: null,
					rxMbps: spread(iv.map((x) => x.rxMbps)),
					txMbps: spread(iv.map((x) => x.txMbps)),
					rxErrors: sum(iv.map((x) => x.rxErrors)),
					txErrors: sum(iv.map((x) => x.txErrors)),
					rxDropped: sum(iv.map((x) => x.rxDropped)),
					carrierChanges: sum(iv.map((x) => x.carrierChanges)),
				}
			: null,
		// The controller pings even a node whose probe failed, so lan reads every row.
		lan: pingSummary(rows.map((r) => r.lan)),
		gateway: pingSummary(measured.map((r) => r.gateway)),
		psi: {
			cpuSome: spread(measured.map((r) => r.psi?.cpuSome)),
			ioSome: spread(measured.map((r) => r.psi?.ioSome)),
			ioFull: spread(measured.map((r) => r.psi?.ioFull)),
			memorySome: spread(measured.map((r) => r.psi?.memorySome)),
		},
		loadPerCore: spread(
			measured.map((r) => (r.load?.one != null && r.load?.cores ? r.load.one / r.load.cores : null))
		),
		memory: {
			availableMbMin: round(
				pct(
					measured.map((r) => r.memory?.availableMb),
					0
				)
			),
			swapUsedMbMax: round(
				pct(
					measured.map((r) => r.memory?.swapUsedMb),
					100
				)
			),
		},
		disk: last
			? {
					device: last.disk?.device ?? null,
					rootUsedPct: last.disk?.rootUsedPct ?? null,
					readMBps: spread(iv.map((x) => x.readMBps)),
					writeMBps: spread(iv.map((x) => x.writeMBps)),
					utilPct: spread(iv.map((x) => x.utilPct)),
					awaitMs: spread(iv.map((x) => x.awaitMs)),
				}
			: null,
		cpuTempC: { ...spread(measured.map((r) => r.cpuTempC)), sensor: last?.cpuTempSensor ?? null },
	};
}

/** Every node in the rows, sorted by name. */
export function summarizePerf(rows) {
	const by = new Map();
	for (const r of rows) {
		if (!by.has(r.node)) by.set(r.node, []);
		by.get(r.node).push(r);
	}
	return [...by.keys()]
		.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
		.map((n) => summarizeNode(n, by.get(n)));
}

/**
 * One node's ACTIVE tests over the window (`perf-active.ts`): the spread of
 * every MEASURED result, the last one, and how many attempts found the node
 * busy, disturbed, skipped or broken. A node with attempts and no measurement
 * is one we could not test, said as such: `measured: 0`, never a fast disk.
 */
export function summarizeActive(node, rows) {
	const measured = rows.filter((r) => r.outcome === 'measured');
	const count = (o) => rows.filter((r) => r.outcome === o).length;
	const last = measured.at(-1) ?? null;
	return {
		node,
		attempts: rows.length,
		measured: measured.length,
		busy: count('busy'),
		disturbed: count('disturbed'),
		skipped: count('skipped'),
		failed: count('failed'),
		lastMeasuredAt: last?.at ?? null,
		lastWhy: rows.at(-1)?.outcome !== 'measured' ? (rows.at(-1)?.why ?? null) : null,
		fs: last?.disk?.fs ?? null,
		syncWriteMs: spread(measured.map((r) => r.disk?.syncWriteMs)),
		seqWriteMBps: spread(measured.map((r) => r.disk?.seqWriteMBps)),
		seqReadMBps: spread(measured.map((r) => r.disk?.seqReadMBps)),
		upMbps: spread(measured.map((r) => r.net?.upMbps)),
		downMbps: spread(measured.map((r) => r.net?.downMbps)),
	};
}

/** Every node with active rows, sorted by name. */
export function summarizeActiveAll(rows) {
	const by = new Map();
	for (const r of rows) {
		if (!by.has(r.node)) by.set(r.node, []);
		by.get(r.node).push(r);
	}
	return [...by.keys()]
		.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
		.map((n) => summarizeActive(n, by.get(n)));
}
