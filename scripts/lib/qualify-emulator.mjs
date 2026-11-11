/**
 * THE JOB EMULATOR behind `fleet qualify`'s concurrency ramp (wave bootcamp2
 * Q1): one unit of work shaped like a demanding CI job, so k of them side by
 * side load the node the way k such jobs would.
 *
 * WHY NOT REAL JOBS (measured 2026-11-11, plan "Q1 design decision"): only
 * hadoku-cardtable's forge.yml can be aimed at a node, forge.yml needs jdk21
 * (claw-1/claw-2 lack it), and prove-job's admission caps live JIT units at
 * the manifest maxConcurrent, so a ramp above today's limit is refused. An
 * unaimed dispatch would mostly measure lost races.
 *
 * WHAT A UNIT IS, FROM WHAT THE KERNEL MEASURED. Every job-completed hook
 * writes a row to its node's job-metrics.jsonl (job-metrics.sh): the job
 * cgroup's `cpuUsageUsec`, `peakBytes`, `ioWriteBytes`. The controller's
 * job-history has its `durationSec`. Joined by job id, a job's CPU RATE is
 * cpuSec / durationSec cores. Over every job of at least MIN_JOB_SEC, a unit
 * is, per dimension, the HARSHER of:
 *   - the FLEET's p75 job, so a node is rated on work the dispatcher could
 *     send it, not only on what routing happened to send. A node's own mix
 *     moves with its limit (a lower limit draws lighter jobs), and rating it on
 *     that alone would oscillate;
 *   - THIS NODE's own p75 job, because the claws that draw the forge jobs run
 *     a heavier mix (claw-9's p75 job is 3.75 cores against the fleet's 2.38,
 *     2026-11-11), and a fleet-only unit rated claw-9 fine at 4 jobs where
 *     its real CPU pressure was 38%.
 * Every unit in a step is that job, while a real day's concurrent jobs sit
 * mostly near the median: harsher than a normal day by construction, as the
 * operator asked, without pretending every job is heavy. Heavy jobs (p90
 * 4-7 cores) are kept apart by the dispatcher's heavy holds, not by
 * maxConcurrent; rating every node on them cut every 4-core claw to 1.
 *
 * FIXED WORK, NOT FIXED TIME. A unit hashes a fixed number of chunks per
 * worker, duty-cycled to the profile's rate, so alone it takes about
 * `UNIT_TARGET_SEC`; beside k-1 others it takes longer exactly as much as the
 * node is oversubscribed. Its wall time over the k=1 wall time is the
 * duration-ratio bar, measured rather than inferred.
 */

/** Jobs shorter than this are checkout-and-exit noise, not load. */
export const MIN_JOB_SEC = 60;
/** The percentile a unit is. */
export const UNIT_PERCENTILE = 0.75;
/** Fleet jobs a profile needs before it is a measurement and not an anecdote. */
export const MIN_FLEET_ROWS = 200;
/** This node's own jobs it needs before its own p75 counts; fewer, and the fleet's stands alone. */
export const MIN_NODE_ROWS = 50;
/** How far back the profile looks. */
export const PROFILE_DAYS = 30;
/** Roughly how long one unit runs alone. Long enough to heat a package; short enough for 6 steps. */
export const UNIT_TARGET_SEC = 360;
/** One hashing chunk, MiB. Small enough that a duty cycle is smooth. */
const CHUNK_MB = 64;

const q = (xs, f) => {
	const a = [...xs].sort((x, y) => x - y);
	return a.length ? a[Math.min(a.length - 1, Math.floor(f * (a.length - 1) + 0.5))] : null;
};

/** PURE. A node's job-metrics rows as `{cores, peakMb, writeMb}`, joined to job-history. */
function jobCosts(metrics, dur, since) {
	const out = [];
	for (const m of metrics) {
		if (!m?.jobId || !(Date.parse(m.ts) >= since)) continue;
		const d = dur.get(String(m.jobId));
		if (!(d >= MIN_JOB_SEC) || !(m.cpuUsageUsec > 0) || !(m.peakBytes > 0)) continue;
		out.push({
			cores: m.cpuUsageUsec / 1e6 / d,
			peakMb: m.peakBytes / 2 ** 20,
			writeMb: (m.ioWriteBytes ?? 0) / 2 ** 20,
		});
	}
	return out;
}

const p75 = (rows) => ({
	cores: q(
		rows.map((r) => r.cores),
		UNIT_PERCENTILE
	),
	peakMb: q(
		rows.map((r) => r.peakMb),
		UNIT_PERCENTILE
	),
	writeMb: q(
		rows.map((r) => r.writeMb),
		UNIT_PERCENTILE
	),
});

/**
 * PURE. The emulated job: the harsher of the fleet's p75 job and this node's.
 * `{ ok:false, reason }` when the fleet sample is too thin to call it a
 * measurement.
 *
 * @param {Record<string, object[]>} metricsByNode every node's job-metrics rows
 * @param {object[]} history the controller's job-history rows
 * @param {string} node the node being qualified
 * @param {number} nowMs
 */
export function jobProfile(metricsByNode, history, node, nowMs) {
	const since = nowMs - PROFILE_DAYS * 86_400_000;
	const dur = new Map();
	for (const h of history)
		if (h?.jobId && Number.isFinite(h.durationSec)) dur.set(String(h.jobId), h.durationSec);
	const byNode = Object.fromEntries(
		Object.entries(metricsByNode).map(([n, rows]) => [n, jobCosts(rows, dur, since)])
	);
	const fleetRows = Object.values(byNode).flat();
	if (fleetRows.length < MIN_FLEET_ROWS)
		return {
			ok: false,
			reason:
				`only ${fleetRows.length} job(s) of ≥ ${MIN_JOB_SEC} s in the last ${PROFILE_DAYS} d joined job-metrics ` +
				`to job-history across ${Object.keys(byNode).length} node(s); a profile needs ${MIN_FLEET_ROWS}`,
		};
	const fleet = p75(fleetRows);
	const ownRows = byNode[node] ?? [];
	const own = ownRows.length >= MIN_NODE_ROWS ? p75(ownRows) : null;
	const pick = (k) => Math.max(fleet[k], own?.[k] ?? 0);
	return {
		ok: true,
		fleetRows: fleetRows.length,
		nodeRows: ownRows.length,
		fleet,
		own,
		cores: Math.max(0.25, pick('cores')),
		peakMb: Math.ceil(pick('peakMb')),
		writeMb: Math.ceil(pick('writeMb')),
	};
}

/**
 * The unit's shape on a node whose single-thread hash speed is `hashMbPerSec`:
 * `workers` hashing threads at `duty` each (together the profile's cores), each
 * doing `chunks` chunks so the unit runs about UNIT_TARGET_SEC alone.
 */
export function unitShape(profile, hashMbPerSec) {
	const workers = Math.max(1, Math.ceil(profile.cores));
	const duty = Math.min(1, profile.cores / workers);
	const busySec = UNIT_TARGET_SEC * duty;
	const chunks = Math.max(1, Math.round((busySec * hashMbPerSec) / CHUNK_MB));
	return {
		workers,
		duty,
		chunks,
		chunkMb: CHUNK_MB,
		holdMb: profile.peakMb,
		writeMb: profile.writeMb,
	};
}

/** Measures one thread's hash rate on the node: prints `HASHRATE <MiB/s>`. */
export const HASH_RATE_SCRIPT = [
	's=$(date +%s%N)',
	`head -c ${CHUNK_MB * 4}M /dev/zero | sha512sum >/dev/null`,
	'e=$(date +%s%N)',
	`awk -v ns=$((e - s)) 'BEGIN{ printf "HASHRATE %.1f\\n", ${CHUNK_MB * 4} / (ns / 1e9) }'`,
].join('\n');

const int = (n, what) => {
	if (!Number.isInteger(n) || n < 0) throw new Error(`emulator: bad ${what} ${n}`);
	return n;
};

/**
 * Runs `k` units side by side in a scratch directory under the CI user's own
 * disk-backed cache (NOT /tmp, which is tmpfs on the claws: a write there is
 * RAM, not disk). Prints `UNIT <i> <wallMs> <exit> <timedOut 0|1>` per unit,
 * then `OOMKILL <before> <after>` from /proc/vmstat, then `EMU-END`.
 *
 * Each unit runs in its OWN SESSION (`setsid`), and a watchdog kills that
 * whole process group at `timeoutSec`: killing only the unit's shell would
 * leave its hashing workers and its `dd` orphaned and still loading the node.
 * A unit still running at the deadline has already failed its duration bar,
 * so waiting longer buys nothing.
 */
export function emulatorScript({ k, shape, timeoutSec }) {
	int(k, 'k');
	int(timeoutSec, 'timeoutSec');
	const { workers, chunks, chunkMb } = shape;
	int(workers, 'workers');
	int(chunks, 'chunks');
	const holdMb = int(Math.round(shape.holdMb), 'holdMb');
	const writeMb = int(Math.round(shape.writeMb), 'writeMb');
	const duty = Number(shape.duty);
	if (!(duty > 0 && duty <= 1)) throw new Error(`emulator: bad duty ${duty}`);
	return [
		'set -u',
		'root="${XDG_CACHE_HOME:-$HOME/.cache}/qualify-emu"',
		'mkdir -p "$root" && d=$(mktemp -d "$root/run.XXXXXX") || { echo "EMU-FAILED scratch"; exit 1; }',
		'trap \'rm -rf "$d"\' EXIT',
		'oom() { awk \'$1=="oom_kill"{print $2}\' /proc/vmstat 2>/dev/null || echo U; }',
		'o0=$(oom)',
		'echo "EMU-T0 $(date +%s)"',
		// One worker: hash a chunk, then sleep so its share of a core is `duty`.
		`worker() { i=0; while [ $i -lt ${chunks} ]; do s=$(date +%s%N); head -c ${chunkMb}M /dev/zero | sha512sum >/dev/null; e=$(date +%s%N);`,
		`  awk -v b=$((e - s)) -v d=${duty} 'BEGIN{ z = b / 1e9 * (1 - d) / d; if (z > 0.001) system("sleep " z) }'; i=$((i+1)); done; }`,
		// The unit: hold peak memory (touched, so it is resident), write its bytes
		// to disk with fdatasync, run its workers; its wall is the slowest part.
		'unit() {',
		`  python3 -c 'import time; b=bytearray(${holdMb}*1048576); [b.__setitem__(i,1) for i in range(0,len(b),4096)]; time.sleep(86400)' &`,
		'  hp=$!',
		'  s=$(date +%s%N)',
		`  dd if=/dev/zero of="$d/w.$1" bs=1M count=${writeMb} conv=fdatasync status=none 2>/dev/null &`,
		'  wp=$!',
		'  ws=""',
		`  j=0; while [ $j -lt ${workers} ]; do worker & ws="$ws $!"; j=$((j+1)); done`,
		'  wait $wp $ws',
		'  e=$(date +%s%N); kill $hp 2>/dev/null; rm -f "$d/w.$1"; echo "$(( (e - s) / 1000000 ))" > "$d/wall.$1"',
		'}',
		'run_unit() {',
		'  setsid bash -c "$(declare -f worker unit); d=\'$d\'; unit $1" &',
		'  p=$!',
		// The watchdog: its own output to /dev/null so it never holds the caller's
		// pipe open, and cancelled, it kills its own sleep (an orphaned sleep held
		// stdout and made every step last its whole timeout).
		`  ( trap 'kill $s 2>/dev/null; exit 0' TERM; sleep ${timeoutSec} & s=$!; wait $s; touch "$d/timedout.$1"; kill -TERM -- -$p 2>/dev/null; sleep 3; kill -KILL -- -$p 2>/dev/null ) >/dev/null 2>&1 &`,
		'  w=$!',
		'  wait $p; x=$?',
		'  kill $w 2>/dev/null',
		'  t=0; [ -e "$d/timedout.$1" ] && t=1',
		'  echo "UNIT $1 $(cat "$d/wall.$1" 2>/dev/null || echo 0) $x $t" > "$d/res.$1"',
		'}',
		`i=0; while [ $i -lt ${k} ]; do run_unit $i & i=$((i+1)); done`,
		'wait',
		`i=0; while [ $i -lt ${k} ]; do cat "$d/res.$i" 2>/dev/null || echo "UNIT $i 0 255 0"; i=$((i+1)); done`,
		'echo "EMU-T1 $(date +%s)"',
		'echo "OOMKILL $o0 $(oom)"',
		'echo EMU-END',
	].join('\n');
}

/**
 * PURE. `{ units: [{ wallSec, exit, timedOut }], oomKills: number|null, t0, t1, complete }`
 * (t0/t1: the step's start and end, node epoch seconds, matching the sampler's `at`).
 * `complete` is false without EMU-END: a step whose output was cut short is
 * not a measurement.
 */
export function parseEmulator(text) {
	const units = [];
	let oomKills = null;
	let t0 = null;
	let t1 = null;
	for (const line of String(text).split('\n')) {
		const p = line.trim().split(/\s+/);
		if (p[0] === 'UNIT' && p.length === 5)
			units.push({ wallSec: Number(p[2]) / 1000, exit: Number(p[3]), timedOut: p[4] === '1' });
		if (p[0] === 'EMU-T0') t0 = Number(p[1]);
		if (p[0] === 'EMU-T1') t1 = Number(p[1]);
		if (p[0] === 'OOMKILL' && p.length === 3 && /^\d+$/.test(p[1]) && /^\d+$/.test(p[2]))
			oomKills = Number(p[2]) - Number(p[1]);
	}
	return { units, oomKills, t0, t1, complete: /^EMU-END$/m.test(String(text)) };
}
