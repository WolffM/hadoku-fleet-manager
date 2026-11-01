# usb-prep-core.sh — constants/defaults and the two core print helpers
# (die, say) for scripts/node-usb-prep.sh. Sourced by it; not standalone.

LABEL=CLAWKIT
MNT=/mnt/clawkit-prep
VENTOY_MNT=/mnt/clawkit-prep-ventoy
RESERVE_MB_DEFAULT=1024
# Headroom added on top of the ISO's own size when sizing the netinst
# partition — sfdisk aligns to 1MiB boundaries, and this absorbs that
# rounding plus a little slack rather than sizing the partition to the exact
# byte count the ISO happened to be built at.
NETINST_PAD_MB=8

DEV=""
PROFILE=""
PUBKEY=""
CONFIRM=false
SKIP_VENTOY=false
# Rewrite the payload on an existing stick WITHOUT reformatting it. A refresh
# must not destroy telemetry or saved installer logs sitting on CLAWKIT — that
# is usually the reason the refresh is happening.
REFRESH_PAYLOAD=false
VENTOY_DIR="${VENTOY_DIR:-}"
RESERVE_MB="$RESERVE_MB_DEFAULT"
# §6.1 (#51): the Debian netinst ISO, written RAW onto its own GPT partition —
# see docs/planning/installer-partition-2026-10-02.md. Empty means "no
# netinst partition on this build", which is the default and leaves the
# existing Ventoy-ISO-file workflow untouched for every other image.
NETINST_ISO=""

die() {
	printf '\n!!! %s\n' "$1" >&2
	exit 1
}
say() { printf '\n=== %s ===\n' "$1"; }
