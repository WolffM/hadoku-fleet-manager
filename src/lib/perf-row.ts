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

/** One /proc/pressure window, percent of time stalled. `full` is absent for cpu on older kernels. */
export interface PsiReading {
	cpuSome: number | null;
	ioSome: number | null;
	ioFull: number | null;
	memorySome: number | null;
	memoryFull: number | null;
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
	/**
	 * /proc/pressure avg10: percent of time stalled over the last 10 SECONDS, a
	 * snapshot of the moment of the tick. (Documented as avg60 until 2026-11-05;
	 * the probe always read avg10.)
	 */
	psi?: PsiReading;
	/**
	 * /proc/pressure avg300: the last 5 minutes, i.e. the whole interval since
	 * the previous tick, so nothing between ticks goes unseen. Absent on rows
	 * written before 2026-11-05. Judged by doctor's `cpu-oversubscribed`.
	 */
	psi300?: PsiReading;
	/** CI jobs running on the node at the tick (Runner.Worker processes). null: could not count. */
	workers?: number | null;
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
		/**
		 * fio, 4 KiB random I/O with the page cache bypassed over the same 256 MiB
		 * file: IOPS at queue depth 32 (what a busy database or cache can pull),
		 * and completion latency at depth 1 (what one reader waits per request).
		 * Absent on rows from before fio; null when fio could not run (`fioWhy`).
		 */
		randReadIops?: number | null;
		randWriteIops?: number | null;
		qd1ReadP50Us?: number | null;
		qd1ReadP99Us?: number | null;
		fioWhy?: string;
	} | null;
	/** Controller <-> node over ssh, connection setup subtracted. */
	net?: { upMbps: number | null; downMbps: number | null; bytes: number } | null;
	/**
	 * iperf3 between this node and one other claw over the LAN, the path two
	 * copies of a redundant tenant use. `outMbps` is this node -> peer, `inMbps`
	 * peer -> this node, each as the receiver counted it; `retransmits` are the
	 * sender's TCP retransmissions over both runs. A field is null when its run
	 * failed (`why`); the whole is null when no peer was tested.
	 */
	peer?: {
		node: string;
		outMbps: number | null;
		inMbps: number | null;
		retransmits: number | null;
		why?: string;
	} | null;
	/** Most CI workers seen during the test; above 0 means disturbed. */
	maxWorkers?: number | null;
}
