#!/usr/bin/env bash
# make-preseed-render — render_preseed itself, plus the two staleness checks
# that re-derive what it would currently write.
#
# Sourced, never executed, and only ever BY `lib/make-preseed.sh` (never
# directly by a checkout-resident script) — see that file for the sourcing
# contract and why a preseed exists at all.
#
# Split out of `make-preseed.sh` (wave 5t lane B, 800-line ceiling) as a pure
# move: every function body below is byte-identical to the original file.
# `render_preseed` alone is ~690 lines and stays under the ceiling on its own,
# so it was not split further — doing that would mean breaking its single
# rendered heredoc across files, which is exactly the kind of rewrite this
# split is not allowed to be.

# render_preseed <user> <pw-hash> <ssid> <psk> <authorized_key_file> <timezone>
#
# No hostname parameter, deliberately — see the netcfg block below.
render_preseed() {
	local user="$1" pwhash="$2" ssid="$3" psk="$4" keyfile="$5" tz="${6:-Etc/UTC}"
	local pubkey
	pubkey="$(head -1 "$keyfile")"

	# netcfg's wireless keys get the INSTALLER onto wifi. They do not survive
	# into the installed system, so a wifi-only node would come up after its
	# first reboot with no network and no way in — the exact shape of failure
	# this whole script exists to avoid. wpa_supplicant + systemd-networkd is
	# written directly because it needs no desktop stack and works on a
	# `standard`-task install with nothing added.
	# Only offer the wireless branch when there is something to associate with.
	# A wl* interface with no credentials is worse than no interface: netcfg
	# selects it, cannot associate, and reports the same failure as an unplugged
	# cable.
	# SINGLE-QUOTED, so nothing here expands when the variable is ASSIGNED.
	#
	# The first attempt used double quotes: '$(ls /sys/class/net ...)' ran on the
	# CONTROL HOST at render time and baked hokon's own 'wlp13s0' into the file,
	# and '$i' collapsed to a bare backslash. A variable's VALUE is not rescanned
	# for command substitution when it is interpolated, so quoting it here is
	# enough - the installer sees the literal command and runs it on the node.
	# TELEMETRY. The installer's logs live on a ramdisk that dies with it, so a
	# failed install has always left nothing behind — the operator photographs a
	# screen and we reason from a sentence. This writes the machine's own account
	# of itself to the CLAWKIT partition every few seconds, so a stick brought
	# back from a failure can be read.
	#
	# It is a background loop rather than a failure hook because d-i has no
	# failure hook: whatever it wrote last is what survives, including through a
	# hard power-off, which is why it syncs every pass.
	#
	# THE MOUNT IS TESTED, NOT ASSUMED. The first version ran
	# 'mount LABEL=CLAWKIT /clawkit' and guarded on '[ -d /clawkit ]' - a
	# directory mkdir had created one line earlier, so the guard was true
	# whether the mount worked or not, and the loop wrote into the installer's
	# ramdisk where everything died with it. The stick came back empty twice and
	# looked exactly as though the loop had never run.
	#
	# busybox mount, which is what the installer has, does not resolve LABEL=
	# either. So blkid is asked, a scan of the partition nodes is the fallback,
	# and the guard is /proc/mounts - the only thing that answers whether a
	# filesystem is actually there.
	#
	# DETACHED, AND BOUNDED. d-i runs early_command and CONSUMES its output. A
	# subshell backgrounded with a bare '&' inherits that pipe, so the parent
	# reads until EOF and EOF never arrives while a child holds the write end.
	# early_command never returns, the installer draws no screen, the console is
	# dead - and because early_command never returned, no telemetry is written
	# either. The instrument takes out the patient and then fails to record it.
	#
	# Measured 2026-08-30: reproducing the bare '&' under output capture hung a
	# test harness for two full minutes; the form below returns in 0s and the
	# loop keeps writing.
	#
	# So the inner subshell takes </dev/null and sends both streams to
	# /dev/null, dropping every inherited descriptor, and the outer '( ... ) &'
	# THE SYSLOG COPY IS CAPPED, and that is not tidiness.
	#
	# claw-4's install wrote a 854 MB syslog.txt onto a 1 GB partition - 7.5
	# million lines, 99.9% of them one repeating PCIe AER message from a failing
	# wifi card. It came within 50 MB of filling CLAWKIT, and had it filled, the
	# telemetry would have stopped and taken with it the ONLY evidence that
	# diagnosed the fault. A diagnostic that destroys its own medium under
	# exactly the conditions it exists to record is worse than none.
	#
	# Head and tail, middle elided, elision stated. The head holds the boot and
	# hardware detection, the tail holds whatever it died on, and the part that
	# gets dropped is the repetition that caused the problem.
	#
	# double-forks so nothing is left as a child. Bounded to 180 passes - thirty
	# minutes - because a telemetry loop that outlives what it was watching is a
	# process nobody remembers to kill.
	# `wired_interfaces` globs `e*` ALONE. It already matches en*, eth* and enx*,
	# so globbing both `e*` and `en*` counted every modern interface TWICE —
	# claw-7's two ports were reported as four, hokon's one as two. Caught
	# 2026-09-08 reading claw-7's install telemetry, which is the file that
	# diagnosed claw-5's six-install saga: a doubled interface count in the
	# diagnostic of last resort is exactly the wrong thing to get wrong.
	#
	# NOTHING INSIDE THE SINGLE-QUOTED STRING BELOW MAY CARRY AN APOSTROPHE.
	# The first attempt put this note in there and "claw-5's" closed the quote,
	# breaking the whole file — the same class as the backtick rule further down.
	local TELEMETRY
	TELEMETRY='mkdir -p /clawkit 2>/dev/null; \
    ( ( modprobe ext4 2>/dev/null; modprobe vfat 2>/dev/null; \
      T=0; \
      while [ $T -lt 60 ]; do \
        grep -q " /clawkit " /proc/mounts 2>/dev/null && break; \
        for p in /dev/disk/by-label/CLAWKIT /dev/sd?[0-9] /dev/sd?[0-9][0-9] /dev/nvme*p[0-9] /dev/mmcblk*p[0-9]; do \
          [ -e "$p" ] || continue; \
          mount -t ext4 "$p" /clawkit 2>/dev/null || mount "$p" /clawkit 2>/dev/null || continue; \
          [ -f /clawkit/bootstrap/node-bootstrap.sh ] && break; \
          umount /clawkit 2>/dev/null; \
        done; \
        grep -q " /clawkit " /proc/mounts 2>/dev/null && break; \
        T=$((T+1)); sleep 2; \
      done; \
      grep -q " /clawkit " /proc/mounts 2>/dev/null || exit 0; \
      D=/clawkit/telemetry/$(date -u +%Y%m%dT%H%M%SZ); \
      mkdir -p $D 2>/dev/null; \
      { echo "mounted after $T tries"; echo "kernel: $(uname -r)"; \
        echo "filesystems:"; cut -f2 /proc/filesystems 2>/dev/null | sed "s/^/  /"; \
      } > $D/mounted.txt; sync; \
      N=0; while [ $N -lt 180 ]; do \
          { echo "== $(date -u +%FT%TZ)"; \
            echo "-- links"; ip link 2>&1; \
            echo "-- addrs"; ip addr 2>&1; \
            echo "-- routes"; ip route 2>&1; \
            echo "-- wireless"; \
            for n in /sys/class/net/*; do \
              [ -d "$n/wireless" ] && echo "$(basename $n) is wireless"; \
            done; \
            cat /proc/net/wireless 2>/dev/null; \
          } > $D/network.txt 2>&1; \
          dmesg > $D/dmesg.txt 2>&1; \
          SZ=$(wc -c < /var/log/syslog 2>/dev/null || echo 0); \
          if [ "$SZ" -gt 8000000 ]; then \
            { head -c 3000000 /var/log/syslog; \
              printf "\n\n=== TELEMETRY CAP: %s bytes elided from the middle ===\n" "$((SZ-6000000))"; \
              printf "=== the head and tail are kept; the elided part is repetition ===\n\n"; \
              tail -c 3000000 /var/log/syslog; \
            } > $D/syslog.txt 2>/dev/null; \
          else \
            cp /var/log/syslog $D/syslog.txt 2>/dev/null; \
          fi; \
          { echo "vendor=$(cat /sys/class/dmi/id/sys_vendor 2>/dev/null)"; \
            echo "product=$(cat /sys/class/dmi/id/product_name 2>/dev/null)"; \
            echo "chassis_type=$(cat /sys/class/dmi/id/chassis_type 2>/dev/null)"; \
            echo "cpu_model=$(grep -m1 "^model name" /proc/cpuinfo | cut -d: -f2- | sed "s/^ //")"; \
            echo "cpu_threads=$(grep -c ^processor /proc/cpuinfo)"; \
            echo "mem_total_kb=$(grep -m1 MemTotal /proc/meminfo | tr -dc 0-9)"; \
            echo "battery=$(ls /sys/class/power_supply 2>/dev/null | grep -c BAT)"; \
            echo "lid_switch=$(ls /proc/acpi/button/lid 2>/dev/null | head -1)"; \
            echo "wireless_interfaces=$(ls -d /sys/class/net/*/wireless 2>/dev/null | wc -l)"; \
            echo "wired_interfaces=$(ls -d /sys/class/net/e* 2>/dev/null | wc -l)"; \
            for n in /sys/class/net/*; do \
              i=$(basename $n); [ "$i" = lo ] && continue; \
              echo "net.$i.carrier=$(cat $n/carrier 2>/dev/null)"; \
              echo "net.$i.operstate=$(cat $n/operstate 2>/dev/null)"; \
              echo "net.$i.wireless=$([ -d $n/wireless ] && echo 1 || echo 0)"; \
              echo "net.$i.pci=$(cat $n/device/vendor 2>/dev/null):$(cat $n/device/device 2>/dev/null)"; \
              echo "net.$i.driver=$(basename $(readlink -f $n/device/driver 2>/dev/null) 2>/dev/null)"; \
              echo "net.$i.mac=$(cat $n/address 2>/dev/null)"; \
            done; \
            for b in /sys/block/*; do \
              d=$(basename $b); \
              case $d in loop*|ram*|sr*|dm-*|zram*|md*) continue;; esac; \
              echo "disk.$d.bytes=$(( $(cat $b/size 2>/dev/null || echo 0) * 512 ))"; \
              echo "disk.$d.rotational=$(cat $b/queue/rotational 2>/dev/null)"; \
              echo "disk.$d.model=$(cat $b/device/model 2>/dev/null)"; \
            done; \
            for d in /sys/bus/pci/devices/*; do \
              echo "pci.$(basename $d)=$(cat $d/vendor 2>/dev/null):$(cat $d/device 2>/dev/null) class=$(cat $d/class 2>/dev/null)"; \
            done; \
            for d in /sys/bus/usb/devices/*; do \
              [ -f "$d/idVendor" ] || continue; \
              echo "usb.$(basename $d)=$(cat $d/idVendor 2>/dev/null):$(cat $d/idProduct 2>/dev/null) $(cat $d/product 2>/dev/null)"; \
            done; \
          } > $D/hardware.txt 2>&1; \
          sync; N=$((N+1)); sleep 10; \
      done ) </dev/null >/dev/null 2>&1 & ) & '

	# ── THE CLAW-4 INSTALL KILLER, DISARMED BEFORE IT FIRES ────────────────────
	#
	# Section 10 of claw-4-install-postmortem-2026-09-01.md: a Realtek RTL8723BE
	# behind PCI Express Root Port #1 threw 2,307,238 CORRECTABLE AER errors. The
	# storm consumed enough bus and log bandwidth that USB reads timed out,
	# /dev/sdc1 stopped opening, Ventoy's dm-linear window over an extent on that
	# device died with it, and pkgsel lost its media with no in-place recovery.
	# Two hours, and the storm was first blamed on Ventoy -- acting on THAT
	# diagnosis would have cost a rewrite of the whole imaging toolchain and fixed
	# nothing. It also wrote an 854 MB syslog onto a 1 GB partition, coming within
	# 50 MB of destroying the only evidence that explained it.
	#
	# PCIe ASPM is the documented trigger for that card's error storms, so ASPM is
	# turned off here -- in early_command, which runs BEFORE netcfg and long
	# before pkgsel, so the mitigation is in place before the window in which the
	# fault actually killed the install.
	#
	# UNCONDITIONAL, AND NOT KEYED ON THE CARD. Three reasons. It cannot be keyed
	# on a storm, because a storm is only visible after it has been building for a
	# while and by then the install is already dying. It should not be keyed on a
	# model list, because the next bad card is the one not on the list -- and this
	# fleet has met exactly one so far, which is not a population to generalise
	# from. And the cost of being wrong is close to zero in this direction: ASPM is
	# a LINK POWER-SAVING feature, so disabling it costs a little idle power on a
	# machine whose entire job is to be awake and building, against a failure mode
	# that has already cost two hours and nearly the toolchain.
	#
	# NOTHING IS REMOVED. This is deliberately not a driver blacklist: claw-7 is
	# imaged with a radio it is expected to USE as its fallback link, and
	# blacklisting the module would trade a broken install for a node that cannot
	# come back when its cable is pulled. The card keeps working; only the link
	# power state changes.
	#
	# COUNTING AER ERRORS HERE WAS CUT, DELIBERATELY. A first version also summed
	# /sys/bus/pci/devices/*/aer_dev_correctable and logged a storm, which needed
	# an awk program nested inside a double-quoted string inside a single-quoted
	# shell assignment inside an unquoted heredoc. early_command is the most
	# dangerous script in this system -- it runs in a busybox initrd, d-i CONSUMES
	# its output, and this file's own history is a list of things that hang or
	# mangle text there: a bare `&` that made the installer read until an EOF that
	# never came, `logger` with no argument reading stdin forever, busybox `tr`
	# silently eating every letter `n`. Detection is not worth any of that risk,
	# because node-bootstrap's preflight already counts the same registers in a
	# real shell where a mistake is visible. What belongs here is the one line
	# that has to happen BEFORE pkgsel, and nothing else.
	#
	# Best-effort by design. The policy file is absent on a kernel without
	# CONFIG_PCIEASPM and read-only under some configurations, and neither is a
	# reason to stop an install -- so it reports what it managed and carries on.
	local ASPM_FIX
	ASPM_FIX='if [ -w /sys/module/pcie_aspm/parameters/policy ]; then \
      echo performance > /sys/module/pcie_aspm/parameters/policy 2>/dev/null; \
      logger -t fleet "aspm policy now $(cat /sys/module/pcie_aspm/parameters/policy 2>/dev/null)"; \
    else \
      logger -t fleet "aspm policy not writable - correctable-error storms are NOT mitigated"; \
    fi;'

	# ── §6.10: A RETRY MUST NOT INHERIT A DIRTY /target ────────────────────────
	#
	# claw-9, 2026-09-21, attempt 2: debootstrap died mid-unpack on corrupted
	# media (localedef segfault, then xz/zstd decompression failures on the
	# kernel package — see docs/planning/claw-9-install-20260921-and-6.1-decision-2026-10-01.md
	# §2). d-i re-ran the SAME menu item on the SAME half-unpacked /target three
	# more times, every retry hitting `tar: can't open './usr/share/doc/...':
	# File exists` — base-installer has no `base-installer/early_command` hook
	# (confirmed: that debconf template does not exist in a modern d-i; only
	# `base-config/early_command` did, and base-config itself is gone) and a
	# failed component drops debconf's priority so the OPERATOR picks "Retry"
	# from main-menu — this is NOT an automatic loop this file can intercept at
	# the point of retry.
	#
	# So the fix runs the other side of the race: a background watchdog,
	# shaped exactly like TELEMETRY above (same double-fork, same bound, same
	# reason — early_command's output pipe must never be held open), watches
	# /var/log/syslog for the two debconf error names the postmortem's
	# telemetry actually shows (`base-installer/debootstrap-failed`,
	# `base-installer/kernel/failed-install`) and wipes /target the MOMENT one
	# appears — before the operator has finished reading the screen, let alone
	# selected Retry. "Stop with a clear message" is covered too: the wipe is
	# announced on /dev/console, not just syslog, so what happened is visible
	# without a telemetry dive.
	#
	# ONLY NEW SYSLOG CONTENT IS EXAMINED each pass (line-count watermark, not a
	# bare grep), or the fix would refire forever once the line it is looking
	# for exists: syslog is append-only and never shrinks mid-install.
	#
	# `rm -rf` DOES NOT STOP AT A MOUNT POINT — busybox has no --one-file-system
	# — and by the time base-installer fails, /target routinely has
	# /target/proc, /target/sys (and on EFI hardware,
	# /target/sys/firmware/efi/efivars underneath THAT), a /target/dev bind,
	# and /target/boot/efi all mounted. Walking into efivars does not just read
	# a directory, it deletes real NVRAM boot variables on the machine; walking
	# into a /dev bind deletes the INSTALLER'S OWN device nodes, since a bind
	# mount is the same inodes, not a copy. So every mount strictly below
	# $TGT is unmounted FIRST, re-read from $MOUNTS_SRC, and the wipe proceeds
	# only when NONE remain — if anything cannot be cleared, nothing is
	# deleted and the reason is said on the console, not just logged.
	#
	# The bounded retry loop (not a single deepest-first pass) handles nesting
	# order for free: unmounting a parent while a child is still mounted on it
	# just fails that one `umount` harmlessly, and the next pass catches it
	# once the child is gone — no depth arithmetic needed. `umount -l` (lazy)
	# is tried only after a plain `umount` fails, and is safe here
	# specifically BECAUSE it is lazy: it detaches the mountpoint from the
	# namespace immediately, so the next build of $MOUNTS_SRC always reports
	# it gone — it cannot un-protect data that is still busy, because
	# whatever `rm -rf` sees afterward at that path is $TGT's OWN underlying
	# directory, not the live content of whatever was mounted there.
	#
	# `$MOUNTS_SRC` defaults to `/proc/mounts` and is overridden only by the
	# test (`FLEET_TG_MOUNTS`), the same way `$FLEET_TG_TARGET` already is —
	# a fake mounts file lets the "a nested mount will not clear" case be
	# driven without root and without a real mount.
	#
	# NO awk. The rest of this file's d-i-side blocks never use it (grep/sed/
	# cut/parameter expansion only), and awk's own `$2`/`$0` field syntax
	# collides with needing single-quote protection from the SAME shell that
	# is meant to interpolate $TGT around it — and this whole string is itself
	# bash-single-quoted, which cannot contain a literal apostrophe at all (see
	# the apostrophe rule elsewhere in this file). Plain `grep`/`cut` on
	# `/proc/mounts`'s fixed space-separated columns avoids the problem
	# entirely instead of fighting it.
	#
	# THE CHECK ITSELF IS ISOLATED BETWEEN TWO `:` SENTINELS
	# (`TARGET-GUARD-CHECK-BEGIN`/`-END`). `:` is the shell no-op builtin, so
	# these are inert at runtime; they exist so make-preseed.test.mjs can slice
	# out exactly this span and EXECUTE it against a fake $FLEET_TG_TARGET and
	# $FLEET_TG_MOUNTS, which is how the safety property is mutation-tested
	# rather than merely pattern-matched. Both default to the real paths in
	# production and are overridden only by the test.
	local TARGET_GUARD
	TARGET_GUARD='( ( T=0; SEEN=0; \
      while [ $T -lt 360 ]; do \
        CUR=$(wc -l < /var/log/syslog 2>/dev/null || echo 0); \
        if [ "$CUR" -gt "$SEEN" ]; then \
          NEWSLICE=$(sed -n "$((SEEN+1)),\$p" /var/log/syslog 2>/dev/null); \
          SEEN=$CUR; \
          if printf "%s\n" "$NEWSLICE" | grep -qE "base-installer/debootstrap-failed|base-installer/kernel/failed-install"; then \
            : TARGET-GUARD-CHECK-BEGIN ; \
            TGT="${FLEET_TG_TARGET:-/target}"; \
            MOUNTS_SRC="${FLEET_TG_MOUNTS:-/proc/mounts}"; \
            if [ -n "$(ls -A "$TGT" 2>/dev/null)" ]; then \
              logger -t fleet "dirty target after a failed bootstrap-base - wiping before the next retry"; \
              P=0; \
              while [ $P -lt 10 ]; do \
                NESTED=$(grep " $TGT/" "$MOUNTS_SRC" 2>/dev/null | cut -d" " -f2); \
                [ -n "$NESTED" ] || break; \
                for MP in $NESTED; do \
                  umount "$MP" 2>/dev/null || umount -l "$MP" 2>/dev/null || true; \
                done; \
                P=$((P+1)); \
              done; \
              STILL=$(grep " $TGT/" "$MOUNTS_SRC" 2>/dev/null | cut -d" " -f2); \
              if [ -n "$STILL" ]; then \
                logger -t fleet "could not clear every mount under $TGT before wiping - refusing: $STILL"; \
                printf "\n!! %s is dirty after a failed bootstrap-base, but something is still\n!! mounted beneath it (%s) - refusing to delete anything.\n!! Clear it by hand, then retry.\n\n" "$TGT" "$STILL" >/dev/console 2>/dev/null || true; \
              else \
                rm -rf "$TGT"/* "$TGT"/.[!.]* "$TGT"/..?* 2>/dev/null; \
                logger -t fleet "target cleaned - safe to retry"; \
                printf "\n!! bootstrap-base failed and left %s dirty.\n!! It has been wiped automatically - the next retry starts clean.\n\n" "$TGT" >/dev/console 2>/dev/null || true; \
              fi; \
            fi; \
            : TARGET-GUARD-CHECK-END ; \
          fi; \
        fi; \
        T=$((T+1)); sleep 5; \
      done ) </dev/null >/dev/null 2>&1 & ) & '

	local WIFI_PICK=""
	if [ -n "$ssid" ]; then
		WIFI_PICK='for i in $(ls /sys/class/net | grep -E "^wl"); do \
      logger -t fleet "picking wireless $i (credentials preloaded)"; \
      debconf-set netcfg/choose_interface $i; exit 0; \
    done; '
	fi

	# THE claw-5 FAILURE, PREVENTED.
	#
	# netcfg writes an interfaces stanza for the interface it was told to
	# configure, and if networking is skipped during the install it is told
	# none — so the installed system holds nothing but loopback. The box then
	# boots with a live ethernet port, you plug a cable in, and NOTHING HAPPENS,
	# because no DHCP client has ever been told that interface exists. That is
	# exactly the state claw-5 came up in, and the reason fixes/claw-fix.sh
	# had to be written.
	#
	# This only fires when d-i wrote no wired stanza at all, and only for an
	# interface that has a CARRIER right now — so it can neither fight netcfg's
	# own configuration nor invent one for a port with nothing in it. Run
	# against /target from the installer, not `in-target`, because the carrier
	# lives in the installer's /sys.
	local WIRED_LATE
	WIRED_LATE='if ! grep -qE "^[[:space:]]*iface[[:space:]]+(en|eth)" /target/etc/network/interfaces 2>/dev/null; then \
      for i in $(ls /sys/class/net | grep -E "^(en|eth)"); do \
        if [ "$(cat /sys/class/net/$i/carrier 2>/dev/null)" = 1 ]; then \
          printf "\nauto %s\niface %s inet dhcp\n" "$i" "$i" >> /target/etc/network/interfaces; \
          logger -t fleet "late: wrote fallback dhcp stanza for $i"; \
          break; \
        fi; \
      done; \
    fi'

	# `wlan0` DOES NOT EXIST ON THESE BOXES, and this block named it three times.
	#
	# Debian trixie uses predictable interface names and nothing here sets
	# net.ifnames=0, so the radio comes up as `wlp3s0` or similar. The
	# inconsistency was visible inside this very function: WIFI_PICK above
	# DERIVES the name (`ls /sys/class/net | grep -E "^wl"`) and hands the real
	# one to netcfg, and then this block hardcoded `wlan0` for the config
	# filename and the unit instance. The `[Match] Name=wl*` line matched
	# correctly, which is what made the failure so quiet: networkd would ask for
	# DHCP on a radio that `wpa_supplicant@wlan0` had never associated, so the
	# box came up with a wireless interface, no association, and a unit that
	# failed to start under a name nobody would think to look for.
	#
	# It has never fired in anger — claw-5 has no radio and claw-1/2/3 predate
	# this file — so claw-7 would have been the first box to find it, at the
	# console, which is the most expensive place in this system to find anything.
	#
	# DERIVED WITH SHELL BUILTINS ONLY. No basename, no dirname, no `ip -br`, no
	# `iw`: late_command runs in the installer, and this file's own history is a
	# list of things that are not there or behave differently when they are — the
	# claw-5 telemetry capture was three `iw: not found` usage messages, and
	# busybox `tr` silently ate every letter `n` out of the disk models.
	# `${d%/wireless}` and `${p##*/}` are POSIX parameter expansion and need
	# nothing but the shell.
	#
	# EVERY `$` THAT MUST REACH THE NODE IS ESCAPED. This assignment is DOUBLE
	# quoted (it interpolates $ssid and $psk), unlike WIRED_LATE above which is
	# single quoted and can use $i freely. An unescaped $W here would expand on
	# the CONTROL HOST at render time and bake in an empty string — the same
	# mistake this function's WIFI_PICK comment records, where a command
	# substitution ran on hokon and baked in hokon's own `wlp13s0`.
	local WIFI_LATE=""
	if [ -n "$ssid" ]; then
		WIFI_LATE=" ; \\
    in-target sh -c 'apt-get install -y wpasupplicant >/dev/null 2>&1 || true' ; \\
    W='' ; for d in /sys/class/net/*/wireless; do [ -e \"\$d\" ] || continue; p=\${d%/wireless}; W=\${p##*/}; break; done ; \\
    if [ -n \"\$W\" ]; then \\
      logger -t fleet \"late: wireless interface is \$W\" ; \\
      printf '%s\\n' 'ctrl_interface=/run/wpa_supplicant' 'update_config=1' 'network={' '  ssid=\"$ssid\"' '  psk=\"$psk\"' '  key_mgmt=WPA-PSK' '}' > /target/etc/wpa_supplicant/wpa_supplicant-\$W.conf ; \\
      in-target chmod 600 /etc/wpa_supplicant/wpa_supplicant-\$W.conf ; \\
      printf '%s\\n' '[Match]' 'Name=wl*' '' '[Network]' 'DHCP=yes' > /target/etc/systemd/network/25-wireless.network ; \\
      in-target systemctl enable wpa_supplicant@\$W ; \\
      in-target systemctl enable systemd-networkd ; \\
    else \\
      logger -t fleet 'late: NO wireless interface in the installer - wrote no wifi config' ; \\
      printf '%s\\n' 'The installer saw no wireless interface, so no wifi config was written.' 'A radio needing an out-of-tree driver (any Broadcom card) is invisible here:' 'the module is built by DKMS after first boot, and the interface appears then.' 'node-bootstrap.sh section 5f installs the driver and 11b configures the radio.' > /target/etc/fleet-wifi-deferred ; \\
      printf '%s\\n' '[fleet] no wireless interface in the installer - wifi deferred to node-bootstrap' > /dev/console 2>/dev/null || true ; \\
    fi"
	fi

	# NO BACKTICKS BELOW THIS LINE.
	#
	# This heredoc is UNQUOTED, because it interpolates $user, $host and the key.
	# That also makes every backtick a command substitution — run as root, since
	# `fleet onboard` re-execs under sudo. Five comments used backticks for code
	# style and were silently EXECUTED at render time, leaving holes in the
	# generated file where the words should have been.
	#
	# Quoting the delimiter would fix the execution and break the interpolation
	# this file exists for, so the rule is simply: single quotes in the prose.
	# `make-preseed.test.mjs` fails if a backtick reappears here.
	cat <<PRESEED
# Generated by fleet onboard on $(date -u +%Y-%m-%dT%H:%M:%SZ). Do not hand-edit;
# rebuild the stick instead. Boot with: auto=true priority=critical

### Locale, keyboard, clock — fleet-wide, never per node.
d-i debian-installer/locale string en_US.UTF-8
d-i keyboard-configuration/xkb-keymap select us
d-i time/zone string $tz
d-i clock-setup/utc boolean true
d-i clock-setup/ntp boolean true

### Network.
# CHOOSE THE INTERFACE BY LOOKING, NOT BY GUESSING.
#
# 'choose_interface auto' takes the first interface with a carrier, which on a
# box with an ethernet port and no cable is a coin flip.
#
# early_command runs BEFORE netcfg, in the installer environment, so the node
# chooses for itself: a wired link that is actually up wins, a wireless
# interface is used only when credentials were preloaded, and if neither holds
# it falls through to asking rather than choosing wrong.
#
# It writes what it decided to /var/log/syslog, so the reason is on the box even
# when the screen only says autoconfiguration failed.
d-i preseed/early_command string \\
    ${TELEMETRY}\\
    ${ASPM_FIX}\\
    ${TARGET_GUARD}\\
    for i in \$(ls /sys/class/net | grep -E '^(en|eth)'); do \\
      if [ "\$(cat /sys/class/net/\$i/carrier 2>/dev/null)" = 1 ]; then \\
        logger -t fleet "picking wired \$i (carrier up)"; \\
        debconf-set netcfg/choose_interface \$i; exit 0; \\
      fi; \\
    done; \\
    logger -t fleet "no wired carrier"; \\
    ${WIFI_PICK}\\
    logger -t fleet "no usable interface chosen - netcfg will ask"

d-i netcfg/choose_interface select auto
# THE HOSTNAME IS THE ONE QUESTION THIS STICK MUST NOT ANSWER.
#
# One stick images many nodes. A name baked in here would be given to every one
# of them, and two machines answering to the same name is a fleet that reports
# one machine flapping.
#
# 'seen false' resets debconf's seen flag, so the question is asked even though
# everything around it is automated. The value below is only the default offered
# in the box.
#
# THE INSTALLER DOES NOT ASK THIS. Measured on claw-5, 2026-09-01.
#
# 'seen false' asks d-i to re-ask a preseeded question, but Ventoy's auto_install
# boots Debian with 'priority=critical', and the priority filter suppresses
# everything below critical no matter what 'seen' says — netcfg/get_hostname is
# priority HIGH. So every node imaged from this stick comes up as 'localhost'.
#
# That is survivable, and deliberately so: the fallback is a name
# node-bootstrap.sh treats as "nobody named this box", and it ASKS at the
# console, then writes the hostname and /etc/hosts together. Naming a node is
# one question either way; asking it during bootstrap is better, because that is
# where /etc/hosts gets written in the same breath.
#
# 'localhost' rather than a distro name: the profile already records the distro,
# and this placeholder should not.
d-i netcfg/get_hostname string localhost
d-i netcfg/get_hostname seen false
d-i netcfg/hostname seen false
d-i netcfg/get_domain string
d-i netcfg/get_domain seen false
# THE INSTALL WANTS ETHERNET. THE NODE CAN RUN ON WIFI.
#
# A netinst image carries almost nothing: 'standard', openssh-server, sudo,
# curl and jq all come from the mirror, so no network means no install, and the
# failure surfaces twice — once at network config and again at package
# selection.
#
# Wired is preferred when it has a carrier: partitioning a disk and negotiating
# WPA at the same time has two ways to fail and one of them is silent. Wifi
# credentials are written into the INSTALLED system by late_command below, so a
# wifi node is reachable from its first boot either way.
#
# 30s because a switch still bringing a port up loses a shorter race.
d-i netcfg/link_wait_timeout string 30
d-i netcfg/dhcp_timeout string 60
# netcfg/dhcp_options is deliberately NOT preseeded.
#
# It is the menu shown AFTER a DHCP failure, so preseeding it answers "what
# now?" the same way every time. Setting it to retry turns a link that will
# never get a lease into an infinite loop, with the installer trying and failing
# and trying again and no way out but the menu it was told not to show.
#
# Left unset, the operator gets the choice once: retry, configure manually, or
# do not configure the network. That is a decision only someone standing at the
# machine can make.
$(
		if [ -n "$ssid" ]; then
			cat <<WIFI
# Best-effort only — see the note above on interface selection. These apply if
# netcfg chose the wireless interface, and are harmless if it did not.
d-i netcfg/wireless_essid string $ssid
d-i netcfg/wireless_essid_again string $ssid
d-i netcfg/wireless_security_type select wpa
d-i netcfg/wireless_wpa string $psk
WIFI
		else
			echo "# no wifi credentials were given — this node is ethernet-only"
		fi
	)

### Mirror. Never the CD.
d-i mirror/country string manual
d-i mirror/http/hostname string deb.debian.org
d-i mirror/http/directory string /debian
d-i mirror/http/proxy string

### Accounts. Root is locked; the fleet user holds passwordless sudo, which
### provision-fleet.mjs requires to write system units remotely.
d-i passwd/root-login boolean false
d-i passwd/user-fullname string $user
d-i passwd/username string $user
d-i passwd/user-password-crypted password $pwhash
d-i user-setup/allow-password-weak boolean true
d-i user-setup/encrypt-home boolean false

### Partitioning. NOTE the absent partman-auto/disk — see the header.
d-i partman-auto/method string regular
d-i partman-auto/choose_recipe select atomic
d-i partman-partitioning/confirm_write_new_label boolean true
d-i partman/choose_partition select finish
d-i partman/confirm boolean true
d-i partman/confirm_nooverwrite boolean true
d-i partman-efi/non_efi_system boolean true
d-i partman-partitioning/choose_label string gpt

### The loop-mounted ISO must never become an apt source. If it does, package
### selection later asks for a disc that no longer exists and the install stops.
d-i apt-setup/cdrom/set-first boolean false
d-i apt-setup/cdrom/set-next boolean false
d-i apt-setup/cdrom/set-failed boolean false
d-i apt-setup/disable-cdrom-entries boolean true
d-i apt-setup/use_mirror boolean true
d-i apt-setup/services-select multiselect security, updates
d-i apt-setup/contrib boolean true
d-i apt-setup/non-free-firmware boolean true

### Packages. THE SMALLEST THING THAT COMES UP REACHABLE.
###
### Everything here crosses the network after partitioning, so a link that drops
### late throws away a finished base system. tasksel 'standard' is ~200 packages
### and a full-upgrade re-downloads what the ISO already shipped; neither is
### needed for a node whose next step is an ssh session. openssh-server and sudo
### are on the media, so this install can finish on a poor link.
###
### node-bootstrap.sh installs the rest over ssh, where a failed apt is a retry
### rather than a drive to the machine.
###
### popularity-contest is disabled because configuring it sends apt back to the
### install media.
popularity-contest popularity-contest/participate boolean false
tasksel tasksel/first multiselect
d-i pkgsel/include string openssh-server sudo systemd-timesyncd
d-i pkgsel/upgrade select none
d-i pkgsel/update-policy select none

### Bootloader.
###
### 'bootdev string default' is the line that cost claw-9 an evening, two SSDs
### written off as dead, and a 1 TB spinning disk it is still running its root
### filesystem from.
###
### 'default' does NOT mean "the disk this install just partitioned". It means
### the FIRST disk d-i enumerates. On every claw before claw-9 those were the
### same disk, because every one of them had exactly one. claw-9 was built in
### its predecessor's chassis with that predecessor's old drive still cabled, so
### the first disk was a 1 TB leftover carrying a GPT label from a previous
### install, while '/' went to the 240 GB SSD. The installer's own syslog says
### it plainly:
###
###   grub-installer: info: Identified partition label for /dev/sdb1: msdos
###   grub-install: warning: this GPT partition label contains no BIOS Boot
###                 Partition; embedding won't be possible.
###   grub-install: error: embedding is not possible, but this is required for
###                 cross-disk install.
###   error: Running 'grub-install  --force "/dev/sda"' failed.
###
### "cross-disk install" is the whole diagnosis and it arrives forty minutes in,
### phrased as a partition-table complaint about a disk the operator never
### chose. It reads as a failing drive. It is not one: both SSDs blamed that
### night were healthy.
###
### So the disk is PINNED, by 'partman/early_command' below, to the one fixed
### disk in the box — and when there is more than one, the install stops in the
### first ten seconds and says which, instead of failing at the last step and
### blaming the hardware. 'partman-auto/disk' is deliberately left to ask (see
### the header), so d-i cannot be told the target up front; what it CAN be told
### is that a guess between several disks is not allowed.
d-i grub-installer/only_debian boolean true
d-i grub-installer/with_other_os boolean true

### Pin the boot disk when there is only one it can be. See the note above.
###
### Runs before partitioning, which is the last moment this is free: no
### filesystem has been written yet. 'list-devices disk' is d-i's own
### enumerator; removable devices are dropped so the install stick itself is
### never a candidate.
###
### ONE fixed disk is the fleet's normal case and every claw before claw-9 had
### it. There the pin is exact and replaces a guess that happened to be right.
###
### SEVERAL fixed disks is the case that broke, and this does NOT pretend to
### fix it. It warns — on the console, in syslog, and therefore in the telemetry
### the stick collects on a failed install — and leaves 'bootdev' unset so d-i
### behaves as it always has. A hard refusal belongs here, but whether a
### non-zero 'partman/early_command' actually ABORTS d-i or is merely logged is
### not something this file's author has observed, and a guard that is claimed
### to stop an install and silently does not is worse than the warning it
### replaced. The operator-facing instruction — disconnect every disk but the
### target before installing — is carried where it is certain to be read, in
### usb-prep's console steps.
d-i partman/early_command string \
  fixed=""; \
  for dev in \$(list-devices disk); do \
    base=\$(basename "\$dev"); \
    [ "\$(cat /sys/block/\$base/removable 2>/dev/null)" = "1" ] && continue; \
    fixed="\$fixed \$dev"; \
  done; \
  set -- \$fixed; \
  if [ \$# -eq 1 ]; then \
    debconf-set grub-installer/bootdev "\$1"; \
    logger -t fleet-preseed "bootdev pinned to \$1 (sole fixed disk)"; \
  else \
    detail=""; \
    for dev in \$fixed; do \
      base=\$(basename "\$dev"); \
      sz=\$(( \$(cat /sys/block/\$base/size 2>/dev/null || echo 0) / 2097152 )); \
      detail="\$detail \$dev(\${sz}GB)"; \
    done; \
    logger -t fleet-preseed "WARNING \$# fixed disks:\$detail - grub may target the wrong one"; \
    printf '\n!! %s fixed disks present:%s\n!! GRUB will be installed to the FIRST of them, which may not be\n!! the disk you are about to install onto. If this install ends in\n!! "embedding is not possible", that is why. Power off, disconnect\n!! every disk except the target, and start again.\n\n' "\$#" "\$detail" >/dev/console 2>/dev/null || true; \
  fi

### Reboot without the "installation complete" prompt.
d-i finish-install/reboot_in_progress note

### The node must be REACHABLE the moment it boots.
###
### Without this the operator has a box that needs a console for every further
### step. With it, node-bootstrap.sh can be run over ssh — and the console stays
### plugged in only for the ssh-hardening step, which is the one that can
### actually lock you out.
d-i preseed/late_command string \\
    in-target mkdir -p /home/$user/.ssh ; \\
    echo '$pubkey' > /target/home/$user/.ssh/authorized_keys ; \\
    in-target chown -R $user:$user /home/$user/.ssh ; \\
    in-target chmod 700 /home/$user/.ssh ; \\
    in-target chmod 600 /home/$user/.ssh/authorized_keys ; \\
    echo '$user ALL=(ALL) NOPASSWD:ALL' > /target/etc/sudoers.d/90-$user ; \\
    in-target chmod 440 /etc/sudoers.d/90-$user ; \\
    in-target systemctl enable ssh ; \\
    ${WIRED_LATE}${WIFI_LATE}
PRESEED
}

# preseed_rerender <file> — read the OPERATOR-SUPPLIED values back out of an
# ALREADY-RENDERED preseed (user, password hash, wifi, timezone, pubkey) and
# feed them through THIS CHECKOUT's render_preseed. The result is stdout: what
# the CURRENT generator would write for the SAME node.
#
# Same move as stick-stamp.sh's stamp_compare, for the same reason: a version
# string a writer left behind is the writer's own claim about itself, which is
# not evidence. Re-derive from the inputs that are actually on the file and
# diff the output, rather than reading a number.
#
# Returns 2 on stdout-nothing when the file carries no username line — that is
# not "current", it is "not a preseed this function can read".
preseed_rerender() {
	local file="$1" user hash ssid psk tz pubkey keyfile out
	[ -f "$file" ] || return 2
	user="$(sed -n 's/^d-i passwd\/username string //p' "$file" | head -1)"
	[ -n "$user" ] || return 2
	hash="$(sed -n 's/^d-i passwd\/user-password-crypted password //p' "$file" | head -1)"
	ssid="$(sed -n 's/^d-i netcfg\/wireless_essid string //p' "$file" | head -1)"
	psk="$(sed -n 's/^d-i netcfg\/wireless_wpa string //p' "$file" | head -1)"
	tz="$(sed -n 's/^d-i time\/zone string //p' "$file" | head -1)"
	# late_command's authorized_keys line is the only place the pubkey survives
	# rendering. No apostrophe can appear in an ssh public-key line (type +
	# base64 + comment), so a single quote is a safe delimiter here — the same
	# assumption render_preseed's own output relies on.
	pubkey="$(sed -n "s#.*echo '\\(ssh-[^']*\\)' > /target/home/[^/]*/\\.ssh/authorized_keys.*#\\1#p" "$file" | head -1)"
	keyfile="$(mktemp)"
	printf '%s\n' "$pubkey" >"$keyfile"
	out="$(render_preseed "$user" "$hash" "$ssid" "$psk" "$keyfile" "${tz:-Etc/UTC}")"
	rm -f "$keyfile"
	printf '%s\n' "$out"
}

# preseed_is_stale <file> — 0 current, 1 STALE, 2 could not tell.
#
# The rendered file's first line carries a render timestamp
# ("# Generated by fleet onboard on ...") that can never match a re-render, so
# it is the one line dropped from both sides before comparing. Everything else
# is deterministic in the inputs.
#
# Verified against a real stick on 2026-10-01: re-rendering its preseed.cfg
# (last written 2026-09-08) with this checkout's generator and dropping only
# that line produced an EXACT match on every line the two had in common, and a
# clean, readable diff everywhere they did not — missing the 2026-09-20
# grub/bootdev-pin fix (`f0ddc3b`) and the 2026-09-26 wifi-interface fix
# (`67a9a00`), both landed after that preseed was last written. That gap is
# what let claw-9's grub-installer fail with "cross-disk install" on
# 2026-09-21: the pin that would have caught two fixed disks was not on the
# stick that night.
preseed_is_stale() {
	local file="$1" fresh have want
	fresh="$(preseed_rerender "$file")" || return 2
	have="$(grep -v '^# Generated by fleet onboard on' "$file")"
	want="$(printf '%s\n' "$fresh" | grep -v '^# Generated by fleet onboard on')"
	[ -n "$have" ] && [ -n "$want" ] || return 2
	[ "$have" = "$want" ] && return 0
	return 1
}

