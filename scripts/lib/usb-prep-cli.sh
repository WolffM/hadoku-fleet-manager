# usb-prep-cli.sh — the --help text, the node-profiles.mjs shell-out
# (profiles()), and the copied-script parse-check (parse_check()) for
# scripts/node-usb-prep.sh. Sourced by it; not standalone.

usage() {
	# QUOTED delimiter. This block takes no variables, and unquoted it made
	# `bash scripts/onboarding.sh` in the prose a command substitution — so
	# printing --help would have RUN onboarding.
	cat <<'EOF'
usage: sudo bash scripts/node-usb-prep.sh [options]

  Most operators want `bash scripts/onboarding.sh` instead — it asks for all
  of the below and elevates itself. This is the scriptable half.

  --device /dev/sdX      the whole USB disk. NEVER guessed, never defaulted.
  --profile ID           node profile to install (see: fleet usb-prep --list-profiles)
  --pubkey FILE          ssh PUBLIC key to authorise on the new node
  --confirm              actually do it. Without this it is a dry run.
  --ventoy-dir DIR       extracted ventoy-*-linux release (or set VENTOY_DIR)
  --skip-ventoy          the stick already has Ventoy; only refresh $LABEL
  --refresh-payload      rewrite the payload in place; do NOT reformat $LABEL
  --reserve-mb N         size of the $LABEL partition (default $RESERVE_MB_DEFAULT)
  --netinst-iso FILE     write FILE raw onto its own partition (#51, §6.1) so
                         d-i boots from it directly, never through Ventoy's
                         loop presentation. FULL REBUILD ONLY — refused with
                         --refresh-payload or --skip-ventoy, because it needs
                         to grow Ventoy's own reservation to make room.
  --list-profiles        print the declared profiles and exit

With --device, --profile and --pubkey all given, nothing is prompted for and the
run is scriptable. With any of them missing it walks you through it — but only on
a terminal: it will not prompt into a pipe.
EOF
}
# ── the profile resolver ────────────────────────────────────────────────────
# Shelled out to, never reimplemented here. node-profiles.mjs is the single
# implementation of "which profile is that, and is it coherent", and it THROWS
# on a missing manifest rather than handing back an empty profile — a stick
# written from an empty profile images a node into a shape nobody declared and
# prints a green summary doing it.
#
# `sudo` resets PATH through secure_path, so root may not see the node the
# operator installed. Say that plainly instead of failing as "command not found".
NODE_BIN="${FLEET_NODE_BIN:-$(command -v node || command -v nodejs || true)}"
profiles() {
	[ -n "$NODE_BIN" ] || die "node is not on PATH (sudo resets it). Re-run with 'sudo -E', or set FLEET_NODE_BIN=/path/to/node."
	"$NODE_BIN" "$HERE/node-profiles.mjs" "$@"
}
# Parse-check with the interpreter the shebang actually names. The original
# script ran `sh -n` because claw-admin-fix.sh is POSIX sh; node-bootstrap.sh is
# bash and `sh -n` would reject it for using arrays. Checking with the wrong
# interpreter is not a weaker check, it is a different and wrong one.
parse_check() {
	local f="$1" shebang
	shebang="$(head -1 "$f")"
	case "$shebang" in
	*bash*) bash -n "$f" || die "the copied $f is not valid bash" ;;
	*) sh -n "$f" || die "the copied $f is not valid sh" ;;
	esac
}
