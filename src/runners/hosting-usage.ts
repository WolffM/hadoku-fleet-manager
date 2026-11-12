/**
 * HOSTING USAGE — what each shared hosting slice actually used, per hour,
 * for the last {@link USAGE_KEEP_HOURS} hours (fleet-manager#83 follow-up).
 *
 * `heldBackMb` holds back a slice's declared size minus what it uses now, and
 * counts the agent as up only past a fixed mark (`steadyMb`, or 256 MiB). Both
 * numbers are hand-typed and drift as a tenant does more or less work. This
 * record is the history a LEARNED hold-back is computed from: the 15 s tick
 * already reads every slice's `memory.current`, and folds each reading into
 * an hourly bucket here.
 *
 * ADMISSION USES IT. Once a slice has {@link LEARN_MIN_HOURS} hours of
 * readings, {@link learnedHold} is what the dispatcher holds back for it
 * (operator, 2026-11-12: "it can decide now"); before that, `heldBackMb`'s
 * rule stands. `ephemeral-tick-probe.ts` logs both, and which one decided,
 * once an hour per slice (grep "[hosting-usage] hold"). The learned value
 * changes only what the dispatcher holds back from CI, never the kernel's
 * MemoryMin, which stays the declared size (operator, 2026-11-11), so a hold
 * learned too small squeezes a CI job, never the tenant.
 *
 * Losing this file loses history, not safety: every slice falls back to the
 * declared rule until it has learned again. One writer:
 * {@link observeSliceUsage}, from the tick.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from '../host.js';
import { writeJsonAtomic } from '../lib/atomic-json.js';
import { HOLD_FULL_MS } from './hosting-record.js';

export const HOSTING_USAGE_FILE = 'hosting-usage.json';

/** 14 days of hourly buckets. */
export const USAGE_KEEP_HOURS = 14 * 24;

/**
 * A slice needs this many hours of readings before its learned value decides.
 * Six hours is ~1,400 readings, enough for a stable mean and spread; the first
 * hours of a NEW slice include its start-up, and the peak keeps that for the
 * whole window anyway. Set at the switch (2026-11-12), with 22 h in hand.
 */
export const LEARN_MIN_HOURS = 6;

/** The learned up mark never leaves this band (MiB): above it a real agent reads as down, below it noise reads as up. */
export const UP_MARK_FLOOR_MB = 64;
export const UP_MARK_CEIL_MB = 256;

/** How often the tick's in-memory record is written out. */
export const USAGE_FLUSH_MS = 5 * 60_000;

/** One hour of readings: count, sum, sum of squares, min, max (MiB). */
export type UsageBucket = [n: number, sum: number, sumSq: number, min: number, max: number];

export interface UsageDoc {
	version: 1;
	/** `${node}/${tenant}` -> hour (`YYYY-MM-DDTHH`, UTC) -> bucket. */
	slices: Record<string, Record<string, UsageBucket>>;
}

export const sliceKey = (node: string, tenant: string): string => `${node}/${tenant}`;
export const hourKey = (ms: number): string => new Date(ms).toISOString().slice(0, 13);

const isBucket = (b: unknown): b is UsageBucket =>
	Array.isArray(b) && b.length === 5 && b.every((x) => typeof x === 'number' && Number.isFinite(x));

/** The record on disk: empty when there is none yet, `null` when one exists and does not parse. */
export function readHostingUsage(dir = stateDir()): UsageDoc | null {
	const path = join(dir, HOSTING_USAGE_FILE);
	if (!existsSync(path)) return { version: 1, slices: {} };
	try {
		const doc = JSON.parse(readFileSync(path, 'utf8')) as Partial<UsageDoc>;
		if (doc?.version !== 1 || !doc.slices || typeof doc.slices !== 'object') return null;
		for (const hours of Object.values(doc.slices))
			if (!hours || typeof hours !== 'object' || !Object.values(hours).every(isBucket)) return null;
		return doc as UsageDoc;
	} catch {
		return null;
	}
}

/** Fold one reading into its hour, and drop hours older than {@link USAGE_KEEP_HOURS} (and slices left empty). */
export function addReading(doc: UsageDoc, key: string, mb: number, nowMs: number): void {
	const hours = (doc.slices[key] ??= {});
	const h = hourKey(nowMs);
	const b = hours[h];
	hours[h] = b
		? [b[0] + 1, b[1] + mb, b[2] + mb * mb, Math.min(b[3], mb), Math.max(b[4], mb)]
		: [1, mb, mb * mb, mb, mb];
	const oldest = hourKey(nowMs - USAGE_KEEP_HOURS * 3_600_000);
	for (const [k, hrs] of Object.entries(doc.slices)) {
		for (const hk of Object.keys(hrs)) if (hk < oldest) delete hrs[hk];
		if (Object.keys(hrs).length === 0) delete doc.slices[k];
	}
}

export interface UsageStats {
	hours: number;
	meanMb: number;
	sdMb: number;
	/** The highest single reading in the window. */
	peakMb: number;
	/** 10th percentile of the hourly minimums: the slice's idle floor, ignoring the odd restart. */
	idleMb: number;
}

export function usageStats(hours: Record<string, UsageBucket> | undefined): UsageStats | null {
	const buckets = Object.values(hours ?? {});
	const n = buckets.reduce((s, b) => s + b[0], 0);
	if (n === 0) return null;
	const mean = buckets.reduce((s, b) => s + b[1], 0) / n;
	const variance = Math.max(0, buckets.reduce((s, b) => s + b[2], 0) / n - mean * mean);
	const mins = buckets.map((b) => b[3]).sort((a, b) => a - b);
	return {
		hours: buckets.length,
		meanMb: Math.round(mean),
		sdMb: Math.round(Math.sqrt(variance)),
		peakMb: Math.max(...buckets.map((b) => b[4])),
		idleMb: mins[Math.floor((mins.length - 1) * 0.1)],
	};
}

/**
 * The hold-back admission WOULD use if it learned from history, or `null`
 * while the slice has fewer than {@link LEARN_MIN_HOURS} hours of readings.
 *
 * Same shape as `heldBackMb`, with the two hand-typed numbers learned:
 *   - the slice's ENVELOPE is the higher of mean + 3σ and the peak reading in
 *     the window, never above the declared size. A tenant that starts doing
 *     more raises it within the hour it does; one that does less lowers it
 *     as the old hours age out;
 *   - the UP MARK is 80% of the idle floor, inside
 *     [{@link UP_MARK_FLOOR_MB}, {@link UP_MARK_CEIL_MB}].
 * Below the up mark, unreadable, or inside the declaration's first
 * `HOLD_FULL_MS`, the whole declaration is held, exactly as today.
 */
export function learnedHold(o: {
	declaredMb: number;
	currentMb: number | null;
	since: string;
	stats: UsageStats | null;
	nowMs?: number;
}): { holdMb: number; envelopeMb: number; upMarkMb: number } | null {
	const { declaredMb, currentMb, stats } = o;
	if (!stats || stats.hours < LEARN_MIN_HOURS) return null;
	const since = Date.parse(o.since);
	const young = !Number.isFinite(since) || (o.nowMs ?? Date.now()) - since < HOLD_FULL_MS;
	const envelopeMb = Math.min(declaredMb, Math.max(stats.meanMb + 3 * stats.sdMb, stats.peakMb));
	const upMarkMb = Math.min(
		UP_MARK_CEIL_MB,
		Math.max(UP_MARK_FLOOR_MB, Math.round(stats.idleMb * 0.8))
	);
	const holdMb =
		currentMb === null || !Number.isFinite(currentMb) || young || currentMb < upMarkMb
			? declaredMb
			: Math.max(0, Math.round(envelopeMb - currentMb));
	return { holdMb, envelopeMb, upMarkMb };
}

let loaded: { dir: string; doc: UsageDoc } | null = null;
let flushedAtMs = 0;

/** Test seam. Not part of the supported API. */
export function __resetHostingUsageForTesting(): void {
	loaded = null;
	flushedAtMs = 0;
}

/**
 * The tick's one write path: fold this tick's readings in, write the record
 * out at most every {@link USAGE_FLUSH_MS}, and hand back each slice's stats.
 * A record on disk that does not parse is reported through `onUnreadable` and
 * replaced: it is a learning cache, and refusing to record would keep it
 * broken forever.
 */
export function observeSliceUsage(
	readings: readonly { node: string; tenant: string; mb: number | null }[],
	o: { nowMs?: number; dir?: string; onUnreadable?: (path: string) => void } = {}
): Map<string, UsageStats | null> {
	const dir = o.dir ?? stateDir();
	const nowMs = o.nowMs ?? Date.now();
	if (loaded?.dir !== dir) {
		const doc = readHostingUsage(dir);
		if (!doc) o.onUnreadable?.(join(dir, HOSTING_USAGE_FILE));
		loaded = { dir, doc: doc ?? { version: 1, slices: {} } };
	}
	const out = new Map<string, UsageStats | null>();
	for (const r of readings) {
		const key = sliceKey(r.node, r.tenant);
		if (r.mb !== null && Number.isFinite(r.mb)) addReading(loaded.doc, key, r.mb, nowMs);
		out.set(key, usageStats(loaded.doc.slices[key]));
	}
	if (nowMs - flushedAtMs >= USAGE_FLUSH_MS) {
		writeJsonAtomic(join(dir, HOSTING_USAGE_FILE), loaded.doc, { fsync: false });
		flushedAtMs = nowMs;
	}
	return out;
}
