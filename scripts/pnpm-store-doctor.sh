#!/usr/bin/env bash
# Detect (and optionally repair) a corrupt pnpm store.
#
# WHY THIS EXISTS
# ---------------
# The claws run ~28 runner instances against a PERSISTENT pnpm store, and
# `update-packages.yml` collapses dispatch bursts with `cancel-in-progress:
# true`. A cancellation is a SIGKILL to the process tree, so a long
# `pnpm install --no-frozen-lockfile` can die mid-write and leave the store
# holding a content file that was never finished. Nothing validates the store on
# the way in, so the damage is permanent and silent until some later install
# links the truncated file into node_modules.
#
# That has now happened three times: ERR_PNPM_UNEXPECTED_STORE on 2026-05-31
# (dataplatform pinned at 1.4.10 for ~18h), and both variants on 2026-08-25
# (11 truncated files on claw-3, an index row mapping yauzl@2.10.0 to
# body-parser@1.20.6 on claw-2 — about an hour of red CI across three
# workflows). Retries do not help: every attempt reads the same poison.
#
# HOW A CORRUPT ENTRY IS IDENTIFIED — this is exact, not a heuristic.
# The store is content-addressed by SHA-512: a file's PATH IS the hash of its
# CONTENT. Exactly one legitimately-empty entry can therefore exist — the one
# named sha512(""). Any OTHER zero-byte file under files/ claims a hash its own
# content cannot produce, so it is corrupt by definition. We derive that hash
# rather than hardcoding it, so this stays correct if pnpm changes algorithms
# (the scan simply finds nothing to do if the name no longer matches).
#
# Note `links/` and marker files are NOT scanned: they legitimately contain
# empty files (a package's own __init__.py, py.typed, .gitkeep). Scanning the
# whole store instead of files/ reports those as corruption and is wrong.
set -uo pipefail

FIX=0
DROP_INDEX=0
STORE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --fix) FIX=1 ;;
    # For ERR_PNPM_UNEXPECTED_PKG_CONTENT_IN_STORE, where the CONTENT is intact
    # but the index maps a package to the wrong entry. That mismatch is not
    # visible by size, so the only reliable repair is to drop the index and let
    # pnpm rebuild it; the (large) content files are kept.
    --drop-index) DROP_INDEX=1 ;;
    --store) STORE="${2:-}"; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "pnpm-store-doctor: unknown argument '$1'" >&2; exit 2 ;;
  esac
  shift
done

# DO NOT TRUST `pnpm store path`. On pnpm 11.5.0 across this fleet it reports
# `.../store/v10` while the store actually in use is `.../store/v11`. The doctor
# then looked at a directory that does not exist, printed "no store directory
# found", and exited 0 — so every hand-run and every guard invocation that did
# not pass --store explicitly was a silent no-op. That includes update-packages,
# which AGENTS.md names as the only workflow on the DEFAULT store and the widest
# corruption window in the fleet.
#
# Resolve by looking for what EXISTS beside the reported path, newest version
# first. A reported path that happens to exist is still used as-is.
if [ -z "$STORE" ]; then
  reported="$(pnpm store path 2>/dev/null | tail -1)"
  if [ -n "$reported" ] && [ -d "$reported" ]; then
    STORE="$reported"
  elif [ -n "$reported" ]; then
    root="${reported%/*}"
    for cand in $(ls -d "$root"/v* 2>/dev/null | sort -V -r); do
      [ -d "$cand/files" ] && STORE="$cand" && break
    done
    [ -n "$STORE" ] && echo "pnpm-store-doctor: pnpm reported '$reported' but using '$STORE'" >&2
  fi
fi
if [ -z "$STORE" ] || [ ! -d "$STORE" ]; then
  echo "pnpm-store-doctor: no store directory found (looked at '${STORE:-unset}')" >&2
  exit 0   # Nothing to check is not a failure — a cold runner has no store yet.
fi

EMPTY_HASH="$(printf '' | sha512sum | cut -d' ' -f1)"

# The store root may be the versioned dir (…/store/v11) or its parent (…/store).
mapfile -t FILE_DIRS < <(find "$STORE" -maxdepth 2 -type d -name files 2>/dev/null)
if [ "${#FILE_DIRS[@]}" -eq 0 ]; then
  echo "pnpm-store-doctor: no files/ directory under $STORE — nothing to check"
  exit 0
fi

total_bad=0
for fd in "${FILE_DIRS[@]}"; do
  # A store path is <files>/<first2>/<rest>; the hash is those joined.
  mapfile -t bad < <(
    find "$fd" -type f -size 0 2>/dev/null | while read -r f; do
      rest="${f#"$fd"/}"
      hash="${rest//\//}"
      [ "$hash" = "$EMPTY_HASH" ] && continue
      printf '%s\n' "$f"
    done
  )
  n="${#bad[@]}"
  total_bad=$(( total_bad + n ))
  echo "pnpm-store-doctor: $fd — ${n} corrupt (zero-byte, non-empty-hash) entr$([ "$n" = 1 ] && echo y || echo ies)"
  if [ "$n" -gt 0 ] && [ "$FIX" = "1" ]; then
    printf '%s\n' "${bad[@]}" | while read -r f; do
      rm -f "$f" && echo "  removed ${f#"$fd"/}"
    done
  fi
done

if [ "$DROP_INDEX" = "1" ]; then
  # index.db (SQLite) in newer stores, or an index/ tree in older ones.
  find "$STORE" -maxdepth 2 -name 'index.db*' -type f -print -delete 2>/dev/null
  find "$STORE" -maxdepth 2 -type d -name index -print -exec rm -rf {} + 2>/dev/null
  echo "pnpm-store-doctor: index dropped — pnpm will rebuild it on the next install"
fi

if [ "$total_bad" -gt 0 ] && [ "$FIX" != "1" ]; then
  echo "pnpm-store-doctor: FOUND $total_bad corrupt entr$([ "$total_bad" = 1 ] && echo y || echo ies) (re-run with --fix to remove)" >&2
  exit 1
fi
echo "pnpm-store-doctor: done (removed=$total_bad, index_dropped=$DROP_INDEX)"
exit 0
