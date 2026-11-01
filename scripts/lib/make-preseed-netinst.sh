#!/usr/bin/env bash
# make-preseed-netinst — the §6.1 netinst-partition half: the raw-ISO
# partition layout, its GRUB menu entry, and the preseed-as-initrd-cpio
# delivery mechanism, each with its own re-derive-don't-trust staleness check.
#
# Sourced, never executed, and only ever BY `lib/make-preseed.sh` (never
# directly by a checkout-resident script) — see that file for the sourcing
# contract, and the header comment just above `NETINST_PART_NUMBER` below for
# why this is MBR-aware and keyed by partition number rather than name.
#
# Split out of `make-preseed.sh` (wave 5t lane B, 800-line ceiling) as a pure
# move: every function body below is byte-identical to the original file.

# ═══════════════════════════════════════════════════════════════════════════
# §6.1 — the netinst partition (#51)
#
# The operator's decision (docs/planning/claw-9-install-20260921-and-6.1-decision-2026-10-01.md
# §3, option 2): the Debian netinst ISO is written RAW onto its own dedicated
# partition — `dd`, not a file sitting on Ventoy's exFAT partition — so d-i
# never boots through Ventoy's loop-mounted-ISO presentation, which both the
# claw-4 and claw-9 postmortems implicate in an intermittent, unexplained
# install-media corruption. Ventoy itself is untouched and still carries every
# OTHER image.
#
# A partition holding the ISO's raw bytes IS a valid iso9660 filesystem — the
# same way a physical CD is — so GRUB's iso9660.mod reads it directly with no
# loopback layer at all. The functions below are the two symmetric halves of
# that: node-usb-prep.sh writes the partition and a tiny custom GRUB menu that
# boots it, and verify-stick.sh re-derives everything that menu claims rather
# than trusting what was written (same "re-derive, don't trust a writer's own
# record" rule stick-stamp.sh and preseed_is_stale already apply elsewhere).
#
# THE REAL STICK IS MBR (`dos`), NOT GPT — measured, not assumed:
# `lsblk -o NAME,PTTYPE,PARTLABEL,LABEL /dev/sdg` reads `PTTYPE dos` with
# `sdg1 Ventoy/exfat, sdg2 VTOYEFI, sdg3 CLAWKIT`, because
# `node-usb-prep.sh` calls `Ventoy2Disk.sh -I -r` with no `-g`. An MBR
# partition entry has NO name field at all — GPT's `name=` is simply absent
# from `sfdisk -d`'s output on a `dos` label — so the first version of this
# file, which looked up the netinst partition by a GPT `name="DINSTALL"`,
# silently found nothing on the device this fleet actually uses (its own
# file-backed test built a `label: gpt` image and never caught it).
#
# Staying MBR — rather than switching Ventoy to `-g` to get GPT's name field
# back — was the explicit choice: that would change the operator-approved
# layout for a lookup convenience. So the partition is identified by a FIXED
# NUMBER instead (`NETINST_PART_NUMBER`, the 4th primary — Ventoy, VTOYEFI,
# CLAWKIT already take 1–3), which resolves identically on `dos` and `gpt`
# alike, and is cross-checked at verify time against the filesystem actually
# found there (iso9660, fs-uuid matching NETINST.meta) rather than trusted on
# the number alone.
#
# MBR HAS EXACTLY FOUR PRIMARY PARTITION SLOTS. This fleet's stick already
# uses three; the netinst partition is the fourth and LAST one that fits
# without extended/logical partitions (not introduced here, since Ventoy
# itself does not use them). `node-usb-prep.sh` refuses cleanly, before
# writing anything, if a 5th would be needed.

# The preseed-carrier's path and the build record's path on CLAWKIT, and the
# netinst partition's fixed number. One set of constants, read everywhere, so
# the scripts that touch this cannot name any of it differently.
NETINST_PART_NUMBER=4
# A human-readable label ONLY — there is no on-disk field it corresponds to
# on an MBR table. Used in messages; never passed to sfdisk or used to look
# anything up.
NETINST_PART_NAME="DINSTALL"
NETINST_CPIO_REL="install/preseed-initrd.cpio.gz"
NETINST_META_REL="install/NETINST.meta"

# partition_count <dev> — how many partition entries `sfdisk -d` reports.
# Used to refuse BEFORE appending a 5th primary to an MBR table rather than
# relying on sfdisk's own (correct, but generic) refusal message.
partition_count() {
	sfdisk -d "$1" 2>/dev/null | grep -cE "^${1}[0-9]+ *:"
}

# partition_sector_by_number <dev> <n> — print "<start-sector> <size-sectors>"
# for the Nth partition (1-based) on <dev>; return 1 if it does not exist.
#
# BY NUMBER, NOT BY NAME. `sfdisk -d` labels every entry by device path plus
# number (e.g. "/dev/sdg4 : start=...") on BOTH `dos` and `gpt` tables —
# that line format does not depend on the table type, unlike the `name=`
# field this file used to key on, which simply does not exist on `dos`.
#
# Reads `sfdisk -d`, never a mounted partition device node (no `/dev/sdg4`
# mount, no blkid-by-partlabel). That is deliberate, not merely convenient:
# it is the ONE code path that resolves identically against a real stick and
# a plain sparse FILE used in a test harness. Neither losetup nor a
# kernel-visible partition table is needed either way, which is what let
# this whole mechanism be proven here without root and without touching
# CLAWKIT.
partition_sector_by_number() {
	local dev="$1" n="$2" line start size
	line="$(sfdisk -d "$dev" 2>/dev/null | grep -F "${dev}${n} :")"
	[ -n "$line" ] || return 1
	start="$(printf '%s\n' "$line" | sed -n 's/.*start= *\([0-9][0-9]*\).*/\1/p')"
	size="$(printf '%s\n' "$line" | sed -n 's/.*size= *\([0-9][0-9]*\).*/\1/p')"
	if [ -n "$start" ] && [ -n "$size" ]; then
		printf '%s %s\n' "$start" "$size"
		return 0
	fi
	return 1
}

# netinst_partition_bytes <dev> <n> <nbytes> — the first <nbytes> bytes of the
# Nth partition on <dev>, to stdout. <dev> may be a whole-disk block device or
# a plain file.
netinst_partition_bytes() {
	local dev="$1" n="$2" nbytes="$3" start size off
	read -r start size < <(partition_sector_by_number "$dev" "$n") || return 1
	[ -n "$start" ] || return 1
	off=$((start * 512))
	dd if="$dev" bs=1M iflag=skip_bytes,count_bytes skip="$off" count="$nbytes" status=none 2>/dev/null
}

# netinst_partition_fs_uuid <dev> <n> — the iso9660 filesystem UUID blkid
# reports for the Nth partition's byte range.
#
# THIS IS THE SAME VALUE GRUB'S `search --fs-uuid` RESOLVES, not a convenient
# stand-in for it — confirmed by reading both implementations, not assumed.
# GRUB (grub-core/fs/iso9660.c, grub_iso9660_uuid) and libblkid
# (superblocks/iso9660.c) both read the SAME sixteen bytes — the Primary
# Volume Descriptor's MODIFICATION date/time field — and format them with the
# identical "%c%c%c%c-%c%c-%c%c-%c%c-%c%c-%c%c-%c%c" pattern. blkid tries the
# modification field first and falls back to the creation field only when the
# modification field is unset; xorriso-built Debian images set it, so the two
# tools agree byte-for-byte on every ISO this has been checked against. The
# volume LABEL (e.g. "Debian 13.6.0 amd64 n") was deliberately not used
# instead: it is the release string and changes every point release, so a
# label-based search would need regenerating on every Debian point release
# where the UUID does not. NEITHER depends on the partition table type —
# fs-uuid is a property of the FILESYSTEM, which is why GRUB's `search
# --fs-uuid` in render_netinst_grub_cfg below works unchanged on `dos`.
netinst_partition_fs_uuid() {
	local dev="$1" n="$2" start size off bytes
	read -r start size < <(partition_sector_by_number "$dev" "$n") || return 1
	off=$((start * 512))
	bytes=$((size * 512))
	blkid -p -O "$off" -S "$bytes" -o value -s UUID "$dev" 2>/dev/null
}

# netinst_verify <dev> <n> <nbytes> <want_sha256> — 0 if the Nth partition's
# first <nbytes> bytes hash to <want_sha256>; 1 otherwise, INCLUDING "no such
# partition" and "could not read it" — could-not-look is not a pass.
netinst_verify() {
	local dev="$1" n="$2" nbytes="$3" want="$4" have
	have="$(netinst_partition_bytes "$dev" "$n" "$nbytes" | sha256sum 2>/dev/null | awk '{print $1}')"
	[ -n "$have" ] && [ "$have" = "$want" ]
}

# netinst_meta_write <clawkit-mnt> <iso-file> <fsuuid> — record what was just
# written, on CLAWKIT (ext4, mutable) rather than on the netinst partition
# itself (iso9660, and dd'd raw — there is nowhere to append a record to it
# after the fact). verify-stick.sh reads this back, but — same rule as
# above — re-derives the fs-uuid and the checksum live rather than trusting
# it; this file only supplies the ISO's recorded byte count and sha256, which
# nothing else on the stick can re-derive without the original ISO in hand.
netinst_meta_write() {
	local mnt="$1" iso="$2" fsuuid="$3" dest
	dest="$mnt/$NETINST_META_REL"
	mkdir -p "$(dirname "$dest")"
	{
		printf 'name=%s\n' "$(basename "$iso")"
		printf 'bytes=%s\n' "$(wc -c <"$iso" | tr -d '[:space:]')"
		printf 'sha256=%s\n' "$(sha256sum "$iso" | awk '{print $1}')"
		printf 'fsuuid=%s\n' "$fsuuid"
		printf 'partition=%s\n' "$NETINST_PART_NAME"
		printf 'partition_number=%s\n' "$NETINST_PART_NUMBER"
		printf 'built=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	} >"$dest"
}

# netinst_meta_read <clawkit-mnt> <key> — one field back out of NETINST.meta.
netinst_meta_read() {
	local mnt="$1" key="$2"
	sed -n "s/^${key}=//p" "$mnt/$NETINST_META_REL" 2>/dev/null | head -1
}

# preseed_build_initrd_cpio <preseed-file> <out.cpio.gz> — package a rendered
# preseed.cfg as a one-file cpio+gzip archive, for a SECOND `initrd` argument
# in the netinst partition's GRUB menu entry.
#
# WHY THIS AND NOT `preseed/file=` ON THE KERNEL CMDLINE: nothing can write a
# file back into the netinst partition after its ISO bytes are dd'd raw, so
# the usual `preseed/file=/cdrom/preseed.cfg` has nowhere to point. GRUB
# loading a second `initrd` image is a standard, long-documented mechanism —
# the same one dracut uses to prepend an early-microcode cpio, and the exact
# end state the Debian wiki's own ISO-remastering recipe
# (DebianInstaller/Preseed/EditIso) reaches via `cpio -H newc -o -A` — and the
# kernel concatenates every `initrd` argument into ONE initial ramdisk before
# unpacking, so the two delivery mechanisms are byte-for-byte equivalent at
# the point d-i's init looks for a preseed.
#
# AND THAT LOOK NEEDS NO BOOT PARAMETER AT ALL. Per the Debian Installation
# Guide (apbs02, "Taking the preseed file from the initrd" — the FIRST of
# d-i's three preseed-loading methods, and the only parameter-free one): "If
# you are using initrd preseeding, you only have to make sure a file named
# preseed.cfg is included in the root directory of the initrd. The installer
# will automatically check if this file is present and load it." So the file
# below needs no companion `preseed/file=` anywhere in render_netinst_grub_cfg.
preseed_build_initrd_cpio() {
	local preseed="$1" out="$2" work
	[ -f "$preseed" ] || return 1
	work="$(mktemp -d)" || return 1
	cp "$preseed" "$work/preseed.cfg"
	(cd "$work" && printf '%s\n' preseed.cfg | cpio -o -H newc 2>/dev/null) | gzip -9 >"$out" 2>/dev/null
	rm -rf "$work"
	[ -s "$out" ]
}

# preseed_initrd_cpio_read <cpio.gz> — the embedded preseed.cfg, to stdout.
# Lets verify-stick.sh run the SAME preseed_is_stale check against whichever
# preseed will actually be used to install — the cpio-embedded one — instead
# of inventing a second staleness rule for it.
preseed_initrd_cpio_read() {
	local archive="$1" work out
	[ -f "$archive" ] || return 1
	work="$(mktemp -d)" || return 1
	(cd "$work" && gzip -dc "$archive" 2>/dev/null | cpio -idm --quiet 2>/dev/null)
	out="$work/preseed.cfg"
	if [ -f "$out" ]; then
		cat "$out"
		rm -rf "$work"
		return 0
	fi
	rm -rf "$work"
	return 1
}

# render_netinst_grub_cfg <iso-fs-uuid> <cpio-relpath-on-clawkit> — the custom
# GRUB menu entry that boots d-i straight off the netinst partition.
#
# DELIVERY MECHANISM: Ventoy's own documented custom-menu feature. A file at
# `/ventoy/ventoy_grub.cfg` on Ventoy's own (first) partition is loaded by
# pressing F6 at Ventoy's boot menu and run as plain GRUB2 commands —
# ventoy.net's own plugin docs ("grub_menu"): "you can define your own grub2
# menu in a cfg file ... called ventoy_grub.cfg ... Press F6 to load the
# customized menu", explicitly restricted to "common grub2 commands" (no
# internal Ventoy boot functions) — which is exactly what is used below, so
# the restriction costs nothing here.
#
# THE PARTITION IS READ DIRECTLY, NO LOOPBACK. Raw ISO bytes on their own
# partition ARE a valid iso9660 filesystem, the same way a physical disc is —
# GRUB's iso9660.mod recognises it exactly as it would recognise an optical
# drive. The dm-linear/loop layer both claw-4's and claw-9's postmortems
# implicate in an unexplained corruption is gone entirely, not merely hidden.
#
# PARTITION-TABLE-AGNOSTIC, ON PURPOSE. The real stick is MBR (`dos`), not
# GPT — `lsblk -o PTTYPE /dev/sdg` reads `dos` — so both `part_msdos` and
# `part_gpt` are loaded; whichever does not match the disk's actual table
# just fails its `insmod` harmlessly (GRUB script continues past a failed
# command) and the other lets `search` walk the table that is really there.
# `search --fs-uuid` itself does not care about the table type at all — a
# filesystem UUID is a property of the filesystem, not the partition table —
# so nothing else in this function needed to change for `dos`.
#
# FOUND BY FS-UUID, NOT BY VOLUME LABEL, AND NOT BY PARTITION NAME EITHER.
# See netinst_partition_fs_uuid above for why fs-uuid and GRUB's `--fs-uuid`
# are provably the same value. A GPT partition NAME was tried first and
# abandoned — it does not exist as a field on an MBR table at all, which is
# what the real stick has.
#
# PRESEED ARRIVES VIA THE SECOND `initrd` ARGUMENT — see
# preseed_build_initrd_cpio above — needing no `preseed/file=` parameter.
#
# THE `linux`/`vga=788 --- quiet` LINE IS QUOTED VERBATIM FROM DEBIAN'S OWN
# SHIPPED `boot/grub/grub.cfg` ("... Automated install" menuentry, read
# directly off the 13.6.0 netinst image) — the only addition is the second
# initrd argument; every other token is the vendor's own, not reinvented here.
render_netinst_grub_cfg() {
	local iso_uuid="$1" cpio_rel="$2"
	cat <<CFG
# Written by node-usb-prep.sh for the §6.1 netinst partition (#51). Rebuild
# the stick instead of hand-editing it — see
# docs/planning/installer-partition-2026-10-02.md and
# docs/planning/claw-9-install-20260921-and-6.1-decision-2026-10-01.md.
insmod part_msdos
insmod part_gpt
insmod iso9660
insmod ext2
insmod search_fs_uuid
insmod search_label
search --no-floppy --fs-uuid --set=isopart $iso_uuid
search --no-floppy --label --set=kitpart CLAWKIT
menuentry 'Install Debian (fleet netinst partition — #51)' {
    linux  (\$isopart)/install.amd/vmlinuz auto=true priority=critical vga=788 --- quiet
    initrd (\$isopart)/install.amd/initrd.gz (\$kitpart)/$cpio_rel
}
CFG
}

# netinst_grub_cfg_uuid <file> — the fs-uuid a written ventoy_grub.cfg was
# built for, read back rather than re-derived — the live partition's OWN
# fs-uuid (netinst_partition_fs_uuid) is the thing to compare it against.
netinst_grub_cfg_uuid() {
	sed -n 's/^search --no-floppy --fs-uuid --set=isopart //p' "$1" 2>/dev/null | head -1
}

# netinst_grub_cfg_is_stale <file> — 0 current, 1 STALE, 2 could not tell.
#
# Same move as preseed_is_stale: re-render from the one value this checkout
# cannot know on its own (the fs-uuid, which is the ISO's, not the repo's)
# and diff the rest. A future change to the menu entry itself — a missing
# insmod, a changed kernel path for a new Debian major — would otherwise sit
# on an already-built stick exactly as silently as the pre-2026-09-20
# bootdev line sat in a stale preseed.
netinst_grub_cfg_is_stale() {
	local file="$1" uuid have want
	[ -f "$file" ] || return 2
	uuid="$(netinst_grub_cfg_uuid "$file")"
	[ -n "$uuid" ] || return 2
	have="$(cat "$file" 2>/dev/null)"
	want="$(render_netinst_grub_cfg "$uuid" "$NETINST_CPIO_REL")"
	[ -n "$have" ] && [ "$have" = "$want" ] && return 0
	return 1
}
