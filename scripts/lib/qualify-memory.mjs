/**
 * `tmpfs-headroom` — when `/tmp` is full, is there still room to mint a job
 * (wave bootcamp2 Q2)?
 *
 * `/tmp` is tmpfs on every claw, sized at about half the installed RAM, so a
 * byte in it is a byte of memory — and tmpfs pages are not charged to the job
 * that wrote them, so a job's own `MemoryMax` never sees them. claw-6 (from
 * 2026-09-30) and claw-2 (from 10-04) refused every mint for days because a
 * finished job's `/tmp/pytest-of-*` and `node-compile-cache` debris (2.2 GB)
 * held the RAM mint admission needs, while every panel still read "mintable"
 * (private issue 129). Admission refuses when `MemAvailable − reserve <
 * minFreeMb`, and an unmeasured job reserves HEAVY_JOB_MB.
 *
 * So the test fills `/tmp` to TMP_FILL_PCT of its size, inside a directory of
 * its own, reads MemAvailable while it is full, and deletes what it wrote.
 * It fails when a full `/tmp` leaves less than `minFreeMb + HEAVY_JOB_MB`: on
 * that node, the debris of ONE job that used `/tmp` freely is enough to stop
 * every mint.
 *
 * The fill never pushes a node below its own floor: it checks MemAvailable
 * before every chunk and stops at `minFreeMb`, which is itself a fail, because
 * the bar sits above it. Every write is bounded by `timeout`, the node-side
 * script deletes its files on any exit, and the directory is removed by a
 * separate cleanup call whatever happened.
 */
import { JOB_RESERVE_DEFAULT_MB } from '../../dist/lib/job-reserve.js';
import { QUALIFY_TTL_DAYS } from './qualify-registry.mjs';

/**
 * One heavy job's memory, MiB: what mint admission reserves for a job nothing
 * has measured (JOB_RESERVE_DEFAULT_MB, 4096: ~1.4x the worst of 674 measured
 * job windows, p95 2,663 MB, max 2,954 MB). Read from admission's own constant,
 * not copied, so this bar moves when admission's reserve does: the question is
 * exactly "would admission take one more unmeasured job".
 */
export const HEAVY_JOB_MB = JOB_RESERVE_DEFAULT_MB;

/**
 * How full the fill makes `/tmp`, percent of its size. A job that writes to
 * `/tmp` freely fills it to the brim; 90 is that, short of the last 10% the
 * node's own services may need while the test holds it (wave plan: "tmpfs fill
 * to ~90% of /tmp").
 */
export const TMP_FILL_PCT = 90;

/** MiB per write; MemAvailable is re-read before each, so the stop floor is never overshot by more. */
export const CHUNK_MB = 256;
/** Seconds the fill may take before it stops and says so. tmpfs writes at RAM speed; minutes means swapping. */
export const FILL_DEADLINE_SEC = 300;
/** Seconds between the last write and the MemAvailable read, so reclaim has settled. */
export const SETTLE_SEC = 5;

const DIR_RE = /^\/[A-Za-z0-9._/-]*\/qualify-tmpfs\.[A-Za-z0-9]{6}$/;
const ROOT_RE = /^\/[A-Za-z0-9._/-]*$/;

function assertDir(dir) {
	if (typeof dir !== 'string' || !DIR_RE.test(dir) || dir.split('/').includes('..'))
		throw new Error(`${JSON.stringify(dir)} is not a qualify-tmpfs directory`);
}
function assertRoot(root) {
	if (typeof root !== 'string' || !ROOT_RE.test(root) || root.split('/').includes('..'))
		throw new Error(`bad root: ${JSON.stringify(root)}`);
}
function assertCount(name, v) {
	if (!Number.isInteger(v) || v < 0) throw new Error(`bad ${name}: ${v}`);
}

/** MiB to write so `/tmp` reaches TMP_FILL_PCT of its size; 0 when it is already there. PURE. */
export function fillTargetMb({ sizeMb, usedMb, pct = TMP_FILL_PCT }) {
	return Math.max(0, Math.floor((sizeMb * pct) / 100) - usedMb);
}

/** The filesystem, its size and use, memory, and a directory of the test's own under `root`. */
export function tmpfsFactsScript(root) {
	assertRoot(root);
	return [
		'# QUALIFY_TMPFS_FACTS',
		'set -u',
		`root='${root}'`,
		'echo "FSTYPE $(stat -f -c %T "$root")"',
		'df -Pm "$root" | awk \'NR==2{print "TMP_SIZE_MB " $2; print "TMP_USED_MB " $3}\'',
		'awk \'/^MemAvailable:/{print "MEM_AVAIL_MB " int($2/1024)} /^MemTotal:/{print "MEM_TOTAL_MB " int($2/1024)}\' /proc/meminfo',
		'd=$(mktemp -d "$root/qualify-tmpfs.XXXXXX") || exit 3',
		'echo "DIR $d"',
	].join('\n');
}

/** The longest the fill script can take on the node before it ends itself. */
export const fillBoundSec = (settleSec) => FILL_DEADLINE_SEC + 65 + settleSec + 15;

/** Fill `dir` to `targetMb`, read memory while full, delete. Stops at MemAvailable < `stopMb`. */
export function tmpfsFillScript({ dir, root, targetMb, chunkMb, stopMb, settleSec }) {
	assertDir(dir);
	assertRoot(root);
	for (const [n, v] of Object.entries({ targetMb, stopMb, settleSec })) assertCount(n, v);
	if (!Number.isInteger(chunkMb) || chunkMb <= 0) throw new Error(`bad chunkMb: ${chunkMb}`);
	return [
		'# QUALIFY_TMPFS_FILL',
		'set -u',
		`d='${dir}'`,
		`root='${root}'`,
		`target=${targetMb}`,
		`chunk=${chunkMb}`,
		`stop=${stopMb}`,
		'trap \'rm -f -- "$d"/fill.*\' EXIT',
		"trap 'exit 143' HUP INT TERM",
		"mem() { awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo; }",
		`written=0; deadline=$((SECONDS + ${FILL_DEADLINE_SEC}))`,
		'while [ "$written" -lt "$target" ]; do',
		'  a=$(mem)',
		'  if [ "$a" -lt "$stop" ]; then echo "STOPPED MemAvailable $a < $stop"; break; fi',
		'  if [ "$SECONDS" -ge "$deadline" ]; then echo "DEADLINE"; break; fi',
		'  n=$chunk; [ $((target - written)) -lt "$n" ] && n=$((target - written))',
		'  timeout -k 5 60 dd if=/dev/zero of="$d/fill.$written" bs=1M count="$n" status=none || { echo "DD_FAIL $?"; break; }',
		'  written=$((written + n))',
		'done',
		'echo "FILLED_MB $written"',
		`sleep ${settleSec}`,
		'echo "FULL_AVAIL_MB $(mem)"',
		'echo "FULL_TMP_USED_MB $(df -Pm "$root" | awk \'NR==2{print $3}\')"',
		'echo "PSI_SOME_AVG10 $(awk \'/^some/{sub("avg10=","",$2); print $2}\' /proc/pressure/memory 2>/dev/null)"',
		'rm -f -- "$d"/fill.*',
		'if ls "$d"/fill.* >/dev/null 2>&1; then echo "LEFT $d"; else echo CLEAN; fi',
		'echo "AFTER_AVAIL_MB $(mem)"',
		'echo FILL_END',
	].join('\n');
}

/** Removes `dir` and says whether it is gone. */
export function tmpfsCleanupScript(dir) {
	assertDir(dir);
	return [
		'# QUALIFY_TMPFS_CLEANUP',
		`d='${dir}'`,
		'rm -rf -- "$d"',
		'if [ -e "$d" ]; then echo "LEFT $d"; exit 1; fi',
		'echo CLEAN',
	].join('\n');
}

const fieldOf = (s) => (k) => s.match(new RegExp(`^${k} (.+)$`, 'm'))?.[1]?.trim() ?? null;
const numOf = (v) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

export function parseFacts(out) {
	const f = fieldOf(String(out ?? ''));
	return {
		fstype: f('FSTYPE'),
		sizeMb: numOf(f('TMP_SIZE_MB')),
		usedMb: numOf(f('TMP_USED_MB')),
		availMb: numOf(f('MEM_AVAIL_MB')),
		memTotalMb: numOf(f('MEM_TOTAL_MB')),
		dir: f('DIR'),
	};
}

export function parseFill(out) {
	const s = String(out ?? '');
	const f = fieldOf(s);
	return {
		filledMb: numOf(f('FILLED_MB')),
		fullAvailMb: numOf(f('FULL_AVAIL_MB')),
		fullTmpUsedMb: numOf(f('FULL_TMP_USED_MB')),
		psiSome10: numOf(f('PSI_SOME_AVG10')),
		afterAvailMb: numOf(f('AFTER_AVAIL_MB')),
		stopped: f('STOPPED'),
		ddFail: f('DD_FAIL'),
		deadline: /^DEADLINE$/m.test(s),
		clean: /^CLEAN$/m.test(s),
		left: f('LEFT'),
		complete: /^FILL_END$/m.test(s),
	};
}

/**
 * PURE. The verdict on one fill.
 *
 * @param {object} a
 * @param {number} a.minFreeMb the node's floor
 * @param {number} a.targetMb what the fill set out to write
 * @param {number} a.tmpSizeMb
 * @param {Partial<ReturnType<typeof parseFill>>} a.fill
 */
export function judgeHeadroom({ minFreeMb, targetMb, tmpSizeMb, fill }) {
	const needMb = minFreeMb + HEAVY_JOB_MB;
	const a = fill.fullAvailMb ?? null;
	const filled = fill.filledMb ?? 0;
	const metrics = {
		needMb,
		minFreeMb,
		heavyJobMb: HEAVY_JOB_MB,
		tmpSizeMb,
		targetMb,
		filledMb: fill.filledMb ?? null,
		fullAvailMb: a,
		fullTmpUsedMb: fill.fullTmpUsedMb ?? null,
		psiSome10: fill.psiSome10 ?? null,
		afterAvailMb: fill.afterAvailMb ?? null,
	};
	const shortBy = fill.stopped
		? fill.stopped
		: fill.ddFail
			? `a write failed, exit ${fill.ddFail}`
			: fill.deadline
				? `the ${FILL_DEADLINE_SEC} s fill deadline passed`
				: filled < targetMb
					? 'the fill ended early'
					: null;
	const short = shortBy ? `the fill stopped at ${filled} of ${targetMb} MiB (${shortBy})` : null;
	const full = `with /tmp at ${fill.fullTmpUsedMb ?? '?'} of ${tmpSizeMb} MiB`;
	const bar = `${needMb} MiB (minFreeMb ${minFreeMb} + one heavy job ${HEAVY_JOB_MB} MiB)`;

	let v;
	if (a === null)
		v = { status: 'could-not-look', reason: 'no MemAvailable reading while /tmp was full' };
	else if (a < needMb)
		v = {
			status: 'fail',
			reason:
				`${full}, MemAvailable ${a} MiB < ${bar}: mint admission would refuse every unmeasured job` +
				(short ? `; ${short}` : ''),
		};
	else if (short)
		v = {
			status: 'could-not-look',
			reason: `${short}, and MemAvailable was still ${a} MiB ≥ ${needMb} MiB, so a full /tmp was never measured`,
		};
	else v = { status: 'pass', reason: `${full}, MemAvailable ${a} MiB ≥ ${bar}` };
	if (fill.clean === false) v.reason += `; and it left ${fill.left ?? 'its fill files'} behind`;
	return { ...v, metrics };
}

const tail = (r) =>
	String(r?.error || r?.stderr || r?.stdout || '')
		.trim()
		.slice(-300);

/**
 * The test. `root`, a cap on the fill, the chunk and the settle are injectable
 * so the tests run it for real in /dev/shm at a tiny size; the bar is not.
 */
export function makeTmpfsTest({
	root = '/tmp',
	maxFillMb = Infinity,
	chunkMb = CHUNK_MB,
	settleSec = SETTLE_SEC,
} = {}) {
	return {
		id: 'tmpfs-headroom',
		track: 'qualify',
		needsDrain: true,
		runsAs: 'ci',
		ttlDays: QUALIFY_TTL_DAYS,
		minutes: Math.ceil(fillBoundSec(settleSec) / 60) + 3,
		async run(ctx) {
			const minFreeMb = ctx.machine?.minFreeMb;
			if (!Number.isFinite(minFreeMb) || minFreeMb < 0)
				return {
					status: 'could-not-look',
					reason: `the node's manifest entry has no usable minFreeMb (${JSON.stringify(minFreeMb)}), so there is no bar`,
					metrics: {},
				};
			const factsR = await ctx.exec(tmpfsFactsScript(root), { timeoutMs: 60_000 });
			const facts = parseFacts(factsR.stdout);
			if (!facts.dir)
				return {
					status: 'could-not-look',
					reason: `could not make a scratch directory in ${root}: ${tail(factsR) || 'no output'}`,
					metrics: {},
				};
			let verdict;
			let left = null;
			try {
				verdict = await measure(ctx, facts, minFreeMb);
			} finally {
				const c = await ctx.exec(tmpfsCleanupScript(facts.dir), { timeoutMs: 60_000 });
				if (!c.ok || !/^CLEAN$/m.test(String(c.stdout)))
					left = `and it left ${facts.dir} behind: ${tail(c) || 'cleanup said nothing'}`;
			}
			return left ? { ...verdict, reason: `${verdict.reason}; ${left}` } : verdict;
		},
	};

	async function measure(ctx, facts, minFreeMb) {
		if (!facts.fstype)
			return {
				status: 'could-not-look',
				reason: `could not read the filesystem of ${root}`,
				metrics: {},
			};
		if (facts.fstype !== 'tmpfs')
			return {
				status: 'pass',
				reason: `${root} is ${facts.fstype}, not tmpfs: filling it costs disk, not the RAM mint admission needs`,
				metrics: { fstype: facts.fstype },
			};
		if (facts.sizeMb === null || facts.usedMb === null)
			return {
				status: 'could-not-look',
				reason: `could not read the size of ${root}`,
				metrics: {},
			};
		const targetMb = Math.min(
			fillTargetMb({ sizeMb: facts.sizeMb, usedMb: facts.usedMb }),
			maxFillMb
		);
		const fillR = await ctx.exec(
			tmpfsFillScript({
				dir: facts.dir,
				root,
				targetMb,
				chunkMb,
				stopMb: Math.ceil(minFreeMb),
				settleSec,
			}),
			{ timeoutMs: (fillBoundSec(settleSec) + 60) * 1000 }
		);
		const fill = parseFill(fillR.stdout);
		const v = judgeHeadroom({ minFreeMb, targetMb, tmpSizeMb: facts.sizeMb, fill });
		v.metrics.beforeAvailMb = facts.availMb;
		v.metrics.memTotalMb = facts.memTotalMb;
		if (fillR.ok && fill.complete) return v;
		const why = `the fill did not finish: ${tail(fillR) || 'no output'}`;
		return v.status === 'fail'
			? { ...v, reason: `${v.reason}; ${why}` }
			: { status: 'could-not-look', reason: `${why}; ${v.reason}`, metrics: v.metrics };
	}
}

export const test = makeTmpfsTest();
