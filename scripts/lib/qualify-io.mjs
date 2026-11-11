/**
 * `disk-sync-writes` — does this node's disk keep up with synced writes when
 * it is carrying its full load of jobs, and does it keep up for long enough
 * (wave bootcamp2 Q2).
 *
 * Two incidents set the shape, and a short probe caught neither:
 *
 *   - claw-1's worn laptop disk took ~40 ms for one 4k O_DSYNC write, and at 3
 *     concurrent jobs 11 of 83 cardtable shards failed on time (hadoku_site
 *     1bb546d07, 2026-11-02, which cut its ceiling 3 → 2). A single fsync
 *     probe on an idle node does not see the queue that k writers build.
 *   - claw-6's SATA SSD writes ~400 MB/s for the first ~2.8 GB of synced
 *     writes and 110–200 MB/s after it, with flushes rising from 1 ms to 13 ms;
 *     the scraper suite ran 2.5x slower there (scraper 9611128, 2026-10-25). A
 *     short `dd` fits inside the fast cache, which is why one ranked claw-6 the
 *     FASTEST disk in the fleet.
 *
 * So the test runs two phases with fio, in a directory of its own under the
 * ci user's DISK cache (`${XDG_CACHE_HOME:-$HOME/.cache}`) — never `/tmp`,
 * which is tmpfs on the claws and would measure RAM:
 *
 *   (b) first, on a fresh disk: 4k random writes with O_DSYNC, one writer per
 *       slot (k = the node's `maxConcurrent`), for RAND_SEC. Judged on p99
 *       completion latency, which includes the sync.
 *   (a) then a sequential write of SEQ_SEGMENTS x 1 GiB, back to back, with an
 *       fdatasync every 16 MiB, each GiB timed on its own. Judged on whether
 *       the last GiB still runs at SEQ_HOLD_RATIO of the first.
 *
 * Random runs first on purpose: run after 6 GiB of sequential writes it would
 * measure the tail of the cliff, not the disk at the start of a busy hour.
 *
 * Space is checked before a byte is written, every fio is bounded by
 * `timeout`, the node-side script removes its files on any exit, and the
 * directory itself is removed by a separate cleanup call whatever happened,
 * including a transport that gave up on the run.
 */
import { QUALIFY_TTL_DAYS } from './qualify-registry.mjs';

/**
 * The p99 of a 4k O_DSYNC random write at k parallel writers, ms. 40 ms is what
 * claw-1's disk took for an ORDINARY such write when it failed 11 of 83
 * cardtable shards at 3 concurrent jobs (site 1bb546d07, 2026-11-02): a disk
 * whose slowest 1% of synced writes reach the latency that broke claw-1's
 * typical one does not hold k sync-heavy jobs. Since-boot mean flush times read
 * live on 2026-11-11 put the SSD/NVMe claws at 0.7–3.6 ms and claw-1 at 27 ms.
 */
export const RAND_SYNC_P99_MS = 40;

/**
 * The last GiB's write rate over the first GiB's, at or above which a disk
 * "holds" a sustained synced write. claw-6's SSD fell from ~400 MB/s to
 * 110–200 MB/s past ~2.8 GB (0.28–0.5 of its start) and that cost the scraper
 * suite 2.5x (scraper 9611128); 0.5 fails the whole of that range.
 */
export const SEQ_HOLD_RATIO = 0.5;

/** GiB segments in the sequential phase: 6, so the run passes 5 GB, past claw-6's ~2.8 GB cliff with room. */
export const SEQ_SEGMENTS = 6;
export const SEGMENT_MB = 1024;
/**
 * A segment that has not written its GiB in this long is a crossed bar, not a
 * missing reading: under 8.5 MB/s is no disk anything should be built on.
 */
export const SEGMENT_DEADLINE_SEC = 120;
/** Seconds of random writes. Long enough for a write-back cache to fill and the queue to show. */
export const RAND_SEC = 60;
/** Each random writer's file. k of these, so the working set is not one hot block. */
export const RAND_FILE_MB = 256;
/** The cache must have this many times the test's own footprint free before anything is written. */
export const FREE_SPACE_FACTOR = 2;

const DEADLINE_RCS = new Set([124, 137]);
const DIR_RE = /^\/[A-Za-z0-9._/-]*\/qualify-io\.[A-Za-z0-9]{6}$/;

function assertDir(dir) {
	if (typeof dir !== 'string' || !DIR_RE.test(dir) || dir.split('/').includes('..'))
		throw new Error(`${JSON.stringify(dir)} is not a qualify-io directory`);
}
function assertInt(name, v) {
	if (!Number.isInteger(v) || v <= 0) throw new Error(`bad ${name}: ${v}`);
}

/** Makes the scratch directory and reports what the run needs to know first. */
export function ioPrepScript() {
	return [
		'# QUALIFY_IO_PREP',
		'set -u',
		'base="${XDG_CACHE_HOME:-$HOME/.cache}"',
		'mkdir -p "$base" || exit 3',
		'd=$(mktemp -d "$base/qualify-io.XXXXXX") || exit 3',
		'echo "DIR $d"',
		'echo "AVAIL_MB $(df -Pm "$d" | awk \'NR==2{print $4}\')"',
		'echo "FSTYPE $(stat -f -c %T "$d")"',
		'echo "FIO $(command -v fio || echo none)"',
	].join('\n');
}

/** Seconds the random phase may take: its run, laying out k files, and a margin. */
const randDeadlineSec = (randSec) => randSec + 120;

/** The longest the run script can take on the node before it ends itself. */
export function runBoundSec({ segments, segmentDeadlineSec, randSec }) {
	return randDeadlineSec(randSec) + 10 + segments * (segmentDeadlineSec + 10) + 30;
}

/** Both phases, in `dir`. Every fio is under `timeout`; the files go on any exit. */
export function ioRunScript({
	dir,
	k,
	segments,
	segmentMb,
	randSec,
	randFileMb,
	segmentDeadlineSec,
}) {
	assertDir(dir);
	for (const [n, v] of Object.entries({
		k,
		segments,
		segmentMb,
		randSec,
		randFileMb,
		segmentDeadlineSec,
	}))
		assertInt(n, v);
	return [
		'# QUALIFY_IO_RUN',
		'set -u',
		`d='${dir}'`,
		'cd "$d" || exit 3',
		'trap \'rm -f -- "$d"/rand.* "$d"/seq.* "$d"/fio.json\' EXIT',
		"trap 'exit 143' HUP INT TERM",
		`timeout -k 10 ${randDeadlineSec(randSec)} fio --name=rand --directory="$d" --rw=randwrite --bs=4k` +
			` --size=${randFileMb}M --numjobs=${k} --direct=1 --sync=dsync --ioengine=psync` +
			` --time_based --runtime=${randSec} --group_reporting --output-format=json --output="$d/fio.json"`,
		'echo "RAND_RC $?"',
		'echo RAND_JSON_BEGIN; cat "$d/fio.json" 2>/dev/null; echo; echo RAND_JSON_END',
		'rm -f -- "$d"/rand.* "$d/fio.json"',
		`for i in $(seq 1 ${segments}); do`,
		'  t0=$(date +%s%N)',
		`  timeout -k 10 ${segmentDeadlineSec} fio --name=seq --filename="$d/seq.$i" --rw=write --bs=1M` +
			` --size=${segmentMb}M --direct=1 --ioengine=psync --fdatasync=16 --end_fsync=1 --output=/dev/null`,
		'  rc=$?',
		'  t1=$(date +%s%N)',
		'  echo "SEG $i $rc $(( (t1 - t0) / 1000000 ))"',
		'  [ "$rc" -eq 0 ] || break',
		'done',
		'echo RUN_END',
	].join('\n');
}

/** Removes `dir` and says whether it is gone. */
export function ioCleanupScript(dir) {
	assertDir(dir);
	return [
		'# QUALIFY_IO_CLEANUP',
		`d='${dir}'`,
		'rm -rf -- "$d"',
		'if [ -e "$d" ]; then echo "LEFT $d"; exit 1; fi',
		'echo CLEAN',
	].join('\n');
}

/** @returns {{ dir: string|null, availMb: number|null, fstype: string|null, fio: string|null }} */
export function parsePrep(out) {
	const s = String(out ?? '');
	const field = (k) => s.match(new RegExp(`^${k} (.+)$`, 'm'))?.[1]?.trim() ?? null;
	const avail = Number(field('AVAIL_MB'));
	return {
		dir: field('DIR'),
		availMb: Number.isFinite(avail) && field('AVAIL_MB') !== null ? avail : null,
		fstype: field('FSTYPE'),
		fio: field('FIO'),
	};
}

const ms2 = (ns) => (Number.isFinite(ns) ? Math.round(ns / 1e4) / 100 : null);

/**
 * @returns {{ rand: { rc: number|null, p50Ms: number|null, p99Ms: number|null, iops: number|null },
 *   segments: { rc: number, ms: number }[], complete: boolean }}
 */
export function parseRun(out) {
	const s = String(out ?? '');
	const rcM = s.match(/^RAND_RC (\d+)$/m);
	const rand = { rc: rcM ? Number(rcM[1]) : null, p50Ms: null, p99Ms: null, iops: null };
	const body = s.match(/^RAND_JSON_BEGIN$([\s\S]*?)^RAND_JSON_END$/m)?.[1] ?? '';
	const brace = body.indexOf('{');
	if (brace >= 0) {
		let doc = null;
		try {
			doc = JSON.parse(body.slice(brace));
		} catch {
			// A torn document is "no reading": the judge says the phase produced none.
			doc = null;
		}
		const job = doc?.jobs?.[0];
		const pct = job?.write?.clat_ns?.percentile;
		if (job && job.error === 0 && pct) {
			rand.p50Ms = ms2(pct['50.000000']);
			rand.p99Ms = ms2(pct['99.000000']);
			rand.iops = Number.isFinite(job.write.iops) ? Math.round(job.write.iops) : null;
		}
	}
	const segments = [...s.matchAll(/^SEG (\d+) (\d+) (\d+)$/gm)].map((m) => ({
		rc: Number(m[2]),
		ms: Number(m[3]),
	}));
	return { rand, segments, complete: /^RUN_END$/m.test(s) };
}

const mbps = (mb, ms) => (ms > 0 ? Math.round(mb / (ms / 1000)) : null);

/**
 * PURE. The verdict on one run.
 *
 * @param {object} a
 * @param {number} a.k
 * @param {number} a.segmentMb
 * @param {number} a.segmentDeadlineSec
 * @param {number} [a.segmentsExpected]
 * @param {ReturnType<typeof parseRun>['rand']} a.rand
 * @param {ReturnType<typeof parseRun>['segments']} a.segments
 * @returns {{ status: 'pass'|'fail'|'could-not-look', reason: string, metrics: object }}
 */
export function judgeDisk({
	k,
	segmentMb,
	segmentDeadlineSec,
	segmentsExpected = SEQ_SEGMENTS,
	rand,
	segments,
}) {
	const crossed = [];
	const unknown = [];

	if (rand.rc !== 0 || rand.p99Ms === null)
		unknown.push(`the random-write phase produced no reading (fio exit ${rand.rc ?? 'unknown'})`);
	else if (rand.p99Ms > RAND_SYNC_P99_MS)
		crossed.push(
			`4k O_DSYNC random-write p99 ${rand.p99Ms} ms > ${RAND_SYNC_P99_MS} ms at k=${k} parallel writers`
		);

	const deadlineHit = segments.findIndex((x) => DEADLINE_RCS.has(x.rc));
	const otherFail = segments.findIndex((x) => x.rc !== 0 && !DEADLINE_RCS.has(x.rc));
	if (deadlineHit >= 0)
		crossed.push(
			`sequential segment ${deadlineHit + 1} did not write its ${segmentMb} MB within its ${segmentDeadlineSec} s deadline` +
				` (under ${Math.round((segmentMb / segmentDeadlineSec) * 10) / 10} MB/s)`
		);
	else if (otherFail >= 0)
		unknown.push(`sequential segment ${otherFail + 1}: fio exited ${segments[otherFail].rc}`);
	else if (segments.length !== segmentsExpected)
		unknown.push(
			`the sequential phase was cut short (${segments.length}/${segmentsExpected} segments reported)`
		);

	const firstMbps = segments[0]?.rc === 0 ? mbps(segmentMb, segments[0].ms) : null;
	const whole = segments.length === segmentsExpected && segments.every((x) => x.rc === 0);
	const lastMbps = whole ? mbps(segmentMb, segments[segments.length - 1].ms) : null;
	const holdRatio =
		firstMbps && lastMbps !== null ? Math.round((lastMbps / firstMbps) * 100) / 100 : null;
	if (holdRatio !== null && holdRatio < SEQ_HOLD_RATIO)
		crossed.push(
			`sustained write fell from first GB ${firstMbps} MB/s to last GB ${lastMbps} MB/s` +
				` (${holdRatio} of its start < ${SEQ_HOLD_RATIO})`
		);

	const metrics = {
		k,
		rand,
		segments: segments.map((x) => ({ ...x, mbps: x.rc === 0 ? mbps(segmentMb, x.ms) : null })),
		firstMbps,
		lastMbps,
		holdRatio,
		bars: { randSyncP99Ms: RAND_SYNC_P99_MS, seqHoldRatio: SEQ_HOLD_RATIO },
	};
	// A crossed bar is a verdict even when something else was unreadable: the
	// disk DID cross it.
	if (crossed.length)
		return { status: 'fail', reason: [...crossed, ...unknown].join('; '), metrics };
	if (unknown.length) return { status: 'could-not-look', reason: unknown.join('; '), metrics };
	return {
		status: 'pass',
		reason:
			`4k O_DSYNC random-write p99 ${rand.p99Ms} ms ≤ ${RAND_SYNC_P99_MS} ms at k=${k}; ` +
			`${segmentsExpected} x ${segmentMb} MB synced sequential held ${firstMbps} → ${lastMbps} MB/s` +
			` (${holdRatio} ≥ ${SEQ_HOLD_RATIO})`,
		metrics,
	};
}

const tail = (r) =>
	String(r?.error || r?.stderr || r?.stdout || '')
		.trim()
		.slice(-300);

/**
 * The test. Sizes are injectable so the tests run it for real at a tiny size;
 * the bars are not.
 */
export function makeIoTest({
	segments = SEQ_SEGMENTS,
	segmentMb = SEGMENT_MB,
	randSec = RAND_SEC,
	randFileMb = RAND_FILE_MB,
	segmentDeadlineSec = SEGMENT_DEADLINE_SEC,
} = {}) {
	const boundSec = runBoundSec({ segments, segmentDeadlineSec, randSec });
	return {
		id: 'disk-sync-writes',
		track: 'qualify',
		needsDrain: true,
		runsAs: 'ci',
		ttlDays: QUALIFY_TTL_DAYS,
		minutes: Math.ceil(boundSec / 60) + 3,
		async run(ctx) {
			const k = ctx.machine?.maxConcurrent;
			if (!Number.isInteger(k) || k <= 0)
				return {
					status: 'could-not-look',
					reason: `the node's manifest entry has no usable maxConcurrent (${JSON.stringify(k)}), so there is no k to write at`,
					metrics: {},
				};

			const prepR = await ctx.exec(ioPrepScript(), { timeoutMs: 60_000 });
			const prep = parsePrep(prepR.stdout);
			if (!prep.dir)
				return {
					status: 'could-not-look',
					reason: `could not make a scratch directory on the node: ${tail(prepR) || 'no output'}`,
					metrics: {},
				};

			// The directory goes whatever measure() did, a throw included.
			let verdict;
			let left = null;
			try {
				verdict = await measure(ctx, prep, k);
			} finally {
				const c = await ctx.exec(ioCleanupScript(prep.dir), { timeoutMs: 120_000 });
				if (!c.ok || !/^CLEAN$/m.test(String(c.stdout)))
					left = `and it left ${prep.dir} behind: ${tail(c) || 'cleanup said nothing'}`;
			}
			return left ? { ...verdict, reason: `${verdict.reason}; ${left}` } : verdict;
		},
	};

	async function measure(ctx, prep, k) {
		const testMb = segments * segmentMb + k * randFileMb;
		if (prep.fio === null || prep.fio === 'none')
			return { status: 'could-not-look', reason: 'fio is not installed on the node', metrics: {} };
		if (prep.fstype === 'tmpfs')
			return {
				status: 'could-not-look',
				reason: `the ci user's cache ${prep.dir} is on tmpfs, so a write test there measures RAM, not the disk`,
				metrics: {},
			};
		if (prep.availMb === null)
			return {
				status: 'could-not-look',
				reason: 'could not read free space under the cache',
				metrics: {},
			};
		if (prep.availMb < FREE_SPACE_FACTOR * testMb)
			return {
				status: 'could-not-look',
				reason:
					`only ${prep.availMb} MiB free under the cache, under ${FREE_SPACE_FACTOR}x the test's ` +
					`${testMb} MiB; refusing to fill the disk to measure it`,
				metrics: { availMb: prep.availMb, testMb },
			};
		const runR = await ctx.exec(
			ioRunScript({
				dir: prep.dir,
				k,
				segments,
				segmentMb,
				randSec,
				randFileMb,
				segmentDeadlineSec,
			}),
			{ timeoutMs: (boundSec + 60) * 1000 }
		);
		const run = parseRun(runR.stdout);
		const v = judgeDisk({ k, segmentMb, segmentDeadlineSec, segmentsExpected: segments, ...run });
		if (runR.ok && run.complete) return v;
		const why = `the run did not finish: ${tail(runR) || 'no output'}`;
		return v.status === 'fail'
			? { ...v, reason: `${v.reason}; ${why}` }
			: { status: 'could-not-look', reason: `${why}; ${v.reason}`, metrics: v.metrics };
	}
}

export const test = makeIoTest();
