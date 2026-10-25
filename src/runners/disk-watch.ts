/**
 * An early warning on the `_work` filesystem, before admission's own cliff.
 *
 * Wave 4c §F, the operator's disk ask (2026-10-07): admission already refuses
 * a mint under {@link WORK_FREE_FLOOR_MB} (2,048 MB, `ephemeral.ts`) and
 * `runner-health.ts`'s `checkStarvation` already pages when that refusal holds
 * for hours while other claws work — but both only speak once a node is
 * ALREADY refused. Nothing says so earlier, while there is still runway to act.
 * `fleet doctor` checks `/` (10%/20% of a node's own size) but runs only by
 * hand, 11 days stale as of this wave. This file is the gap: a PURE judgement
 * over the SAME per-node `_work` free-space reading `ephemeral-tick.ts`
 * already takes every tick (wave 4b, #101's `df -Pm` piggybacked on the `free
 * -m` ssh), with absolute GB lines rather than a percentage — `/`'s 10%/20%
 * rule is fine for a drive that is mostly OS and logs; `_work` holds the JIT
 * payload cache and every job's workspace, so what matters is GIGABYTES OF
 * HEADROOM LEFT, not a ratio of a disk whose total size varies 16x across the
 * fleet (110 GB on claw-2 to 1,817 GB on claw-8).
 *
 * THE SEAM, NOT THE WIRING. `ephemeral-tick.ts` is lane A's file this wave and
 * cannot be touched here beyond the one hunk the wave brief calls out
 * separately. So the registry below — {@link recordDiskReadings} /
 * {@link diskReadingsForReport} — lives in THIS file rather than beside
 * `admissionVerdictByNode` in `ephemeral-tick.ts`, even though it is the exact
 * same pattern (a module-level snapshot, replaced WHOLESALE once per tick,
 * copied out never mutated — see that file's own doc for why wholesale
 * matters: a node that stops being reachable must stop being reported on the
 * very next pass, not keep a frozen reading forever). The ONE hunk landing
 * after lane A does nothing but call {@link recordDiskReadings} with the two
 * maps `dispatchEphemeral` already builds (`tmpFreeMbByNode`, `workFreeMbByNode`
 * — see that file's `SPACE_PROBE_DF_CMD`/`parseSpaceProbe`). Until that hunk
 * lands, this registry is simply always empty, which is the same honest
 * "could not look yet" `admissionVerdictByNode` reports after every mgmt-api
 * restart — never misread as "every node is fine".
 *
 * HOKON APPEARS HERE SINCE #120 (2026-10-19). Until then it was a guest the
 * dispatcher never minted for, `withoutGuests` stripped it before the space
 * probe, and this registry never carried it. An on-demand guest IS minted
 * for — that is what promotion means now — so `ephemeral-tick.ts` probes its
 * space with every other minting node and the dispatcher refuses it under
 * the same floors. `runner-health.ts`'s `checkDiskWatch` walks
 * `loadEphemeralNodes()` plus the manifest's on-demand guests to decide WHO
 * to judge.
 *
 * /tmp IS JUDGED TOO (2026-10-21). The `_work` lines above were the whole of
 * this file until hokon's 10 GB tmpfs filled with 23,000 leaked temp dirs and
 * the dispatcher refused every mint there — `space: /tmp has 1718MB free,
 * under the 2048MB floor` — including the pm2-host deploys only hokon can
 * run, for two episodes in one night, with `_work` at 370 GB free the whole
 * time. {@link judgeTmpDisk} draws its lines relative to the mint floor
 * rather than in absolute GB, because /tmp is tmpfs sized to the box (4 GB
 * on an 8 GB claw, 10 GB on hokon) and what matters is runway above the
 * floor, not a ratio.
 */

/** One node's per-tick `_work`/`/tmp` free-space reading, mirrored from
 *  `ephemeral-tick.ts`'s own `AdmissionVerdict` space fields — `null` is
 *  "unreadable this tick", never "zero bytes free". `tmpSizeMb` is the /tmp
 *  filesystem's TOTAL size (#132): `null` when the probe did not carry it,
 *  which judges exactly as the absolute lines did before it existed. */
export interface DiskReading {
	tmpFreeMb: number | null;
	tmpSizeMb?: number | null;
	workFreeMb: number | null;
}

/**
 * Free-space lines on the `_work` filesystem — the one holding `~/.hadoku/jit`
 * (falling back to `~/.hadoku` or `$HOME`; see `ephemeral-tick.ts`'s
 * `SPACE_PROBE_DF_CMD`) — that turn this early warning on. Absolute GB, well
 * above admission's own {@link WORK_FREE_FLOOR_MB} (`ephemeral.ts`, 2,048 MB =
 * 2 GB): a percentage would scale with a node's own disk size and say nothing
 * about how many job workspaces are actually left, which is the one thing that
 * matters here.
 *
 * MEASURED LIVE 2026-10-07, read-only (`ssh <claw> df -BG ~/.hadoku/jit` or its
 * fallback — nothing else was run on any node):
 *
 * | node   | total  | free   | used |
 * | ------ | ------ | ------ | ---- |
 * | claw-2 |  110 G |   61 G | 43 % |  <- tightest, by a wide margin
 * | claw-9 |  207 G |  174 G | 12 % |
 * | claw-6 |  221 G |  189 G | 10 % |
 * | claw-3 |  452 G |  369 G | 15 % |
 * | claw-1 |  904 G |  798 G |  7 % |
 * | claw-4 |  900 G |  807 G |  6 % |
 * | claw-5 |  900 G |  818 G |  5 % |
 * | claw-8 | 1817 G | 1695 G |  2 % |
 *
 * THE WAVE BRIEF NAMED claw-9 AS THE SMALLEST, AT 174 GB — that claim does not
 * survive this measurement. claw-2 is smaller by nearly 3x, on a drive barely a
 * tenth the size of the next-smallest claw. Read live rather than trusted,
 * exactly as CLAUDE.md requires ("a planning doc standing in for the code"):
 * the lines below are set against claw-2, the real tightest node, not the
 * brief's stale figure.
 *
 * {@link DISK_WATCH_ADVISORY_FREE_GB} (25 GB) sits comfortably under claw-2's
 * measured 61 GB headroom — no false advisory on deploy — and about 12x
 * {@link WORK_FREE_FLOOR_MB}'s 2 GB: an early warning with real runway left
 * to act (clean a cache, move a repo off the node) before a mint is ever
 * refused. {@link DISK_WATCH_PAGE_FREE_GB} (10 GB) is the line past which a
 * handful of job workspaces could plausibly tip the node into admission's own
 * refusal within hours rather than days — still 5x the hard floor, so the page
 * fires with room to actually fix it, never at the instant admission itself
 * would already be refusing.
 */
import { TMP_FREE_FLOOR_MB } from './ephemeral.js';

export const DISK_WATCH_ADVISORY_FREE_GB = 25;

/** @see DISK_WATCH_ADVISORY_FREE_GB */
export const DISK_WATCH_PAGE_FREE_GB = 10;

/** `DISK_WATCH_ADVISORY_FREE_GB` in MB, the unit {@link DiskReading} carries. */
const ADVISORY_MB = DISK_WATCH_ADVISORY_FREE_GB * 1024;
/** `DISK_WATCH_PAGE_FREE_GB` in MB. */
const PAGE_MB = DISK_WATCH_PAGE_FREE_GB * 1024;

/**
 * This node's verdict: `'unreadable'` when the `_work` probe could not read a
 * number at all — ITS OWN FINDING, never silently "ok" (CLAUDE.md: "I could not
 * look must never render as nothing is wrong"). Otherwise one of three bands,
 * each strictly worse than the last; `'page'` implies past the advisory line
 * too.
 */
export type DiskWatchLevel = 'ok' | 'advisory' | 'page' | 'unreadable';

export interface DiskWatchVerdict {
	level: DiskWatchLevel;
	/** `null` only when `level === 'unreadable'`. */
	freeGb: number | null;
}

/**
 * The pure judgement: one node's `_work` free MB against the two lines above.
 *
 * `null` is UNREADABLE, not "assume the worst" and not "assume fine" — it is
 * its own level so a caller can tell "this node is nearly full" apart from
 * "this node would not answer", which are different findings with different
 * fixes (CLAUDE.md's "a rate limit, a timeout and a deleted repo are three
 * different jobs" applies here just as much as to a GitHub read).
 */
/**
 * /tmp's lines, RELATIVE TO THE MINT FLOOR (`TMP_FREE_FLOOR_MB`, 2048 MB):
 * page with half a floor of runway left — on hokon that is a deploy away from
 * being refused — and advise at one floor of runway. Absolute GB lines would
 * mean a different thing on every tmpfs in the fleet.
 */
export const TMP_WATCH_PAGE_MARGIN_MB = 512;
export const TMP_WATCH_ADVISORY_MARGIN_MB = TMP_FREE_FLOOR_MB;

/**
 * Where the advisory line sits on a /tmp of `tmpSizeMb` (#132).
 *
 * One full floor of runway is only possible on a tmpfs bigger than two
 * floors. claw-2 and claw-6 hold 8 GB, so their tmpfs is ~3.9 GB — under the
 * 4,096 MB line even when EMPTY — and the advisory fired every hour for space
 * that was never there, naming leaked temp dirs that did not exist. So the
 * runway is capped at half of what the filesystem can hold above the floor:
 * the advisory then means something is actually CONSUMING /tmp (~1 GB used on
 * a 3.9 GB tmpfs), not that the box is small. On hokon's 10 GB tmpfs half is
 * ~4 GB, so the full floor of runway stands and nothing there changes.
 *
 * The page line is NOT moved: under floor + 512 MB a mint is one job's
 * scratch away from refusal, whatever the filesystem's size.
 */
export function tmpAdvisoryLineMb(tmpSizeMb: number | null = null): number {
	if (tmpSizeMb === null) return TMP_FREE_FLOOR_MB + TMP_WATCH_ADVISORY_MARGIN_MB;
	const half = Math.floor(Math.max(0, tmpSizeMb - TMP_FREE_FLOOR_MB) / 2);
	return TMP_FREE_FLOOR_MB + Math.min(TMP_WATCH_ADVISORY_MARGIN_MB, half);
}

/**
 * A /tmp too small to hold a full floor of runway above the mint floor — a
 * CAPACITY FACT about the box, said once (`runner-health.ts`), never a
 * finding that repeats while nothing changes. `null` size is "not known",
 * never "small".
 */
export function tmpIsSmall(tmpSizeMb: number | null = null): boolean {
	return tmpSizeMb !== null && tmpSizeMb < TMP_FREE_FLOOR_MB + TMP_WATCH_ADVISORY_MARGIN_MB;
}

/**
 * The pure judgement for /tmp. Same levels as {@link judgeWorkDisk}.
 *
 * Unchanged by CI jobs' temp moving to disk (#100/#101, observed per job since
 * 2026-10-24): what still writes /tmp ignores TMPDIR, tmpfs is still RAM, and
 * admission still refuses under the floor. `runner-health.ts`'s
 * `checkDiskWatch` says why at the point the advisory is worded.
 */
export function judgeTmpDisk(
	tmpFreeMb: number | null,
	tmpSizeMb: number | null = null
): DiskWatchVerdict {
	if (tmpFreeMb === null) return { level: 'unreadable', freeGb: null };
	const freeGb = Math.round((tmpFreeMb / 1024) * 10) / 10;
	if (tmpFreeMb < TMP_FREE_FLOOR_MB + TMP_WATCH_PAGE_MARGIN_MB) return { level: 'page', freeGb };
	if (tmpFreeMb < tmpAdvisoryLineMb(tmpSizeMb)) return { level: 'advisory', freeGb };
	return { level: 'ok', freeGb };
}

/** The worse of two levels, for a snapshot that carries one per node. */
export function worseDiskLevel(a: DiskWatchLevel, b: DiskWatchLevel): DiskWatchLevel {
	const rank: Record<DiskWatchLevel, number> = { ok: 0, advisory: 1, unreadable: 2, page: 3 };
	return rank[b] > rank[a] ? b : a;
}

export function judgeWorkDisk(workFreeMb: number | null): DiskWatchVerdict {
	if (workFreeMb === null) return { level: 'unreadable', freeGb: null };
	const freeGb = Math.round((workFreeMb / 1024) * 10) / 10;
	if (workFreeMb < PAGE_MB) return { level: 'page', freeGb };
	if (workFreeMb < ADVISORY_MB) return { level: 'advisory', freeGb };
	return { level: 'ok', freeGb };
}

/**
 * THE SNAPSHOT — same shape and same rule as `ephemeral-tick.ts`'s
 * `admissionVerdictByNode`: module-level, replaced WHOLESALE once per tick,
 * never mutated in place, only ever handed out as a copy. See this file's own
 * header for why wholesale matters and why this lives here rather than there.
 *
 * EMPTY until the `ephemeral-tick.ts` hunk lands and fires at least once — see
 * {@link recordDiskReadings}. An absent node is "this pass could not look",
 * exactly `admissionVerdictByNode`'s rule, and `runner-health.ts`'s
 * `checkDiskWatch` must carry the previous reading forward for it rather than
 * clear anything.
 */
let diskReadingByNode: ReadonlyMap<string, DiskReading> = new Map();

/**
 * Called once per `dispatchEphemeral` tick (the one hunk in `ephemeral-tick.ts`,
 * landing after lane A) with the SAME two maps that tick already built for
 * admission's own space clause — no second probe, no second ssh.
 *
 * Keyed off `tmpFreeMbByNode`'s own keys: that map and `workFreeMbByNode` are
 * set together, for the same node set, on the same `Promise.all` pass in
 * `ephemeral-tick.ts` (see `SPACE_PROBE_DF_CMD`), so iterating one and
 * `.get`-ing the other never drops a node either map actually has.
 */
export function recordDiskReadings(
	tmpFreeMbByNode: ReadonlyMap<string, number | null>,
	workFreeMbByNode: ReadonlyMap<string, number | null>,
	tmpSizeMbByNode: ReadonlyMap<string, number | null> = new Map()
): void {
	const next = new Map<string, DiskReading>();
	for (const [node, tmpFreeMb] of tmpFreeMbByNode) {
		next.set(node, {
			tmpFreeMb,
			tmpSizeMb: tmpSizeMbByNode.get(node) ?? null,
			workFreeMb: workFreeMbByNode.get(node) ?? null,
		});
	}
	diskReadingByNode = next;
}

/**
 * What the last tick recorded, for `runner-health.ts`'s early-warning finding
 * and (follow-up, not this lane) a `GET /fleet` panel field.
 *
 * Copied, same rule as `admissionVerdictsForReport` — a caller must not be able
 * to mutate the fleet's belief about its own disk state.
 */
export function diskReadingsForReport(): ReadonlyMap<string, DiskReading> {
	return new Map(diskReadingByNode);
}

/** Test seam. Not part of the supported API. */
export function __resetDiskReadingsForTesting(): void {
	diskReadingByNode = new Map();
}

/**
 * Test seam: inject the reading snapshot directly, bypassing a real
 * `dispatchEphemeral` pass — same reason `__setAdmissionVerdictsForTesting`
 * exists. `runner-health.ts`'s disk-watch check is this file's READER, not its
 * producer.
 */
export function __setDiskReadingsForTesting(readings: ReadonlyMap<string, DiskReading>): void {
	diskReadingByNode = new Map(readings);
}
