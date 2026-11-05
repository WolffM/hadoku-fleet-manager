/**
 * THE PERFORMANCE ROW'S SHAPE: one node, one 5-minute tick. Zero-import and
 * declarative, at config, so the probe (access) that fills it and the store
 * (state) that keeps it share one definition without either importing upward.
 * perf-sample-store.ts re-exports every name here.
 */

export const PERF_SCHEMA = 1;

/** Round trips of one ping burst. null fields = no reply came back to measure. */
export interface PingStats {
	target: string;
	sent: number;
	received: number;
	minMs: number | null;
	p50Ms: number | null;
	p95Ms: number | null;
	maxMs: number | null;
	/** Mean absolute difference between consecutive replies (RFC 3550's idea, unsmoothed). */
	jitterMs: number | null;
}

export interface PerfSampleRow {
	v: typeof PERF_SCHEMA;
	at: string;
	node: string;
	/** false = the node could not be measured this tick; `why` says how. Never a row of zeros. */
	ok: boolean;
	why?: string;
	/** Controller -> the node's LAN address. Measured even when the node's own probe fails. */
	lan?: PingStats | null;
	bootId?: string | null;
	uptimeSec?: number | null;
	link?: {
		iface: string | null;
		kind: 'wired' | 'wifi' | null;
		speedMbps: number | null;
		carrierChanges: number | null;
		rxBytes: number | null;
		txBytes: number | null;
		rxErrors: number | null;
		txErrors: number | null;
		rxDropped: number | null;
		txDropped: number | null;
		wifi: { signalDbm: number | null; txBitrateMbps: number | null } | null;
	};
	/** The node -> its default gateway: its OWN link, independent of the controller's. */
	gateway?: PingStats | null;
	/** /proc/pressure avg60, percent of time stalled. `full` is absent for cpu on older kernels. */
	psi?: {
		cpuSome: number | null;
		ioSome: number | null;
		ioFull: number | null;
		memorySome: number | null;
		memoryFull: number | null;
	};
	load?: { one: number | null; five: number | null; fifteen: number | null; cores: number | null };
	memory?: { totalMb: number | null; availableMb: number | null; swapUsedMb: number | null };
	/** The disk under `/`, from /proc/diskstats: counters since boot. */
	disk?: {
		device: string | null;
		reads: number | null;
		readSectors: number | null;
		readMs: number | null;
		writes: number | null;
		writeSectors: number | null;
		writeMs: number | null;
		ioMs: number | null;
		rootUsedPct: number | null;
	};
	cpuTempC?: number | null;
	/** Which sensor `cpuTempC` came from (`coretemp`, `k10temp`, `thermal_zone`, ...): a wrong one shows as an implausible value. */
	cpuTempSensor?: string | null;
}

/** What became of one active test attempt. */
export type ActiveOutcome = 'measured' | 'busy' | 'disturbed' | 'skipped' | 'failed';

/**
 * One ACTIVE test of one node (`perf-active.ts`): disk and network measured by
 * doing work, only while the node is idle. `busy` = it was not idle, nothing
 * ran; `disturbed` = CI work arrived mid-test, so the numbers are discarded
 * (kept null); `skipped` = it could not be tested safely (low disk space, a
 * maintenance or reboot drain); `failed` = the test itself broke, with `why`.
 */
export interface ActivePerfRow {
	v: typeof PERF_SCHEMA;
	at: string;
	node: string;
	outcome: ActiveOutcome;
	why?: string;
	/** The idle gate's reading before anything ran. */
	idle?: { workers: number | null; ioSome10: number | null; cpuSome10: number | null };
	disk?: {
		fs: string | null;
		/** Mean per synced 4 KiB write (O_DSYNC): what a database commit waits on. */
		syncWriteMs: number | null;
		/** 256 MiB, page cache bypassed, flushed. */
		seqWriteMBps: number | null;
		seqReadMBps: number | null;
	} | null;
	/** Controller <-> node over ssh, connection setup subtracted. */
	net?: { upMbps: number | null; downMbps: number | null; bytes: number } | null;
	/** Most CI workers seen during the test; above 0 means disturbed. */
	maxWorkers?: number | null;
}
