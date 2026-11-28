#!/usr/bin/env bash
#
# hokon's production-path guard: the two ROOT steps (run by the operator).
#
#   sudo bash deploy/systemd/hokon-prod-guard/install.sh            # dry run (default)
#   sudo bash deploy/systemd/hokon-prod-guard/install.sh --apply    # both steps, no restart
#   sudo bash deploy/systemd/hokon-prod-guard/install.sh --restart-tailscaled
#                                   # the tailnet blips for a few seconds: only
#                                   # with no live prod match (ask cardtable)
#   sudo bash deploy/systemd/hokon-prod-guard/install.sh --undo     # both back
#
# 1. pm2-hadoku.service MemoryHigh 20G -> 26G. The 2026-11-28 09:33Z all-claw
#    loss was this cgroup (prod cardtable, cloudflared, mgmt-api AND the PPE
#    Forge JVMs) pinned at its own hand-set MemoryHigh=20G with its 4G swap
#    full, refaulting file cache at >1 GB/s (memory PSI 98% inside it).
#    805,886 memory.high events had piled up by then. Budget: pm2 26G + agent
#    panes capped at 24G (user-priority/app.slice.d/memory-cap.conf) + ~6G
#    for the rest of the box, of 61G. MemoryMax (32G) and swap (4G) unchanged.
#    The same set-property drop-in that holds 20G today is rewritten, so
#    nothing else shadows it. Applies live; nothing restarts.
# 2. tailscaled's logs onto tmpfs (tailscaled-logs-tmpfs.conf). Takes effect
#    at tailscaled's next start: --restart-tailscaled, at a quiet moment.
#
# Everything is read back from systemd and cgroupfs, never from this script.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
TS_DROPIN=/etc/systemd/system/tailscaled.service.d/70-logs-tmpfs.conf
PM2_HIGH_NEW=26G
PM2_HIGH_OLD=20G
CG=/sys/fs/cgroup/system.slice

mode="${1:-dry-run}"
case "$mode" in dry-run | --apply | --restart-tailscaled | --undo) ;; *) echo "unknown: $mode" >&2; exit 2 ;; esac
[ "$mode" = dry-run ] || [ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }

show() {
	echo "pm2-hadoku   MemoryHigh=$(systemctl show pm2-hadoku -p MemoryHigh --value) cgroup memory.high=$(cat $CG/pm2-hadoku.service/memory.high) current=$(($(cat $CG/pm2-hadoku.service/memory.current) / 1048576))M high-events=$(awk '/^high/{print $2}' $CG/pm2-hadoku.service/memory.events)"
	echo "tailscaled   TS_LOGS_DIR=$(tr '\0' '\n' 2>/dev/null </proc/"$(systemctl show tailscaled -p MainPID --value)"/environ | sed -n 's/^TS_LOGS_DIR=//p')  drop-in: $([ -f $TS_DROPIN ] && echo present || echo absent)  root-LV writes so far: $(awk '/^254:1/{print $3}' $CG/tailscaled.service/io.stat)"
}

claw_rtt() { # first tailnet TCP connect to each claw's agent port, in ms
	for ip in $(tailscale status 2>/dev/null | awk '$2 ~ /^claw-(8|9|10)$/ {print $1}'); do
		s=$(date +%s%N)
		if timeout 2 bash -c "</dev/tcp/$ip/7621" 2>/dev/null; then echo -n "$ip=$((($(date +%s%N) - s) / 1000000))ms "; else echo -n "$ip=down "; fi
	done
	echo
}

case "$mode" in
dry-run)
	echo "== now"; show
	echo "== --apply would"
	echo "  systemctl set-property pm2-hadoku.service MemoryHigh=$PM2_HIGH_NEW   (live; rewrites /etc/systemd/system.control/pm2-hadoku.service.d/50-MemoryHigh.conf)"
	if cmp -s "$SRC/tailscaled-logs-tmpfs.conf" $TS_DROPIN 2>/dev/null; then echo "  same   $TS_DROPIN"; else echo "  write  $TS_DROPIN  (+ daemon-reload; effective at tailscaled's next start)"; fi
	echo "== /var/lib/tailscale"; ls -la /var/lib/tailscale 2>/dev/null || echo "  (needs root to list)"
	;;
--apply)
	systemctl set-property pm2-hadoku.service MemoryHigh=$PM2_HIGH_NEW
	install -D -m 0644 "$SRC/tailscaled-logs-tmpfs.conf" $TS_DROPIN
	systemctl daemon-reload
	show
	echo "tailscaled picks up the log dir at its next start: --restart-tailscaled when prod is quiet."
	;;
--restart-tailscaled)
	[ -f $TS_DROPIN ] || { echo "run --apply first" >&2; exit 1; }
	echo "before: $(claw_rtt)"
	t0=$(date +%s%N)
	systemctl restart tailscaled
	until timeout 1 tailscale status >/dev/null 2>&1; do sleep 0.2; done
	for i in $(seq 1 50); do r=$(claw_rtt); case "$r" in *down*) sleep 0.2 ;; *) break ;; esac; done
	echo "after:  $r  (claws reachable $((($(date +%s%N) - t0) / 1000000)) ms after the restart began)"
	show
	ls -la /run/tailscale-logs
	;;
--undo)
	systemctl set-property pm2-hadoku.service MemoryHigh=$PM2_HIGH_OLD
	rm -f $TS_DROPIN
	systemctl daemon-reload
	show
	echo "tailscaled returns to /var/lib/tailscale for logs at its next start."
	;;
esac
