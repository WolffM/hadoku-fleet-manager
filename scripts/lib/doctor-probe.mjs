import { WIFI_MANAGER_PROBE } from './node-interfaces.mjs';
import { EFFECTIVE_MEMORY_MAX_SH } from './cgroup-ceiling.mjs';

/** Seconds of all-core load the thermal reading is taken under. Fixed, by §H. */
export const LOAD_SECONDS = 60;

/**
 * A `~`-relative path this file will embed, UNQUOTED user data, into a remote
 * shell command (`doctorProbe`'s `seedCachePaths`). Deliberately strict: only
 * `~/`, then letters, digits, `.`, `_`, `/` and `-`. No spaces, no quotes, no
 * `$`, no `;` — nothing a shell would treat as anything other than a literal
 * path segment. A manifest value that does not match this is DROPPED, never
 * "best-effort" embedded; see `doctorProbe`'s own `seedCachePaths` doc.
 */
export const SAFE_CACHE_PATH = /^~\/[A-Za-z0-9._/-]+$/;

// ═══════════════════════════════════════════════════════════════════════════
// THE NODE-HALF PROBE
// ═══════════════════════════════════════════════════════════════════════════

/** Why an operator's `--no-load` run carries no under-load reading. */
export const NO_LOAD_WHY =
	'the load phase was disabled with --no-load, so no under-load temperature was taken';

/**
 * Why a `--cadence` run carries no under-load reading for the backstop.
 *
 * hokon is the backstop and the production host. Probing it is in scope, but a
 * nightly 60s all-core load on the box serving production is not. Its findings are advisory anyway, so the
 * missing reading costs no verdict. A hand-run `fleet doctor` still loads it.
 */
export const BACKSTOP_CADENCE_NO_LOAD_WHY =
	'a scheduled (--cadence) run never loads the backstop, which is the production host; run fleet doctor by hand for its under-load temperature';

/**
 * The shell the node runs. Emits a line protocol and decides nothing.
 *
 *   `DOCTOR-BEGIN v1` … `DOCTOR-END <host>`   sentinels
 *   `D <key> <value>`                          a fact
 *   `U <key> <reason>`                         I could not look, and why
 *   `S <line>`                                 one raw line of smartctl output
 *   `WMGR …`                                   {@link WIFI_MANAGER_PROBE}'s own
 *
 * A run without `DOCTOR-END` is SILENCE, not an empty result — same rule
 * `bootcamp.mjs` applies to `PROBE-END` and `parseSummary` applies to its
 * `SUMMARY` line. A node that died halfway through prints plenty and finishes
 * nothing, and reading that as "nothing to report" is how an audit goes green
 * on a box it never finished talking to.
 *
 * SENSOR KEYS ARE EMITTED ONCE AND REUSED. `sensors()` is defined in the shell
 * and called for the idle reading and for every sample during the load, so
 * `idle.<key>` and `peak.<key>` are guaranteed to be the SAME physical sensor.
 * Picking the die sensor on the control side (see {@link cpuSensor}) would be
 * worthless if the two halves could disagree about which sensor that was.
 *
 * @param {{loadSeconds?: number, force?: boolean, seedCachePaths?: string[], noLoadWhy?: string}} [opts]
 *   `loadSeconds: 0` disables the load phase and says so as an `unknown`.
 *   `force` loads the box even while CI is building on it.
 *   `seedCachePaths`: `~`-relative paths (wave 4c §E's manifest `$seeds[*].cache`
 *     / `$seeds[*][*].cache`) to size alongside the other known consumers. A
 *     path that does not match {@link SAFE_CACHE_PATH} is silently dropped
 *     here — never embedded into the remote shell unvalidated. The caller is
 *     responsible for deriving this from the manifest; this file only
 *     validates what it is handed.
 */
export function doctorProbe({
	loadSeconds = LOAD_SECONDS,
	force = false,
	seedCachePaths = [],
	noLoadWhy = NO_LOAD_WHY,
} = {}) {
	const secs = Number.isFinite(loadSeconds) && loadSeconds > 0 ? Math.floor(loadSeconds) : 0;
	// Embedded in a remote shell line inside double quotes, so nothing that
	// shell would expand may reach it.
	if (!/^[\w\s.,;:()'-]+$/.test(noLoadWhy))
		throw new Error(`doctorProbe: unsafe noLoadWhy ${noLoadWhy}`);
	return [
		'set -u',
		// A value may be empty (a grep that matched nothing); `say` refuses it so
		// an empty string can never masquerade as a measurement.
		'say() { if [ -n "${2:-}" ]; then printf "D %s %s\\n" "$1" "$2"; else printf "U %s %s\\n" "$1" "the node produced no value for this"; fi; }',
		'unk() { printf "U %s %s\\n" "$1" "$2"; }',
		'if [ "$(id -u)" = 0 ]; then SUDO=""; else SUDO="sudo -n"; fi',
		'if $SUDO true 2>/dev/null; then ROOTOK=yes; else ROOTOK=no; fi',
		'echo "DOCTOR-BEGIN v1"',
		'say schema 1',
		'say hostname "$(cat /proc/sys/kernel/hostname 2>/dev/null)"',
		'say product "$(cat /sys/class/dmi/id/product_name 2>/dev/null)"',
		'say kernel "$(uname -r)"',
		'say startedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
		'say uptimeSec "$(cut -d" " -f1 /proc/uptime | cut -d. -f1)"',
		'say cores "$(grep -c ^processor /proc/cpuinfo)"',
		'say load1 "$(cut -d" " -f1 /proc/loadavg)"',
		'say rootElevation "$ROOTOK"',
		// ── every temperature sensor, named, emitted by ONE function ──────────
		'sensors() {',
		'  i=0',
		'  for z in /sys/class/thermal/thermal_zone*/; do',
		'    [ -r "$z/temp" ] || continue',
		'    printf "zone.%s.%s %s\\n" "$i" "$(cat "$z/type" 2>/dev/null)" "$(cat "$z/temp" 2>/dev/null)"',
		'    i=$((i+1))',
		'  done',
		'  i=0',
		// ITERATE `temp*_input`, NOT `temp*_label`. A label is optional and the
		// sensor that matters most here does not have one: claw-5 is an FX-8350
		// whose `k10temp` exposes `temp1_input` with NO `temp1_label`, so a
		// label-driven loop found zero sensors on it and `fleet doctor` reported
		// "no readable sensor under /sys/class/thermal or /sys/class/hwmon" on a
		// box whose die temperature was sitting there in sysfs. The reading is the
		// thing that exists; the label is how it is spelled.
		'  for h in /sys/class/hwmon/hwmon*; do',
		'    n=$(cat "$h/name" 2>/dev/null || echo unnamed)',
		'    for f in "$h"/temp*_input; do',
		'      [ -r "$f" ] || continue',
		'      v=$(cat "$f" 2>/dev/null) || continue',
		'      [ -n "$v" ] || continue',
		'      b=$(basename "$f" _input)',
		'      if [ -r "${f%_input}_label" ]; then l=$(tr " " "_" < "${f%_input}_label"); else l="$b"; fi',
		'      printf "hwmon.%s.%s.%s %s\\n" "$i" "$n" "${l:-$b}" "$v"',
		'    done',
		'    i=$((i+1))',
		'  done',
		'}',
		'throttles() { t=0; for c in /sys/devices/system/cpu/cpu*/thermal_throttle/core_throttle_count; do [ -r "$c" ] || continue; t=$((t + $(cat "$c" 2>/dev/null || echo 0))); done; echo "$t"; }',
		'SENSED=0',
		'while read -r k v; do printf "D idle.%s %s\\n" "$k" "$v"; SENSED=$((SENSED+1)); done < <(sensors)',
		'[ "$SENSED" -gt 0 ] || unk idle.sensors "no readable sensor under /sys/class/thermal or /sys/class/hwmon"',
		'say idle.throttleCount "$(throttles)"',
		// ── watchdog: what it will do about load, and what sensor it watches ──
		'say watchdog.active "$(systemctl is-active watchdog 2>/dev/null)"',
		'say watchdog.enabled "$(systemctl is-enabled watchdog 2>/dev/null)"',
		'say watchdog.keepalive "$(systemctl is-active wd_keepalive 2>/dev/null)"',
		'if [ -r /etc/watchdog.conf ]; then',
		'  WDL=$(grep -E "^[[:space:]]*max-load-(1|5|15)[[:space:]]*=" /etc/watchdog.conf | tr -d " " | paste -sd, -)',
		'  say watchdog.loadTrigger "${WDL:-none}"',
		'  WDS=$(grep -E "^[[:space:]]*temperature-sensor" /etc/watchdog.conf | tr -d " " | cut -d= -f2)',
		'  if [ -n "$WDS" ]; then say watchdog.sensorPath "$WDS"; say watchdog.sensorMilliC "$(cat "$WDS" 2>/dev/null)"; else unk watchdog.sensorPath "watchdog.conf names no temperature-sensor"; fi',
		'else unk watchdog.conf "/etc/watchdog.conf is not readable"; fi',
		'say crashes "$(last -x reboot 2>/dev/null | grep -c crash)"',
		// ── root filesystem and the physical device behind it ─────────────────
		'say disk.root.fs "$(findmnt -no FSTYPE --target / 2>/dev/null)"',
		'say disk.root.totalKb "$(df -P / | awk "NR==2{print \\$2}")"',
		'say disk.root.availKb "$(df -P / | awk "NR==2{print \\$4}")"',
		'say disk.root.usePct "$(df -P / | awk "NR==2{gsub(/%/,\\"\\",\\$5);print \\$5}")"',
		'say mem.totalKb "$(awk "/^MemTotal:/{print \\$2}" /proc/meminfo)"',
		'say mem.availKb "$(awk "/^MemAvailable:/{print \\$2}" /proc/meminfo)"',
		'RSRC=$(findmnt -no SOURCE --target / 2>/dev/null | sed "s/\\[.*\\]//")',
		'RDEV=$(lsblk -rnso NAME,TYPE "$RSRC" 2>/dev/null | awk "\\$2==\\"disk\\"{print \\$1}" | tail -1)',
		'if [ -n "$RDEV" ]; then say disk.root.device "$RDEV"; else unk disk.root.device "could not resolve a physical device behind ${RSRC:-an unreadable root source}"; fi',
		// ── the `_work` filesystem — wave 4c §F, the operator's disk ask ──────
		//
		// The SAME directory `ephemeral-tick.ts`'s own space probe targets
		// (`~/.hadoku/jit`, falling back to `~/.hadoku` then `$HOME` — a node that
		// has never minted has no `jit` directory yet, and that absence is not
		// "unreadable"). Reported here as DATA, never a gate — `disk-watch.ts`
		// owns the early-warning judgement on this same filesystem, on its own
		// absolute-GB lines; doctor still judges `/` on the existing percentage
		// rule and, below, judges `_work` the same way ONLY when it is a
		// genuinely DIFFERENT filesystem from `/` — on most of this fleet today
		// it is the same device, and double-reporting one full disk as two
		// findings would be noise, not signal.
		// ONE spelling of the node's fleet directory in this probe — same move,
		// same reason, as `ci-throttle-install.sh`'s and `clean-runner-debris.sh`'s
		// own `NODE_DIR` (ecosystem-literals.test.mjs's WAVE 4B LANE C entry): a
		// script running ON a node must name it once and cannot resolve it from
		// the controller's environment, because there is no controller
		// environment to read at the point this probe runs.
		'NODE_DIR="$HOME/.hadoku"',
		'WORKDIR="$NODE_DIR/jit"',
		'[ -d "$WORKDIR" ] || WORKDIR="$NODE_DIR"',
		'[ -d "$WORKDIR" ] || WORKDIR="$HOME"',
		'say disk.work.fs "$(findmnt -no FSTYPE --target "$WORKDIR" 2>/dev/null)"',
		'say disk.work.totalKb "$(df -P "$WORKDIR" | awk "NR==2{print \\$2}")"',
		'say disk.work.availKb "$(df -P "$WORKDIR" | awk "NR==2{print \\$4}")"',
		// THREE-STATE, not yes/no: `$RSRC`/`$WSRC` unreadable must read as
		// "unknown", never collapse into "different" — that would draw a second
		// disk-free finding for a disk doctor never actually distinguished from
		// root.
		'WSRC=$(findmnt -no SOURCE --target "$WORKDIR" 2>/dev/null)',
		'if [ -z "$WSRC" ] || [ -z "$RSRC" ]; then say disk.work.sameAsRoot unknown',
		'elif [ "$WSRC" = "$RSRC" ]; then say disk.work.sameAsRoot yes',
		'else say disk.work.sameAsRoot no; fi',
		// ── where the space went: the known large consumers, read-only `du -sk`
		//
		// `sizeKb` reports 0 for a directory that does not exist — a node that
		// never earned a capability, never minted, or never built a pnpm package
		// has no cache for it, and that is a fact about the node, not a read
		// failure. It only emits `U` (via `say`'s own empty-string rule) if `du`
		// itself produced nothing for a directory that DOES exist, which is the
		// actual "could not look" case.
		'sizeKb() { if [ -d "$1" ]; then command du -sk "$1" 2>/dev/null | tail -1 | cut -f1; else echo 0; fi; }',
		'say consumer.jitKb "$(sizeKb "$NODE_DIR/jit")"',
		'say consumer.warmKb "$(sizeKb "$NODE_DIR/warm")"',
		'say consumer.cacheKb "$(sizeKb "$HOME/.cache")"',
		// NEVER TRUST `pnpm store path` ALONE — `pnpm-store-doctor.sh` already
		// measured it reporting `.../store/v10` while `v11` is the store actually
		// in use on this fleet. Same resolution that script uses: look for what
		// EXISTS beside the reported path, newest version first.
		'PSTORE_REPORTED=$(pnpm store path 2>/dev/null | tail -1)',
		'PSTORE=""',
		'if [ -n "$PSTORE_REPORTED" ] && [ -d "$PSTORE_REPORTED" ]; then',
		'  PSTORE="$PSTORE_REPORTED"',
		'elif [ -n "$PSTORE_REPORTED" ]; then',
		'  PROOT="${PSTORE_REPORTED%/*}"',
		'  for cand in $(ls -d "$PROOT"/v* 2>/dev/null | sort -V -r); do [ -d "$cand/files" ] && PSTORE="$cand" && break; done',
		'fi',
		'if [ -n "$PSTORE" ]; then say consumer.pnpmStoreKb "$(sizeKb "$PSTORE")"; else unk consumer.pnpmStoreKb "pnpm store path produced nothing this run could resolve to an existing directory"; fi',
		// Seed caches (wave 4c §E): one `D`/`U` line per DECLARED cache path, keyed
		// by the path itself so a reader never has to re-derive which capability it
		// belonged to from an index. Absent `seedCachePaths` emits nothing — no
		// `$seeds` in the manifest is "no seed caches", never an error.
		...seedCachePaths
			.filter((p) => SAFE_CACHE_PATH.test(p))
			.map((p) => `say 'consumer.seed|${p}' "$(sizeKb "$HOME/${p.slice(2)}")"`),
		// ── SMART, from the drive's firmware, with the reason when it cannot ──
		// Scoped to the ROOT device on purpose. claw-4 carries four empty USB
		// card-reader slots (sdc..sdf) that answer "Unknown USB bridge" forever;
		// a per-/sys/block sweep would emit four permanent unreadable findings
		// per run on a node whose actual disks are both fine, which is how a
		// findings list stops being read.
		'if [ -z "$RDEV" ]; then unk smart "the root block device could not be resolved, so no drive was queried"',
		'elif [ ! -x /usr/sbin/smartctl ]; then unk smart "smartctl is not installed on this node (/usr/sbin/smartctl absent); it is in both node profiles toolchain.packages"',
		'elif [ "$ROOTOK" != yes ]; then unk smart "reading SMART needs root and sudo -n was refused on this node"',
		'else',
		'  say smart.device "$RDEV"',
		'  SOUT=$($SUDO /usr/sbin/smartctl -H -A "/dev/$RDEV" 2>&1)',
		'  if [ -n "$SOUT" ]; then printf "%s\\n" "$SOUT" | sed "s/^/S /"; else unk smart "smartctl produced no output at all for /dev/$RDEV"; fi',
		'fi',
		// ── staged reboot. Same file and shape `preflight.mjs` already judges. ─
		'if [ -f /var/run/reboot-required ]; then',
		'  say reboot.required yes',
		'  say reboot.stagedAtEpoch "$(stat -c %Y /var/run/reboot-required 2>/dev/null)"',
		'  if [ -f /var/run/reboot-required.pkgs ]; then say reboot.packages "$(tr "\\n" "," < /var/run/reboot-required.pkgs | sed "s/,$//")"; fi',
		'else say reboot.required no; fi',
		// ── CI registrations, and whether this box is working right now ───────
		'say runners.registered "$(systemctl list-units "actions.runner.*" --no-pager --plain 2>/dev/null | grep -c running)"',
		'say runners.failed "$(systemctl list-units "actions.runner.*" --state=failed --no-pager --plain 2>/dev/null | grep -c failed)"',
		'BUSY=$(pgrep -c -f "[R]unner\\.Worker" 2>/dev/null | head -1)',
		'BUSY=${BUSY:-0}',
		'say runners.busy "$BUSY"',
		// ── every failed system unit, and since when ──────────────────────────
		//
		// Not just `actions.runner.*`. claw-5 and claw-6 failed
		// systemd-networkd-wait-online on EVERY boot from their 2026-08-31/09-01
		// install until 10-27 — a preseed-era networkd config for a radio neither
		// box has, costing each boot two minutes — and `fleet benchmark` printed
		// `failed units: 1` for claw-6 on 10-04 without anything turning it into
		// a finding. The timestamp is what tells a leftover from something new.
		// A COUNTED zero is emitted as 0; a systemctl that cannot list is `U`.
		'if FU=$(systemctl list-units --state=failed --no-legend --no-pager --plain 2>/dev/null); then',
		'  say failedUnits.count "$(printf "%s\\n" "$FU" | grep -c .)"',
		'  for u in $(printf "%s\\n" "$FU" | awk "NF{print \\$1}"); do',
		'    say "failedUnit.$u" "$(systemctl show -P StateChangeTimestamp --timestamp=unix "$u" 2>/dev/null | tr -d @)"',
		'  done',
		'else unk failedUnits "systemctl could not list this node\'s units"; fi',
		// ── the default-route NIC: link speed and flaps this boot ─────────────
		//
		// 2026-11-03: claw-4's NIC dropped its link 633 times in 1h43m, each time
		// renegotiating at 100 Mbps (a damaged cable: gigabit needs all four
		// pairs), and the node was off the network with two services on it.
		// Nothing read either number. Speed is the kernel's own; a Wi-Fi link has
		// none worth judging, so only `kind` is said for it. The flap count is
		// this boot's kernel journal, matched on the interface's name.
		'NIC=$(ip -o route show default 2>/dev/null | awk "{print \\$5; exit}")',
		'if [ -n "$NIC" ]; then',
		'  say nic.iface "$NIC"',
		'  if [ -d "/sys/class/net/$NIC/wireless" ]; then say nic.kind wifi; else say nic.kind wired; fi',
		'  SP=$(cat "/sys/class/net/$NIC/speed" 2>/dev/null)',
		'  case "$SP" in ""|-*) unk nic.speedMbps "the kernel reports no link speed for $NIC";; *) say nic.speedMbps "$SP";; esac',
		'  if KL=$(journalctl -k -b --no-pager -o cat 2>/dev/null); then',
		'    say nic.linkDowns "$(printf "%s\\n" "$KL" | grep -c "$NIC.*Link is Down")"',
		'  else unk nic.linkDowns "this boot\'s kernel journal could not be read"; fi',
		'else unk nic "no default route"; fi',
		// ── every pm2 manager, its ceiling and how many apps it runs ─────────────
		//
		// Claimed against the tenant registry and the app layer's host list by
		// doctor-run (lib/hosting-claims.mjs); the node only measures. The app
		// count is the daemon's direct children, from the kernel: pm2's own list
		// also carries stopped apps, and an "idle" manager is one RUNNING none.
		// The ceiling is the EFFECTIVE one (lib/cgroup-ceiling.mjs): a tenant's
		// pm2 is bounded by its hosting slice, not by its own unit file.
		EFFECTIVE_MEMORY_MAX_SH,
		"if PU=$(systemctl list-units --no-legend --plain 'pm2-*.service' 2>/dev/null); then",
		'  say pm2Units.count "$(printf "%s\\n" "$PU" | grep -c .)"',
		'  for u in $(printf "%s\\n" "$PU" | awk "NF{print \\$1}"); do',
		'    cg=$(systemctl show -P ControlGroup "$u" 2>/dev/null); m=$(systemctl show -P MainPID "$u" 2>/dev/null)',
		'    if [ "${m:-0}" -gt 0 ] 2>/dev/null; then a=$(ps --ppid "$m" --no-headers 2>/dev/null | wc -l); else a=U; fi',
		'    say "pm2Unit.$u" "$(effmax "$cg" U) $a"',
		'  done',
		'else unk pm2Units "systemctl could not list this node\'s pm2 units"; fi',
		'if E=$(journalctl -b 0 -p err --no-pager 2>/dev/null); then say errorsThisBoot "$(printf "%s\\n" "$E" | grep -vcE "ACPI|Bluetooth")"; else unk errorsThisBoot "the journal could not be read by this user"; fi',
		// ── which stack owns the radio. node-interfaces.mjs owns the question. ─
		//
		// IN A SUBSHELL, and that is not style. `WIFI_MANAGER_PROBE` is one
		// `;`-joined string ending in `exit 0` — correct when it is the whole
		// remote command, fatal when it is a stanza of a longer one. Inlined bare,
		// it ended the probe: every node reported its wifi and then nothing, no
		// `DOCTOR-END`, and the run read as UNREACHABLE on a box that had just
		// answered 60 lines. Caught by executing it, not by reading it.
		`( ${WIFI_MANAGER_PROBE} )`,
		'RADIO=',
		'for d in /sys/class/net/*/wireless; do [ -e "$d" ] || continue; RADIO=$(basename "$(dirname "$d")"); break; done',
		'if [ -n "$RADIO" ]; then',
		'  say wifi.iface "$RADIO"',
		'  say wifi.operstate "$(cat "/sys/class/net/$RADIO/operstate" 2>/dev/null)"',
		'  say wifi.carrier "$(cat "/sys/class/net/$RADIO/carrier" 2>/dev/null)"',
		'  if [ -x /sbin/iw ]; then',
		'    L=$(/sbin/iw dev "$RADIO" link 2>/dev/null)',
		'    say wifi.ssid "$(printf "%s\\n" "$L" | awk -F"SSID: " "/SSID: /{print \\$2; exit}")"',
		'    say wifi.signalDbm "$(printf "%s\\n" "$L" | awk "/signal:/{print \\$2; exit}")"',
		'    say wifi.freqMhz "$(printf "%s\\n" "$L" | awk "/freq:/{print \\$2; exit}")"',
		'  else unk wifi.link "iw is not installed on this node, so the radio cannot be asked for its SSID or signal"; fi',
		'fi',
		// ── the load phase: a FIXED 60s, all cores, and the peak of every sensor
		secs > 0
			? [
					`LOADSECS=${secs}`,
					`FORCE=${force ? 1 : 0}`,
					'if [ "$BUSY" -gt 0 ] && [ "$FORCE" != 1 ]; then',
					'  unk load "CI was building here ($BUSY worker(s)) — loading the box would slow a consumer\'s job and skew the reading. Re-run with --force, or when the node is idle."',
					'else',
					'  say load.seconds "$LOADSECS"',
					'  NPROC=$(grep -c ^processor /proc/cpuinfo)',
					'  say load.workers "$NPROC"',
					'  say load.throttleBefore "$(throttles)"',
					'  i=0; while [ "$i" -lt "$NPROC" ]; do (timeout "$LOADSECS" sha512sum /dev/zero >/dev/null 2>&1) & i=$((i+1)); done',
					'  declare -A PEAK',
					'  sample() { while read -r k v; do cur=${PEAK[$k]:-0}; if [ "$v" -gt "$cur" ] 2>/dev/null; then PEAK[$k]=$v; fi; done < <(sensors); }',
					'  END=$(( $(date +%s) + LOADSECS ))',
					'  while [ "$(date +%s)" -lt "$END" ]; do sample; sleep 3; done',
					'  wait 2>/dev/null',
					'  sample',
					'  for k in "${!PEAK[@]}"; do printf "D peak.%s %s\\n" "$k" "${PEAK[$k]}"; done',
					'  say load.throttleAfter "$(throttles)"',
					'  say load.finishedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
					'fi',
				].join('\n')
			: `unk load ${JSON.stringify(noLoadWhy)}`,
		'echo "DOCTOR-END $(cat /proc/sys/kernel/hostname 2>/dev/null)"',
	].join('\n');
}
