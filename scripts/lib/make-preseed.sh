#!/usr/bin/env bash
# make-preseed — emit the Debian preseed that makes an install ask nothing.
#
# Sourced, never executed:  . lib/make-preseed.sh  then  render_preseed > file
#
# WHY A PRESEED AT ALL
# --------------------
# A stock netinst asks about fifteen questions, every one of which has the same
# answer on every node in this fleet, and one of them broke a real install on
# 2026-08-30: `[!!] Configuring popularity-contest — /media/cdrom/: Please
# insert the disc labeled … Media change`.
#
# That is not a disk being unmounted, which is what it looks like. The installer
# had registered the VENTOY-LOOPMOUNTED ISO as an apt "cdrom" source; during
# pkgsel it went back to that source and the loop device was no longer there.
# `apt-setup/disable-cdrom-entries` below is the fix, and it is the single most
# load-bearing line in this file.
#
# WHAT IS DELIBERATELY LEFT TO ASK
# --------------------------------
# The target disk, and ONLY when the box has more than one. `partman-auto/disk`
# is intentionally NOT set: with one disk d-i takes it silently, with several it
# asks. Preseeding it would mean this stick, booted on the wrong machine,
# repartitions it with no prompt — a fleet stick lives in a drawer and gets
# picked up by whoever is nearest.
#
# Everything else is a fleet decision, not a node decision, so it is answered
# here once.
#
# SECRETS: the wifi PSK and the password hash are written onto the CLAWKIT
# partition, which is unencrypted. Whoever holds the stick holds them. That is
# the same trust boundary as the ssh private key the fleet already relies on,
# and it is stated in README.txt on the stick rather than left implied.

# SPLIT ACROSS FILES (wave 5t lane B, 800-line ceiling): this file is now a
# thin entry point. `render_preseed` and its staleness checks live in
# `make-preseed-render.sh`; the §6.1 netinst-partition functions (raw-ISO
# partition layout, its GRUB menu, the preseed-as-initrd-cpio delivery) live
# in `make-preseed-netinst.sh`. Every caller still does exactly
# `. "$HERE/lib/make-preseed.sh"` and gets every function unchanged.
#
# RESOLVED FROM `${BASH_SOURCE[0]}`, NOT `$0`. This file is sourced, never
# executed — the four callers already say so at the top of each of theirs —
# so `$0` is whatever THEY were invoked as (node-usb-prep.sh, onboarding.sh,
# verify-stick.sh, refresh-preseed.sh, or a test's `bash -c` wrapper), not
# this file's own path. `${BASH_SOURCE[0]}` is this file's path regardless of
# who sourced it, which is the only thing that lets it find its own siblings.
MAKE_PRESEED_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$MAKE_PRESEED_HERE/make-preseed-render.sh"
. "$MAKE_PRESEED_HERE/make-preseed-netinst.sh"
unset MAKE_PRESEED_HERE
