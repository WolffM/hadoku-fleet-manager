#!/usr/bin/env bash
# verify-stick.sh — read back what is actually ON the stick, before the garage.
#
#   sudo bash verify-stick.sh
#
# Everything onboarding claimed it wrote is re-read here from the device. The
# expensive failure is a stick that looks finished and asks fifteen questions at
# the target, so the checks below are the ones that decide that.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/make-preseed.sh
. "$HERE/lib/make-preseed.sh"
P=0; F=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; P=$((P+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; F=$((F+1)); }
hdr()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }

V=$(blkid -L Ventoy) || { echo "no Ventoy partition"; exit 1; }
K=$(blkid -L CLAWKIT) || { echo "no CLAWKIT partition"; exit 1; }
MV=$(mktemp -d); MK=$(mktemp -d)
trap 'umount "$MV" 2>/dev/null; umount "$MK" 2>/dev/null; rmdir "$MV" "$MK" 2>/dev/null' EXIT
mount -o ro "$V" "$MV" || exit 1
mount -o ro "$K" "$MK" || exit 1

# §6.1 (#51): Ventoy's ISO file is now OPTIONAL. A stick built with
# `node-usb-prep.sh --netinst-iso` carries Debian on its own numbered
# partition (the real stick is MBR, so it is found by NUMBER, not by a GPT
# name — see make-preseed.sh) and may legitimately have ZERO .iso files on
# Ventoy — Ventoy is
# kept only for "every other image" per the operator's decision. Checked here
# only enough to decide whether the LEGACY Ventoy-ISO sub-checks below apply;
# the real "can this stick install anything at all" refusal is after the
# netinst-partition section, once both mechanisms have been looked at.
hdr "Ventoy partition ($V)"
ISO=$(ls "$MV"/*.iso 2>/dev/null | head -1)
if [ -n "$ISO" ]; then
  ok "installer (legacy, Ventoy-hosted): $(basename "$ISO")"
else
  printf '  → no .iso on Ventoy — expected for a §6.1 netinst-partition stick\n'
fi

if [ -n "$ISO" ]; then
J="$MV/ventoy/ventoy.json"
if [ -f "$J" ]; then
  ok "ventoy.json present"
  python3 -c "import json,sys;json.load(open(sys.argv[1]))" "$J" 2>/dev/null \
    && ok "ventoy.json is valid JSON" || bad "ventoy.json is NOT valid JSON — Ventoy ignores it silently"
  REF=$(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(d['auto_install'][0]['image'])" "$J" 2>/dev/null)
  [ "$REF" = "/$(basename "$ISO")" ] \
    && ok "auto_install points at the ISO that is present" \
    || bad "auto_install names '$REF' but the ISO is '/$(basename "$ISO")' — preseed will NOT be injected"
  TPL=$(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(d['auto_install'][0]['template'])" "$J" 2>/dev/null)
  [ -f "$MV$TPL" ] && ok "preseed exists where ventoy.json names it ($TPL)" \
                   || bad "ventoy.json names $TPL but there is no such file"
  python3 -c "
import json,sys;d=json.load(open(sys.argv[1]))
c={list(x)[0]:list(x.values())[0] for x in d.get('control',[])}
print('SECONDARY',c.get('VTOY_SECONDARY_BOOT_MENU'))" "$J" 2>/dev/null | grep -q "SECONDARY 0" \
    && ok "boot-mode prompt disabled" || bad "boot-mode prompt still enabled"
else
  bad "NO ventoy.json — the install will ask every question"
fi

hdr "Preseed (Ventoy, legacy path)"
PS="$MV/ventoy/script/preseed.cfg"
if [ -f "$PS" ]; then
  n=$(grep -cE '^(d-i|popularity-contest|tasksel) ' "$PS")
  ok "$n directives"
  for k in apt-setup/cdrom/set-first apt-setup/disable-cdrom-entries; do
    grep -q "$k" "$PS" && ok "$k" || bad "$k MISSING — the install will stop asking for install media"
  done
  grep -q 'popularity-contest/participate boolean false' "$PS" && ok "popularity-contest disabled" || bad "popularity-contest still enabled"
  grep -qE '^d-i partman-auto/disk' "$PS" && bad "the disk IS preseeded — it will not ask, on any machine" || ok "disk left to ask (only if >1)"
  # The hostname is the one thing this stick must NOT decide. Report the
  # re-ask flag, not just the fallback value — printing only the value made a
  # correctly-built stick look like it had a node's name baked in.
  H=$(grep -oP '(?<=netcfg/get_hostname string ).*' "$PS")
  if grep -q 'netcfg/get_hostname seen false' "$PS"; then
    ok "hostname: asked at the node (fallback '$H', which node-bootstrap refuses)"
  else
    bad "hostname is PRESET to '$H' — every node from this stick gets that name"
  fi
  s=$(grep -oP '(?<=wireless_essid string ).*' "$PS" | head -1)
  [ -n "$s" ] && ok "wifi SSID: $s" || printf '  → no wifi (ethernet required)\n'
  grep -q wpa_supplicant "$PS" && ok "wifi persists past first boot" || { [ -n "$s" ] && bad "wifi is installer-only — node loses network after reboot"; }
  # The check that matters most for whether the installer STARTS at all. d-i
  # consumes early_command's output; a background loop that keeps those
  # descriptors open blocks it, and the symptom is a blank installer with a dead
  # console and no telemetry to explain it.
  # DERIVED FROM THE GENERATOR, not from remembered strings.
  #
  # This block twice asserted the presence of an implementation that had since
  # been replaced — first 'mount LABEL=CLAWKIT', then 'blkid -L CLAWKIT' — going
  # red on correct sticks and green on broken ones. Both times the fix swapped
  # one literal for another.
  #
  # So: render a preseed from the same generator that built the stick, and
  # require the stick's copy to carry the same load-bearing lines. When the
  # generator changes, this changes with it.
  REF="$(mktemp)"
  if ( . "$HERE/lib/make-preseed.sh" && render_preseed x y "" "" /dev/null UTC ) >"$REF" 2>/dev/null; then
    MISSING=0
    while IFS= read -r want; do
      grep -Fq "$want" "$PS" || { bad "stick preseed is missing: $(printf '%.60s' "$want")"; MISSING=1; }
    done <<'WANTED'
modprobe ext4
/proc/mounts
bootstrap/node-bootstrap.sh ] && break
preseed/early_command
WANTED
    [ "$MISSING" = 0 ] && ok "telemetry matches the current generator (mount is verified, not assumed)"
  else
    bad "could not render a reference preseed to compare against"
  fi
  rm -f "$REF"

  # WHETHER THIS IS THE CURRENT GENERATOR'S OUTPUT, not just a preseed that
  # still contains four anchor strings that have been stable since
  # 2026-08-30. Those anchors would still be present on a preseed a MONTH out
  # of date, which is exactly what shipped to claw-9 on 2026-09-21: its
  # preseed.cfg was last written 2026-09-08, missing the 2026-09-20
  # grub/bootdev-pin fix, and the check above passed anyway. Re-render the
  # SAME operator-supplied inputs through THIS checkout's generator and diff
  # — the same move stamp_compare makes for the CLAWKIT payload below, so a
  # stick cannot look current by carrying old load-bearing logic next to a
  # few lines that never change.
  preseed_is_stale "$PS"
  case $? in
  0) ok "preseed matches what this checkout's generator would write" ;;
  1) bad "preseed is STALE against this checkout — run: sudo bash refresh-preseed.sh" ;;
  2) bad "could not compare the preseed to the generator (nothing to extract)" ;;
  esac

  grep -q authorized_keys "$PS" && ok "fleet key installed at first boot" || bad "no key — node will not be reachable"
  grep -q 'NOPASSWD:ALL' "$PS" && ok "passwordless sudo" || bad "no passwordless sudo — provision cannot write units"
else
  bad "NO preseed.cfg"
fi
fi # [ -n "$ISO" ] — legacy Ventoy-ISO sub-checks

hdr "CLAWKIT payload ($K)"
( cd "$MK" && sha256sum -c MANIFEST.sha256 >/dev/null 2>&1 ) && ok "MANIFEST.sha256 verifies" || bad "payload checksums FAIL"

# WHETHER THE PAYLOAD IS CURRENT, which MANIFEST.sha256 structurally cannot say:
# it checks the writer's files against the writer's own record. This re-hashes
# the stick against THIS CHECKOUT. A stick three commits behind passed every
# other check in this script on 2026-08-31.
. "$HERE/lib/stick-stamp.sh"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
stamp_compare "$MK" "$REPO_ROOT"
case $? in
0) ok "payload matches this checkout ($(sed -n 's/^version=//p' "$MK/STAMP"))" ;;
1) bad "payload is STALE against this checkout — run: fleet refresh" ;;
2) bad "cannot tell whether the payload is current (no STAMP) — run: fleet refresh to add one" ;;
esac
for f in bootstrap/node-bootstrap.sh bootstrap/authorized_key.pub profiles; do
  [ -e "$MK/$f" ] && ok "$f" || bad "$f missing"
done
printf '  → profiles on the stick: %s\n' "$(ls "$MK/profiles" 2>/dev/null | tr '\n' ' ')"

# §6.1 (#51): the netinst partition. Everything here is RE-DERIVED from the
# partition's own bytes — never trusted from NETINST.meta, which is the
# writer's own record and cannot fail on its own say-so (CLAUDE.md: "a
# verifier that reads its own writer's artifact cannot fail"). NETINST.meta
# supplies only what nothing else on the stick can re-derive without the
# original ISO in hand: the recorded byte count and sha256.
HAS_NETINST=false
[ -f "$MK/$NETINST_META_REL" ] && HAS_NETINST=true
if [ "$HAS_NETINST" = true ]; then
  hdr "Netinst partition (§6.1, #51)"
  K_DEV="$(printf '%s' "$K" | sed 's/[0-9]*$//')"
  REC_NAME="$(netinst_meta_read "$MK" name)"
  REC_BYTES="$(netinst_meta_read "$MK" bytes)"
  REC_SHA256="$(netinst_meta_read "$MK" sha256)"
  REC_FSUUID="$(netinst_meta_read "$MK" fsuuid)"
  ok "recorded: $REC_NAME ($REC_BYTES bytes), built $(netinst_meta_read "$MK" built)"

  if [ -n "$REC_BYTES" ] && [ -n "$REC_SHA256" ]; then
    if netinst_verify "$K_DEV" "$NETINST_PART_NUMBER" "$REC_BYTES" "$REC_SHA256"; then
      ok "partition $NETINST_PART_NUMBER ($NETINST_PART_NAME) bytes match the recorded sha256"
    else
      bad "partition $NETINST_PART_NUMBER ($NETINST_PART_NAME) bytes do NOT match the recorded sha256 — the ISO write may be corrupt or truncated. Rebuild with: node-usb-prep.sh --netinst-iso"
    fi
  else
    bad "NETINST.meta is missing byte count or sha256 — cannot verify the partition at all"
  fi

  LIVE_FSUUID="$(netinst_partition_fs_uuid "$K_DEV" "$NETINST_PART_NUMBER" 2>/dev/null)"
  if [ -n "$LIVE_FSUUID" ]; then
    [ "$LIVE_FSUUID" = "$REC_FSUUID" ] \
      && ok "fs-uuid matches NETINST.meta's record ($LIVE_FSUUID)" \
      || bad "live fs-uuid ($LIVE_FSUUID) does not match NETINST.meta ($REC_FSUUID) — the partition was rewritten since it was recorded"
  else
    bad "could not read an iso9660 fs-uuid off partition $NETINST_PART_NUMBER ($NETINST_PART_NAME) — it may not hold a valid iso9660 filesystem"
  fi

  GCFG="$MV/ventoy/ventoy_grub.cfg"
  if [ -f "$GCFG" ]; then
    ok "ventoy_grub.cfg present (F6 at Ventoy's boot menu boots it)"
    GCFG_UUID="$(netinst_grub_cfg_uuid "$GCFG")"
    if [ -n "$LIVE_FSUUID" ]; then
      [ "$GCFG_UUID" = "$LIVE_FSUUID" ] \
        && ok "ventoy_grub.cfg points at the partition's ACTUAL fs-uuid" \
        || bad "ventoy_grub.cfg points at $GCFG_UUID but the partition's live fs-uuid is $LIVE_FSUUID — this boot menu will not find it"
    fi
    netinst_grub_cfg_is_stale "$GCFG"
    case $? in
    0) ok "ventoy_grub.cfg matches what this checkout's generator would write" ;;
    1) bad "ventoy_grub.cfg is STALE against this checkout — rebuild with: node-usb-prep.sh --netinst-iso" ;;
    2) bad "could not compare ventoy_grub.cfg to the generator" ;;
    esac
  else
    bad "NO ventoy_grub.cfg on Ventoy's partition — F6 will not offer the netinst boot menu"
  fi

  CPIO="$MK/$NETINST_CPIO_REL"
  if [ -f "$CPIO" ]; then
    ok "$NETINST_CPIO_REL present"
    EMBEDDED="$(mktemp)"
    if preseed_initrd_cpio_read "$CPIO" >"$EMBEDDED" 2>/dev/null; then
      preseed_is_stale "$EMBEDDED"
      case $? in
      0) ok "embedded preseed matches what this checkout's generator would write" ;;
      1) bad "embedded preseed is STALE against this checkout — run: sudo bash refresh-preseed.sh" ;;
      2) bad "could not compare the embedded preseed to the generator" ;;
      esac
    else
      bad "$NETINST_CPIO_REL did not extract to a preseed.cfg — the archive is malformed"
    fi
    rm -f "$EMBEDDED"
  else
    bad "NO $NETINST_CPIO_REL — the netinst partition's GRUB entry has nothing to boot into (d-i needs no preseed/file= parameter, but it still needs this file to exist). Run: sudo bash refresh-preseed.sh"
  fi
fi

# THE REAL "CAN THIS STICK INSTALL ANYTHING" REFUSAL. could-not-look must
# never render as nothing-is-wrong: a stick with no ISO on Ventoy and no
# netinst partition recorded cannot install Debian at all, and neither of the
# two sections above would otherwise say so on their own.
[ -n "$ISO" ] || [ "$HAS_NETINST" = true ] || bad "NO INSTALLER ANYWHERE — no .iso on Ventoy and no $NETINST_PART_NAME partition (number $NETINST_PART_NUMBER) on CLAWKIT. This stick will not install anything."

hdr "Result"
printf '  %d passed, %d failed\n' "$P" "$F"
[ "$F" -eq 0 ] && printf '  \033[32mStick is ready. The install asks two things: hostname, and disk if >1.\033[0m\n' \
               || printf '  \033[31mFix the above before driving anywhere.\033[0m\n'
