/**
 * THE PERFORMANCE PROBE: one script a node runs every 5 minutes, and the pure
 * parsers that turn its output, and a ping's, into a `PerfSampleRow`.
 *
 * Everything here is OBSERVED on the node, never read from a record the fleet
 * wrote: the default route's interface and its kernel counters, the radio's
 * signal, /proc/pressure (avg10 and avg300), the CI jobs running, /proc/loadavg, /proc/meminfo, /proc/diskstats for
 * the disk under `/`, the CPU sensor, and a 20-packet ping to the node's own
 * gateway (its link, apart from the controller's). The script is read-only
 * and costs the node ~4 s of an idle ping; nothing in it loads the disk or
 * the network enough to disturb CI.
 *
 * The disk under `/` is resolved through LVM, LUKS and partitions to the
 * whole disk (`lsblk -s`). btrfs reports its source as `device[/subvolume]`
 * (hokon), so the suffix is stripped first.
 *
 * WIRE FORMAT: `key=value` lines, ending `end=1`. A missing `end=1` is a torn
 * run and the whole probe is unreadable, never half a row. A key the node
 * could not read comes back empty and parses to null: unknown, not zero.
 *
 * The script reaches the node on STDIN (`bash -s`), so the same text runs over
 * ssh and on the controller itself with no quoting layer between them.
 */
import type { PerfSampleRow, PingStats, PsiReading } from './lib/perf-row.js';

/**
 * `ciw` prints how many CI jobs are running on the node, or NOTHING when it
 * cannot look. Through `sudo -n`: claw-1/2/3 mount /proc `hidepid=invisible`,
 * and the admin user these scripts run as cannot see ci's processes there, so
 * a plain `pgrep` counted 0 with jobs live (fleet-manager#69). Without sudo,
 * or without pgrep, it prints nothing, which parses to null: unknown, not 0.
 */
export const CI_WORKERS_FN = String.raw`ciw() { command -v pgrep >/dev/null 2>&1 && sudo -n true 2>/dev/null || return 0; sudo -n pgrep -ax Runner.Worker 2>/dev/null | grep -c " spawnclient "; }`;

export const PERF_PROBE_SCRIPT = String.raw`${CI_WORKERS_FN}
r=$(ip -o route show default 2>/dev/null | head -n1)
i=$(printf '%s\n' "$r" | awk '{for(k=1;k<NF;k++) if($k=="dev"){print $(k+1); exit}}')
g=$(printf '%s\n' "$r" | awk '{for(k=1;k<NF;k++) if($k=="via"){print $(k+1); exit}}')
echo "iface=$i"; echo "gw=$g"
echo "bootId=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)"
echo "uptime=$(cut -d' ' -f1 /proc/uptime 2>/dev/null)"
if [ -n "$i" ]; then
  if [ -d "/sys/class/net/$i/wireless" ] || [ -d "/sys/class/net/$i/phy80211" ]; then echo "kind=wifi"; else echo "kind=wired"; fi
  echo "speed=$(cat /sys/class/net/$i/speed 2>/dev/null)"
  echo "carrier=$(cat /sys/class/net/$i/carrier_changes 2>/dev/null)"
  for f in rx_bytes tx_bytes rx_errors tx_errors rx_dropped tx_dropped; do echo "$f=$(cat /sys/class/net/$i/statistics/$f 2>/dev/null)"; done
  if command -v iw >/dev/null 2>&1; then
    iw dev "$i" link 2>/dev/null | awk '/signal:/{print "signal="$2} /tx bitrate:/{print "txrate="$3}'
  fi
  awk -v i="$i:" '$1==i{gsub(/\./,"",$4); print "signalProc="$4}' /proc/net/wireless 2>/dev/null
fi
for p in cpu io memory; do
  [ -r /proc/pressure/$p ] && awk -v p=$p '{split($2,a,"="); split($4,b,"="); print "psi."p"."$1"="a[2]; print "psi300."p"."$1"="b[2]}' /proc/pressure/$p
done
echo "workers=$(ciw)"
echo "load=$(cut -d' ' -f1-3 /proc/loadavg)"; echo "cores=$(nproc)"
awk '/^MemTotal:/{print "memTotalKb="$2} /^MemAvailable:/{print "memAvailKb="$2} /^SwapTotal:/{st=$2} /^SwapFree:/{print "swapUsedKb="st-$2}' /proc/meminfo
s=$(findmnt -no SOURCE / 2>/dev/null)
s=$(printf '%s' "$s" | sed 's/\[.*//')
d=$(lsblk -s -n -r -o NAME,TYPE "$s" 2>/dev/null | awk '$2=="disk"{print $1; exit}')
echo "disk=$d"
[ -n "$d" ] && awk -v d="$d" '$3==d{print "diskstats="$4","$6","$7","$8","$10","$11","$13}' /proc/diskstats
echo "rootUsed=$(df --output=pcent / 2>/dev/null | tail -n1 | tr -dc 0-9)"
t=""; ts=""
for h in /sys/class/hwmon/hwmon*; do n=$(cat "$h/name" 2>/dev/null); case "$n" in coretemp|k10temp|zenpower|cpu_thermal) ts=$n; for f in "$h"/temp*_input; do [ -r "$f" ] && t="$t $(cat "$f")"; done;; esac; done
if [ -z "$t" ]; then ts=thermal_zone; for z in /sys/class/thermal/thermal_zone*/temp; do [ -r "$z" ] && t="$t $(cat "$z")"; done; fi
echo "tempMilli=$(printf '%s\n' $t | sort -n | tail -n1)"; echo "tempSensor=$ts"
[ -n "$g" ] && echo "gwping=$(ping -n -c 20 -i 0.2 -W 1 "$g" 2>/dev/null | awk -F'time=' '/time=/{split($2,a," "); printf "%s,", a[1]}')"
echo "end=1"
`;

/** Packets in one burst, from the node and from the controller alike. */
export const PING_COUNT = 20;

const num = (v: string | undefined): number | null => {
	if (v === undefined || v.trim() === '') return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};

const round = (n: number, places = 2): number => Math.round(n * 10 ** places) / 10 ** places;

/** Nearest-rank percentile of an ascending array. */
function percentile(sorted: readonly number[], p: number): number {
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** Stats for the reply times of one burst of `sent` packets, in arrival order. */
export function pingStats(target: string, timesMs: readonly number[], sent: number): PingStats {
	const sorted = [...timesMs].sort((a, b) => a - b);
	const diffs = timesMs.slice(1).map((t, k) => Math.abs(t - timesMs[k]));
	const has = sorted.length > 0;
	return {
		target,
		sent,
		received: timesMs.length,
		minMs: has ? round(sorted[0]) : null,
		p50Ms: has ? round(percentile(sorted, 50)) : null,
		p95Ms: has ? round(percentile(sorted, 95)) : null,
		maxMs: has ? round(sorted[sorted.length - 1]) : null,
		jitterMs: diffs.length ? round(diffs.reduce((a, b) => a + b, 0) / diffs.length) : null,
	};
}

/** Reply times from `ping`'s own output (`... time=2.83 ms`), in arrival order. */
export function pingTimesOf(pingOutput: string): number[] {
	return [...String(pingOutput).matchAll(/time=([\d.]+)/g)]
		.map((m) => Number(m[1]))
		.filter(Number.isFinite);
}

/** The node-side half of a row, or `{ why }` when the output is not a whole probe. */
export function parsePerfProbe(
	stdout: string
):
	| { ok: true; fields: Omit<PerfSampleRow, 'v' | 'at' | 'node' | 'ok' | 'lan'> }
	| { ok: false; why: string } {
	const kv = new Map<string, string>();
	for (const line of String(stdout).split('\n')) {
		const eq = line.indexOf('=');
		if (eq > 0) kv.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
	}
	if (kv.get('end') !== '1') return { ok: false, why: 'the probe did not finish (no end marker)' };
	const kind = kv.get('kind');
	const signal = num(kv.get('signal')) ?? num(kv.get('signalProc'));
	const [one, five, fifteen] = (kv.get('load') ?? '').split(/\s+/);
	const ds = (kv.get('diskstats') ?? '').split(',');
	const dsAt = (k: number) => (ds.length === 7 ? num(ds[k]) : null);
	const kb = (k: string) => {
		const v = num(kv.get(k));
		return v === null ? null : Math.round(v / 1024);
	};
	const psiAt = (prefix: 'psi' | 'psi300'): PsiReading => ({
		cpuSome: num(kv.get(`${prefix}.cpu.some`)),
		ioSome: num(kv.get(`${prefix}.io.some`)),
		ioFull: num(kv.get(`${prefix}.io.full`)),
		memorySome: num(kv.get(`${prefix}.memory.some`)),
		memoryFull: num(kv.get(`${prefix}.memory.full`)),
	});
	const temp = num(kv.get('tempMilli'));
	const gw = kv.get('gw') || null;
	const gwTimes = (kv.get('gwping') ?? '')
		.split(',')
		.filter(Boolean)
		.map(Number)
		.filter(Number.isFinite);
	return {
		ok: true,
		fields: {
			bootId: kv.get('bootId') || null,
			uptimeSec: num(kv.get('uptime')),
			link: {
				iface: kv.get('iface') || null,
				kind: kind === 'wifi' || kind === 'wired' ? kind : null,
				// The kernel reports -1 (or nothing) for a link with no negotiated speed.
				speedMbps: (() => {
					const s = num(kv.get('speed'));
					return s !== null && s > 0 ? s : null;
				})(),
				carrierChanges: num(kv.get('carrier')),
				rxBytes: num(kv.get('rx_bytes')),
				txBytes: num(kv.get('tx_bytes')),
				rxErrors: num(kv.get('rx_errors')),
				txErrors: num(kv.get('tx_errors')),
				rxDropped: num(kv.get('rx_dropped')),
				txDropped: num(kv.get('tx_dropped')),
				wifi: kind === 'wifi' ? { signalDbm: signal, txBitrateMbps: num(kv.get('txrate')) } : null,
			},
			gateway: gw ? pingStats(gw, gwTimes, PING_COUNT) : null,
			psi: psiAt('psi'),
			psi300: psiAt('psi300'),
			workers: num(kv.get('workers')),
			load: { one: num(one), five: num(five), fifteen: num(fifteen), cores: num(kv.get('cores')) },
			memory: {
				totalMb: kb('memTotalKb'),
				availableMb: kb('memAvailKb'),
				swapUsedMb: kb('swapUsedKb'),
			},
			disk: {
				device: kv.get('disk') || null,
				reads: dsAt(0),
				readSectors: dsAt(1),
				readMs: dsAt(2),
				writes: dsAt(3),
				writeSectors: dsAt(4),
				writeMs: dsAt(5),
				ioMs: dsAt(6),
				rootUsedPct: num(kv.get('rootUsed')),
			},
			cpuTempC: temp === null ? null : round(temp / 1000, 1),
			cpuTempSensor: kv.get('tempSensor') || null,
		},
	};
}
