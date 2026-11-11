/**
 * `fleet qualify`'s node-side SAMPLER: what the node looked like, every few
 * seconds, while a qualification test loaded it.
 *
 * One tick is:
 *   S <epochSec> cpu10=<%> cpu300=<%> io10=<%> mem10=<%> workers=<n|U> throttle=<n|U>
 *   T <sensor key> <millidegrees>        (one per sensor; doctor's own keys)
 *   E
 * PSI is `/proc/pressure/*` `some`; `workers` is the live `Runner.Worker` count
 * as the CI role sees it (jobs run as `ci`, so hidepid does not hide them);
 * `throttle` is the summed core throttle count, read through doctor's own
 * `throttles` (doctor-probe.mjs), as are the sensors, so a qualification and a
 * doctor run agree on what a key means. `cpuSensor` (doctor-parse.mjs) picks the
 * die from the keys.
 *
 * A value the node could not read is `U`, parsed as null, never 0: "the sensor
 * was unreadable" is not "the CPU was idle".
 *
 * LIFETIME. The loop runs under `setsid nohup` so it outlives the ssh session
 * that started it, writes only inside its own `mktemp -d` directory, records
 * its pid there, and ends when stopped (the stop KILLS that pid and waits for
 * it), when its directory disappears, or after `maxMinutes` whatever happens,
 * so a qualification that dies mid-window cannot leave a sampler running.
 */
import { SENSORS_SH, THROTTLES_SH } from './doctor-probe.mjs';

const LOOP_MARK = 'QUALIFY_SAMPLER_LOOP';

/**
 * The script that STARTS the sampler. Prints `SAMPLER <dir>` on success.
 *
 * @param {{ everySec?: number, maxMinutes?: number }} [o]
 */
export function startSamplerScript({ everySec = 5, maxMinutes = 180 } = {}) {
	if (!Number.isInteger(everySec) || everySec < 1) throw new Error(`bad everySec ${everySec}`);
	if (!Number.isInteger(maxMinutes) || maxMinutes < 1)
		throw new Error(`bad maxMinutes ${maxMinutes}`);
	return [
		'set -u',
		'd=$(mktemp -d "${TMPDIR:-/tmp}/qualify-sample.XXXXXX") || { echo "SAMPLER-FAILED mktemp"; exit 1; }',
		`cat > "$d/loop.sh" <<'${LOOP_MARK}'`,
		SENSORS_SH,
		THROTTLES_SH,
		// `some avg10=1.23 avg60=… avg300=…` → the field asked for, or U.
		'psi() { f=/proc/pressure/$1; [ -r "$f" ] || { echo U; return; }; v=$(awk -v k="$2=" \'$1=="some"{for(i=2;i<=NF;i++) if(index($i,k)==1){print substr($i,length(k)+1); exit}}\' "$f"); echo "${v:-U}"; }',
		// `pgrep -c` prints 0 AND exits 1 when nothing matches: take its output,
		// never `|| echo 0`, which printed "0\n0" and broke the tick line.
		'workers() { command -v pgrep >/dev/null 2>&1 || { echo U; return; }; n=$(pgrep -c -f "[R]unner.Worker" 2>/dev/null); case "$n" in ""|*[!0-9]*) echo U ;; *) echo "$n" ;; esac; }',
		'echo $$ > "$1/pid"',
		'end=$(( $(date +%s) + $3 * 60 ))',
		// The directory itself is a condition too: a stop that removed it while
		// this loop slept must not leave it sampling (claw-5, 2026-11-11).
		'while [ -d "$1" ] && [ ! -e "$1/stop" ] && [ "$(date +%s)" -lt "$end" ]; do',
		'  { printf "S %s cpu10=%s cpu300=%s io10=%s mem10=%s workers=%s throttle=%s\\n" "$(date +%s)" "$(psi cpu avg10)" "$(psi cpu avg300)" "$(psi io avg10)" "$(psi memory avg10)" "$(workers)" "$(throttles 2>/dev/null || echo U)"',
		'    sensors 2>/dev/null | while read -r k v; do printf "T %s %s\\n" "$k" "$v"; done',
		'    echo E; } >> "$1/samples"',
		'  sleep "$2"',
		'done',
		LOOP_MARK,
		`setsid nohup bash "$d/loop.sh" "$d" ${everySec} ${maxMinutes} >/dev/null 2>&1 < /dev/null &`,
		'echo "SAMPLER $d"',
	].join('\n');
}

const SAFE_DIR = /^\/[A-Za-z0-9._/-]*qualify-sample\.[A-Za-z0-9]+$/;

/** The script that STOPS the sampler in `dir`, prints its samples, and removes it. */
export function stopSamplerScript(dir) {
	if (!SAFE_DIR.test(dir))
		throw new Error(`refusing an unexpected sampler dir ${JSON.stringify(dir)}`);
	return [
		`d='${dir}'`,
		'[ -d "$d" ] || { echo "SAMPLER-GONE"; exit 0; }',
		'touch "$d/stop"',
		// END THE LOOP, then read: the sentinel alone is not enough for a loop
		// asleep in a long tick. A tick cut short by the kill has no `E` and is
		// dropped by parseSamples.
		'p=$(cat "$d/pid" 2>/dev/null)',
		'case "$p" in ""|*[!0-9]*) ;; *) kill "$p" 2>/dev/null; i=0; while kill -0 "$p" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done ;; esac',
		'cat "$d/samples" 2>/dev/null',
		'echo SAMPLER-END',
		'rm -rf "$d"',
	].join('\n');
}

const num = (v) =>
	v === undefined || v === 'U' || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;

/**
 * PURE. The sampler's output as rows. A tick cut short (no `E`) is dropped:
 * half a tick is not a reading.
 *
 * @param {string} text
 * @returns {{ at: number, cpuSome10: number|null, cpuSome300: number|null, ioSome10: number|null,
 *   memSome10: number|null, workers: number|null, throttle: number|null, temps: Record<string, number> }[]}
 */
export function parseSamples(text) {
	const rows = [];
	let cur = null;
	for (const line of String(text).split('\n')) {
		const [tag, ...rest] = line.trim().split(/\s+/);
		if (tag === 'S') {
			const f = Object.fromEntries(rest.slice(1).map((kv) => kv.split('=')));
			cur = {
				at: Number(rest[0]),
				cpuSome10: num(f.cpu10),
				cpuSome300: num(f.cpu300),
				ioSome10: num(f.io10),
				memSome10: num(f.mem10),
				workers: num(f.workers),
				throttle: num(f.throttle),
				temps: {},
			};
		} else if (tag === 'T' && cur && rest.length === 2) {
			const v = num(rest[1]);
			if (v !== null) cur.temps[rest[0]] = v / 1000;
		} else if (tag === 'E' && cur) {
			if (Number.isFinite(cur.at)) rows.push(cur);
			cur = null;
		}
	}
	return rows;
}
