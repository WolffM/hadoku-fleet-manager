#!/bin/sh
# stress-node.sh — is this claw wearing out?
#
# DIFFERENT QUESTION FROM benchmark-node.sh, and that is the whole point.
# The benchmark asks "how fast is this box, compared to the others". This asks
# "is this box about to die", and the answers it wants are FAILURE COUNTS and
# TRENDS, not throughput.
#
# Intended cadence: roughly twice a year, on a node that is not building. It is
# long (default ~20 minutes) and it deliberately heats the machine, because the
# faults worth catching only appear under sustained load:
#
#   - RAM that is fine at idle and flips bits when hot
#   - a CPU that throttles harder this year than last
#   - a disk quietly accumulating reallocated sectors
#   - a PCIe link that only storms under traffic (claw-4, 2026-09-01)
#
# WHAT IT WILL NOT DO: write to any block device it does not own, run
# `badblocks -w`, or touch a filesystem it did not create a file on. Destroying
# data to prove the disk still holds data is not a trade this makes.
#
# EVERY SUBSYSTEM REPORTS SEPARATELY, and a subsystem that could not be tested
# says so. "I could not look" must never render as "nothing is wrong" — a run
# that skipped the RAM test because memtester was missing has NOT cleared the
# RAM.
#
# USAGE
#   sudo sh stress-node.sh                 # ~20 minutes
#   sudo sh stress-node.sh --minutes 60    # a harder pass
#   sudo sh stress-node.sh --quick         # ~3 minutes, smoke test only
#   sudo sh stress-node.sh --force         # run even if CI is building

set -u

MINUTES=20
FORCE=0
while [ $# -gt 0 ]; do
	case "$1" in
	--minutes) MINUTES="${2:-20}"; shift 2 ;;
	--quick) MINUTES=3; shift ;;
	--force) FORCE=1; shift ;;
	*) shift ;;
	esac
done

emit() { printf '%s %s\n' "$1" "$2"; }
unk() { printf '%s unknown %s\n' "$1" "$2"; }
have() { command -v "$1" >/dev/null 2>&1 || [ -x "/usr/sbin/$1" ]; }
BIN() { command -v "$1" 2>/dev/null || echo "/usr/sbin/$1"; }

[ "$(id -u)" = 0 ] || { echo "run as root: sudo sh $0"; exit 1; }

HOST=$(cat /proc/sys/kernel/hostname 2>/dev/null)
echo "STRESS-BEGIN v1"
emit schema 1
emit hostname "$HOST"
emit startedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
emit plannedMinutes "$MINUTES"

BUSY=$(pgrep -c -f '[R]unner\.Worker|actions-runner/bin' 2>/dev/null); BUSY=$(echo "${BUSY:-0}" | head -1)
if [ "$BUSY" -gt 0 ] && [ "$FORCE" = 0 ]; then
	emit aborted "CI is building here — stressing it would slow the job and skew the result"
	echo "STRESS-END $HOST"
	exit 2
fi

# ── baseline, before any load ───────────────────────────────────────────────
thermal_max() {
	m=0
	for z in /sys/class/thermal/thermal_zone*/temp; do
		[ -r "$z" ] || continue
		t=$(cat "$z" 2>/dev/null)
		[ "${t:-0}" -gt "$m" ] 2>/dev/null && m=$t
	done
	echo $((m / 1000))
}
aer_total() {
	s=0
	for f in /sys/bus/pci/devices/*/aer_dev_correctable; do
		[ -r "$f" ] || continue
		s=$((s + $(awk '{t+=$2} END{print t+0}' "$f" 2>/dev/null)))
	done
	echo "$s"
}
mce_total() {
	c=$(dmesg 2>/dev/null | grep -ci 'machine check\|mce:'); echo "${c:-0}" | head -1
}

BASE_THERMAL=$(thermal_max); emit baseline.thermalC "$BASE_THERMAL"
BASE_AER=$(aer_total); emit baseline.aerCorrectable "$BASE_AER"
emit baseline.mce "$(mce_total)"
emit baseline.uptimeSec "$(cut -d' ' -f1 /proc/uptime | cut -d. -f1)"

# ── SMART, the single best wear signal, BEFORE and AFTER ────────────────────
# These attributes are what actually predict a dying drive. Reallocated and
# Pending sectors climbing is the finding; a raw value on its own means little,
# which is why fleet benchmark --write keeps history.
smart_snapshot() {
	pfx="$1"
	for b in /sys/block/*; do
		d=$(basename "$b")
		case $d in loop*|ram*|sr*|dm-*|zram*|md*) continue ;; esac
		have smartctl || { unk "$pfx.$d.smart" "smartctl absent"; continue; }
		S=$($(BIN smartctl) -H -A "/dev/$d" 2>/dev/null)
		[ -n "$S" ] || { unk "$pfx.$d.smart" "no SMART data (USB bridge or unsupported)"; continue; }
		emit "$pfx.$d.health" "$(echo "$S" | awk -F: '/overall-health|SMART Health Status/{gsub(/^ +/,"",$2);print $2}' | head -1)"
		if echo "$S" | grep -q 'NVMe Log'; then
			# NVMe: key/value, and the wear signals have different names.
			for k in 'Power On Hours' 'Percentage Used' 'Available Spare' \
				'Media and Data Integrity Errors' 'Unsafe Shutdowns' 'Temperature'; do
				v=$(echo "$S" | awk -F: -v a="$k" '$0 ~ "^"a":" {gsub(/[^0-9]/,"",$2); print $2; exit}')
				[ -n "$v" ] && emit "$pfx.$d.$(echo "$k" | tr -d ' ')" "$v"
			done
		else
			for attr in Reallocated_Sector_Ct Current_Pending_Sector Offline_Uncorrectable \
				Wear_Leveling_Count Percentage_Used Media_Wearout_Indicator \
				Power_On_Hours Temperature_Celsius UDMA_CRC_Error_Count; do
				v=$(echo "$S" | awk -v a="$attr" '$2==a{print $10; exit}')
				[ -n "$v" ] && emit "$pfx.$d.$attr" "$v"
			done
		fi
	done
}
smart_snapshot smartBefore

# ── RAM ─────────────────────────────────────────────────────────────────────
# memtester in userspace cannot test the memory the kernel holds, so it is not
# memtest86+. It IS enough to catch a stick that flips bits under heat, which is
# the failure mode that shows up as random build corruption.
RAMMB=$(( $(grep -m1 MemAvailable /proc/meminfo | tr -dc 0-9) / 1024 ))
RAMTEST=$(( RAMMB * 70 / 100 ))
if ! have memtester; then
	DEBIAN_FRONTEND=noninteractive apt-get install -y -qq memtester >/dev/null 2>&1 || true
fi
if have memtester && [ "$RAMTEST" -gt 128 ]; then
	emit ram.testedMb "$RAMTEST"
	OUT=$($(BIN memtester) "${RAMTEST}M" 1 2>&1 | tail -40)
	FAILS=$(echo "$OUT" | grep -ci 'FAILURE'); FAILS=$(echo "${FAILS:-0}" | head -1)
	emit ram.failures "$FAILS"
	emit ram.verdict "$([ "$FAILS" = 0 ] && echo PASS || echo FAIL)"
	[ "$FAILS" = 0 ] || echo "$OUT" | grep -i failure | head -5 | sed 's/^/ram.detail /'
else
	unk ram.verdict "memtester unavailable or too little free RAM to test meaningfully"
fi

# ── CPU + thermal, sustained ────────────────────────────────────────────────
# The number that matters is not throughput, it is whether the box THROTTLES and
# how hot it gets holding all cores busy. claw-3 was demoted on exactly this:
# 96C against a 100C trip, 1018 throttle events in 51 minutes.
NPROC=$(grep -c ^processor /proc/cpuinfo)
SECS=$(( MINUTES * 60 * 40 / 100 ))
[ "$SECS" -lt 30 ] && SECS=30
emit cpu.loadSeconds "$SECS"
emit cpu.workers "$NPROC"
i=0
while [ "$i" -lt "$NPROC" ]; do
	( end=$(( $(date +%s) + SECS )); while [ "$(date +%s)" -lt "$end" ]; do :; done ) &
	i=$((i + 1))
done
PEAK=0
while pgrep -P $$ >/dev/null 2>&1; do
	t=$(thermal_max)
	[ "$t" -gt "$PEAK" ] 2>/dev/null && PEAK=$t
	sleep 5
	kill -0 %1 2>/dev/null || break
done
wait 2>/dev/null
emit cpu.peakThermalC "$PEAK"
emit cpu.thermalRiseC "$(( PEAK - BASE_THERMAL ))"
# Throttling, read from the kernel rather than inferred from the temperature.
THR=0
for c in /sys/devices/system/cpu/cpu*/thermal_throttle/core_throttle_count; do
	[ -r "$c" ] || continue
	THR=$((THR + $(cat "$c" 2>/dev/null || echo 0)))
done
emit cpu.throttleEvents "$THR"
emit cpu.verdict "$([ "$THR" -eq 0 ] && [ "$PEAK" -lt 90 ] && echo PASS || echo REVIEW)"

# ── disk, read-verify only ──────────────────────────────────────────────────
# A long SMART self-test is the manufacturer's own surface scan and costs
# nothing but time. It runs in the drive's firmware, in the background, and is
# the right tool here precisely because it does not write.
for b in /sys/block/*; do
	d=$(basename "$b")
	case $d in loop*|ram*|sr*|dm-*|zram*|md*) continue ;; esac
	have smartctl || continue
	$(BIN smartctl) -t long "/dev/$d" >/dev/null 2>&1 &&
		emit "disk.$d.selfTest" "started (runs in firmware; read result later with: smartctl -l selftest /dev/$d)" ||
		unk "disk.$d.selfTest" "drive refused a self-test"
done

# ── GPU ─────────────────────────────────────────────────────────────────────
if have nvidia-smi; then
	emit gpu.eccErrors "$(nvidia-smi --query-gpu=ecc.errors.uncorrected.volatile.total --format=csv,noheader 2>/dev/null | head -1)"
	emit gpu.tempC "$(nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader 2>/dev/null | head -1)"
	emit gpu.verdict PASS
else
	unk gpu.verdict "no nvidia-smi; an integrated GPU has no separate wear signal worth reading"
fi

# ── what changed while we were loading it ───────────────────────────────────
smart_snapshot smartAfter
AER_AFTER=$(aer_total)
# Growth under load is the signal. claw-4 sat at 0 idle and threw 7.5
# million during an install, so a baseline reading alone proves nothing.
emit delta.aerCorrectable "$(( AER_AFTER - BASE_AER ))"
emit after.aerCorrectable "$AER_AFTER"
emit after.mce "$(mce_total)"
emit after.thermalC "$(thermal_max)"
emit finishedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "STRESS-END $HOST"
