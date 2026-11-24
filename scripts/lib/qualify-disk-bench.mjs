/**
 * `disk-bench`: how a storage zone performs AS a zone, on its formatted mount
 * (hadoku-fleet-manager#156). The bars, the targets and the pool it is judged
 * against are in qualify-disk-bench-judge.mjs.
 *
 *   fleet qualify --machine claw-8 --disk-bench    every zone disk of the node (or every
 *                                                  candidate already at its storage mount)
 *
 * PHASES, in a `mktemp -d` of the zone's own directory (never Garage's data
 * directory, never `/tmp`), each fio under `timeout`, the directory removed
 * on any exit:
 *   seqw   sequential 1 MiB write, O_DIRECT, BENCH_SEQ_MB, fsync at the end
 *   seqr   the same file read back, O_DIRECT
 *   randr  4k random reads over it, O_DIRECT, queue depth 1: p50/p99
 *   randw  4k random writes with O_DSYNC (Garage fsyncs), one writer: p50/p99
 *   mixed  Garage-shaped: 1 MiB buffered block writes with an fsync each,
 *          beside 4k metadata writes with an fdatasync each, together
 * The directory's filesystem must sit on the disk the target names (by
 * serial): a bench of the wrong disk is refused before a byte is written.
 *
 * It drains the node (needsDrain): a bench beside CI measures CI. Garage is
 * left running. Each reading is learned per serial and per model in
 * node-baselines (qualify-baseline.mjs `disk-bench`).
 */
import { assertSerial } from './qualify-disk-burnin.mjs';
import { readInventory } from './qualify-disk-inventory.mjs';
import { benchTargets, judgeBench } from './qualify-disk-bench-judge.mjs';
import { QUALIFY_TTL_DAYS } from './qualify-registry.mjs';

/** The sequential file, MiB: past a desktop disk's cache, small enough to stay minutes. */
export const BENCH_SEQ_MB = 4096;
export const BENCH_RAND_SEC = 30;
export const BENCH_MIXED_SEC = 60;
/** The target needs this much free, MiB, before anything is written: the files twice over. */
export const BENCH_FREE_MB = 2 * (BENCH_SEQ_MB + 256 + 1024 + 64);
const DIR_RE = /^\/srv\/storage\/[A-Za-z0-9._:-]+$/;

const PHASES = ['seqw', 'seqr', 'randr', 'randw', 'mixed'];

/** The node script for one target, as root. */
export function benchScript({ dir, serial }) {
	if (!DIR_RE.test(dir) || dir.split('/').includes('..'))
		throw new Error(`${JSON.stringify(dir)} is not a storage zone directory`);
	assertSerial(serial);
	const fio = (phase, deadline, args) => [
		`echo BENCH_${phase}_BEGIN`,
		`timeout -k 10 ${deadline} fio --output-format=json ${args} 2>&1`,
		`echo; echo "BENCH_${phase}_RC $?"`,
		`echo BENCH_${phase}_END`,
	];
	const seq = `--filename="$d/seq" --bs=1M --size=${BENCH_SEQ_MB}M --direct=1 --ioengine=psync`;
	return [
		`sudo -n sh -s <<'DISK_BENCH_EOF'`,
		'set -u',
		`t='${dir}'`,
		`serial='${serial}'`,
		'refuse() { echo "BENCH_REFUSE $*"; exit 3; }',
		'command -v fio >/dev/null 2>&1 || refuse "fio is not installed"',
		'[ -d "$t" ] || refuse "$t does not exist"',
		'src=$(findmnt -no SOURCE -T "$t") || refuse "findmnt could not place $t"',
		// Walk up from the filesystem's device (a partition, dm-crypt, LVM) to its disk.
		'pk=$(lsblk -nsro NAME,TYPE "$src" 2>/dev/null | awk \'$2 == "disk" { print $1; exit }\')',
		'[ -n "$pk" ] || refuse "no disk under $src"',
		'disk=/dev/$pk',
		'got=$(lsblk -dno SERIAL "$disk" 2>/dev/null | sed "s/[[:space:]]*$//")',
		'[ "$got" = "$serial" ] || refuse "$t is on $disk (serial ${got:-none}), not $serial"',
		'avail=$(df -Pm "$t" | awk \'NR==2{print $4}\')',
		`[ "\${avail:-0}" -ge ${BENCH_FREE_MB} ] || refuse "$t has \${avail:-?} MiB free, the bench needs ${BENCH_FREE_MB}"`,
		'd=$(mktemp -d "$t/qualify-bench.XXXXXX") || refuse "mktemp failed in $t"',
		'trap \'rm -rf -- "$d"\' EXIT',
		"trap 'exit 143' HUP INT TERM",
		'echo "BENCH_ON $disk $(stat -f -c %T "$t")"',
		...fio('seqw', 600, `--name=seqw ${seq} --rw=write --end_fsync=1`),
		...fio('seqr', 600, `--name=seqr ${seq} --rw=read --readonly`),
		...fio(
			'randr',
			BENCH_RAND_SEC + 60,
			`--name=randr ${seq} --rw=randread --bs=4k --time_based --runtime=${BENCH_RAND_SEC} --readonly`
		),
		...fio(
			'randw',
			BENCH_RAND_SEC + 120,
			`--name=randw --filename="$d/rand" --rw=randwrite --bs=4k --size=256M --direct=1 --ioengine=psync` +
				` --sync=dsync --time_based --runtime=${BENCH_RAND_SEC}`
		),
		...fio(
			'mixed',
			BENCH_MIXED_SEC + 180,
			`--time_based --runtime=${BENCH_MIXED_SEC} --ioengine=psync` +
				' --name=blocks --filename="$d/blocks" --rw=write --bs=1M --size=1024M --fsync=1' +
				' --name=meta --filename="$d/meta" --rw=randwrite --bs=4k --size=64M --fdatasync=1'
		),
		'echo BENCH_END',
		'DISK_BENCH_EOF',
	].join('\n');
}

const ms = (ns) => (Number.isFinite(ns) ? Math.round(ns / 1e4) / 100 : null);
const mbps = (bytesPerSec) =>
	Number.isFinite(bytesPerSec) ? Math.round(bytesPerSec / 1048576) : null;
const pct = (side, p) => ms(side?.clat_ns?.percentile?.[p]);

/** PURE. fio's jobs for one phase, or null when it produced no whole document or failed. */
export function phaseJobs(out, phase) {
	const s = String(out ?? '');
	const body =
		s.match(new RegExp(`^BENCH_${phase}_BEGIN$([\\s\\S]*?)^BENCH_${phase}_END$`, 'm'))?.[1] ?? '';
	const rc = Number(body.match(new RegExp(`^BENCH_${phase}_RC (\\d+)$`, 'm'))?.[1]);
	const brace = body.indexOf('{');
	if (rc !== 0 || brace < 0) return null;
	try {
		const jobs = JSON.parse(body.slice(brace, body.lastIndexOf('}') + 1))?.jobs;
		return Array.isArray(jobs) && jobs.every((j) => j.error === 0) ? jobs : null;
	} catch {
		// A torn document is "no reading"; the judge names the phase.
		return null;
	}
}

/** PURE. The reading, a null per phase that did not finish. */
export function parseBench(out) {
	const s = String(out ?? '');
	const j = Object.fromEntries(PHASES.map((p) => [p, phaseJobs(s, p)]));
	const blocks = j.mixed?.find((x) => x.jobname === 'blocks');
	const meta = j.mixed?.find((x) => x.jobname === 'meta');
	return {
		refused: s.match(/^BENCH_REFUSE (.+)$/m)?.[1] ?? null,
		on: s.match(/^BENCH_ON (.+)$/m)?.[1] ?? null,
		complete: /^BENCH_END$/m.test(s),
		reading: {
			seqWriteMbps: mbps(j.seqw?.[0]?.write?.bw_bytes),
			seqReadMbps: mbps(j.seqr?.[0]?.read?.bw_bytes),
			randReadP50Ms: pct(j.randr?.[0]?.read, '50.000000'),
			randReadP99Ms: pct(j.randr?.[0]?.read, '99.000000'),
			randWriteP50Ms: pct(j.randw?.[0]?.write, '50.000000'),
			randWriteP99Ms: pct(j.randw?.[0]?.write, '99.000000'),
			blockMbps: mbps(blocks?.write?.bw_bytes),
			metaP99Ms: pct(meta?.write, '99.000000'),
		},
	};
}

const tail = (r) =>
	String(r?.error || r?.stderr || r?.stdout || '')
		.trim()
		.slice(-300);

/**
 * The test. `zoneDisks` is the node's declared zone (garage-layout.json), or
 * null; `pool` the OTHER zones' readings (qualify-disk-bench-judge.mjs
 * `poolReadings`).
 */
export function makeBenchTest({ zoneDisks, pool, rootZoneDir, mountPointFor }) {
	// Every phase's deadline summed is ~28 min for one disk; a slow disk is a fail, not an overrun.
	const minutes = 30 * Math.max(1, zoneDisks?.length ?? 1);
	return {
		id: 'disk-bench',
		track: 'qualify',
		needsDrain: true,
		runsAs: 'admin',
		ttlDays: QUALIFY_TTL_DAYS,
		minutes,
		/** The serials it will touch, for the link check around it. */
		touched: (r) => (r?.metrics?.disks ?? []).map((d) => d.serial).filter(Boolean),
		async run(ctx) {
			const inv = await readInventory(ctx);
			if ('error' in inv) return { status: 'could-not-look', reason: inv.error, metrics: {} };
			const { targets, why } = benchTargets({
				zoneDisks,
				inventory: inv.inventory,
				rootZoneDir,
				mountPointFor,
			});
			const disks = why.map((w) => ({ serial: null, verdict: 'blocked', reason: w }));
			for (const t of targets) {
				ctx.log?.(`   bench ${t.serial}${t.root ? ' (root zone)' : ''} at ${t.dir}`);
				const r = await ctx.exec(benchScript({ dir: t.dir, serial: t.serial }), {
					timeoutMs: 30 * 60_000,
				});
				const b = parseBench(r.stdout);
				const base = { serial: t.serial, model: t.model, root: t.root, dir: t.dir, on: b.on };
				if (b.refused) {
					disks.push({ ...base, verdict: 'blocked', reason: `refused on the node: ${b.refused}` });
					continue;
				}
				if (!b.complete) {
					disks.push({
						...base,
						verdict: 'blocked',
						reason: `the bench did not finish: ${tail(r) || 'no output'}`,
						reading: b.reading,
					});
					continue;
				}
				const j = judgeBench(b.reading, pool);
				disks.push({
					...base,
					verdict: j.verdict,
					reason: j.reason,
					reading: b.reading,
					bars: j.bars,
				});
			}
			const line = (v) =>
				disks
					.filter((d) => d.verdict === v)
					.map((d) => `${d.serial ?? '(none)'}: ${d.reason}`)
					.join(' | ');
			const metrics = { disks };
			if (!disks.length) return { status: 'could-not-look', reason: 'nothing to bench', metrics };
			if (disks.some((d) => d.verdict === 'fail'))
				return { status: 'fail', reason: line('fail'), metrics };
			if (disks.some((d) => d.verdict === 'blocked'))
				return { status: 'could-not-look', reason: line('blocked'), metrics };
			return { status: 'pass', reason: line('pass'), metrics };
		},
	};
}
