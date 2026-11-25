/**
 * `disk-node-impact`: what being a storage zone does to the node's real work
 * (hadoku-fleet-manager#156). The load shape, the levels and the bars are in
 * qualify-disk-impact-judge.mjs.
 *
 *   fleet qualify --machine claw-8 --node-impact     soak every zone disk of the node
 *
 * NEEDS the zone's own `disk-bench` (its rates set the load) and the node's
 * own `concurrency-ramp` (its stored p75 unit and the k=1 wall that unit took
 * are the decoy job and its baseline; that k=1 step's heat is also what the
 * node does without the load, #162). Either missing is could-not-look.
 *
 * ONE LEVEL, on the node, under the drain (no CI runs; Garage keeps running):
 *   1. the root disk's 4k O_DSYNC write p99, without the load (IMPACT_PROBE_SEC);
 *   2. the load starts in the background, in a `mktemp -d` of the zone's
 *      directory, under `setsid` and its own `timeout`: phase A writes the
 *      resync stream alone for LOAD_WARM_SEC (so the scrub has a file to
 *      read); phase B adds the scrub reading it back, O_DIRECT;
 *   3. in phase B, sampled: the root probe again, then the decoy unit (k=1);
 *   4. the load is stopped by its process group and its directory removed,
 *      whatever happened; the load also ends itself at its deadline.
 * Space is bounded: each stream wraps inside LOAD_FILE_MB.
 */
import { GARAGE_DATA_FSYNC } from './garage-layout-declared.mjs';
import { onAbort } from './qualify-abort.mjs';
import { assertSerial } from './qualify-disk-burnin.mjs';
import { readInventory } from './qualify-disk-inventory.mjs';
import { benchTargets } from './qualify-disk-bench-judge.mjs';
import { IMPACT_LEVELS, impactResult, judgeLevel, loadAt } from './qualify-disk-impact-judge.mjs';
import { judgeStep } from './qualify-concurrency.mjs';
import { emulatorScript, parseEmulator } from './qualify-emulator.mjs';
import { QUALIFY_BARS, QUALIFY_TTL_DAYS } from './qualify-registry.mjs';

export const LOAD_WARM_SEC = 120;
export const IMPACT_PROBE_SEC = 30;
/** Each stream's file, MiB: the writer wraps inside it, the scrub reads it. */
export const LOAD_FILE_MB = 2048;
const DIR_RE = /^\/srv\/storage\/[A-Za-z0-9._:-]+$/;
const LOAD_RE = /^\/srv\/storage\/[A-Za-z0-9._:-]+\/qualify-impact\.[A-Za-z0-9]{6}$/;

const int = (n, what) => {
	if (!Number.isInteger(n) || n <= 0) throw new Error(`bad ${what}: ${n}`);
	return n;
};

/** Root's synced-write probe, as the running role, on the root filesystem's cache. */
export function rootProbeScript(sec = IMPACT_PROBE_SEC) {
	int(sec, 'sec');
	return [
		'set -u',
		'b="${XDG_CACHE_HOME:-$HOME/.cache}"; mkdir -p "$b"',
		'd=$(mktemp -d "$b/qualify-impact.XXXXXX") || { echo "PROBE_FAILED mktemp"; exit 1; }',
		'trap \'rm -rf -- "$d"\' EXIT',
		'echo PROBE_BEGIN',
		`timeout -k 5 ${sec + 60} fio --output-format=json --name=root --filename="$d/r" --rw=randwrite` +
			` --bs=4k --size=128M --direct=1 --ioengine=psync --sync=dsync --time_based --runtime=${sec} 2>&1`,
		'echo; echo "PROBE_RC $?"',
		'echo PROBE_END',
	].join('\n');
}

/** PURE. The probe's p99, ms, or null. */
export function parseRootProbe(out) {
	const body = String(out ?? '').match(/^PROBE_BEGIN$([\s\S]*?)^PROBE_END$/m)?.[1] ?? '';
	if (Number(body.match(/^PROBE_RC (\d+)$/m)?.[1]) !== 0) return null;
	try {
		const job = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1))?.jobs?.[0];
		const ns = job?.error === 0 ? job.write?.clat_ns?.percentile?.['99.000000'] : null;
		return Number.isFinite(ns) ? Math.round(ns / 1e4) / 100 : null;
	} catch {
		// A torn document is "no reading": judgeLevel says so.
		return null;
	}
}

/** Starts the load on the zone, as root. Prints LOAD_DIR <dir> or LOAD_REFUSE <why>. */
export function loadStartScript({ dir, serial, writeMbps, readMbps, totalSec }) {
	if (!DIR_RE.test(dir)) throw new Error(`${JSON.stringify(dir)} is not a storage zone directory`);
	assertSerial(serial);
	for (const [k, v] of Object.entries({ writeMbps, readMbps, totalSec })) int(v, k);
	const writer = (file) =>
		// Direct, no fsync per block: Garage writes blocks without one
		// (GARAGE_DATA_FSYNC), and direct is that rate reaching the disk.
		`--name=resync --filename="$d/${file}" --rw=write --bs=1M --rate=${writeMbps}m ` +
		`${GARAGE_DATA_FSYNC ? '--fsync=1' : '--direct=1'} --size=${LOAD_FILE_MB}M`;
	return [
		"sudo -n sh -s <<'DISK_IMPACT_EOF'",
		'set -u',
		`t='${dir}'`,
		`serial='${serial}'`,
		'refuse() { echo "LOAD_REFUSE $*"; exit 3; }',
		'command -v fio >/dev/null 2>&1 || refuse "fio is not installed"',
		'src=$(findmnt -no SOURCE -T "$t") || refuse "findmnt could not place $t"',
		'pk=$(lsblk -nsro NAME,TYPE "$src" 2>/dev/null | awk \'$2 == "disk" { print $1; exit }\')',
		'got=$(lsblk -dno SERIAL "/dev/${pk:-none}" 2>/dev/null | sed "s/[[:space:]]*$//")',
		'[ -n "$pk" ] && [ "$got" = "$serial" ] || refuse "$t is on ${pk:-no disk} (serial ${got:-none}), not $serial"',
		'avail=$(df -Pm "$t" | awk \'NR==2{print $4}\')',
		`[ "\${avail:-0}" -ge ${4 * LOAD_FILE_MB} ] || refuse "$t has \${avail:-?} MiB free, the load needs ${4 * LOAD_FILE_MB}"`,
		'd=$(mktemp -d "$t/qualify-impact.XXXXXX") || refuse "mktemp failed in $t"',
		'cat > "$d/load.sh" <<\'LOAD_EOF\'',
		'd=$1',
		`timeout -k 5 ${LOAD_WARM_SEC} fio --output=/dev/null --ioengine=psync --time_based --runtime=${LOAD_WARM_SEC} ${writer('a')}`,
		'date +%s > "$d/phaseB"',
		'sz=$(stat -c %s "$d/a" 2>/dev/null || echo 0)',
		`[ "$sz" -ge 1048576 ] || { echo "the resync stream wrote $sz bytes" > "$d/failed"; exit 1; }`,
		`timeout -k 5 ${Math.max(1, totalSec - LOAD_WARM_SEC)} fio --output=/dev/null --ioengine=psync --time_based` +
			` --runtime=${Math.max(1, totalSec - LOAD_WARM_SEC)} ${writer('b')}` +
			` --name=scrub --filename="$d/a" --rw=read --bs=1M --rate=${readMbps}m --direct=1 --size="$sz"`,
		'date +%s > "$d/done"',
		'LOAD_EOF',
		'setsid nohup sh "$d/load.sh" "$d" >/dev/null 2>&1 </dev/null &',
		'echo $! > "$d/pid"',
		'echo "LOAD_DIR $d"',
		'DISK_IMPACT_EOF',
	].join('\n');
}

/** Stops the load in `dir` and removes it. Prints LOAD_STOPPED [failed: why]. */
export function loadStopScript(dir) {
	if (!LOAD_RE.test(dir)) throw new Error(`refusing an unexpected load dir ${JSON.stringify(dir)}`);
	return [
		"sudo -n sh -s <<'DISK_IMPACT_STOP_EOF'",
		`d='${dir}'`,
		'[ -d "$d" ] || { echo LOAD_STOPPED gone; exit 0; }',
		'p=$(cat "$d/pid" 2>/dev/null)',
		// The whole TREE under the load's own pid, never its process group:
		// GNU `timeout` moves itself and fio into a group of their own, so a
		// group kill stopped only load.sh and left fio writing at full rate
		// under the next level (claw-8, 2026-11-25). The pid is ours only while
		// its command line names this directory.
		'tree() { for c in $(pgrep -P "$1"); do tree "$c"; done; echo "$1"; }',
		'all=""',
		'case "$p" in ""|*[!0-9]*) ;; *) tr "\\0" " " < "/proc/$p/cmdline" 2>/dev/null | grep -qF "$d" && all=$(tree "$p") ;; esac',
		'if [ -n "$all" ]; then',
		'  kill -TERM $all 2>/dev/null; sleep 2',
		'  for x in $all; do kill -0 "$x" 2>/dev/null && kill -KILL "$x" 2>/dev/null; done; sleep 1',
		'  for x in $all; do kill -0 "$x" 2>/dev/null && { echo "LOAD_LEFT pid $x"; exit 1; }; done',
		'fi',
		'f=$(cat "$d/failed" 2>/dev/null)',
		'rm -rf -- "$d"',
		'[ -e "$d" ] && { echo "LOAD_LEFT $d"; exit 1; }',
		'echo "LOAD_STOPPED ${f:+failed: $f}"',
		'DISK_IMPACT_STOP_EOF',
	].join('\n');
}

const tail = (r) =>
	String(r?.error || r?.stderr || r?.stdout || '')
		.trim()
		.slice(-300);

/**
 * The test. `zoneDisks` as disk-bench's; `benchOf(serial)` the zone's last
 * bench reading or null; `ramp` the node's last concurrency-ramp metrics or
 * null (its `shape` and `steps[0].worstSec`).
 */
export function makeImpactTest({
	zoneDisks,
	benchOf,
	ramp,
	rootZoneDir,
	mountPointFor,
	sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
	return {
		id: 'disk-node-impact',
		track: 'qualify',
		needsDrain: true,
		runsAs: 'admin',
		ttlDays: QUALIFY_TTL_DAYS,
		minutes: 45 * Math.max(1, zoneDisks?.length ?? 1),
		touched: (r) => (r?.metrics?.disks ?? []).map((d) => d.serial).filter(Boolean),
		async run(ctx) {
			const shape = ramp?.shape;
			const baseSec = ramp?.steps?.[0]?.worstSec;
			if (!shape || !Number.isFinite(baseSec))
				return {
					status: 'could-not-look',
					reason: `${ctx.node} has no concurrency-ramp k=1 result to take its p75 unit and its time from; qualify it first`,
					metrics: {},
				};
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
				const reading = benchOf(t.serial);
				if (!reading) {
					disks.push({
						serial: t.serial,
						verdict: 'blocked',
						reason: `${t.serial} has no disk-bench reading to size Garage's load from; bench it first`,
					});
					continue;
				}
				const levels = [];
				for (const level of IMPACT_LEVELS) {
					const l = await runLevel(ctx, {
						t,
						level,
						load: loadAt(reading, level),
						shape,
						baseSec,
						alone: ramp.steps[0],
						sleep,
					});
					levels.push(l);
					ctx.log?.(
						`   ${t.serial} level ${level}: ${l.verdict}${l.reasons.length ? ` — ${l.reasons.join('; ')}` : ''}`
					);
					if (l.verdict !== 'crossed') break;
				}
				const r = impactResult(t.serial, levels);
				disks.push({ ...r, model: t.model, root: t.root, dir: t.dir });
			}
			const line = (v) =>
				disks
					.filter((d) => d.verdict === v)
					.map((d) => d.reason)
					.join(' | ');
			const metrics = { disks, baseUnitSec: baseSec };
			if (!disks.length) return { status: 'could-not-look', reason: 'nothing to soak', metrics };
			if (disks.some((d) => d.verdict === 'fail'))
				return { status: 'fail', reason: line('fail'), metrics };
			if (disks.some((d) => d.verdict === 'blocked'))
				return { status: 'could-not-look', reason: line('blocked'), metrics };
			return { status: 'pass', reason: line('pass'), metrics };
		},
	};
}

/** One level on one zone. The load is stopped on every path. */
async function runLevel(ctx, { t, level, load, shape, baseSec, alone, sleep }) {
	const out = (verdict, reasons, metrics = {}) => ({ level, load, verdict, reasons, metrics });
	const base = parseRootProbe((await ctx.exec(rootProbeScript(), { timeoutMs: 180_000 })).stdout);
	const unitTimeout = Math.ceil(baseSec * QUALIFY_BARS.durationRatio) + 30;
	const totalSec = LOAD_WARM_SEC + IMPACT_PROBE_SEC + unitTimeout + 180;
	const started = await ctx.exec(
		loadStartScript({
			dir: t.dir,
			serial: t.serial,
			...{ writeMbps: load.writeMbps, readMbps: load.readMbps },
			totalSec,
		}),
		{ timeoutMs: 120_000 }
	);
	const refused = String(started.stdout ?? '').match(/^LOAD_REFUSE (.+)$/m)?.[1];
	if (refused) return out('could-not-look', [`the load was refused on the node: ${refused}`]);
	const dir = String(started.stdout ?? '').match(/^LOAD_DIR (\S+)$/m)?.[1];
	if (!dir) return out('could-not-look', [`the load did not start: ${tail(started)}`]);
	let sampler = null;
	let stopped = null;
	const stop = async () => {
		const r = await ctx.exec(loadStopScript(dir), { timeoutMs: 60_000 });
		const o = String(r.stdout ?? '');
		return /^LOAD_STOPPED/m.test(o)
			? { ok: true, failed: o.match(/^LOAD_STOPPED failed: (.+)$/m)?.[1] ?? null }
			: { ok: false, why: tail(r) };
	};
	// A killed run stops the load before it undrains (qualify-abort.mjs).
	const unregister = onAbort(async () => {
		const s = await stop();
		if (!s.ok) throw new Error(`the load in ${dir} was not confirmed stopped: ${s.why}`);
	});
	try {
		await sleep((LOAD_WARM_SEC + 5) * 1000);
		sampler = await ctx.sample({ everySec: 5, maxMinutes: Math.ceil(totalSec / 60) + 5 });
		const loaded = parseRootProbe(
			(await ctx.exec(rootProbeScript(), { timeoutMs: 180_000 })).stdout
		);
		const emu = await ctx.exec(emulatorScript({ k: 1, shape, timeoutSec: unitTimeout }), {
			timeoutMs: (unitTimeout + 120) * 1000,
		});
		const rows = await sampler.stop();
		stopped = await stop();
		// A load that died early measured an unloaded node: that is no reading.
		if (stopped.ok && stopped.failed)
			return out('could-not-look', [`the Garage-shaped load stopped early: ${stopped.failed}`]);
		const run = parseEmulator(emu.stdout ?? '');
		const step = judgeStep({
			k: 1,
			samples: rows,
			run,
			baselineSec: baseSec,
			noDieTemperature: ctx.machine?.thermal?.noDieTemperature === true,
		});
		const j = judgeLevel({ step, samples: rows, rootP99Base: base, rootP99Load: loaded, alone });
		return out(j.verdict, j.reasons, j.metrics);
	} finally {
		if (sampler && !sampler.stopped) await sampler.stop().catch(() => []);
		stopped ??= await stop();
		unregister();
		if (!stopped.ok) ctx.log?.(`   ✗ the load in ${dir} was not confirmed stopped: ${stopped.why}`);
	}
}
