#!/bin/sh
# benchmark-node.sh — everything knowable about one claw, measured where possible.
#
# WHY MEASURED AND NOT READ
# -------------------------
# The manifest's capacity numbers were all argued from evidence, and the
# arguments are in the file: claw-1 is capped at 3 because its p95 job memory is
# 2897MB against a 9216MB slice; claw-2 dropped 3->2 because three of ITS jobs
# overran a 5632MB cap and the kernel started picking victims; claw-3 sits at 3
# because 4 cores bind before its 15G does, and it is demoted entirely because
# it hits 96C against a 100C trip.
#
# Not one of those numbers is derivable from a spec sheet. A 3.4GHz FX-8350 and
# a 3.4GHz i7-6700 are different machines, and the only honest way to rank them
# is to run something and time it.
#
# So this reads what can be read and RUNS what cannot. Every measured figure
# says how it was obtained, and a probe that could not run emits
# `unknown <reason>` rather than nothing -- an absent field and a zero must not
# look alike.
#
# OUTPUT is `key value` lines, the same shape as the enrollment record and
# hardware.txt, because it is read three ways: by a human at a console, by
# `fleet benchmark` over ssh, and by somebody pasting a scrollback.
#
# IT PUTS THE BOX UNDER LOAD. That is the point -- thermals and throttling are
# only observable under load -- but it means this must not run on a node that is
# building. It refuses if it finds runner work in progress, unless --force.
#
# USAGE
#   sudo sh benchmark-node.sh            # full pass, roughly 3 minutes
#   sudo sh benchmark-node.sh --quick    # skip the disk and network timings
#   sudo sh benchmark-node.sh --force    # run even if CI looks busy

set -u

QUICK=0
FORCE=0
for a in "$@"; do
	case "$a" in
	--quick) QUICK=1 ;;
	--force) FORCE=1 ;;
	esac
done

emit() { printf '%s %s\n' "$1" "$2"; }
# `unknown <reason>` is a VALUE. A field that is simply absent tells a reader
# nothing about whether to go and look.
unk() { printf '%s unknown %s\n' "$1" "$2"; }
have() { command -v "$1" >/dev/null 2>&1 || [ -x "/usr/sbin/$1" ]; }
run_t() { if have "$1"; then "$(command -v "$1" 2>/dev/null || echo "/usr/sbin/$1")" "$@"; fi; }

echo "BENCH-BEGIN v1"
# Whether this capture ran as root, so a refused write can say whether root
# would have helped (#121) instead of always advising it.
emit capture.root "$([ "$(id -u)" = 0 ] && echo yes || echo no)"
emit schema 1
emit recordedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
emit hostname "$(cat /proc/sys/kernel/hostname 2>/dev/null)"
emit uptimeSec "$(cut -d' ' -f1 /proc/uptime 2>/dev/null | cut -d. -f1)"

# ── is it safe to load this box? ────────────────────────────────────────────
# count0 <cmd...> — a counter that prints 0 and exits non-zero on "none found"
# needs its status ignored, NOT an `|| echo 0` that appends a second line.
count0() { c=$("$@" 2>/dev/null); echo "${c:-0}" | head -1; }
BUSY=$(count0 pgrep -c -f '[R]unner\.Worker|actions-runner/bin')
emit ciWorkersRunning "$BUSY"
if [ "${BUSY:-0}" -gt 0 ] && [ "$FORCE" = 0 ]; then
	emit aborted "CI is building here; benchmarking would both skew the numbers and slow the job"
	echo "BENCH-END $(cat /proc/sys/kernel/hostname 2>/dev/null)"
	exit 2
fi

# ── chassis ─────────────────────────────────────────────────────────────────
for f in sys_vendor product_name board_name bios_version chassis_type; do
	v=$(cat "/sys/class/dmi/id/$f" 2>/dev/null)
	[ -n "$v" ] && emit "dmi.$f" "$v" || unk "dmi.$f" "not exposed by this firmware"
done

# ── cpu ─────────────────────────────────────────────────────────────────────
emit cpu.model "$(grep -m1 '^model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^ //')"
emit cpu.threads "$(grep -c ^processor /proc/cpuinfo)"
if have lscpu; then
	L=$(lscpu 2>/dev/null)
	emit cpu.cores "$(echo "$L" | awk -F: '/^Core\(s\) per socket/{gsub(/ /,"",$2);c=$2} /^Socket\(s\)/{gsub(/ /,"",$2);s=$2} END{print (c&&s)?c*s:"" }')"
	emit cpu.sockets "$(echo "$L" | awk -F: '/^Socket\(s\)/{gsub(/ /,"",$2);print $2}')"
	# NOT EVERY CPU HAS A cpufreq DRIVER. claw-5's FX-8350 has none, so lscpu
	# prints no "CPU max MHz" line and this read empty. Fall back to sysfs, and
	# if that is absent too, say so rather than leaving a blank that reads like
	# a machine with no clock.
	MHZ=$(echo "$L" | awk -F: '/CPU max MHz/{gsub(/ /,"",$2);print int($2)}')
	if [ -z "$MHZ" ]; then
		khz=$(cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq 2>/dev/null)
		[ -n "$khz" ] && MHZ=$((khz / 1000))
	fi
	if [ -n "$MHZ" ]; then
		emit cpu.mhzMax "$MHZ"
	else
		unk cpu.mhzMax "no cpufreq driver and lscpu reports no max (common on pre-Zen AMD)"
	fi
	emit cpu.mhzMin "$(echo "$L" | awk -F: '/CPU min MHz/{gsub(/ /,"",$2);print int($2)}')"
	emit cpu.l3 "$(echo "$L" | awk -F: '/^L3 cache/{gsub(/^ +/,"",$2);print $2}')"
else
	unk cpu.cores "lscpu absent"
fi
# Flags that change what a build can do, not the whole list.
for fl in avx2 avx512f aes sse4_2 vmx svm; do
	grep -qm1 " $fl" /proc/cpuinfo 2>/dev/null && emit "cpu.flag.$fl" yes || emit "cpu.flag.$fl" no
done
emit cpu.governor "$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null || echo none)"

# ── memory ──────────────────────────────────────────────────────────────────
emit mem.totalKb "$(grep -m1 MemTotal /proc/meminfo | tr -dc 0-9)"
emit mem.availableKb "$(grep -m1 MemAvailable /proc/meminfo | tr -dc 0-9)"
emit mem.swapTotalKb "$(grep -m1 SwapTotal /proc/meminfo | tr -dc 0-9)"
if have dmidecode; then
	D=$(/usr/sbin/dmidecode -t memory 2>/dev/null)
	emit mem.type "$(echo "$D" | awk -F: '/^\tType:/{gsub(/ /,"",$2); if($2!="Unknown"&&$2!="None"){print $2; exit}}')"
	emit mem.speedMTs "$(echo "$D" | awk -F: '/Configured Memory Speed:|Configured Clock Speed:/{gsub(/[^0-9]/,"",$2); if($2!=""){print $2; exit}}')"
	emit mem.sticks "$(echo "$D" | grep -cE '^[[:space:]]*Size:[[:space:]]+[0-9]+ +[MG]B')"
	emit mem.slots "$(echo "$D" | grep -cE '^[[:space:]]*Size:')"
else
	unk mem.type "dmidecode needs root and is absent"
fi

# ── storage: EVERY drive, mounted or not ────────────────────────────────────
# claw-4 has two, and the second is invisible to anything that only looks at /.
for b in /sys/block/*; do
	d=$(basename "$b")
	case $d in loop*|ram*|sr*|dm-*|zram*|md*) continue ;; esac
	emit "disk.$d.sizeBytes" "$(( $(cat "$b/size" 2>/dev/null || echo 0) * 512 ))"
	emit "disk.$d.rotational" "$(cat "$b/queue/rotational" 2>/dev/null)"
	emit "disk.$d.model" "$(cat "$b/device/model" 2>/dev/null | sed 's/ *$//')"
	emit "disk.$d.scheduler" "$(sed 's/.*\[\(.*\)\].*/\1/' "$b/queue/scheduler" 2>/dev/null)"
	MP=$(lsblk -nro MOUNTPOINT "/dev/$d" 2>/dev/null | grep -v '^$' | tr '\n' ',' | sed 's/,$//')
	emit "disk.$d.mountpoints" "${MP:-none}"
	# BUS TYPE COMES FROM THE DEVICE, NOT FROM smartctl BEING AVAILABLE.
	# kind used to be emitted inside the smartctl block and chosen by whether its
	# OUTPUT mentioned "NVMe Log" -- so on any box where smartctl cannot run
	# (hokon, which has no passwordless sudo) the output is empty, the NVMe test
	# fails, and every drive fell through to `ata`. hokon's four NVMe devices
	# were all recorded as ata: not a gap but a wrong answer, which is worse.
	case "$d" in
	nvme*) emit "disk.$d.kind" nvme ;;
	*) emit "disk.$d.kind" ata ;;
	esac
	if have smartctl; then
		S=$(/usr/sbin/smartctl -H -A "/dev/$d" 2>/dev/null)
		emit "disk.$d.smartHealth" "$(echo "$S" | awk -F: '/overall-health|SMART Health Status/{gsub(/^ +/,"",$2);print $2}' | head -1)"
		# ATA AND NVMe REPORT NOTHING ALIKE. ATA gives an attribute table with
		# the raw value in column 10; NVMe gives "Power On Hours: 31,328" as a
		# key/value line, commas and all. claw-3 is NVMe and reported no disk
		# hours at all because only the ATA shape was parsed -- a field that
		# silently reads empty on a whole class of drive.
		if echo "$S" | grep -q 'NVMe Log'; then
			nv() { echo "$S" | awk -F: -v k="$1" '$0 ~ "^"k":" {gsub(/[^0-9]/,"",$2); print $2; exit}'; }
			emit "disk.$d.powerOnHours" "$(nv 'Power On Hours')"
			emit "disk.$d.percentageUsed" "$(nv 'Percentage Used')"
			emit "disk.$d.availableSparePct" "$(nv 'Available Spare')"
			emit "disk.$d.mediaErrors" "$(nv 'Media and Data Integrity Errors')"
			emit "disk.$d.unsafeShutdowns" "$(nv 'Unsafe Shutdowns')"
			emit "disk.$d.tempC" "$(nv 'Temperature')"
			# NVMe has no reallocated-sector concept; spare exhaustion is the
			# equivalent signal, and saying `unknown` beats implying zero.
			unk "disk.$d.reallocated" "NVMe reports wear as percentageUsed and availableSparePct"
		else
			at() { echo "$S" | awk -v a="$1" '$2==a{print $10; exit}'; }
			emit "disk.$d.powerOnHours" "$(at Power_On_Hours)"
			emit "disk.$d.reallocated" "$(at Reallocated_Sector_Ct)"
			emit "disk.$d.pendingSectors" "$(at Current_Pending_Sector)"
			emit "disk.$d.wearLeveling" "$(at Wear_Leveling_Count)"
			emit "disk.$d.tempC" "$(at Temperature_Celsius)"
		fi
	else
		unk "disk.$d.powerOnHours" "smartctl absent"
	fi
done

# ── gpu ─────────────────────────────────────────────────────────────────────
GPUN=0
if have lspci; then
	lspci -nnk 2>/dev/null | grep -iE 'vga compatible|3d controller' | while IFS= read -r line; do
		GPUN=$((GPUN+1))
		emit "gpu.$GPUN.device" "$(echo "$line" | cut -d' ' -f2- | cut -c1-90)"
	done
	emit gpu.count "$(lspci 2>/dev/null | grep -icE 'vga compatible|3d controller')"
	emit gpu.driver "$(lspci -nnk 2>/dev/null | grep -A3 -iE 'vga compatible|3d controller' | awk -F: '/Kernel driver in use/{gsub(/ /,"",$2);print $2; exit}')"
else
	unk gpu.count "lspci absent"
fi
if have nvidia-smi; then
	emit gpu.nvidiaName "$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)"
	emit gpu.nvidiaVramMb "$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1)"
else
	unk gpu.nvidiaName "nvidia-smi absent (no proprietary driver installed)"
fi
# The capability that matters here is ENCODE, and it is decided by silicon
# generation, not by whether a GPU exists. Report the generation; the encoder
# probe in capability-probe.sh answers the rest by actually encoding.
emit gpu.nvencAv1Capable "$(lspci 2>/dev/null | grep -qiE 'AD1[0-9][0-9]|RTX 40' && echo yes || echo no)"

# ── network ─────────────────────────────────────────────────────────────────
for n in /sys/class/net/*; do
	i=$(basename "$n")
	case "$i" in lo|docker*|veth*|br-*|tail*|nordlynx) continue ;; esac
	emit "net.$i.mac" "$(cat "$n/address" 2>/dev/null)"
	emit "net.$i.carrier" "$(cat "$n/carrier" 2>/dev/null || echo 0)"
	emit "net.$i.driver" "$(basename "$(readlink -f "$n/device/driver" 2>/dev/null)" 2>/dev/null)"
	emit "net.$i.wireless" "$([ -d "$n/wireless" ] && echo 1 || echo 0)"
	# ethtool IS NOT ALWAYS INSTALLED, AND THE KERNEL ALREADY KNOWS. hokon has no
	# ethtool, so its 1Gb link reported no speed at all while
	# /sys/class/net/enp14s0/speed read 1000 the whole time. Try ethtool first
	# (it also gives duplex), then fall back to sysfs, then say why not.
	SP=""
	DX=""
	if have ethtool; then
		E=$(/usr/sbin/ethtool "$i" 2>/dev/null)
		SP=$(echo "$E" | awk -F: '/Speed:/{gsub(/ /,"",$2);print $2}')
		DX=$(echo "$E" | awk -F: '/Duplex:/{gsub(/ /,"",$2);print $2}')
	fi
	case "$SP" in "" | Unknown*)
		sys=$(cat "$n/speed" 2>/dev/null)
		[ -n "$sys" ] && [ "$sys" -gt 0 ] 2>/dev/null && SP="${sys}Mb/s"
		;;
	esac
	# "Unknown!" IS ETHTOOL SAYING NO, NOT A SPEED. A port with no cable answers
	# `Speed: Unknown!`, and passing that through recorded the string as though
	# it were a measurement -- claw-1's unplugged ethernet carried it while the
	# wifi link it actually runs on sat in the next field.
	case "$SP" in Unknown* | "") SP="" ;; esac
	if [ -n "$SP" ]; then
		emit "net.$i.linkSpeed" "$SP"
	elif [ -d "$n/wireless" ]; then
		# WIFI IS THIS FLEET'S ACTUAL NETWORK CONSTRAINT, and sysfs cannot see it:
		# the rate is negotiated per frame, so /sys/class/net/*/speed is empty on
		# every wireless interface. Three of the claws are wifi-primary and had NO
		# link figure at all, while `iw dev <if> link` — already installed on every
		# box that has a radio — reports the negotiated rate and the signal that
		# determines it. Those numbers had only ever been gathered by hand.
		#
		# Rate, not throughput: 650 MBit/s here is what the radios agreed on, and
		# a curl to the internet measures something else entirely. Both are worth
		# having and they are not the same number.
		#
		# NO SSID OR BSSID IS RECORDED. They identify a household network and this
		# file is committed to a public repo.
		if have iw && IWL=$(/usr/sbin/iw dev "$i" link 2>/dev/null) && [ -n "${IWL:-}" ] &&
			! echo "$IWL" | grep -qi 'not connected'; then
			RX=$(echo "$IWL" | awk '/rx bitrate:/{print int($3)}')
			TX=$(echo "$IWL" | awk '/tx bitrate:/{print int($3)}')
			SIG=$(echo "$IWL" | awk '/signal:/{print int($2)}')
			FRQ=$(echo "$IWL" | awk '/freq:/{print int($2)}')
			[ -n "$RX" ] && emit "net.$i.linkSpeed" "${RX}Mb/s"
			[ -n "$RX" ] && emit "net.$i.wifiRxMbps" "$RX"
			[ -n "$TX" ] && emit "net.$i.wifiTxMbps" "$TX"
			[ -n "$SIG" ] && emit "net.$i.wifiSignalDbm" "$SIG"
			[ -n "$FRQ" ] && emit "net.$i.wifiFreqMhz" "$FRQ"
		else
			# An unassociated radio is not a slow one. hokon's MT7922 has never
			# associated and its antennas are not connected, so anything read from
			# it is wrong -- saying so beats reporting a number.
			unk "net.$i.linkSpeed" "wireless: not associated (or iw absent)"
		fi
	elif [ "$(cat "$n/carrier" 2>/dev/null || echo 0)" = "0" ]; then
		unk "net.$i.linkSpeed" "no link (carrier down — cable unplugged or port unused)"
	else
		unk "net.$i.linkSpeed" "no ethtool and $n/speed unreadable"
	fi
	if [ -n "$DX" ]; then emit "net.$i.duplex" "$DX"; fi
done

# ── thermal, idle ───────────────────────────────────────────────────────────
# AMD REGISTERS NO THERMAL ZONE, SO THIS READ NOTHING ON THE AMD BOXES.
# thermal_zone* comes from ACPI, which the Intel claws have and neither AMD
# machine does: hokon (Zen 4) and claw-5 (FX-8350) both report `thermal.zones 0`
# while k10temp sits in /sys/class/hwmon exposing Tctl the whole time. The
# sensor was never missing, only unread -- so both boxes have been reporting
# "0 -> 0" in a temperature column, and claw-1 next to them reads 98C against a
# 105C trip. A cooling problem on the production host would have been invisible.
#
# Restricted to CPU chips on purpose. Reading every hwmon would fold nvme, GPU
# and wifi temperatures into a number the fleet uses as a CPU thermal headroom
# figure, silently changing what it means on the Intel boxes too.
thermal_max() {
	m=0
	src="-"
	for z in /sys/class/thermal/thermal_zone*/temp; do
		[ -r "$z" ] || continue
		t=$(cat "$z" 2>/dev/null)
		if [ "${t:-0}" -gt "$m" ] 2>/dev/null; then
			m=$t
			src="thermal_zone"
		fi
	done
	for h in /sys/class/hwmon/hwmon*; do
		n=$(cat "$h/name" 2>/dev/null)
		case "$n" in
		k10temp | coretemp | zenpower | cpu_thermal) ;;
		*) continue ;;
		esac
		for f in "$h"/temp*_input; do
			[ -r "$f" ] || continue
			t=$(cat "$f" 2>/dev/null)
			if [ "${t:-0}" -gt "$m" ] 2>/dev/null; then
				m=$t
				src="$n"
			fi
		done
	done
	# Both halves in one line: this runs in a $( ) subshell, so a variable set
	# here does NOT reach the caller. Returning the source out of band is what
	# `set -u` turned into a script-killing unbound variable on the first try.
	echo "$((m / 1000)) $src"
}

# ACTUAL CLOCK, BECAUSE A THROTTLING BOX LOOKS LIKE A SLOW ONE.
#
# claw-3 benchmarks 620 MB/s one run and 336 the next -- a 1.85x spread on the
# same silicon, at 91-94C both times. Temperature makes that a good GUESS and
# nothing here made it a measurement. Sampling the clock at the same two points
# as the thermal reading turns it into one: a chip sitting far below its own
# ceiling right after a sustained load is throttling, and the number says so.
#
# Free, and deliberately so. scaling_cur_freq is in-kernel on every box that has
# cpufreq at all, so this needs no package and belongs in no toolpack. claw-5's
# FX-8350 has no cpufreq driver and therefore no answer -- unk with the reason,
# not a zero.
clock_max() {
	m=0
	for f in /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq; do
		[ -r "$f" ] || continue
		v=$(cat "$f" 2>/dev/null)
		[ "${v:-0}" -gt "$m" ] 2>/dev/null && m=$v
	done
	echo $((m / 1000))
}
emit_clock() {
	v=$(clock_max)
	if [ "${v:-0}" -gt 0 ] 2>/dev/null; then
		emit "$1" "$v"
	else
		unk "$1" "no cpufreq driver (common on pre-Zen AMD)"
	fi
}

# A MISSING SENSOR IS NOT A COLD MACHINE. `m` stays 0 when nothing is readable,
# and 0 is a plausible-looking temperature -- so this emitted `thermal.idleC 0`
# for both AMD boxes, a measurement rather than a gap. Say which it is.
emit_thermal() {
	key=$1
	floor=${2:-0}
	out=$(thermal_max)
	v=${out%% *}
	src=${out##* }
	if [ "${v:-0}" -gt 0 ] 2>/dev/null; then
		emit "$key" "$v"
		emit "$key.source" "$src"
		# A READING CAN BE PRESENT AND STILL BE WRONG. k10temp on AMD family 15h
		# (claw-5's FX-8350) reports a RELATIVE offset rather than an absolute
		# temperature, so a fully loaded chip reads ~19C. Left unmarked it makes
		# the hottest-running box in the fleet look like the coolest, which is a
		# worse failure than the blank this replaced.
		if [ "$floor" -gt 0 ] 2>/dev/null && [ "$v" -lt "$floor" ] 2>/dev/null; then
			emit "$key.suspect" "implausibly low under load; k10temp on AMD family 15h reports a relative offset, not degrees C"
		fi
	else
		unk "$key" "no readable CPU sensor: no thermal_zone and no k10temp/coretemp hwmon"
	fi
}
emit_thermal thermal.idleC
emit_clock cpu.idleMhz
emit thermal.zones "$(ls -d /sys/class/thermal/thermal_zone* 2>/dev/null | wc -l)"

# ── MEASURED: cpu ───────────────────────────────────────────────────────────
# openssl speed is the most portable comparable number available without
# installing anything, and it is deterministic enough to rank machines.
#
# THE RANKING NUMBER IS sha512, NOT sha256, AND THE REASON IS FAIRNESS.
# SHA-NI accelerates SHA-1 and SHA-256 in hardware and covers nothing else.
# hokon (Zen 4) carries it on all 12 threads and NOT ONE claw has it, so the
# sha256 comparison scored hokon at 5.0x the best claw, while every
# unaccelerated measure -- sha512 1.40x, blake2b512 1.36x, gzip 1.51x -- and the
# production job record (~2x, net of a fixed ~7s per-job floor) agree it is
# nothing like that. Ranking machines on an instruction one vendor implements
# and the other does not measures the instruction, not the machine.
#
# sha256 is still recorded: it is the cheapest SHA-NI detector we have, and it
# keeps the four stored runs interpretable. It must not be ranked on, which is
# why cpu.shaNi is emitted beside it -- a reader that sees the 5x can see why.
if have openssl; then
	NPROC=$(grep -c ^processor /proc/cpuinfo)
	F1=$(openssl speed -elapsed -evp sha512 -seconds 2 2>/dev/null | awk '/^sha512/{print $NF}')
	emit bench.cpuSha512SingleKBps "${F1:-0}"
	FM=$(openssl speed -elapsed -evp sha512 -seconds 2 -multi "$NPROC" 2>/dev/null | awk '/^sha512/{print $NF}' | tail -1)
	emit bench.cpuSha512AllCoreKBps "${FM:-0}"
	emit bench.cpuMethod "openssl speed -evp sha512, 2s, single then -multi nproc (sha512 is NOT covered by SHA-NI)"

	S1=$(openssl speed -elapsed -evp sha256 -seconds 2 2>/dev/null | awk '/^sha256/{print $NF}')
	emit bench.cpuSha256SingleKBps "${S1:-0}"
	# SAMPLED WHILE THE LOAD IS STILL ON, which is the only time it means
	# anything. Both of these used to be read after the benchmark finished, and a
	# CPU drops back to its idle clock within milliseconds of the load ending --
	# so `loadedMhz` measured an idle machine and would have reported a
	# throttling box as healthy. Temperature decays slower and was merely
	# optimistic; the clock was simply wrong. Run the last sustained pass in the
	# background, sample two seconds in, then collect it.
	openssl speed -elapsed -evp sha256 -seconds 2 -multi "$NPROC" >/tmp/.fleet-sha256.$$ 2>/dev/null &
	BPID=$!
	sleep 2
	LOADED_MHZ=$(clock_max)
	LOADED_OUT=$(thermal_max)
	wait "$BPID" 2>/dev/null || true
	SM=$(awk '/^sha256/{print $NF}' /tmp/.fleet-sha256.$$ 2>/dev/null | tail -1)
	rm -f /tmp/.fleet-sha256.$$
	emit bench.cpuSha256AllCoreKBps "${SM:-0}"
	emit cpu.flag.shaNi "$(grep -qm1 sha_ni /proc/cpuinfo && echo yes || echo no)"
	emit bench.cpuSha256Caveat "SHA-NI accelerated where present -- NOT comparable across vendors, do not rank on it"
else
	unk bench.cpuSha512SingleKBps "openssl absent"
	unk bench.cpuSha256SingleKBps "openssl absent"
fi

# ── MEASURED: memory bandwidth ──────────────────────────────────────────────
# ONE METHOD, PICKED, PER P1.4. Three methods gave three answers on claw-5,
# 2026-09-03/04: a raw 1GB write+read stream said 2.1 GB/s, an unspecified
# figure typed into the drain record said 1.9, and STREAM triad
# (a[i] = b[i] + scalar*c[i], 512MiB arrays, well past cache) said 5.24. The
# spread between them (2.5x) is bigger than the 1.25-1.5x gain claw-5's BIOS
# fix is expected to produce, so measuring the before/after with more than one
# method in play would be unreadable in either direction. Triad wins because it
# is the one that ACCOUNTS FOR WRITE-ALLOCATE -- the write to `a` first pulls
# the cache line it is about to overwrite, which is real traffic the 1GB
# copy-stream never charged for and is almost certainly why it understated --
# and because "STREAM" already means this exact kernel to anyone who has run
# McCalpin's benchmark, so a number here is comparable without a footnote.
# See docs/planning/measurement-handoff-2026-09-03.md and
# docs/planning/tier-assignment-2026-09-03.md's claw-5 section.
#
# COMPILED, NOT INTERPRETED. `build-essential` is on the toolchain floor of
# both node profiles (node-profiles.json toolchain.packages), so a C compiler
# is guaranteed on every node this script is meant to run on -- a shell or
# python loop over 64M elements would spend its wall-clock in the interpreter,
# not in memory traffic, and would not be measuring the thing it claims to.
if have cc || have gcc; then
	CC=$(command -v cc || command -v gcc)
	TC="/tmp/.fleet-stream.$$.c"
	TB="/tmp/.fleet-stream.$$"
	TE="/tmp/.fleet-stream.$$.err"
	cat >"$TC" <<'CEOF'
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
/* 64M doubles = 512MiB per array, matching the triad measurement already on
 * record for claw-5/claw-6 so a fleet-wide run is comparable to it. */
#define NELEM (64L * 1024 * 1024)
/* First rep pays for first-touch page faults on `a`, not for memory
 * bandwidth; discarded. Best of the remaining two, same as the reference
 * STREAM harness reports MaxRate rather than an average. */
#define REPS 3
int main(void) {
	double *a = malloc((size_t)NELEM * sizeof(double));
	double *b = malloc((size_t)NELEM * sizeof(double));
	double *c = malloc((size_t)NELEM * sizeof(double));
	if (!a || !b || !c) {
		fprintf(stderr, "alloc failed\n");
		return 1;
	}
	for (long i = 0; i < NELEM; i++) {
		b[i] = 1.0;
		c[i] = 2.0;
		a[i] = 0.0;
	}
	double scalar = 3.0, bestBps = 0.0;
	for (int r = 0; r < REPS; r++) {
		struct timespec t0, t1;
		clock_gettime(CLOCK_MONOTONIC, &t0);
		for (long i = 0; i < NELEM; i++) a[i] = b[i] + scalar * c[i];
		clock_gettime(CLOCK_MONOTONIC, &t1);
		if (r == 0) continue;
		double secs = (t1.tv_sec - t0.tv_sec) + (t1.tv_nsec - t0.tv_nsec) / 1e9;
		/* triad: 2 reads (b, c) + 1 write (a) per element */
		double bps = ((double)NELEM * sizeof(double) * 3.0) / secs;
		if (bps > bestBps) bestBps = bps;
	}
	/* Read `a` back so the compiler cannot prove the loop above is dead and
	 * remove it at -O2. */
	volatile double sink = a[0] + a[NELEM - 1];
	(void)sink;
	printf("%.0f\n", bestBps);
	return 0;
}
CEOF
	if "$CC" -O2 -o "$TB" "$TC" 2>"$TE"; then
		BW=$("$TB" 2>/dev/null)
		if [ -n "${BW:-}" ] && [ "$BW" -gt 0 ] 2>/dev/null; then
			emit bench.memBandwidthBps "$BW"
			emit bench.memBandwidthMethod "STREAM triad (a=b+scalar*c), 512MiB arrays x3 (first discarded for page-fault warmup), best of 2, 2 reads+1 write per element -- picked over a raw copy-stream (no write-allocate accounting, understates) and the unspecified drain-record figure, see measurement-handoff-2026-09-03.md P1.4"
		else
			unk bench.memBandwidthBps "compiled but the probe produced no usable output (allocation likely failed -- 1.5GiB needed for three arrays)"
		fi
	else
		unk bench.memBandwidthBps "cc failed to compile the STREAM probe: $(head -c 200 "$TE" 2>/dev/null | tr '\n' ' ')"
	fi
	rm -f "$TC" "$TB" "$TE"
else
	unk bench.memBandwidthBps "no C compiler (cc/gcc) on PATH -- build-essential missing"
fi

# ── thermal, loaded ─────────────────────────────────────────────────────────
# Emit what was captured UNDER LOAD above, not a fresh read of a now-idle box.
if [ "${LOADED_MHZ:-0}" -gt 0 ] 2>/dev/null; then
	emit cpu.loadedMhz "$LOADED_MHZ"
else
	unk cpu.loadedMhz "no cpufreq driver (common on pre-Zen AMD)"
fi
lv=${LOADED_OUT%% *}
lsrc=${LOADED_OUT##* }
if [ "${lv:-0}" -gt 0 ] 2>/dev/null; then
	emit thermal.loadedC "$lv"
	emit thermal.loadedC.source "$lsrc"
	if [ "$lv" -lt 25 ] 2>/dev/null; then
		emit thermal.loadedC.suspect "implausibly low under load; k10temp on AMD family 15h reports a relative offset, not degrees C"
	fi
else
	unk thermal.loadedC "no readable CPU sensor: no thermal_zone and no k10temp/coretemp hwmon"
fi
emit thermal.throttleCount "$(awk '/thermal/{c++} END{print c+0}' /proc/interrupts 2>/dev/null)"

# ── MEASURED: disk, per mounted filesystem ──────────────────────────────────
if [ "$QUICK" = 0 ]; then
	# DEDUPED BY DEVICE. /, /home and /var are usually one filesystem, and
	# timing the same disk three times costs 90 seconds to produce the same
	# number three times under three different names.
	SEEN=""
	for mp in / /home /var /srv; do
		[ -d "$mp" ] || continue
		src=$(findmnt -no SOURCE --target "$mp" 2>/dev/null)
		[ -n "$src" ] || continue
		case " $SEEN " in *" $src "*) continue ;; esac
		SEEN="$SEEN $src"
		key=$(echo "$mp" | sed 's|^/$|root|; s|^/||; s|/|_|g')
		T="$mp/.fleet-bench.$$"
		# 512MB, direct IO so this measures the device and not the page cache.
		W=$(dd if=/dev/zero of="$T" bs=1M count=512 oflag=direct 2>&1 | awk '/copied|bytes/{print $(NF-1)" "$NF}')
		emit "bench.diskWrite.$key" "${W:-unknown}"
		sync
		R=$(dd if="$T" of=/dev/null bs=1M iflag=direct 2>&1 | awk '/copied|bytes/{print $(NF-1)" "$NF}')
		emit "bench.diskRead.$key" "${R:-unknown}"
		emit "bench.diskDevice.$key" "$src"
		rm -f "$T"
	done
	emit bench.diskMethod "dd 512MB bs=1M oflag/iflag=direct (device, not page cache)"
else
	unk bench.diskWrite.root "--quick"
fi

# ── MEASURED: network ───────────────────────────────────────────────────────
if [ "$QUICK" = 0 ] && have curl; then
	# A RANGE REQUEST, so the number is bandwidth rather than handshake. The
	# Release file is ~100KB and finishes before TCP has opened its window;
	# claw-6 measured 751kB/s that way on a gigabit link.
	SP=$(curl -s -o /dev/null -w '%{speed_download}' --max-time 30 \
		-r 0-33554431 \
		http://deb.debian.org/debian/dists/trixie/main/installer-amd64/current/images/netboot/mini.iso 2>/dev/null)
	[ "${SP:-0}" = "0" ] && SP=$(curl -s -o /dev/null -w '%{speed_download}' --max-time 30 \
		http://deb.debian.org/debian/dists/trixie/Release 2>/dev/null)
	emit bench.netArchiveBps "${SP:-0}"
	emit bench.netMethod "curl, 32MB range request from deb.debian.org"
else
	unk bench.netArchiveBps "--quick or curl absent"
fi

# ── stability ───────────────────────────────────────────────────────────────
# A box with no readable AER counter has no AER answer, not zero errors: since
# #121 a 0 is stored as a measurement, so the absence has to say so.
AER=0
AER_SEEN=0
for f in /sys/bus/pci/devices/*/aer_dev_correctable; do
	[ -r "$f" ] || continue
	AER_SEEN=1
	AER=$((AER + $(awk '{s+=$2} END{print s+0}' "$f" 2>/dev/null)))
done
if [ "$AER_SEEN" = 1 ]; then
	emit stability.aerCorrectable "$AER"
else
	unk stability.aerCorrectable "no readable PCIe AER counters"
fi
# `--plain` drops the leading bullet glyph systemctl puts on a failed unit's
# own row (measured: present under a real TTY, absent under --no-legend
# alone), which is what let a plain `wc -l` count rows safely but would have
# put the bullet into column 1 of a names list.
FAILED_UNITS_RAW=$(systemctl --failed --no-legend --no-pager --plain 2>/dev/null)
if [ -n "$FAILED_UNITS_RAW" ]; then
	FAILED_UNITS_COUNT=$(printf '%s\n' "$FAILED_UNITS_RAW" | grep -c .)
	FAILED_UNITS_NAMES=$(printf '%s\n' "$FAILED_UNITS_RAW" | awk '{print $1}' | tr '\n' ',' | sed 's/,$//')
else
	FAILED_UNITS_COUNT=0
	FAILED_UNITS_NAMES=""
fi
emit stability.failedUnits "$FAILED_UNITS_COUNT"
# THE NAMES BEHIND THE COUNT (#87 §4): a count alone cannot tell a dead runner
# unit from something benign without ssh-ing in, which is exactly the gap that
# issue named (claw-3 and claw-6 both read `failed units: 1` with no way to
# tell which). Comma-joined, same convention `disk.*.mountpoints` above uses
# for its own list-shaped value. Empty (not `unknown`) when the count is
# genuinely zero: systemctl ran and found nothing, which is a different answer
# from not being able to ask it at all.
emit stability.failedUnitNames "$FAILED_UNITS_NAMES"
# dmesg is root-only where kernel.dmesg_restrict=1, and `grep -c` of nothing is
# 0 — which would store an unreadable log as "no OOM kills" (#121).
if DMESG=$(dmesg 2>/dev/null); then
	emit stability.oomKills "$(printf '%s\n' "$DMESG" | grep -ci 'out of memory\|oom-kill')"
else
	unk stability.oomKills "dmesg unreadable (kernel.dmesg_restrict without root)"
fi

echo "BENCH-END $(cat /proc/sys/kernel/hostname 2>/dev/null)"
