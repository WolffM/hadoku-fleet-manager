#!/usr/bin/env bash
# node-bootstrap.sh — turn an installed OS into a fleet node.
#
# Phase CONVERT in docs/VOCABULARY.md: an OS -> a server that does not sleep,
# answers ssh, filters packets, and reboots itself when it wedges. Successor to
# minions' `garage-server-bazooka.sh` (982 lines, v6.1), whose post-mortem is
# that repo's `claw-1-full-retrospective.md`. Both live in the vendored tree
# at archive/ — UNTRACKED and not published, because it carries the operator's
# home network and personal details. Upstream is private.
#
#   sudo bash /mnt/bootstrap/node-bootstrap.sh
#
# That is the whole command. `--profile`, `--pubkey` and `--hostname` are all
# INFERRED (see 3 below); each stays available as an override, and each REFUSES
# rather than guessing when what it finds is ambiguous.
#
# THREE THINGS ARE DIFFERENT FROM THE BAZOOKA. EVERYTHING ELSE IS CARRIED
# FORWARD.
#
# 1. IT READS A PROFILE, NOT FLAGS.
#    The bazooka took --hostname, --lan-cidr, --ssh-port, --ssh-pubkey and
#    --surface. Four of those five are properties of a NODE, and they lived only
#    in the operator's shell history: claw-2 and claw-3 needed --surface, claw-1
#    did not, and the only surviving record of which is a sentence in a
#    retrospective. `--surface` in particular is now DERIVED — the profile keys
#    kernel extras by /sys/class/dmi/id/sys_vendor, and the box reads its own
#    vendor string instead of the operator remembering.
#    --hostname is the one thing that is genuinely per-node rather than
#    per-shape, and it was the last surviving REQUIRED flag until 2026-08-30 —
#    see 3.
#
# 2. ITS LAST ACT IS A RECORD, NOT A BANNER.
#    v6 ended in a 30-line ASCII box. Every fact in it — cores, RAM, disk,
#    whether ssh worked — then got RETYPED into the fleet manifest by hand, from
#    memory, later. That is how `ramGb: 11` came to sit beside a node that
#    measures 11885MiB. This prints ENROLL-BEGIN…ENROLL-END, parsed by
#    `scripts/lib/enrollment-record.mjs`, in the shape a manifest entry needs.
#    MEASURED, not typed. `fleet enroll` is a separate workstream; this makes the
#    record it will consume.
#
# 3. IT INFERS ITS OWN ARGUMENTS, AND REFUSES RATHER THAN GUESSING.
#    The invocation above used to be three flags and two absolute paths, typed
#    at a PHYSICAL CONSOLE, on a box with no fleet tooling, off a photograph of
#    somebody's screen — the most expensive place in this system to mistype
#    anything. All three are things this script can see for itself: the key and
#    the profile are on the stick it is running from, and the hostname is the
#    one the Debian installer set twenty minutes ago and that step 3 below is
#    about to write straight back with hostnamectl.
#    WHAT IT WILL NOT DO IS PICK. Two profiles on the stick means the operator
#    built it for more than one shape of box and has not said which one is in
#    front of them; this lists both and stops. A hostname of `debian` is the
#    installer's default, which means nobody named this node; it says so and
#    stops. An inferred wrong answer images a node into a shape nobody chose,
#    which is the failure this whole file is written against. A refusal costs
#    one flag and is recoverable; the other direction needs another drive.
#
# THE SSH LOCKOUT CLUSTER — findings 1 through 8 of the retrospective are ONE
# failure, and four of them were unrecoverable over the network. Every guard is
# carried forward, and one is stronger:
#
#   - KEYS_INSTALLED. `AuthenticationMethods publickey` is written ONLY when a
#     valid key is confirmed present for the fleet user. v4 wrote it
#     unconditionally, which overrides `PasswordAuthentication yes` — sshd never
#     even OFFERS password auth — and with no keys the node was gone.
#   - the pubkey is validated (non-empty, a real key type, not a private key)
#     before anything trusts it.
#   - `nft flush ruleset` BEFORE UFW. Trixie's UFW manages iptables while
#     nftables is the real filter, so `ufw disable` leaves DROP chains standing
#     and the box goes silent while every tool reports the firewall off.
#   - fail2ban `ignoreip` covers LAN + localhost + Tailscale. It banned the
#     operator's own workstation on claw-1 and the ban SURVIVED `ufw disable`,
#     because fail2ban writes nftables rules directly.
#   - MaxAuthTries from the profile, floor 4 (validated by the loader). A client
#     whose agent offers every key it holds exhausts 3 before reaching password.
#   - `chmod 755` on the home directory. sshd SILENTLY rejects authorized_keys
#     on a group-writable home, and the failure looks exactly like a wrong key.
#   - an ssh loopback auth test AFTER restarting sshd, falling back to password
#     auth rather than locking the box.
#
# THE LOOPBACK TEST IS THE ONE THING THAT IS BETTER THAN v6. The bazooka's test
# could only pass if a PRIVATE key happened to already be on the node, which
# on a fresh install it never is — so on claw-1 it "failed" for the wrong reason
# and the fallback logic had to be argued around. Here the test MINTS A
# THROWAWAY KEYPAIR, authorises it, connects with it, and removes it, in a trap
# that fires on every exit path. That proves the whole chain end to end — sshd's
# effective config, the home directory mode, the authorized_keys mode, the
# AllowUsers list — without needing the operator's private key to be anywhere
# near this box.
#
# AND IT READS SSHD, NOT ITS OWN FILE. `sshd -T` dumps the EFFECTIVE
# configuration; the drop-in this script wrote is the writer's artifact and
# checking it would be a verifier reading its own write. That is this repo's
# oldest rule and it applies to a shell script as much as to a gate.
#
# WHAT IT DELIBERATELY DOES NOT DO
#   - No random temporary password. v5 generated one, printed it once in a
#     yellow box, and stored it nowhere; that is precisely how the claw fleet
#     ended up with key-only login and NO REACHABLE ROOT (2026-08-17), which took
#     a physical console and a USB stick per node to undo. The Debian
#     installer already set a password for the fleet user. If key auth cannot be
#     proven, this falls back to allowing that password rather than inventing a
#     secret nobody wrote down.
#   - No second user. One `hadoku` with passwordless sudo. The bazooka's second
#     `openclaw` account doubled every key, group and permission question and is
#     half of why the lockout cluster took three nodes to find.
#   - No openclaw onboarding. Retrospective findings 9-12 are unresolved bugs in
#     `openclaw onboard`; automating around them would encode workarounds for a
#     tool that is going to fix them. For `role: agent|both` this installs the
#     prerequisites and prints what is left, honestly, as manual.
#   - No reboot. The record has to reach the operator, and a script that reboots
#     is a script whose output you read afterwards or not at all.
#
# @guards manifests/node-profiles.json
# @guards scripts/lib/enrollment-record.mjs

# NO `set -e`, ON PURPOSE, AND THIS IS LOAD-BEARING.
#
# The bazooka used `set -euo pipefail` with an ERR trap, and that is right for a
# script whose last line is a banner. It is wrong for one whose last line is the
# only MEASUREMENT of this node that will ever exist: with -e, a failed
# `systemctl restart fail2ban` in step 8 aborts before step 12, and the operator
# is left holding nothing to hand `fleet enroll` — from a box that is, by then,
# mostly converged.
#
# So every command that MUST succeed says `|| die` explicitly, every command
# that may fail says `|| warn`, and the script always reaches its record. The
# record then reports `ready no <reason>` and the script exits non-zero. A
# partial conversion that says so beats a complete abort that says nothing.
set -uo pipefail

PROFILE_FILE=""
PUBKEY=""
HOSTNAME_NEW=""
PROBE=""
DRY_RUN=false

HERE="$(cd "$(dirname "$0")" && pwd)"
# THE KIT ROOT, DERIVED — never the string /mnt/kit.
#
# The stick is mounted wherever the operator mounted it. Every functional path
# in this file already resolves off $HERE, so the script itself does not care;
# what DID care was the guidance it prints. It told the operator to
# `tee /mnt/kit/enrollment-<node>.txt`, and with the stick at /mnt that
# redirect fails and takes the enrollment record with it — the one measurement
# of this node that will ever exist, lost to a hardcoded path in a help string.
KIT_ROOT="$(cd "$HERE/.." 2>/dev/null && pwd || printf '%s' "$HERE")"

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
CYAN=$'\033[0;36m'
NC=$'\033[0m'

log() { printf '%s[node-bootstrap]%s %s\n' "$GREEN" "$NC" "$*"; }
warn() { printf '%s[WARNING]%s %s\n' "$YELLOW" "$NC" "$*"; }
err() { printf '%s[ERROR]%s %s\n' "$RED" "$NC" "$*" >&2; }
step() { printf '\n%s──────────────────────────────────────────────%s\n' "$CYAN" "$NC"; log "$*"; }
die() {
	err "$1"
	exit 1
}

usage() {
	cat <<'EOF'
usage: sudo bash node-bootstrap.sh [--profile FILE] [--pubkey FILE] [--hostname NAME]

  Run from the stick, all three are INFERRED and the command is just

      sudo bash /mnt/bootstrap/node-bootstrap.sh

  Each flag is an OVERRIDE, for when inference refuses or is wrong. What was
  inferred is printed, with where it came from, before anything is changed.

  --profile FILE    a single node profile, as written onto the stick by
                    `fleet usb-prep` (profiles/<id>.json).
                    inferred: the one profiles/*.json beside bootstrap/.
                    REFUSES if there are several — it will not pick a shape.
  --pubkey FILE     the ssh PUBLIC key to authorise for the fleet user.
                    inferred: bootstrap/authorized_key.pub, beside this script.
                    REFUSES if it is absent or is not a public key.
  --hostname NAME   what this node will be called. The one genuinely per-node
                    fact, and the last flag that was still required.
                    inferred: this box's own hostname, as the installer set it.
                    `debian`, `localhost`, empty and `unknown<mac>` — what d-i
                    writes when DHCP gave it no name — mean nobody chose: at a
                    console it ASKS; with no tty it refuses rather than guess.
  --probe FILE      capability-probe.sh (default: next to this script)
  --dry-run         print what would happen; change nothing.
EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
	--profile) PROFILE_FILE="${2:-}" && shift 2 ;;
	--pubkey) PUBKEY="${2:-}" && shift 2 ;;
	--hostname) HOSTNAME_NEW="${2:-}" && shift 2 ;;
	--probe) PROBE="${2:-}" && shift 2 ;;
	--dry-run) DRY_RUN=true && shift ;;
	-h | --help)
		usage
		exit 0
		;;
	*) die "unknown option: $1 (try --help)" ;;
	esac
done

run() {
	if [ "$DRY_RUN" = true ]; then
		printf '  [dry-run] %s\n' "$*"
	else
		"$@"
	fi
}

# `run` cannot carry a redirect, so file writes go through this instead of
# through `cat > x` guarded by an if. One place that honours --dry-run beats
# eleven that each might not.
write_file() {
	local dest="$1"
	local content
	content="$(cat)"
	if [ "$DRY_RUN" = true ]; then
		printf '  [dry-run] write %s (%s lines)\n' "$dest" "$(printf '%s\n' "$content" | wc -l)"
		return 0
	fi
	mkdir -p "$(dirname "$dest")"
	printf '%s\n' "$content" >"$dest"
}

# ── inference: the flags the operator does not have to type ─────────────────
#
# THESE TAKE OBSERVED VALUES AND DECIDE. Nothing below runs `hostname`, and
# nothing below walks up from $HERE — the caller observes, these judge. That is
# the same split as `scripts/lib/usb-device-guard.sh`, and it is the whole
# reason those refusals are tested on every commit rather than "cannot be tested
# without hardware". `scripts/lib/onboarding-docs.test.mjs` sources this file
# with NODE_BOOTSTRAP_SOURCE_ONLY=1 and calls them against a fixture laid out
# like a stick.
#
# THEY CANNOT MOVE TO scripts/lib/, though, and that is not laziness.
# `node-usb-prep.sh` copies exactly two files into the stick's bootstrap/ — this
# one and capability-probe.sh — so a `. "$HERE/lib/node-bootstrap-infer.sh"`
# here would resolve in a checkout and be MISSING on the stick, which is the
# only place this script ever actually runs. A helper that works everywhere
# except in production is worse than a long file.

# The stick's layout, written down once: profiles/ is a sibling of bootstrap/.
kit_profiles_dir() {
	local up
	up="$(cd "$1/.." 2>/dev/null && pwd)" || up=""
	[ -n "$up" ] || up="$1/.."
	printf '%s/profiles' "$up"
}

# Defined here rather than at step 1 because `infer_pubkey` needs it during
# preflight; step 1 still calls it for the `--pubkey` path.
validate_pubkey() {
	local f="$1"
	[ -f "$f" ] || {
		err "pubkey not found: $f"
		return 1
	}
	[ -s "$f" ] || {
		err "pubkey is EMPTY: $f"
		return 1
	}
	# Private-key check FIRST, same order and same reason as
	# scripts/lib/usb-device-guard.sh: a private key has no `ssh-ed25519 ...` line,
	# so the type check below refuses it with a true but unhelpful message, and the
	# operator retries with the same file.
	grep -q 'PRIVATE KEY' "$f" && {
		err "$f is a PRIVATE key. Pass the .pub half."
		return 1
	}
	grep -qE '^(ssh-ed25519|ssh-rsa|ssh-dss|ecdsa-sha2-nistp|sk-ssh-ed25519|sk-ecdsa-sha2) ' "$f" || {
		err "pubkey does not contain a valid key line: $f"
		return 1
	}
	return 0
}

# `--pubkey`, from the copy `fleet usb-prep` writes beside this script. The two
# files travel together: one `cp` per line in usb-prep's payload loop, verified
# against the same MANIFEST.sha256, so if this script is here that key is here.
#
# AN INVALID FILE IS REFUSED AS HARD AS A MISSING ONE. A private key, or a copy
# that landed truncated, is not a key the operator chose any more than an absent
# one is — and inferring it would wrap sshd's hardening around something that
# cannot open the door. Findings 1 and 2 of the claw-1 retrospective are both
# exactly that, and four of that cluster were unrecoverable over the network.
infer_pubkey() {
	local f="$1/authorized_key.pub"
	if [ ! -e "$f" ]; then
		err "no --pubkey given, and there is none at $f.
  sshd is hardened around it, and a node with no key is a node with no way in.
  Rebuild the stick with \`fleet usb-prep\` (it writes that file), or pass
  --pubkey FILE."
		return 1
	fi
	validate_pubkey "$f" || {
		err "no --pubkey given, and $f is not a usable public key (see above).
  sshd is hardened around it, and a node with no key is a node with no way in."
		return 1
	}
	printf '%s' "$f"
}

# `--profile`, when the stick carries EXACTLY ONE.
#
# Not "the first", not "the newest", not "the one whose id looks like the
# hostname". Several profiles means the operator built one stick for more than
# one shape of box and has not yet said which shape is in front of them, and
# there is nothing here that could tell: desktop and laptop differ by lid
# handling and a vendor kernel, and each installs perfectly cleanly on the wrong
# hardware and is wrong afterwards — a laptop on the desktop profile suspends on
# lid close, and step 4 below can only catch that because the profile DECLARED
# `lid: none`. Guess the profile and that check is checking the guess.
infer_profile() {
	local dir="$1" f
	local found=()
	for f in "$dir"/*.json; do
		[ -f "$f" ] && found+=("$f")
	done
	case "${#found[@]}" in
	0)
		err "no --profile given, and no *.json in $dir.
  A node is imaged into a DECLARED shape or not at all. Pass --profile FILE, or
  rebuild the stick with \`fleet usb-prep\`."
		return 1
		;;
	1)
		printf '%s' "${found[0]}"
		;;
	*)
		err "no --profile given, and $dir holds ${#found[@]}:
$(printf '    %s\n' "${found[@]}")
  Pass --profile FILE. This will NOT pick one — a node imaged into a shape
  nobody chose is worse than a node that did not get imaged tonight."
		return 1
		;;
	esac
}

# The running system's own name. The Debian installer set it minutes ago, and
# step 3 below is about to write that same value straight back through
# hostnamectl — so reading it is not a new source of truth, it is this script
# declining to make the operator retype one it is already holding.
observed_hostname() {
	local h=""
	command -v hostname >/dev/null 2>&1 && h="$(hostname 2>/dev/null)"
	[ -n "$h" ] || h="$(cat /etc/hostname 2>/dev/null)"
	printf '%s' "$h" | tr -d '[:space:]'
}

# ...and the names that mean NOBODY CHOSE. `debian` is what the installer writes
# when the hostname field is left at its default; `localhost` and
# `localhost.localdomain` are what a netless install falls back to. Those are
# not node names, they are the absence of one, and accepting them enrolls a node
# called `debian` — which the second box then collides with, in the manifest, in
# ssh config, and in every runner label derived from it. Refusing costs one
# flag. Accepting costs a rename across the fleet.
#
# `unknown<mac>` belongs on that list and was missing from it, which cost
# claw-9 a whole install. When DHCP hands back no hostname AND the question is
# suppressed — exactly the Ventoy priority=critical path every claw is imaged
# on — debian-installer does not fall back to `debian` or `localhost`. It
# synthesises `unknown` followed by the boot interface's MAC with the colons
# stripped, and claw-9 came up calling itself `unknown020000005cc5` off
# enp8s0's 02:00:00:00:5c:c5. That is not a default this list recognised, so
# the case below fell through, `infer_hostname` returned it as a deliberate
# choice, and the operator was NEVER ASKED — the one genuinely per-node fact
# went unasked on the one path that cannot supply it. The box then bootstrapped
# under the MAC name, and `fleet enroll` refused it hours later on a FATAL
# hostname mismatch, because the record and the renamed box disagreed.
#
# Matched as a prefix rather than the exact 12-hex form on purpose: the point
# is that NOTHING a person chooses is called `unknown`-anything. A pattern that
# insisted on twelve hex digits would pass `unknown` + a 16-byte InfiniBand
# address straight through, which is the same failure wearing a longer MAC.
infer_hostname() {
	local h="${1:-}"
	case "$h" in
	'' | debian | localhost | localhost.localdomain | unknown | unknown[0-9a-fA-F]*)
		err "no --hostname given, and this box calls itself '${h:-<nothing>}' — which is what a
  box is called when nobody has named it. Either name it now,
  \`hostnamectl set-hostname claw-4\`, and re-run; or pass --hostname NAME.
  This will not enroll a node under the installer's default."
		return 1
		;;
	esac
	printf '%s' "$h"
}

# A refusal is the right answer to an unnamed box. It is the WRONG answer when
# there is a person at the keyboard who can name it in four seconds.
#
# The old refusal told the operator to run `hostnamectl set-hostname claw-4` and
# re-run — which is this script asking someone to do, by hand, the thing it does
# itself in step 3, and doing it a step earlier than the script would have. Done
# by hand it also leaves /etc/hosts stale, so every later `sudo` prints
# "unable to resolve host claw-5" until something repairs it. Step 3 repairs it;
# a hand-run hostnamectl does not.
#
# So: ask, when there is a console to ask at. `read` from /dev/tty rather than
# stdin because this is called inside `$( )` and stdin may be the script itself;
# the PROMPT goes to /dev/tty for the same reason — anything on stdout is
# captured as the answer. With no tty (ssh -T, a pipe, cron) it prints the old
# refusal unchanged and returns non-zero: unattended callers must still fail.
ask_hostname() {
	local observed="$1" name
	# OPEN it, do not stat it. With no controlling terminal /dev/tty still exists
	# as a character device with rw permissions, so `[ -r /dev/tty ]` is TRUE and
	# every printf below then fails with ENXIO — measured, and it produced the
	# worst possible outcome: exit 1 with the refusal never printed, a bootstrap
	# that stopped and said nothing. Only the open distinguishes the two.
	if ! { true >/dev/tty; } 2>/dev/null || ! { true </dev/tty; } 2>/dev/null; then
		err "no --hostname given, and this box calls itself '${observed:-<nothing>}' — which is
  what a box is called when nobody has named it. There is no console to ask at,
  so pass --hostname NAME. This will not enroll a node under the installer's
  default."
		return 1
	fi
	printf '\n  This box has not been named — the installer left it as %s.\n' \
		"${observed:-<nothing>}" >/dev/tty
	printf '  Name it now; this script will set the hostname and /etc/hosts together.\n' >/dev/tty
	while :; do
		printf '  node name (e.g. claw-5): ' >/dev/tty
		read -r name </dev/tty || return 1
		name="$(printf '%s' "$name" | tr -d '[:space:]')"
		if [ -z "$name" ]; then
			printf '  A name is required.\n' >/dev/tty
			continue
		fi
		# RFC 1123: letters, digits and hyphens; no leading or trailing hyphen.
		# Checked here rather than at hostnamectl because hostnamectl's own
		# refusal arrives in step 3, after the profile has been read and the ssh
		# key installed — half a bootstrap away from the typo that caused it.
		case "$name" in
		*[!a-zA-Z0-9-]* | -* | *-)
			printf '  Letters, digits and hyphens only, and not starting or ending with one.\n' >/dev/tty
			continue
			;;
		esac
		if [ ${#name} -gt 63 ]; then
			printf '  Too long — 63 characters at most.\n' >/dev/tty
			continue
		fi
		# The placeholder names again, because someone WILL type `debian`.
		if ! infer_hostname "$name" >/dev/null 2>&1; then
			printf '  "%s" is the absence of a name, not a name. Pick another.\n' "$name" >/dev/tty
			continue
		fi
		printf '%s' "$name"
		return 0
	done
}

# ── inventory, before anything is allowed to refuse ─────────────────────────
# WHY THIS IS THE FIRST THING THAT RUNS.
#
# claw-5 crossed the garage six times over two days for a fault that one line of
# `hardware.txt` states outright: the box has no wireless device. Every trip
# before that ended in a screenful of installer text and a photograph, because
# nothing on this path had ever written down WHAT THE MACHINE IS. The install
# telemetry does it now; so must this, because bootstrap is the first moment a
# real OS with real tools is available to answer the question properly.
#
# It runs before the profile is read, before the hostname is settled, before the
# network is tested — before ANY guard that can say no. A refusal is exactly the
# case where an inventory is worth most: someone is standing at a console that
# just stopped, and the next question is always "what IS this box?".
#
# It never fails the script, and it never runs a tool it has not found. An
# inventory that could abort a bootstrap would be a diagnostic that causes
# outages; a missing `lspci` must degrade to sysfs, not to an empty file.
inventory_dir() {
	# The stick, so the answer leaves the garage with the operator. `$HERE` is
	# .../bootstrap; the kit root is its parent. Falls back to /var/log when the
	# stick is absent or read-only — a saved inventory somewhere beats a lost one.
	local mac tag root
	mac="$(cat /sys/class/net/*/address 2>/dev/null | grep -v '^00:00:00' | head -1 | tr -d ':')"
	tag="$(date -u +%Y%m%dT%H%M%SZ)-${mac:-nomac}"
	root="$(cd "$HERE/.." 2>/dev/null && pwd)"
	if [ -n "$root" ] && [ -w "$root" ]; then
		printf '%s/inventory/%s' "$root" "$tag"
	else
		printf '/var/log/node-inventory/%s' "$tag"
	fi
}

collect_inventory() {
	local d="$1" n i
	mkdir -p "$d" 2>/dev/null || return 0

	# The headline. Everything here is answerable from /proc and /sys alone, so
	# this file exists even on a box with no optional package installed at all.
	{
		echo "collected=$(date -u +%FT%TZ)"
		echo "observed_hostname=$(observed_hostname)"
		echo "vendor=$(cat /sys/class/dmi/id/sys_vendor 2>/dev/null)"
		echo "product=$(cat /sys/class/dmi/id/product_name 2>/dev/null)"
		echo "board=$(cat /sys/class/dmi/id/board_name 2>/dev/null)"
		echo "chassis_type=$(cat /sys/class/dmi/id/chassis_type 2>/dev/null)"
		echo "bios=$(cat /sys/class/dmi/id/bios_version 2>/dev/null)"
		echo "cpu_model=$(grep -m1 '^model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^ //')"
		echo "cpu_threads=$(grep -c ^processor /proc/cpuinfo)"
		echo "mem_total_kb=$(grep -m1 MemTotal /proc/meminfo | tr -dc 0-9)"
		echo "kernel=$(uname -r)"
		echo "arch=$(uname -m)"
		echo "distro=$(. /etc/os-release 2>/dev/null && echo "${ID:-} ${VERSION_CODENAME:-}")"
		echo "battery=$(ls /sys/class/power_supply 2>/dev/null | grep -c BAT)"
		echo "lid_switch=$(ls /proc/acpi/button/lid 2>/dev/null | head -1)"
		# THE COUNTS, AS STATEMENTS. These two lines are the whole reason this
		# function exists: "how many wireless interfaces does this box have" was
		# answerable from the per-interface detail below for six installs running,
		# and nobody read it that way. Zero is a fact worth saying in words.
		echo "wireless_interfaces=$(ls -d /sys/class/net/*/wireless 2>/dev/null | wc -l)"
		echo "wired_interfaces=$(ls -d /sys/class/net/e* 2>/dev/null | wc -l)"
		for n in /sys/class/net/*; do
			i="$(basename "$n")"
			[ "$i" = lo ] && continue
			echo "net.$i.mac=$(cat "$n/address" 2>/dev/null)"
			echo "net.$i.carrier=$(cat "$n/carrier" 2>/dev/null)"
			echo "net.$i.operstate=$(cat "$n/operstate" 2>/dev/null)"
			echo "net.$i.wireless=$([ -d "$n/wireless" ] && echo 1 || echo 0)"
			echo "net.$i.driver=$(basename "$(readlink -f "$n/device/driver" 2>/dev/null)" 2>/dev/null)"
		done
		for n in /sys/block/*; do
			i="$(basename "$n")"
			case $i in loop* | ram* | sr* | dm-* | zram* | md*) continue ;; esac
			echo "disk.$i.bytes=$(($(cat "$n/size" 2>/dev/null || echo 0) * 512))"
			echo "disk.$i.rotational=$(cat "$n/queue/rotational" 2>/dev/null)"
			echo "disk.$i.model=$(cat "$n/device/model" 2>/dev/null)"
		done
	} >"$d/summary.txt" 2>&1

	# Buses. `lspci`/`lsusb` are far more legible, but pciutils and usbutils are
	# both optional on a minimal Debian and neither was in pkgsel/include — so
	# sysfs is the fallback, and it is the sysfs dump that actually proved claw-5
	# has no wireless device on any bus.
	if command -v lspci >/dev/null 2>&1; then
		lspci -nnk >"$d/pci.txt" 2>&1
	else
		for n in /sys/bus/pci/devices/*; do
			echo "$(basename "$n") $(cat "$n/vendor" 2>/dev/null):$(cat "$n/device" 2>/dev/null) class=$(cat "$n/class" 2>/dev/null) driver=$(basename "$(readlink -f "$n/driver" 2>/dev/null)" 2>/dev/null)"
		done >"$d/pci.txt" 2>&1
	fi
	if command -v lsusb >/dev/null 2>&1; then
		lsusb >"$d/usb.txt" 2>&1
	else
		for n in /sys/bus/usb/devices/*; do
			[ -f "$n/idVendor" ] || continue
			echo "$(basename "$n") $(cat "$n/idVendor" 2>/dev/null):$(cat "$n/idProduct" 2>/dev/null) $(cat "$n/product" 2>/dev/null)"
		done >"$d/usb.txt" 2>&1
	fi

	{
		echo "-- links"; ip link 2>&1
		echo "-- addrs"; ip addr 2>&1
		echo "-- routes"; ip route 2>&1
		echo "-- dns"; cat /etc/resolv.conf 2>/dev/null
		echo "-- wireless"; cat /proc/net/wireless 2>/dev/null
		command -v rfkill >/dev/null 2>&1 && { echo "-- rfkill"; rfkill list 2>&1; }
		command -v iw >/dev/null 2>&1 && { echo "-- iw"; iw dev 2>&1; }
	} >"$d/net.txt" 2>&1

	dmesg >"$d/dmesg.txt" 2>&1
	command -v lsblk >/dev/null 2>&1 && lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT >"$d/block.txt" 2>&1
	command -v dmidecode >/dev/null 2>&1 && dmidecode >"$d/dmi.txt" 2>&1
	sync 2>/dev/null || true
	return 0
}


# ── is this box actually on a network? ──────────────────────────────────────
# EVERYTHING BELOW NEEDS ONE. The toolchain, nodejs and tailscale are all
# `apt-get`/`curl` away, so a netless box cannot be bootstrapped by any ordering
# of these steps — and this script used to discover that at the jq install and
# report it as "jq is not installed and could not be installed. Check
# networking." That sentence names a symptom four layers from the cause and sent
# an operator looking at package management for a machine with no wifi card.
#
# So: ask the three questions separately, and say which one failed. A link with
# no carrier, a carrier with no route, and a route that cannot reach the archive
# are three different faults with three different fixes, and exactly one of them
# is bought at a shop.
check_network() {
	local wired wireless carriers route
	wired="$(ls -d /sys/class/net/e* 2>/dev/null | wc -l)"
	wireless="$(ls -d /sys/class/net/*/wireless 2>/dev/null | wc -l)"
	carriers="$(grep -l '^1$' /sys/class/net/*/carrier 2>/dev/null | wc -l)"
	if command -v ip >/dev/null 2>&1; then
		route="$(ip route show default 2>/dev/null | head -1)"
	else
		# Destination 00000000 in /proc/net/route is the default route. Read
		# directly so an absent iproute2 cannot masquerade as an absent route.
		route="$(awk '$2 == "00000000" { print $1; exit }' /proc/net/route 2>/dev/null)"
	fi

	[ -n "$route" ] && command -v getent >/dev/null 2>&1 &&
		getent hosts deb.debian.org >/dev/null 2>&1 && return 0

	err "this box has no usable network, and every step below needs one."
	printf '  interfaces : %s wired, %s wireless\n' "$wired" "$wireless" >&2
	printf '  carrier up : %s\n' "$carriers" >&2
	printf '  default route: %s\n' "${route:-<none>}" >&2
	if [ "$wireless" = 0 ] && [ "$wired" != 0 ] && [ "$carriers" = 0 ]; then
		printf '\n  This box has NO wireless hardware and its wired port has no link.\n' >&2
		printf '  It is not a driver or a package problem: plug it into ethernet.\n' >&2
	elif [ "$wireless" = 0 ] && [ "$wired" = 0 ]; then
		printf '\n  No network hardware of any kind was detected.\n' >&2
	elif [ -z "$route" ]; then
		printf '\n  A link is up but nothing handed out a route — check DHCP.\n' >&2
	else
		printf '\n  Routing works but DNS does not resolve — check /etc/resolv.conf.\n' >&2
	fi
	printf '\n  Full detail: %s\n' "$INVENTORY_DIR" >&2
	printf '  Nothing has been changed on this box.\n' >&2
	return 1
}

# `scripts/lib/onboarding-docs.test.mjs` sources this file to call the guards
# above directly. NOTHING BELOW THIS LINE MAY RUN WHEN IT DOES. `return` is
# legal only in a sourced file, so the fallback covers the case where the
# variable is set in an environment that then EXECUTES the script: without it,
# bash would print "can only `return' from a function", and — there is no
# `set -e` here, on purpose — carry straight on into the preflight.
if [ -n "${NODE_BOOTSTRAP_SOURCE_ONLY:-}" ]; then
	return 0 2>/dev/null || exit 0
fi

# ── preflight ───────────────────────────────────────────────────────────────
[ "$(id -u)" = 0 ] || die "run this as root: sudo bash $0 ..."

INVENTORY_DIR="$(inventory_dir)"
collect_inventory "$INVENTORY_DIR"
log "inventory written to $INVENTORY_DIR (summary.txt has the headline facts)"

[ "$DRY_RUN" = true ] || check_network || exit 1

# What was not typed is inferred, and SAID OUT LOUD, before anything on this box
# changes. An inference the operator cannot check is just a default with better
# manners, and this one is standing at the console watching the screen it typed
# into — this is the one moment where showing the work is free.
#
# `|| exit 1` and not `|| die`: each guard has already printed its whole
# refusal, including the path it looked at and what to do instead. A second
# ERROR line restating it is the script saying the same thing twice, in the
# place the operator can least afford to read it twice.
#
# AND THE GUARDS `return`, THEY DO NOT `die`. That is load-bearing, because they
# are called inside `$( )`: a `die` there exits the SUBSHELL, the substitution
# yields "", and the parent carries on holding an empty string. Returning
# non-zero is what makes the failure reach this line at all — the substitution's
# status is the assignment's status, so `|| exit 1` fires here, in the shell
# that can actually stop. (`preq` below has exactly this shape and does call
# `die`; see the note there.)
if [ -z "$PROFILE_FILE" ]; then
	PROFILES_DIR="$(kit_profiles_dir "$HERE")"
	PROFILE_FILE="$(infer_profile "$PROFILES_DIR")" || exit 1
	log "inferred --profile $PROFILE_FILE (the only profile in $PROFILES_DIR)"
fi
[ -f "$PROFILE_FILE" ] || die "profile not found: $PROFILE_FILE"

if [ -z "$HOSTNAME_NEW" ]; then
	OBSERVED_NAME="$(observed_hostname)"
	# infer first, ask second. A box the installer DID name needs no question,
	# and `2>/dev/null` here is safe only because ask_hostname reprints the whole
	# refusal verbatim when it cannot prompt.
	if HOSTNAME_NEW="$(infer_hostname "$OBSERVED_NAME" 2>/dev/null)"; then
		log "inferred --hostname $HOSTNAME_NEW (this box's own hostname, as the installer set it)"
	else
		HOSTNAME_NEW="$(ask_hostname "$OBSERVED_NAME")" || exit 1
		log "naming this node $HOSTNAME_NEW (set in step 3, with /etc/hosts)"
	fi
fi

if [ -z "$PUBKEY" ]; then
	PUBKEY="$(infer_pubkey "$HERE")" || exit 1
	log "inferred --pubkey $PUBKEY (written beside this script by \`fleet usb-prep\`)"
fi

PROBE="${PROBE:-$HERE/capability-probe.sh}"

# jq reads the profile. A fresh Debian minimal does not have it, and everything
# below needs apt anyway, so install it FIRST and fail loudly if that does not
# work — rather than falling back to a hand-rolled JSON reader whose bugs would
# be silent misconfiguration.
if ! command -v jq >/dev/null 2>&1; then
	log "installing jq (needed to read the profile)"
	export DEBIAN_FRONTEND=noninteractive
	apt-get update -qq >/dev/null 2>&1 || true
	apt-get install -y -qq jq curl ca-certificates >/dev/null 2>&1 || true
fi
command -v jq >/dev/null 2>&1 ||
	die "jq is not installed and apt could not install it — yet this box has a route and
  working DNS, because check_network proved both before anything got here. So this is
  apt's problem, not the network's: try \`apt-get update\` by hand and read what it says.
  This script will not guess at the profile's contents."

jq -e . "$PROFILE_FILE" >/dev/null 2>&1 || die "$PROFILE_FILE is not valid JSON"

# ── the profile ─────────────────────────────────────────────────────────────
# Every read is REQUIRED. `// empty` plus a check, never `// "default"`: a
# profile missing its power policy and a profile that asked for the default must
# not produce the same node, and the second one does not exist.
#
# KNOWN, MEASURED 2026-08-30, DELIBERATELY NOT FIXED IN THIS CHANGE: that `die`
# DOES NOT STOP THE SCRIPT. Every call site is `X="$(preq .a.b)"`, so `exit 1`
# exits the command substitution's SUBSHELL; the assignment lands "" and
# execution carries on. A stub profile holding only `.id` printed thirteen
# "refusing to substitute a default" errors and kept going — it stopped three
# lines later only by luck, when the empty `.os.distro` failed the distro check.
# The fix is a status check at each call site (`X="$(preq .a.b)" || exit 1`),
# which is the shape the inference guards above already use; several call sites
# are inside pipelines and heredocs, so it is not a mechanical edit, and folding
# it into the argument-inference change would mix two failure modes in one diff.
preq() {
	local v
	v="$(jq -r "$1 // empty" "$PROFILE_FILE")"
	[ -n "$v" ] || die "profile $PROFILE_FILE is missing $1 — refusing to substitute a default"
	printf '%s' "$v"
}
parr() { jq -r "$1 // empty | .[]" "$PROFILE_FILE"; }

# EVERY required key is proven present HERE, in the main shell, before any of
# them is read.
#
# `preq`'s own `die` cannot stop this script: every call site is
# `X="$(preq .a.b)"`, so `exit 1` exits the COMMAND SUBSTITUTION's subshell,
# the assignment lands empty, and execution carries on. Measured 2026-08-30
# against a stub profile holding only `.id`: thirteen "refusing to substitute a
# default" errors printed, the script kept running, and it exited 0. The comment
# above preq claimed the opposite.
#
# Thirty call sites, and several sit inside `echo` blocks and an arithmetic
# expansion where `|| exit 1` does not fit. So the check moves here instead: one
# pass, in the main shell, where `die` actually dies — and it happens before the
# first byte is written to the box rather than midway through hardening sshd.
#
# `scripts/lib/onboarding-docs.test.mjs` asserts this list covers every `preq`
# call site, so the two cannot drift.
REQUIRED_PROFILE_KEYS="
.id .role .os.distro .os.codename
.power.chassis .power.lid
.power.watchdog.device .power.watchdog.timeoutSec .power.watchdog.intervalSec
.power.watchdog.maxLoadPerCore .power.watchdog.minMemoryPages
.power.watchdog.retryTimeoutSec .power.watchdog.maxTempMilliC
.users.fleetUser .users.shell .users.sudo .users.homeMode
.network.lanCidr .network.sshPort
.network.sshd.maxAuthTries .network.sshd.permitRootLogin
.network.sshd.pubkeyAuthentication .network.sshd.x11Forwarding
.network.sshd.allowAgentForwarding .network.sshd.allowTcpForwarding
.network.sshd.clientAliveInterval .network.sshd.clientAliveCountMax
.toolchain.node
.unattendedUpgrades.originsPattern
"
MISSING_KEYS=""
for _k in $REQUIRED_PROFILE_KEYS; do
	[ -n "$(jq -r "$_k // empty" "$PROFILE_FILE")" ] || MISSING_KEYS="$MISSING_KEYS $_k"
done
[ -z "$MISSING_KEYS" ] || die "profile $PROFILE_FILE is missing:$MISSING_KEYS
  Every one of these is read while converting the box. Substituting a default
  for any of them means hardening this node into a shape nobody declared."

PROFILE_ID="$(preq .id)"
ROLE="$(preq .role)"
DISTRO_WANT="$(preq .os.distro)"
CODENAME_WANT="$(preq .os.codename)"
CHASSIS="$(preq .power.chassis)"
LID="$(preq .power.lid)"
FLEET_USER="$(preq .users.fleetUser)"
FLEET_SHELL="$(preq .users.shell)"
SUDO_MODEL="$(preq .users.sudo)"
HOME_MODE="$(preq .users.homeMode)"
PROFILE_LAN="$(preq .network.lanCidr)"
# The LAN is a property of the SITE, not of a node SHAPE, and manifests/ is
# published. The profile therefore ships RFC 5737 TEST-NET-1 and the operator
# supplies the real range here. Refusing the placeholder IS the feature: a run
# that kept it would `ufw allow from 192.0.2.0/24` — a network this box is not
# on — leaving SSH-from-LAN shut behind `default deny incoming`, which is the
# lockout class findings 1-8 of the claw-1 retrospective are all about. Silence
# is the failure mode being prevented; "I could not look" must not render as
# "nothing is wrong", and neither must "nobody told me the LAN".
LAN_CIDR="${FLEET_LAN_CIDR:-$PROFILE_LAN}"
case "$LAN_CIDR" in
192.0.2.* | 198.51.100.* | 203.0.113.*)
	die "network.lanCidr is still the documentation placeholder $LAN_CIDR. Set FLEET_LAN_CIDR=<your-lan>/24 before running — bootstrapping with it would open ufw to a network this box is not on and leave SSH from the LAN shut." ;;
esac
[ "$LAN_CIDR" = "$PROFILE_LAN" ] || log "lanCidr from FLEET_LAN_CIDR: $LAN_CIDR (profile ships $PROFILE_LAN)"

# ── the wireless credentials, checked BEFORE the box is touched ─────────────
#
# Section 11b is the last step and it is the one that can take the network away,
# so discovering there that nobody supplied a PSK means eleven steps of writes
# followed by a box that cannot come back when its cable is pulled. The same
# argument as FLEET_LAN_CIDR above, and the same shape: refuse at the top.
#
# Conditional on the box HAVING a radio. A desktop with no wireless hardware and
# a profile that declares a fallback is a normal node, not a misconfiguration —
# claw-5 is the standing example, and treating it as an error would refuse to
# convert a perfectly good machine.
_WIRELESS_DECL="$(jq -r '.network.wireless // empty | tojson' "$PROFILE_FILE")"
if [ -n "$_WIRELESS_DECL" ] && [ "$_WIRELESS_DECL" != null ]; then
	_HAS_RADIO=false
	for _w in /sys/class/net/*/wireless; do
		[ -e "$_w" ] && _HAS_RADIO=true && break
	done
	if [ "$_HAS_RADIO" = true ]; then
		_SSID_ENV="$(printf '%s' "$_WIRELESS_DECL" | jq -r '.networks[0].ssidEnv')"
		_PSK_ENV="$(printf '%s' "$_WIRELESS_DECL" | jq -r '.networks[0].pskEnv')"
		_SSID_VAL="$(eval printf '%s' "\"\${$_SSID_ENV:-}\"")"
		_PSK_VAL="$(eval printf '%s' "\"\${$_PSK_ENV:-}\"")"
		if [ -z "$_SSID_VAL" ] || [ -z "$_PSK_VAL" ]; then
			die "this box has wireless hardware and profile $PROFILE_ID declares a wireless
  fallback, but $_SSID_ENV / $_PSK_ENV are not set.

  THEY NORMALLY COME OFF THE STICK, not off your keyboard. \`fleet usb-prep\` works
  them out on the control host and writes bootstrap/site.env beside this script;
  convert.sh sources it. Reaching this message means the stick was built without
  them - usually because claw-1 was unreachable when it was built, so there was
  nothing to read them off.

  Rebuild the stick (best - then every box after this one is free), or supply
  them for this one box:

    sudo $_SSID_ENV='ExampleNet_5G' $_PSK_ENV='...' sh $KIT_ROOT/bootstrap/convert.sh

  Note \`sudo VAR=...\` and NOT \`VAR=... sudo\`: sudo resets the environment, and
  the second form looks right, runs, and produces exactly the node this refusal
  is preventing.

  Nothing has been changed on this box. Converting without them would leave a
  node that BELIEVES it has a wireless fallback and does not - and the cable
  comes out on that belief."
		fi
		log "wireless credentials supplied for SSID '$_SSID_VAL' (+ fallback band)"
	fi
fi

# ── the PCIe correctable-error storm that killed claw-4's install ───────────
#
# Section 10 of claw-4-install-postmortem-2026-09-01.md, in one check. A Realtek
# RTL8723BE behind PCI Express Root Port #1 threw 2,307,238 CORRECTABLE AER
# errors; the storm consumed enough bus and log bandwidth that USB reads timed
# out, /dev/sdc1 stopped opening, Ventoy's dm-linear window over an extent on
# that device died with it, and pkgsel lost its media with no in-place recovery.
# Two hours, and the storm was first blamed on Ventoy — acting on that diagnosis
# would have cost a rewrite of the whole imaging toolchain and fixed nothing.
#
# It is a WIRELESS card fault and it only appears when the radio is active, so
# it lands on the next box with a radio rather than on the last one.
#
# REPORTED, NOT ACTED ON, and that is the load-bearing half. The remedy is to
# blacklist a driver or pull a card, and doing either automatically on a
# threshold nobody has calibrated would take a working radio away from a healthy
# box. A healthy node reads 0 — claw-4 and claw-5 both do today — and the
# observed fault was 23x the threshold, so anything in between is genuinely
# unclassified and must not be sold as a storm.
# Initialised OUTSIDE the guard. Section 5e reads it, and a profile that
# declares no threshold would otherwise leave it unset — which under `set -u` is
# not a skipped mitigation but a dead script, nine steps from here.
_AER_STORM=""
_AER_LIMIT="$(jq -r '.network.wireless.pcieAerStormThreshold // empty' "$PROFILE_FILE")"
if [ -n "$_AER_LIMIT" ]; then
	for _dev in /sys/bus/pci/devices/*/aer_dev_correctable; do
		[ -r "$_dev" ] || continue
		_sum="$(awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+$/) t += $i } END { print t + 0 }' "$_dev" 2>/dev/null)"
		[ "${_sum:-0}" -gt "$_AER_LIMIT" ] 2>/dev/null || continue
		_slot="$(basename "$(dirname "$_dev")")"
		_drv="$(basename "$(readlink -f "$(dirname "$_dev")/driver" 2>/dev/null)" 2>/dev/null || echo unknown)"
		warn "PCIe CORRECTABLE ERROR STORM: $_slot (driver $_drv) has logged $_sum correctable AER errors, over the $_AER_LIMIT threshold."
		warn "  This is what killed claw-4's install: the storm starves the bus, USB reads time out, and the installer loses its media mid-pkgsel."
		_AER_STORM="$_AER_STORM $_slot($_drv)"
	done

fi
SSH_PORT="$(preq .network.sshPort)"
MAX_AUTH_TRIES="$(preq .network.sshd.maxAuthTries)"
NODE_MAJOR="$(preq .toolchain.node)"

step "profile: $PROFILE_ID  (role=$ROLE chassis=$CHASSIS lid=$LID user=$FLEET_USER)"

# The profile names a distro. Running the Debian profile on something else would
# apt-get its way through a script whose every command is wrong.
DISTRO_ID="$(. /etc/os-release && echo "${ID:-}")"
DISTRO_CODENAME="$(. /etc/os-release && echo "${VERSION_CODENAME:-unknown}")"
KERNEL_REL="$(uname -r)"
[ "$DISTRO_ID" = "$DISTRO_WANT" ] ||
	die "profile $PROFILE_ID is for '$DISTRO_WANT'; this box reports '$DISTRO_ID'. Wrong profile, or wrong box."
if [ "$DISTRO_CODENAME" != "$CODENAME_WANT" ]; then
	warn "profile expects $CODENAME_WANT, this box is $DISTRO_CODENAME — continuing, but the nftables handling below is Trixie-specific."
fi
log "detected: $DISTRO_ID $DISTRO_CODENAME, kernel $KERNEL_REL"

LOGFILE="/var/log/node-bootstrap-$(date +%Y%m%d-%H%M%S).log"
[ "$DRY_RUN" = true ] || exec > >(tee -a "$LOGFILE") 2>&1
log "logging to $LOGFILE"

# ════════════════════════════════════════════════════════════════════════════
# 1. THE SSH KEY, VALIDATED BEFORE ANYTHING TRUSTS IT
# ════════════════════════════════════════════════════════════════════════════
step "1/12 — validating the ssh public key"

KEYS_INSTALLED=false

# `validate_pubkey` itself is defined up with the inference guards, because
# `infer_pubkey` needs it during preflight. It runs again HERE, unconditionally,
# so that the key reaching this step has been checked whether it was inferred or
# typed — one implementation, both doors.
validate_pubkey "$PUBKEY" || die "═══ SSH PUBKEY VALIDATION FAILED — ABORTING BEFORE ANY HARDENING ═══
  Findings 1 and 2 of the claw-1 retrospective are both 'sshd was hardened
  around a key that was not there', and four of that cluster could not be
  recovered over the network. Fix the file and re-run."
log "  key: $(cut -d' ' -f1,3- <"$PUBKEY" | head -1)"

# ════════════════════════════════════════════════════════════════════════════
# 2. THE FLEET USER
# ════════════════════════════════════════════════════════════════════════════
step "2/12 — the fleet user '$FLEET_USER'"

if id "$FLEET_USER" >/dev/null 2>&1; then
	log "  exists"
else
	run useradd -m -s "$FLEET_SHELL" "$FLEET_USER" || die "could not create $FLEET_USER"
	log "  created"
fi

command -v sudo >/dev/null 2>&1 || run apt-get install -y -qq sudo

GROUPS_WANT="$(parr .users.groups | paste -sd, -)"
run usermod -aG "$GROUPS_WANT" "$FLEET_USER" || die "usermod failed"
log "  groups: $(id -nG "$FLEET_USER" 2>/dev/null || echo "$GROUPS_WANT")"

# GROUP MEMBERSHIP IS NOT PASSWORDLESS SUDO. Debian's `%sudo ALL=(ALL:ALL) ALL`
# still demands a password. Without the drop-in below, `fleet slice` and
# `fleet throttle` cannot write or restart this node's SYSTEM units from the
# control host — provision-fleet.mjs says so, and hokon is the standing proof.
if [ "$SUDO_MODEL" = nopasswd ]; then
	write_file "/etc/sudoers.d/$FLEET_USER" <<EOF
$FLEET_USER ALL=(ALL) NOPASSWD:ALL
EOF
	run chmod 440 "/etc/sudoers.d/$FLEET_USER"
	# NEVER skip this. A malformed sudoers file locks every account out, and on a
	# headless box in a garage that means another console trip.
	if [ "$DRY_RUN" = true ]; then
		log "  [dry-run] would validate sudoers"
	elif visudo -c >/dev/null 2>&1; then
		log "  passwordless sudo granted (validated)"
	else
		rm -f "/etc/sudoers.d/$FLEET_USER"
		die "sudoers did NOT validate — the drop-in was removed, system left as it was"
	fi
else
	warn "profile asks for sudo model '$SUDO_MODEL'. This node's system units will NOT be manageable from the control host."
fi

run loginctl enable-linger "$FLEET_USER"

FLEET_HOME="$(getent passwd "$FLEET_USER" | cut -d: -f6)"
[ -n "$FLEET_HOME" ] || die "could not resolve $FLEET_USER's home directory"

run mkdir -p "$FLEET_HOME/.ssh"
if [ "$DRY_RUN" != true ]; then
	# Append rather than overwrite: re-running this on a live node must not
	# revoke a key somebody added by hand.
	if grep -qxF "$(head -1 "$PUBKEY")" "$FLEET_HOME/.ssh/authorized_keys" 2>/dev/null; then
		log "  key already authorised"
	else
		cat "$PUBKEY" >>"$FLEET_HOME/.ssh/authorized_keys"
		log "  key appended to authorized_keys"
	fi
	chmod 700 "$FLEET_HOME/.ssh"
	chmod 600 "$FLEET_HOME/.ssh/authorized_keys"
	chown -R "$FLEET_USER:$FLEET_USER" "$FLEET_HOME/.ssh"
	# sshd SILENTLY rejects authorized_keys when the home directory is
	# group-writable, and Debian's useradd left claw-1's that way.
	chmod "$HOME_MODE" "$FLEET_HOME"
	# The key is on disk, for this user, readable by sshd. THAT is what the
	# hardening below is allowed to depend on.
	[ -s "$FLEET_HOME/.ssh/authorized_keys" ] && KEYS_INSTALLED=true
fi
log "  home: $FLEET_HOME (mode $HOME_MODE), keys installed: $KEYS_INSTALLED"

# ════════════════════════════════════════════════════════════════════════════
# 3. HOSTNAME
# ════════════════════════════════════════════════════════════════════════════
step "3/12 — hostname -> $HOSTNAME_NEW"
# /etc/hosts FIRST, then the hostname. The other order leaves a window in which
# the box answers to a name nothing can resolve, and every `sudo` in it prints
# "unable to resolve host $HOSTNAME_NEW" — which is what an operator sees after
# running hostnamectl by hand, and is why this script does it rather than asking
# them to.
if [ "$DRY_RUN" != true ]; then
	if grep -q '^127.0.1.1' /etc/hosts; then
		sed -i "s/^127.0.1.1.*/127.0.1.1\t$HOSTNAME_NEW/" /etc/hosts
	else
		printf '127.0.1.1\t%s\n' "$HOSTNAME_NEW" >>/etc/hosts
	fi
fi
# HOSTNAMECTL NEEDS D-BUS, AND WILL FAIL WITHOUT SAYING SO LOUDLY ENOUGH.
#
# Measured on claw-4, 2026-09-02: the system bus was not running, hostnamectl
# printed "Failed to connect to system scope bus via local transport: No such
# file or directory", and this script carried straight on through nine more
# steps and declared the node CONVERGED. It left a box whose /etc/hosts said
# claw-4 and whose /etc/hostname said localhost -- named in one file, unnamed in
# the other, and enrolled under a name it did not answer to.
#
# So: try hostnamectl, then VERIFY, and fall back to the plain files if it did
# not take. `hostname` plus /etc/hostname is what hostnamectl writes anyway; it
# only exists to do it through systemd. A writer that does not read back what it
# wrote is exactly the failure this repo is built around.
run hostnamectl set-hostname "$HOSTNAME_NEW"
if [ "$DRY_RUN" != true ]; then
	if [ "$(cat /proc/sys/kernel/hostname 2>/dev/null)" != "$HOSTNAME_NEW" ]; then
		warn "hostnamectl did not take (is the system bus running?) — writing it directly"
		printf '%s\n' "$HOSTNAME_NEW" >/etc/hostname
		hostname "$HOSTNAME_NEW" 2>/dev/null || true
	fi
	# Three places must agree, and all three are read back rather than assumed.
	LIVE="$(cat /proc/sys/kernel/hostname 2>/dev/null)"
	FILED="$(cat /etc/hostname 2>/dev/null | tr -d '[:space:]')"
	if [ "$LIVE" != "$HOSTNAME_NEW" ] || [ "$FILED" != "$HOSTNAME_NEW" ]; then
		die "could not set the hostname to $HOSTNAME_NEW.
  live kernel name : ${LIVE:-<empty>}
  /etc/hostname    : ${FILED:-<empty>}
  Refusing to continue: every later step, and the enrollment record this script
  ends with, names the node. A box enrolled under a name it does not answer to
  is worse than one that stopped here."
	fi
	log "  hostname verified: live, /etc/hostname and /etc/hosts all say $HOSTNAME_NEW"
fi

# ════════════════════════════════════════════════════════════════════════════
# 4. POWER — THE PROFILE DECIDES, AND THE BOX IS CHECKED AGAINST IT
# ════════════════════════════════════════════════════════════════════════════
step "4/12 — power policy (chassis=$CHASSIS lid=$LID)"

# `lid: none` is a CLAIM ABOUT THE HARDWARE, not a way of spelling "do not
# suspend". Verify it. Running the desktop profile on a laptop by mistake leaves
# a fleet node that suspends on lid close — and the fast loop cannot tell that
# apart from a dead box, so it reads as an unexplained offline node forever.
LID_PRESENT=no
for d in /proc/acpi/button/lid/*/; do
	[ -e "$d/state" ] && LID_PRESENT=yes && break
done
case "$LID" in
none)
	[ "$LID_PRESENT" = no ] ||
		die "profile $PROFILE_ID declares lid: none, but this box HAS a lid switch ($(echo /proc/acpi/button/lid/*)).
  That is the wrong profile for this hardware. A laptop imaged with the desktop
  profile suspends on lid close, and nothing downstream can distinguish that
  from a dead node."
	log "  no lid switch — as declared"
	;;
ignore)
	[ "$LID_PRESENT" = yes ] ||
		warn "profile declares lid: ignore but no lid switch was found. The logind rules below are harmless no-ops here."
	;;
esac

while read -r target; do
	[ -n "$target" ] || continue
	run systemctl mask "$target" >/dev/null 2>&1 || true
done < <(parr .power.maskSleepTargets)
log "  masked $(parr .power.maskSleepTargets | wc -l) sleep target(s)"

# `$`-prefixed keys are prose and are skipped, the same way every loader in this
# repo skips them.
{
	echo '[Login]'
	jq -r '.power.logind | to_entries[] | select(.key | startswith("$") | not) | "\(.key)=\(.value)"' "$PROFILE_FILE"
} | write_file /etc/systemd/logind.conf.d/99-fleet-node.conf

if [ "$(jq -r '.power.consoleBlank' "$PROFILE_FILE")" = false ]; then
	GRUB_FILE=/etc/default/grub
	if [ -f "$GRUB_FILE" ] && ! grep -q 'consoleblank=0' "$GRUB_FILE"; then
		run sed -i 's/^GRUB_CMDLINE_LINUX_DEFAULT="\(.*\)"/GRUB_CMDLINE_LINUX_DEFAULT="\1 consoleblank=0"/' "$GRUB_FILE"
		run update-grub >/dev/null 2>&1 || warn "update-grub failed — console blanking will persist until it is re-run"
	fi
	run setterm --blank 0 --powerdown 0 >/dev/null 2>&1 || true
fi

if [ "$(jq -r '.power.wifiPowersave' "$PROFILE_FILE")" = false ] && command -v nmcli >/dev/null 2>&1; then
	write_file /etc/NetworkManager/conf.d/99-no-powersave.conf <<'EOF'
[connection]
wifi.powersave = 2
EOF
fi

# ════════════════════════════════════════════════════════════════════════════
# 5. PACKAGES + VENDOR KERNEL
# ════════════════════════════════════════════════════════════════════════════
# ADD AN APT COMPONENT, AND PROVE IT LANDED.
#
# Two bugs in one place, both found on claw-8's first real run, 2026-09-08.
#
# 1. THE PATTERN NEVER MATCHED. It was
#      s|^\(deb .*\(deb\|security\)\.debian\.org[^#]*\)$|\1 COMP|
#    and `\|` alternation silently does not match in GNU sed 4.9 here —
#    verified directly: `s|^\(a\|x\)bc$|` matches nothing while `s|^\(a\)bc$|`
#    matches. So `non-free` was never added, nvidia-driver had no installation
#    candidate, and claw-8 came up with a GeForce RTX 2060 SUPER and no driver.
#    `debian\.org` alone needs no alternation and matches both deb.debian.org
#    and security.debian.org, while leaving third-party sources alone —
#    pkgs.tailscale.com/stable/debian contains "debian" but not "debian.org".
#
# 2. IT REPORTED SUCCESS WITHOUT LOOKING. The old code printed "apt component
#    'non-free' enabled" straight after the sed, so the log SAID the thing that
#    had not happened. A writer reading its own intention is the exact failure
#    this repo has a rule about; the component is now read back out of the files
#    and a failure to add it is loud.
add_apt_component() {
	local comp="$1" f
	if grep -rqs "^deb .*[[:space:]]$comp\([[:space:]]\|$\)" /etc/apt/sources.list /etc/apt/sources.list.d/ 2>/dev/null; then
		log "  apt component '$comp' already enabled"
		return 0
	fi
	if [ "$DRY_RUN" = true ]; then
		log "  [dry-run] add apt component '$comp' to the debian.org suites"
		return 0
	fi
	for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list; do
		[ -f "$f" ] || continue
		sed -i "s|^\(deb .*debian\.org[^#]*\)$|\1 $comp|" "$f"
	done
	# READ IT BACK. The edit is the writer; this is a different reader.
	if grep -rqs "^deb .*[[:space:]]$comp\([[:space:]]\|$\)" /etc/apt/sources.list /etc/apt/sources.list.d/ 2>/dev/null; then
		log "  apt component '$comp' enabled"
		return 0
	fi
	warn "could not add apt component '$comp' — packages that live in it will have NO installation candidate."
	warn "  Add it by hand to the debian.org lines in /etc/apt/sources.list and re-run."
	return 1
}

step "5a/12 — third-party apt sources"

# ORDER IS THE WHOLE POINT OF THIS SECTION. `toolchain.thirdPartySources`
# declares an apt repo that a package in `toolchain.packages` lives in, so it
# has to be wired BEFORE the install below, not after it. Until 2026-09-08 it
# was declared and never read: the profile carried the github-cli source and
# section 5 ran `apt-get install $(toolchain.packages)` against whatever repos
# the installer happened to leave behind.
#
# WHAT THAT COST, ACCURATELY — because the profile's own $why-gh got this wrong
# and the wrong version is the more alarming one. `gh` IS in trixie/main, at
# 2.46.0-3 (measured from hokon, 2026-09-08). So the install never failed and no
# box was ever left without the binary; what a box got was a version frozen in
# 2024-04, against the 2.100.0 claw-4 carries from GitHub's own repo. A 17-month
# split across the fleet is drift of exactly the shape check-fleet-toolchain.mjs
# exists to find, and it would have read as "gh behaves differently on some
# claws" rather than as a missing repo.
#
# Same aptKeyUrl/aptList shape as os.kernelExtras above, with the key PATH
# spelled out separately: kernelExtras writes one fixed file because only one
# vendor kernel is ever active, and this map is plural.
export DEBIAN_FRONTEND=noninteractive
# `$`-prefixed keys are PROSE, not sources. Every manifest in this repo carries
# `$why`/`$comment` siblings beside its real data, and the first version of this
# loop read `$why` as a source name and died with "thirdPartySources.$why is
# missing aptKeyUrl" — found by actually dry-running the script in a trixie
# container rather than by reading it. Same convention, same filter, everywhere
# this file walks a manifest object's keys.
THIRD_PARTY_NAMES="$(jq -r '.toolchain.thirdPartySources // {} | keys[]? | select(startswith("$") | not)' "$PROFILE_FILE")"
if [ -z "$THIRD_PARTY_NAMES" ]; then
	log "  none declared — every package resolves from the base archive"
else
	for _src in $THIRD_PARTY_NAMES; do
		_key_url="$(jq -r --arg s "$_src" '.toolchain.thirdPartySources[$s].aptKeyUrl // empty' "$PROFILE_FILE")"
		_key_path="$(jq -r --arg s "$_src" '.toolchain.thirdPartySources[$s].aptKeyPath // empty' "$PROFILE_FILE")"
		_list="$(jq -r --arg s "$_src" '.toolchain.thirdPartySources[$s].aptList // empty' "$PROFILE_FILE")"
		# A source missing any of the three is a BROKEN DECLARATION, not an
		# optional one. Skipping it quietly would install the base-archive
		# version and report success — the exact silence this section removes.
		if [ -z "$_key_url" ] || [ -z "$_key_path" ] || [ -z "$_list" ]; then
			die "thirdPartySources.$_src is missing aptKeyUrl, aptKeyPath or aptList. All three are required: a source with no key cannot be verified, and one with no list is never consulted."
		fi
		if [ "$DRY_RUN" = true ]; then
			log "  [dry-run] $_src: key -> $_key_path, list -> /etc/apt/sources.list.d/fleet-$_src.list"
			continue
		fi
		mkdir -p "$(dirname "$_key_path")"
		# `curl | gpg --dearmor` into a TEMP file first: writing the keyring
		# directly means a failed download truncates a key apt is already using,
		# and apt then rejects every repo signed by it rather than just this one.
		_tmp_key="$(mktemp)"
		if curl -fsSL "$_key_url" | gpg --dearmor >"$_tmp_key" 2>/dev/null && [ -s "$_tmp_key" ]; then
			install -m 0644 "$_tmp_key" "$_key_path"
			printf '%s\n' "$_list" >"/etc/apt/sources.list.d/fleet-$_src.list"
			log "  $_src: key installed at $_key_path, source added"
		else
			# Not fatal, and SAY WHY. The package this source carries also exists
			# in the base archive; losing the repo means an older version, not a
			# missing binary. Dying here would strand a whole box on one repo
			# being unreachable at imaging time.
			warn "$_src: could not fetch or dearmor the signing key from $_key_url — this box will take the base-archive version of that source's packages, which may be markedly older"
		fi
		rm -f "$_tmp_key"
	done
fi

step "5/12 — base packages"

run apt-get update -qq
# shellcheck disable=SC2046
run apt-get install -y -qq $(parr .toolchain.packages | tr '\n' ' ') ||
	die "base package install failed — a node missing its toolchain floor is not a node"
run sensors-detect --auto >/dev/null 2>&1 || true

# THE --surface FLAG, DERIVED. The box reads its own DMI vendor string and the
# profile says what that vendor needs. claw-2 and claw-3 are Surface devices and
# claw-1 is not; under the bazooka that difference was an operator's memory.
DMI_VENDOR="$(cat /sys/class/dmi/id/sys_vendor 2>/dev/null | sed 's/[[:space:]]*$//' || true)"
log "  chassis vendor: ${DMI_VENDOR:-unknown}"
EXTRAS="$(jq -r --arg v "$DMI_VENDOR" '.os.kernelExtras[$v] // empty | tojson' "$PROFILE_FILE")"
if [ -n "$EXTRAS" ] && [ "$EXTRAS" != null ]; then
	step "5b/12 — vendor kernel for '$DMI_VENDOR'"
	KEY_URL="$(printf '%s' "$EXTRAS" | jq -r '.aptKeyUrl // empty')"
	APT_LIST="$(printf '%s' "$EXTRAS" | jq -r '.aptList // empty')"
	if [ -n "$KEY_URL" ] && [ -n "$APT_LIST" ]; then
		if [ "$DRY_RUN" = true ]; then
			log "  [dry-run] add apt repo: $APT_LIST"
		else
			wget -qO - "$KEY_URL" | gpg --dearmor >/etc/apt/trusted.gpg.d/fleet-vendor-kernel.gpg ||
				die "could not fetch the vendor kernel signing key from $KEY_URL"
			printf '%s\n' "$APT_LIST" >/etc/apt/sources.list.d/fleet-vendor-kernel.list
			apt-get update -qq
		fi
	fi
	# shellcheck disable=SC2046
	run apt-get install -y -qq $(printf '%s' "$EXTRAS" | jq -r '.packages[]' | tr '\n' ' ') ||
		die "vendor kernel install failed for '$DMI_VENDOR'"
	log "  vendor kernel installed — active after the next reboot"
	while read -r forbidden; do
		[ -n "$forbidden" ] || continue
		if dpkg-query -W -f='${Status}' "$forbidden" 2>/dev/null | grep -q 'ok installed'; then
			# A refusal, not a warning: the retrospective records TLP causing
			# slowdowns and hangs on Surface hardware, and a hung node is exactly
			# the failure this whole script exists to prevent.
			die "'$forbidden' is installed and profile $PROFILE_ID forbids it on '$DMI_VENDOR' hardware. Remove it and re-run."
		fi
	done < <(printf '%s' "$EXTRAS" | jq -r '.forbidPackages // [] | .[]')
else
	log "  no vendor kernel declared for this chassis — stock kernel"
fi

step "5c/12 — masking services that have no job here"
while read -r svc; do
	[ -n "$svc" ] || continue
	if systemctl is-active "$svc" >/dev/null 2>&1 || systemctl is-enabled "$svc" >/dev/null 2>&1; then
		run systemctl stop "$svc" >/dev/null 2>&1 || true
		run systemctl disable "$svc" >/dev/null 2>&1 || true
		run systemctl mask "$svc" >/dev/null 2>&1 || true
		log "  masked $svc"
	fi
done < <(parr .toolchain.maskServices)

# ════════════════════════════════════════════════════════════════════════════
# 5d. THE GPU, IF THE BOX HAS ONE THE PROFILE KNOWS ABOUT
# ════════════════════════════════════════════════════════════════════════════
step "5d/12 — discrete GPU"

# OBSERVED, then matched against a DECLARATION. The box reads its own PCI bus
# and the profile says what that vendor needs — the same split as 5b's DMI
# vendor kernel, and for the same reason: the alternative is an operator
# remembering which box got which driver.
#
# Class 0x03 is the PCI base class for a display controller, which covers both
# `0300` (VGA) and `0302` (3D controller, which is how a headless or
# Optimus-style card enumerates). Matching the base class only is deliberate —
# matching `0x030000` exactly would miss a card that is present and usable.
#
# Read straight from sysfs and not from `lspci`: pciutils is in the package list
# above, but this has to survive the case where that install was partial, and
# /sys/bus/pci/devices needs no tool at all.
GPU_VENDOR=""
GPU_DEV=""
GPU_DRIVER_STATE="none no-managed-gpu"
for _pci in /sys/bus/pci/devices/*; do
	[ -r "$_pci/class" ] || continue
	case "$(cat "$_pci/class" 2>/dev/null)" in
	0x03*) ;;
	*) continue ;;
	esac
	_v="$(cat "$_pci/vendor" 2>/dev/null)"
	# A declared vendor WINS over an undeclared one. An NVIDIA card beside Intel
	# integrated graphics is the common desktop layout, and taking whichever
	# device sysfs happened to list first would install nothing on half of them.
	if [ -n "$(jq -r --arg v "$_v" '.gpu.vendors[$v] // empty' "$PROFILE_FILE")" ]; then
		GPU_VENDOR="$_v"
		GPU_DEV="$(cat "$_pci/device" 2>/dev/null)"
		break
	fi
	[ -n "$GPU_VENDOR" ] || { GPU_VENDOR="$_v"; GPU_DEV="$(cat "$_pci/device" 2>/dev/null)"; }
done

GPU_SPEC=""
[ -n "$GPU_VENDOR" ] && GPU_SPEC="$(jq -r --arg v "$GPU_VENDOR" '.gpu.vendors[$v] // empty | tojson' "$PROFILE_FILE")"

if [ -z "$GPU_VENDOR" ]; then
	log "  no display controller on the PCI bus — nothing to do"
elif [ -z "$GPU_SPEC" ] || [ "$GPU_SPEC" = null ]; then
	# NOT a failure. Most of the fleet is integrated Intel graphics, and a node
	# with a GPU this profile says nothing about is a normal node — it just gets
	# no driver. Named rather than shrugged at, so a genuinely new card is
	# visible in the log instead of silently unhandled.
	log "  display controller $GPU_VENDOR:$GPU_DEV is not declared in gpu.vendors — no driver installed"
	GPU_DRIVER_STATE="none undeclared-vendor-$GPU_VENDOR"
else
	GPU_NAME="$(printf '%s' "$GPU_SPEC" | jq -r '.name // "unknown"')"
	log "  $GPU_NAME GPU at $GPU_VENDOR:$GPU_DEV — declared, installing its driver"

	# The component, before the package that needs it. nvidia-driver lives in
	# plain `non-free`, and trixie's installer enables `non-free-firmware` only —
	# a different component. Without this apt reports the package as
	# uninstallable on a box that is physically holding the card.
	#
	# Rewriting the EXISTING deb lines rather than adding a new source: a second
	# `deb` line for the same suite with different components makes apt fetch two
	# overlapping indexes, and Debian's own tooling treats the components list on
	# the existing line as the single answer.
	while read -r _comp; do
		[ -n "$_comp" ] || continue
		add_apt_component "$_comp" || true
	done < <(printf '%s' "$GPU_SPEC" | jq -r '.aptComponents // [] | .[]')

	run apt-get update -qq || warn "apt-get update failed after adding the GPU components"

	# shellcheck disable=SC2046
	if run apt-get install -y -qq $(printf '%s' "$GPU_SPEC" | jq -r '.packages[]' | tr '\n' ' '); then
		# WHAT "INSTALLED" DOES AND DOES NOT MEAN. The module is built by DKMS
		# against the running kernel, and this kernel booted with nouveau bound to
		# the card — so nothing can use the GPU until a reboot, and EVERY capability
		# probe below will answer `no`. Reporting that as a hardware verdict would
		# strand a working card on a paperwork error, so the state is carried as
		# `pending-reboot` and the record says so.
		if [ "$(printf '%s' "$GPU_SPEC" | jq -r '.requiresReboot // false')" = true ] &&
			! (lsmod 2>/dev/null | grep -q '^nvidia'); then
			GPU_DRIVER_STATE="pending-reboot driver-installed-module-not-loaded"
			warn "GPU driver installed but its kernel module is NOT loaded — this box must REBOOT before any GPU capability can be probed. Until then every GPU probe answers 'no', and that is the reboot, not the card."
		else
			GPU_DRIVER_STATE="ok driver-installed"
			log "  GPU driver installed and its module is loaded"
		fi
	else
		# Not fatal: a claw with no GPU driver is still a perfectly good CI claw,
		# which is what these boxes are FOR. Failing the whole conversion over an
		# accelerator nothing yet routes work to would be the tail wagging the dog.
		GPU_DRIVER_STATE="no driver-install-failed"
		warn "the $GPU_NAME driver failed to install. This node is still a usable CI claw — it simply has no GPU capability. Check that the apt components above resolved, and that linux-headers matching $(uname -r) are available."
	fi
fi

# ════════════════════════════════════════════════════════════════════════════
# 5f. THE RADIO'S DRIVER — "PRESENT" AND "WORKING" ARE DIFFERENT QUESTIONS
# ════════════════════════════════════════════════════════════════════════════
step "5f/12 — wireless driver"

# A RADIO CAN BE PRESENT, BOUND, AND STILL PRODUCE NO INTERFACE.
#
# claw-7, 2026-09-08: a Broadcom BCM4360 sat at 09:00.0 with b43, ssb and bcma
# all loaded and `bcma-pci-bridge` bound to it. None of them drive that chip, so
# /sys/class/net held no wireless entry at all — and section 11b, which looks for
# exactly that, concluded "this box has NO wireless hardware" and passed. That is
# the same sentence it prints for claw-5, which genuinely has no radio, and the
# two situations could not be more different: one is a statement about a machine,
# the other is a fixable fault one package away.
#
# So the PCI BUS is the question now, not the interface list. Class 0x0280 is
# "network controller, other", which is where every wireless card in this fleet
# enumerates; ethernet is 0x0200 and is deliberately not matched.
WIFI_PCI=""
WIFI_PCI_ID=""
for _pci in /sys/bus/pci/devices/*; do
	[ -r "$_pci/class" ] || continue
	case "$(cat "$_pci/class" 2>/dev/null)" in
	0x0280*) ;;
	*) continue ;;
	esac
	WIFI_PCI="$(basename "$_pci")"
	WIFI_PCI_ID="$(cat "$_pci/vendor" 2>/dev/null):$(cat "$_pci/device" 2>/dev/null)"
	break
done

if [ -z "$WIFI_PCI" ]; then
	log "  no wireless controller on the PCI bus — this box is wired-only"
else
	log "  wireless controller $WIFI_PCI_ID at $WIFI_PCI"
	_WIFI_SPEC="$(jq -r --arg k "$WIFI_PCI_ID" '.network.wireless.drivers[$k] // empty | tojson' "$PROFILE_FILE")"
	if [ -z "$_WIFI_SPEC" ] || [ "$_WIFI_SPEC" = null ]; then
		# NOT silently fine. If the card already has a working driver this is
		# harmless; if it does not, this line is the only warning anyone gets.
		if [ -n "$(ls -d /sys/class/net/*/wireless 2>/dev/null)" ]; then
			log "  not declared in wireless.drivers, but a wireless interface exists — the in-tree driver bound it"
		else
			warn "wireless controller $WIFI_PCI_ID is NOT declared in network.wireless.drivers AND no wireless interface exists."
			warn "  The card is present and nothing drives it. Add it to the profile; \`lspci -nnk\` names the module that claimed it."
		fi
	else
		_WIFI_NAME="$(printf '%s' "$_WIFI_SPEC" | jq -r '.name // "unknown"')"
		log "  $_WIFI_NAME — declared, installing its driver"
		while read -r _comp; do
			[ -n "$_comp" ] || continue
			add_apt_component "$_comp" || true
		done < <(printf '%s' "$_WIFI_SPEC" | jq -r '.aptComponents // [] | .[]')

		# BLACKLIST FIRST, INSTALL SECOND. The conflicting modules are already
		# loaded and already bound; installing wl while b43 holds the device gives
		# a built module that cannot claim anything, and the next boot reruns the
		# same race. Writing the blacklist before the install means the DKMS
		# post-install modprobe is the first one with a clear field.
		_BL="$(printf '%s' "$_WIFI_SPEC" | jq -r '.blacklist // [] | .[]')"
		if [ -n "$_BL" ]; then
			{
				echo "# Written by node-bootstrap.sh 5f. These modules CLAIM the wireless"
				echo "# controller and do not drive it: they bind the device, create no"
				echo "# netdev, and win the race against the real driver on every boot."
				printf 'blacklist %s\n' $_BL
			} | write_file /etc/modprobe.d/fleet-wireless-blacklist.conf
			log "  blacklisted: $(printf '%s' "$_BL" | tr '\n' ' ')"
		fi

		run apt-get update -qq || warn "apt-get update failed after adding the wireless components"
		# shellcheck disable=SC2046
		if run apt-get install -y -qq $(printf '%s' "$_WIFI_SPEC" | jq -r '.packages[]' | tr '\n' ' '); then
			_MOD="$(printf '%s' "$_WIFI_SPEC" | jq -r '.module // empty')"
			if [ "$DRY_RUN" != true ] && [ -n "$_MOD" ]; then
				for _m in $_BL; do modprobe -r "$_m" >/dev/null 2>&1 || true; done
				modprobe "$_MOD" >/dev/null 2>&1 || warn "modprobe $_MOD failed — a reboot may be needed for DKMS to finish"
			fi
			# READ THE OBSERVED RESULT, never the install's exit code. A DKMS build
			# reports success and still yields no interface when it built against a
			# kernel this box is not running.
			if [ -n "$(ls -d /sys/class/net/*/wireless 2>/dev/null)" ]; then
				log "  wireless interface is up: $(basename "$(dirname "$(ls -d /sys/class/net/*/wireless | head -1)")")"
			else
				warn "the driver installed but NO wireless interface appeared. A reboot is usually what finishes this; if it does not, \`dmesg | grep -i $_MOD\` says why."
			fi
		else
			warn "the $_WIFI_NAME driver failed to install — this node has no radio until it does"
		fi
	fi
fi

# ════════════════════════════════════════════════════════════════════════════
# 5e. THE PCIe ERROR-STORM MITIGATION, MADE PERMANENT
# ════════════════════════════════════════════════════════════════════════════
# DETECTED in the preflight, before anything was written; PERSISTED here,
# where the box is already being changed. The preflight tells the operator
# "Nothing has been changed on this box" when it refuses, and writing a grub
# drop-in from it would make that a lie.
# ACTED ON, NOT JUST REPORTED — and the change of stance is the point.
#
# This section used to say "REPORTED, NOT ACTED ON, and that is the
# load-bearing half", on the grounds that "the remedy takes hardware away".
# That reasoning was sound about the remedy it had in mind — blacklisting the
# driver, which is what was done to claw-4 — and it is simply not true of this
# one. ASPM is a LINK POWER-SAVING feature. Turning it off leaves the card
# present, bound and usable; it costs a little idle power on a machine whose
# whole job is to be awake. Nothing is removed, so the objection does not
# apply, and refusing to act was protecting the operator from a cost that was
# never there.
#
# It matters here more than it did on claw-4, because claw-7 is imaged with a
# radio it is EXPECTED TO USE as its fallback link. Blacklisting would trade a
# storming card for a node that cannot come back when its cable is pulled.
#
# A DROP-IN, not an edit of /etc/default/grub, so it is one file to delete to
# undo and it cannot fight anything else that writes that file.
if [ -n "$_AER_STORM" ]; then
	step "5e/12 — persisting the PCIe error-storm mitigation"
	log "  storming devices:$_AER_STORM"
	write_file /etc/default/grub.d/90-fleet-pcie.cfg <<-'EOF'
		# Written by node-bootstrap.sh after OBSERVING a PCIe correctable-error
		# storm on this box. See claw-4-install-postmortem-2026-09-01.md section 10.
		#
		# pcie_aspm=off  — ASPM is the documented trigger for these storms.
		# pci=noaer      — stops the kernel LOGGING every correctable error. The
		#                  errors are correctable and harmless individually; what
		#                  killed claw-4 was the volume, which starved the bus and
		#                  wrote 854MB of syslog onto a 1GB partition.
		#
		# Delete this file and run update-grub to undo. The card is NOT
		# blacklisted and keeps working — only link power management changes.
		GRUB_CMDLINE_LINUX="$GRUB_CMDLINE_LINUX pcie_aspm=off pci=noaer"
	EOF
	if run update-grub >/dev/null 2>&1; then
		log "  grub updated — active after the next reboot"
	else
		warn "update-grub failed; the drop-in is written but not yet compiled into grub.cfg"
	fi
fi

# ════════════════════════════════════════════════════════════════════════════
# 6. SSH HARDENING — THE KEYS_INSTALLED GATE
# ════════════════════════════════════════════════════════════════════════════
step "6/12 — sshd"

SSHD_DROPIN=/etc/ssh/sshd_config.d/99-fleet-node.conf

{
	echo "Port $SSH_PORT"
	echo "PermitRootLogin $(preq .network.sshd.permitRootLogin)"
	echo "PubkeyAuthentication $(preq .network.sshd.pubkeyAuthentication)"
	echo "X11Forwarding $(preq .network.sshd.x11Forwarding)"
	echo "AllowAgentForwarding $(preq .network.sshd.allowAgentForwarding)"
	echo "AllowTcpForwarding $(preq .network.sshd.allowTcpForwarding)"
	echo "MaxAuthTries $MAX_AUTH_TRIES"
	echo "ClientAliveInterval $(preq .network.sshd.clientAliveInterval)"
	echo "ClientAliveCountMax $(preq .network.sshd.clientAliveCountMax)"
	echo "AllowUsers $FLEET_USER"
	# THE LOCKOUT LINE. v4 wrote `AuthenticationMethods publickey`
	# unconditionally; it overrides `PasswordAuthentication yes`, so sshd never
	# even offers password auth, and with no keys present the node was gone.
	if [ "$KEYS_INSTALLED" = true ]; then
		echo "PasswordAuthentication no"
		echo "AuthenticationMethods publickey"
	else
		echo "PasswordAuthentication yes"
		echo "AuthenticationMethods publickey,password password"
	fi
} | write_file "$SSHD_DROPIN"

AUTH_MODE="publickey"
[ "$KEYS_INSTALLED" = true ] || AUTH_MODE="publickey+password"
log "  auth mode: $AUTH_MODE"

if [ "$DRY_RUN" != true ]; then
	sshd -t || {
		rm -f "$SSHD_DROPIN"
		die "sshd rejected the configuration — the drop-in was REMOVED and sshd was not restarted. The box is as you found it."
	}
	systemctl enable ssh >/dev/null 2>&1 || systemctl enable sshd >/dev/null 2>&1 || true
	systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null ||
		die "could not restart sshd"
fi

# ── the loopback auth test ──────────────────────────────────────────────────
# Mint a throwaway keypair, authorise it, connect with it, remove it. This
# proves the WHOLE chain — sshd's effective config, the home mode, the
# authorized_keys mode, AllowUsers — without the operator's private key being
# anywhere near this box. v6's test could only pass when a private key already
# happened to be present, which on a fresh install it never is.
SSH_KEY_AUTH=unknown
SSH_KEY_AUTH_DETAIL="not-attempted"
TEST_TAG="fleet-bootstrap-loopback-$$"
TEST_DIR=""

cleanup_loopback_key() {
	# ALWAYS, on every exit path. A throwaway key left in authorized_keys is a
	# credential nobody knows exists, on a node that is about to join a fleet.
	if [ -n "${FLEET_HOME:-}" ] && [ -f "$FLEET_HOME/.ssh/authorized_keys" ]; then
		sed -i "/$TEST_TAG/d" "$FLEET_HOME/.ssh/authorized_keys" 2>/dev/null || true
	fi
	[ -n "$TEST_DIR" ] && rm -rf "$TEST_DIR"
}
trap cleanup_loopback_key EXIT

if [ "$DRY_RUN" != true ] && [ "$KEYS_INSTALLED" = true ] && command -v ssh-keygen >/dev/null 2>&1; then
	log "  testing key auth over loopback with a throwaway key"
	TEST_DIR="$(mktemp -d)"
	chmod 700 "$TEST_DIR"
	if ssh-keygen -q -t ed25519 -N '' -C "$TEST_TAG" -f "$TEST_DIR/k" >/dev/null 2>&1; then
		cat "$TEST_DIR/k.pub" >>"$FLEET_HOME/.ssh/authorized_keys"
		chown "$FLEET_USER:$FLEET_USER" "$FLEET_HOME/.ssh/authorized_keys"
		chmod 600 "$FLEET_HOME/.ssh/authorized_keys"
		chown -R "$FLEET_USER:$FLEET_USER" "$TEST_DIR"
		if runuser -u "$FLEET_USER" -- ssh -i "$TEST_DIR/k" \
			-o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
			-o ConnectTimeout=8 -p "$SSH_PORT" "$FLEET_USER@127.0.0.1" \
			'echo FLEET_KEY_AUTH_OK' 2>/dev/null | grep -q FLEET_KEY_AUTH_OK; then
			SSH_KEY_AUTH=ok
			SSH_KEY_AUTH_DETAIL="throwaway-key-accepted"
			log "  loopback key auth PASSED"
		else
			SSH_KEY_AUTH=no
			SSH_KEY_AUTH_DETAIL="throwaway-key-rejected"
			warn "loopback key auth FAILED — falling back to password auth so this box stays reachable"
			sed -i 's/^PasswordAuthentication no/PasswordAuthentication yes/' "$SSHD_DROPIN"
			sed -i 's/^AuthenticationMethods publickey$/AuthenticationMethods publickey,password password/' "$SSHD_DROPIN"
			if sshd -t; then
				systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || true
				AUTH_MODE="publickey+password"
				warn "The fleet user's password is the one the Debian installer set. This script does not invent one:"
				warn "a random password printed once and stored nowhere is how the claws ended up with no reachable root."
			else
				err "the fallback config ALSO failed sshd -t. Not restarting sshd; the running daemon still has the old config."
			fi
		fi
		sed -i "/$TEST_TAG/d" "$FLEET_HOME/.ssh/authorized_keys"
	else
		SSH_KEY_AUTH_DETAIL="ssh-keygen-failed"
		warn "could not mint a throwaway key — key auth is UNTESTED on this box"
	fi
	rm -rf "$TEST_DIR"
	TEST_DIR=""
fi

# READ SSHD, NOT THE FILE THIS SCRIPT JUST WROTE. `sshd -T` dumps the EFFECTIVE
# configuration after every drop-in, Include and Match has been resolved. A
# check against our own artifact could not fail, which is this repo's oldest
# rule and applies to a shell script exactly as it applies to a gate.
if [ "$DRY_RUN" != true ] && command -v sshd >/dev/null 2>&1; then
	EFFECTIVE="$(sshd -T -C "user=$FLEET_USER,host=localhost,addr=127.0.0.1" 2>/dev/null || true)"
	if [ -z "$EFFECTIVE" ]; then
		warn "sshd -T produced nothing — the effective config could NOT be read. That is 'I could not look', not 'it is fine'."
	else
		printf '%s\n' "$EFFECTIVE" | grep -qi '^pubkeyauthentication yes' ||
			die "sshd's EFFECTIVE config does not enable pubkey auth. Something later in sshd_config overrides the drop-in."
		printf '%s\n' "$EFFECTIVE" | grep -qi "^allowusers .*\\b$FLEET_USER\\b" ||
			warn "sshd's effective AllowUsers does not list $FLEET_USER — check for a second drop-in."
		log "  sshd effective config confirms pubkey auth on port $(printf '%s\n' "$EFFECTIVE" | awk '/^port /{print $2; exit}')"
	fi
fi

# ════════════════════════════════════════════════════════════════════════════
# 7. FIREWALL — nft FLUSH BEFORE UFW
# ════════════════════════════════════════════════════════════════════════════
step "7/12 — firewall"

# Trixie's UFW writes iptables rules through iptables-nft, but nftables is the
# real packet filter. `ufw disable` drops the iptables rules and leaves nftables
# chains with a DROP policy standing — the box goes silent while every tool
# reports the firewall off. Ghost rules also survive a reboot. So: clean slate
# first, every time.
if command -v nft >/dev/null 2>&1; then
	log "  flushing the nftables ruleset (clean slate for UFW)"
	run nft flush ruleset 2>/dev/null || true
fi

if command -v iptables >/dev/null 2>&1; then
	if iptables --version 2>/dev/null | grep -q nf_tables; then
		log "  iptables backend: nf_tables (correct for Trixie)"
	else
		warn "iptables is NOT on the nf_tables backend — UFW's rules may not be the ones that filter."
		if [ -x /usr/sbin/iptables-nft ]; then
			run update-alternatives --set iptables /usr/sbin/iptables-nft >/dev/null 2>&1 || true
			run update-alternatives --set ip6tables /usr/sbin/ip6tables-nft >/dev/null 2>&1 || true
			log "  switched the iptables alternative to the nft backend"
		fi
	fi
fi

run ufw --force reset >/dev/null
run ufw default deny incoming >/dev/null
run ufw default allow outgoing >/dev/null
run ufw allow from "$LAN_CIDR" to any port "$SSH_PORT" proto tcp comment "SSH from LAN" >/dev/null
while read -r spec; do
	[ -n "$spec" ] || continue
	p="${spec%% *}"
	rest="${spec#* }"
	proto="${rest%% *}"
	why="${rest#* }"
	run ufw allow from "$LAN_CIDR" to any port "$p" proto "$proto" comment "$why from LAN" >/dev/null
	log "  allowed $p/$proto from $LAN_CIDR ($why)"
done < <(jq -r '.network.openPorts // [] | .[] | "\(.port) \(.proto) \(.why)"' "$PROFILE_FILE")
run ufw allow in on tailscale0 comment "Tailscale mesh" >/dev/null 2>&1 || true
run ufw --force enable >/dev/null
log "  active: $LAN_CIDR + Tailscale only"

# ════════════════════════════════════════════════════════════════════════════
# 8. FAIL2BAN
# ════════════════════════════════════════════════════════════════════════════
step "8/12 — fail2ban"

IGNORE_IP="$(parr .network.trustedCidrs | paste -sd' ' - | sed "s|$PROFILE_LAN|$LAN_CIDR|g")"
# trustedCidrs is validated against the PROFILE's lanCidr, so an operator
# override has to land in both or the guard below rejects our own substitution.
# Belt and braces on top of the loader's own check. An ignoreip that lost the LAN
# is the 2026-03-03 lockout: fail2ban banned the operator's workstation after a
# client offered several keys, and the ban survived `ufw disable`.
case " $IGNORE_IP " in
*" $LAN_CIDR "*) : ;;
*) die "trustedCidrs does not contain lanCidr $LAN_CIDR — refusing to configure fail2ban to ban the operator" ;;
esac

{
	echo '[sshd]'
	echo 'enabled = true'
	echo "port = $SSH_PORT"
	echo 'maxretry = 5'
	echo 'bantime = 3600'
	echo 'findtime = 600'
	echo "ignoreip = $IGNORE_IP"
	# On Trixie fail2ban must write nftables rules, not iptables ones, or its
	# bans land in a table nothing consults.
	echo 'banaction = nftables-multiport'
	echo 'banaction_allports = nftables-allports'
} | write_file /etc/fail2ban/jail.d/99-fleet-node.conf

run systemctl enable fail2ban >/dev/null 2>&1 || true
run systemctl restart fail2ban >/dev/null 2>&1 || warn "fail2ban did not restart — check 'systemctl status fail2ban'"
log "  ignoreip: $IGNORE_IP"

# ════════════════════════════════════════════════════════════════════════════
# 9. WATCHDOG
# ════════════════════════════════════════════════════════════════════════════
step "9/12 — hardware watchdog"

WD_LOADED=""
while read -r mod; do
	[ -n "$mod" ] || continue
	if run modprobe "$mod" 2>/dev/null; then
		WD_LOADED="$mod"
		break
	fi
done < <(parr .power.watchdog.modules)
if [ -n "$WD_LOADED" ]; then
	write_file /etc/modules-load.d/watchdog.conf <<EOF
$WD_LOADED
EOF
	log "  watchdog module: $WD_LOADED"
else
	warn "no watchdog module from the profile would load — this node will NOT auto-reboot when it wedges"
fi

CORES="$(nproc)"
WD_MAX_LOAD=$((CORES * $(preq .power.watchdog.maxLoadPerCore)))

# Find the CPU PACKAGE sensor BY TYPE. thermal_zone0 was hardcoded in the
# bazooka and is an AMBIENT zone on every node the fleet owns — it read 27C
# against a 95C limit, so the one check meant to protect the hardware watched a
# sensor that could never trip. The index is not stable either: the package zone
# is 3 on claw-1, 7 on claw-2 and 8 on claw-3.
WD_SENSOR=""
for z in /sys/class/thermal/thermal_zone*/; do
	if [ "$(cat "$z/type" 2>/dev/null)" = x86_pkg_temp ]; then
		WD_SENSOR="${z}temp"
		break
	fi
done

{
	echo "watchdog-device = $(preq .power.watchdog.device)"
	echo "watchdog-timeout = $(preq .power.watchdog.timeoutSec)"
	echo "interval = $(preq .power.watchdog.intervalSec)"
	# 8x the MEASURED core count, never a constant. A fixed ceiling shut claw-1
	# down three times in one hour on 2026-08-17 at a 1-minute load of 40 on 8
	# cores — a CI runner's whole purpose is saturation.
	echo "max-load-1 = $WD_MAX_LOAD"
	echo "min-memory = $(preq .power.watchdog.minMemoryPages)"
	echo "retry-timeout = $(preq .power.watchdog.retryTimeoutSec)"
	if [ -n "$WD_SENSOR" ]; then
		echo "temperature-sensor = $WD_SENSOR"
		echo "max-temperature = $(preq .power.watchdog.maxTempMilliC)"
	else
		# No package sensor: omit the check entirely rather than point it at a zone
		# that cannot trip. A check that never fires is worse than none, because it
		# looks like coverage.
		echo "# no x86_pkg_temp zone found — temperature check deliberately omitted"
	fi
} | write_file /etc/watchdog.conf
log "  max-load-1=$WD_MAX_LOAD (${CORES} cores) sensor=${WD_SENSOR:-none}"

{
	echo '[Manager]'
	jq -r '.power.watchdog.systemd | to_entries[] | select(.key | startswith("$") | not) | "\(.key)=\(.value)"' "$PROFILE_FILE"
} | write_file /etc/systemd/system.conf.d/99-watchdog.conf

run systemctl enable watchdog >/dev/null 2>&1 || true
# `systemctl restart watchdog` does NOT work on Debian and this is not a style
# preference. The unit has Conflicts=wd_keepalive.service and an ExecStopPost
# that deliberately exits 1 to fire OnFailure=wd_keepalive as a handover — so a
# restart stops the daemon, starts wd_keepalive, and the conflicting queued
# start is cancelled, leaving NOTHING running.
run systemctl stop wd_keepalive >/dev/null 2>&1 || true
run systemctl start watchdog >/dev/null 2>&1 || warn "the watchdog daemon did not start"

# ════════════════════════════════════════════════════════════════════════════
# 10. UNATTENDED SECURITY UPGRADES
# ════════════════════════════════════════════════════════════════════════════
step "10/12 — unattended security upgrades"

# BEGIN apt-security render. `fleet apt-security --confirm` writes the same two
# files on a node already in service, from scripts/lib/apt-security.mjs, and
# apt-security.test.mjs runs THIS block and compares the bytes: the profile is
# the one source and these are its two renderers.
#
# Origins-Pattern, matched on codename + label. The Allowed-Origins form this
# replaced expanded to `o=Debian,a=trixie-security`, and Debian's security
# archive is `a=stable-security`, so it matched nothing on any node from first
# boot until 2026-10-25 (the profile's `$why-originsPattern` has the measurement).
write_file /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF

{
	echo 'Unattended-Upgrade::Origins-Pattern {'
	parr .unattendedUpgrades.originsPattern | sed 's/.*/    "&";/'
	echo '};'
	echo "Unattended-Upgrade::Remove-Unused-Kernel-Packages \"$(jq -r '.unattendedUpgrades.removeUnusedKernelPackages' "$PROFILE_FILE")\";"
	echo 'Unattended-Upgrade::Remove-Unused-Dependencies "true";'
	# A node that reboots itself mid-job turns a security update into a CI
	# failure with no operator-visible cause. The watchdog owns the "this box is
	# wedged" reboot; nothing else gets one.
	echo "Unattended-Upgrade::Automatic-Reboot \"$(jq -r '.unattendedUpgrades.automaticReboot' "$PROFILE_FILE")\";"
} | write_file /etc/apt/apt.conf.d/50unattended-upgrades
# END apt-security render.

# ════════════════════════════════════════════════════════════════════════════
# 11. TOOLCHAIN + TAILSCALE
# ════════════════════════════════════════════════════════════════════════════
step "11/12 — toolchain"

# THE TOOL CACHE DIRECTORY, OWNED BY THE FLEET USER.
#
# `lib/runner-toolcache.sh` sends a hadoku-owned runner to /opt/hostedtoolcache,
# and `actions/setup-python` resolves interpreters there. Bootstrap never
# created it, so a fresh node reached `fleet seed-python --confirm` and failed
# with "mkdir: cannot create directory '/opt/hostedtoolcache': Permission
# denied" - claw-4 on 2026-09-02, and claw-5 and claw-6 needed the same
# directory made by hand before they could be seeded.
#
# Only the directory. Seeding the interpreters themselves stays with
# `fleet seed-python`, which downloads python-build-standalone and verifies each
# one by IMPORTING ssl and sqlite3 - work that wants the network and a fleet
# view, not a bootstrap step. What bootstrap owes is the place to put them, and
# an owner who can write there without root.
run mkdir -p /opt/hostedtoolcache
run chown "$FLEET_USER:$FLEET_USER" /opt/hostedtoolcache
log "  /opt/hostedtoolcache: ready, owned by $FLEET_USER"


if ! command -v node >/dev/null 2>&1; then
	if [ "$DRY_RUN" = true ]; then
		log "  [dry-run] install Node.js $NODE_MAJOR from deb.nodesource.com"
	else
		curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1 ||
			warn "the NodeSource setup script failed — node was not installed"
		apt-get install -y -qq nodejs >/dev/null 2>&1 || warn "nodejs install failed"
	fi
fi
log "  node: $(node --version 2>/dev/null || echo 'not installed')"

# COREPACK MUST BE ENABLED, or the node has no pnpm at all.
#
# NodeSource ships corepack inside the nodejs package, but corepack writes no
# shims until `corepack enable` runs — so a node came off this script with
# /usr/bin/corepack present and no `pnpm` on PATH anywhere. claw-4 ran that way
# from onboarding until 2026-09-02, when `fleet toolchain` finally reported it
# as DRIFT: "pnpm () reports a store directory that does not exist". The empty
# parentheses were pnpm not existing, not pnpm misconfigured.
#
# The gate caught it AFTER the fact and nothing prevented it: bootstrap installed
# the runtime and not the package manager, so every node needed a manual
# `corepack enable` that lived only in an operator's memory. claw-5 and claw-6
# carry shims stamped within the same minute, which is what that manual step
# looks like on disk.
#
# Deliberately NOT `npm i -g pnpm`: a globally-installed pnpm SHADOWS corepack's
# shim and the two disagree about the store (pnpm 10 -> store/v10, pnpm 11 ->
# store/v11). That is the 2026-08-27 finding check-fleet-toolchain.mjs is written
# around, and installing it that way here would trade a missing pnpm for a silent
# store split.
# COREPACK ASKS BEFORE IT DOWNLOADS, AND THAT QUESTION STOPPED TWO INSTALLS.
#
# corepack's shim fetches the pnpm tarball on first use and prompts
# "! Corepack is about to download ... ? Do you want to continue? [Y/n]" before
# it does. So `pnpm --version` — a line written to REPORT the version — blocked
# waiting for a keypress, on claw-7 and again on claw-8. It never reached the
# log, because the prompt goes to the terminal and the log only sees what the
# command printed afterwards, which is why it looked like the script had simply
# stopped.
#
# The variable is corepack's own (`COREPACK_ENABLE_DOWNLOAD_PROMPT??='0'` is in
# its dist, verified on corepack 0.34.6). Exported rather than set per command:
# the shim runs again on every `pnpm` invocation for the rest of this script,
# and `fleet provision` runs it later too.
#
# This does not suppress a FAILURE — a download that cannot happen still fails
# loudly. It suppresses the CONFIRMATION of a download this script has already
# decided to make.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

if command -v corepack >/dev/null 2>&1; then
	if [ "$DRY_RUN" = true ]; then
		log "  [dry-run] corepack enable (installs the pnpm shim)"
	else
		corepack enable >/dev/null 2>&1 || warn "corepack enable failed — this node will have no pnpm"
	fi
fi
# Report what the node ACTUALLY resolves, not that a command returned 0. A shim
# that exists but cannot run is the state the toolchain gate reads as drift.
log "  pnpm: $(pnpm --version 2>/dev/null || echo 'MISSING — CI builds will fail here')"

# MATERIALISE THE STORE, ON THE FILESYSTEM CI ACTUALLY BUILDS ON.
#
# `corepack enable` gives the node a working pnpm and NOTHING ELSE. The content
# store is created lazily, by the first package fetch — so a freshly bootstrapped
# node has `pnpm --version` answering happily while
# `~/.local/share/pnpm/store/v11` does not exist. `fleet toolchain` reads exactly
# that directory and reported DRIFT on claw-7 and claw-8 the day they were
# onboarded, on boxes whose pnpm was perfectly healthy.
#
# The gate's remedy said "a globally-installed pnpm is shadowing corepack; run
# corepack enable". That is a REAL failure mode (see the note above about
# `npm i -g pnpm`) but it was not this one: pnpm already resolved to
# corepack's shim on both nodes, so the suggested fix was a no-op and the drift
# would have survived it. Two different causes reach the same missing directory.
#
# IT MUST RUN FROM $HOME. pnpm puts the store on the SAME FILESYSTEM as the
# node_modules it is linking into, because the whole point is hardlinks and those
# cannot cross a mount. /tmp on these nodes is tmpfs and $HOME is ext4, so warming
# it from a /tmp scratch directory builds a store in RAM, reports success, and
# leaves the real path as empty as it found it — measured on both nodes before
# this moved.
#
# A real fetch is the only thing that creates it: `pnpm store prune` on a missing
# store is a no-op, verified. So this installs one tiny, stable package and throws
# the project away, which also PROVES the registry is reachable and the shim can
# actually execute — the version string above only proves it can print.
if command -v pnpm >/dev/null 2>&1; then
	if [ "$DRY_RUN" = true ]; then
		log "  [dry-run] warm the pnpm store with one fetch, as $FLEET_USER, under their \$HOME"
	else
		# AS THE FLEET USER, NOT AS ROOT. This script runs as root, and a store
		# warmed here would land in /root/.local/share/pnpm — root's store, on a
		# path the gate never reads — while leaving root-owned scratch files in
		# the fleet user's home. `runuser` is the idiom the rest of this script
		# already uses for this.
		runuser -u "$FLEET_USER" -- env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 bash -c '
			d="$(mktemp -d -p "$HOME" .pnpm-warm.XXXXXX)" || exit 0
			printf "{\"name\":\"store-warm\",\"version\":\"1.0.0\",\"private\":true}\n" >"$d/package.json"
			cd "$d" && timeout 240 pnpm add is-number@7.0.0 --silent >/dev/null 2>&1
			cd /; rm -rf "$d"
		' >/dev/null 2>&1 || true
		# READ THE DIRECTORY BACK. The install above is the writer; asking pnpm
		# where it thinks the store is would be asking the writer. This asks the
		# filesystem, which is what the gate asks.
		_store="$(runuser -u "$FLEET_USER" -- bash -lc 'pnpm store path' 2>/dev/null | tail -1)"
		if [ -n "$_store" ] && [ -d "$_store" ]; then
			log "  pnpm store: $_store"
		else
			warn "pnpm store was not created (${_store:-path unknown}) — \`fleet toolchain\` will report DRIFT for this node"
		fi
	fi
fi

if [ "$(jq -r '.network.tailscale.install' "$PROFILE_FILE")" = true ] && ! command -v tailscale >/dev/null 2>&1; then
	if [ "$DRY_RUN" = true ]; then
		log "  [dry-run] curl -fsSL https://tailscale.com/install.sh | sh"
	else
		curl -fsSL https://tailscale.com/install.sh | sh >/dev/null 2>&1 ||
			warn "tailscale install failed — the LAN rules above still stand"
	fi
fi
# ENABLE THE DAEMON. Installing tailscale does not reliably leave tailscaled
# running: claw-4 came off this script with the binary present and the unit
# stopped, so `tailscale status` answered "failed to connect to local
# tailscaled; it doesn't appear to be running" rather than "Logged out". Those
# two read almost the same to a human and completely differently to a script -
# the first is a dead daemon, the second is a daemon waiting for a login - and
# `fleet enroll` has to tell them apart to know whether it can start the auth.
# Idempotent: --now on an already-running unit is a no-op.
if command -v tailscale >/dev/null 2>&1; then
	run systemctl enable --now tailscaled >/dev/null 2>&1 ||
		warn "tailscaled did not start — \`tailscale up\` will fail until it does"
fi

# TAGS ARE WHY A NODE NEVER COMES BACK FOR RE-AUTH. A tagged device is owned by
# its TAG rather than by a user, and Tailscale disables node key expiry for it.
# Untagged, every box joins a 180-day treadmill — and the treadmill is silent:
# the four nodes enrolled together last pass expired together, claw-1 lapsed on
# 2026-08-31, and NOTHING in the fleet noticed, because every gate reaches the
# claws over LAN and none of them reads the tailnet. Read from the profile
# rather than hardcoded: the tag must already exist in the tailnet ACL's
# tagOwners, or the control plane REJECTS the login — a failure that surfaces
# only in the browser, after the session has already been torn down.
TS_TAGS="$(jq -r '(.network.tailscale.tags // []) | join(",")' "$PROFILE_FILE")"
TS_UP="sudo tailscale up --ssh"
if [ -n "$TS_TAGS" ]; then
	TS_UP="$TS_UP --advertise-tags=$TS_TAGS"
fi

if [ "$(jq -r '.network.tailscale.ssh' "$PROFILE_FILE")" = true ]; then
	log "  tailscale: installed, NOT authenticated. Run: $TS_UP"
	[ -n "$TS_TAGS" ] ||
		warn "no tailscale tags declared in this profile — this node's key WILL expire in 180 days"
fi

case "$ROLE" in
agent | both)
	# Deliberately NOT automated. Retrospective findings 9-12 are unresolved bugs
	# in `openclaw onboard` (a systemd unit it fails to create, a documented flag
	# that does not exist, a 10s warmup that reads as a failure, and `su -`
	# breaking the user session). Encoding workarounds for those would bake in
	# someone else's bug; the prerequisites are installed and the rest is said out
	# loud instead of pretended.
	log "  role=$ROLE: agent PREREQUISITES are installed (node, xvfb deps come from the package list)."
	log "  Agent onboarding is MANUAL and stays manual — see the claw-1 retrospective, findings 9-12."
	;;
runner)
	log "  role=runner: no agent software installed."
	;;
esac

# ════════════════════════════════════════════════════════════════════════════
# 11b. WIRELESS FALLBACK — SO PULLING THE CABLE IS A ROUTE CHANGE, NOT AN OUTAGE
# ════════════════════════════════════════════════════════════════════════════
step "11b/12 — wireless fallback"

# LAST, ON PURPOSE. Everything above needs the network to fetch packages, and
# this is the one section that can take the network away. Running it here means
# a failure costs a rollback rather than a half-converted box, and by this point
# there is nothing left to download.
#
# WHY NETWORKMANAGER AND NOT IFUPDOWN. Measured in this fleet, not chosen on
# taste: during the 2026-09-07 SSID rename claw-1 (NM) reassociated unaided and
# claw-3 (ifupdown) did not, because ifupdown never retries — and recovering
# claw-3 cost a garage trip. See `garage-network-constraint` in this package's
# memory.
#
# WHY BOTH INTERFACES MOVE. Giving NM the radio and leaving the wired port on
# ifupdown is worse than doing nothing. d-i writes the wired stanza into
# /etc/network/interfaces, NM ships `managed=false` for exactly those
# interfaces, and `allow-hotplug` does NOT react to carrier loss on an interface
# that is already up. Pull the cable in that split and the dead wired default
# route STAYS, at a better metric than the radio's, and the box blackholes
# itself while both links still look configured.
WIFI_STATE="none no-policy-declared"
WIFI_MAC=""
WIFI_DRIVER=""
WIRELESS_SPEC="$(jq -r '.network.wireless // empty | tojson' "$PROFILE_FILE")"

# The radio, OBSERVED. /sys/class/net/<if>/wireless needs no tool at all, which
# is why it is read instead of `iw` — the claw-5 telemetry capture was three
# `iw: not found` usage messages because the initrd had neither iw nor `ip -br`.
WLAN_IF=""
for _w in /sys/class/net/*/wireless; do
	[ -e "$_w" ] || continue
	WLAN_IF="$(basename "$(dirname "$_w")")"
	break
done
# The wired port — THE ONE WITH A CABLE IN IT, not the first one listed.
#
# claw-7 has two: `eno1` (onboard Intel I218-V, empty) and `enp8s0` (Intel I211,
# carrying the link). Taking the first `/sys/class/net/e*` alphabetically picked
# `eno1`, so NetworkManager got a connection for a dead port while the live one
# stayed on the installer's dhclient — `connected (externally)`, default route
# at metric 1002 instead of the 100 this profile asks for. Both links looked
# configured and neither was under one manager, which is the precise split 11b
# exists to prevent.
#
# `carrier` is how the preseed's own WIRED_LATE already chooses, twenty lines of
# this repo away. The precedent was there and this did not follow it.
#
# Falls back to the first port when nothing has a carrier, so a box converted
# with every cable out still gets a wired connection written for its next boot.
WIRED_IF=""
for _e in /sys/class/net/e*; do
	[ -e "$_e" ] || continue
	if [ "$(cat "$_e/carrier" 2>/dev/null)" = 1 ]; then
		WIRED_IF="$(basename "$_e")"
		break
	fi
	[ -n "$WIRED_IF" ] || WIRED_IF="$(basename "$_e")"
done

if [ -z "$WIRELESS_SPEC" ] || [ "$WIRELESS_SPEC" = null ]; then
	# The five wired claws and the three existing laptops land here and are
	# untouched. A profile that declares nothing must CHANGE nothing — this
	# section is a conversion, and a conversion nobody asked for is a migration
	# smuggled into a re-run.
	log "  no network.wireless policy in this profile — leaving networking exactly as the installer left it"
elif [ -z "$WLAN_IF" ] && [ -n "${WIFI_PCI:-}" ]; then
	# THE DISTINCTION THAT LET claw-7 THROUGH. A radio that is PRESENT but has no
	# driver is not "no wireless hardware" — it is a fault, one package away from
	# working, and section 5f has already tried. Reporting it as absence is the
	# same sentence claw-5 gets, and claw-5's answer is a fact about the machine
	# while this one is a fixable defect. "I could not look" must never render as
	# "nothing is wrong", and neither must "it is broken".
	err "this box HAS a wireless controller ($WIFI_PCI_ID at $WIFI_PCI) and NO wireless interface."
	err "  Section 5f either has no entry for it or its driver did not bind. This node cannot"
	err "  fall back to wifi, so its cable must not be pulled."
	WIFI_STATE="no controller-present-no-interface-$WIFI_PCI_ID"
elif [ -z "$WLAN_IF" ]; then
	# claw-5's whole six-install saga was this condition, undiagnosed: an
	# ethernet port with no cable, no wireless hardware at all, and six rounds of
	# "DHCP keeps failing". It is not an error — a desktop with no radio is a
	# normal node — but it is SAID, because the profile asked for something this
	# box physically cannot do.
	log "  policy declares a wireless fallback, but this box has NO wireless hardware (no /sys/class/net/*/wireless)."
	log "  That is a statement about the box, not a fault. It will be reachable on ethernet only."
	WIFI_STATE="none no-wireless-hardware"
else
	WIFI_DRIVER="$(basename "$(readlink -f "/sys/class/net/$WLAN_IF/device/driver" 2>/dev/null)" 2>/dev/null || true)"
	WIFI_MAC="$(cat "/sys/class/net/$WLAN_IF/address" 2>/dev/null || true)"
	log "  radio: $WLAN_IF (driver ${WIFI_DRIVER:-unknown}, mac ${WIFI_MAC:-unknown})"
	log "  wired: ${WIRED_IF:-<none>}"

	WIFI_SSID="$(eval printf '%s' "\"\${$(printf '%s' "$WIRELESS_SPEC" | jq -r '.networks[0].ssidEnv'):-}\"")"
	WIFI_PSK="$(eval printf '%s' "\"\${$(printf '%s' "$WIRELESS_SPEC" | jq -r '.networks[0].pskEnv'):-}\"")"
	WIFI_SSID2="$(eval printf '%s' "\"\${$(printf '%s' "$WIRELESS_SPEC" | jq -r '.networks[1].ssidEnv // "__unset__"'):-}\"")"
	WIFI_PSK2="$(eval printf '%s' "\"\${$(printf '%s' "$WIRELESS_SPEC" | jq -r '.networks[1].pskEnv // "__unset__"'):-}\"")"
	# One password across both bands is the normal gateway shape; requiring it
	# twice only invents a way to typo it.
	[ -n "$WIFI_PSK2" ] || WIFI_PSK2="$WIFI_PSK"

	if [ -z "$WIFI_SSID" ] || [ -z "$WIFI_PSK" ]; then
		# The preflight refuses this before anything is written, so reaching here
		# means the environment changed underneath the run. Loud, and NOT ready:
		# a box that believes it has a fallback and does not is worse than one
		# that never claimed to, because the cable comes out on that belief.
		WIFI_STATE="no credentials-absent"
		err "wireless policy declared and hardware present, but $(printf '%s' "$WIRELESS_SPEC" | jq -r '.networks[0].ssidEnv') / $(printf '%s' "$WIRELESS_SPEC" | jq -r '.networks[0].pskEnv') are empty."
		err "  This node will NOT come back if its cable is pulled. Re-run with both set."
	else
		run apt-get install -y -qq network-manager ||
			warn "network-manager failed to install — the wireless fallback cannot be configured"

		if [ "$DRY_RUN" = true ]; then
			log "  [dry-run] hand $WIRED_IF and $WLAN_IF to NetworkManager"
			log "  [dry-run] write connections: fleet-wired, fleet-wifi-primary ($WIFI_SSID), fleet-wifi-fallback (${WIFI_SSID2:-<none>})"
			WIFI_STATE="ok dry-run"
		elif ! command -v nmcli >/dev/null 2>&1; then
			WIFI_STATE="no networkmanager-absent"
			err "NetworkManager is not installed; the wireless fallback was NOT configured."
		else
			WIRED_METRIC="$(printf '%s' "$WIRELESS_SPEC" | jq -r '.wiredRouteMetric')"
			WLAN_METRIC="$(printf '%s' "$WIRELESS_SPEC" | jq -r '.wirelessRouteMetric')"
			PRIO1="$(printf '%s' "$WIRELESS_SPEC" | jq -r '.networks[0].priority')"
			PRIO2="$(printf '%s' "$WIRELESS_SPEC" | jq -r '.networks[1].priority // 1')"

			# ROLLBACK ANCHOR. Taken before the first write, restored if the
			# verification below fails. `.fleet-pre-nm` rather than `.bak`: this
			# names WHAT it is a backup from, so a future operator finding it knows
			# which change to undo.
			IFACES_BACKUP=/etc/network/interfaces.fleet-pre-nm
			[ -f /etc/network/interfaces ] && [ ! -f "$IFACES_BACKUP" ] &&
				cp -a /etc/network/interfaces "$IFACES_BACKUP"

			# A keyfile per connection, mode 0600, rather than three `nmcli con
			# add` invocations. The file IS the declaration: it can be diffed,
			# re-applied and read back by a probe, where nmcli's result can only be
			# interrogated. NM refuses to load a connection file that is
			# group- or world-readable, which is also the PSK's protection.
			nm_conn() {
				local dest="/etc/NetworkManager/system-connections/$1.nmconnection"
				mkdir -p /etc/NetworkManager/system-connections
				cat >"$dest"
				chmod 600 "$dest"
			}

			if [ -n "$WIRED_IF" ]; then
				nm_conn fleet-wired <<-EOF
					[connection]
					id=fleet-wired
					type=ethernet
					interface-name=$WIRED_IF
					autoconnect=true
					autoconnect-priority=100

					[ethernet]
					cloned-mac-address=permanent

					[ipv4]
					method=auto
					route-metric=$WIRED_METRIC
					dhcp-client-id=mac
					dhcp-send-hostname=true
					dhcp-hostname=$HOSTNAME_NEW

					[ipv6]
					method=auto
					route-metric=$WIRED_METRIC
				EOF
				log "  wrote fleet-wired ($WIRED_IF, route metric $WIRED_METRIC)"
			fi

			# `cloned-mac-address=permanent` IS THE RESERVATION'S FOUNDATION and is
			# not a hardening detail. NM can randomise a wifi MAC per connection,
			# and a randomised MAC draws a NEW DHCP lease every association — so
			# the node's address would move on its own, which is the precise
			# failure this whole section exists to prevent. `dhcp-client-id=mac`
			# is the other half: it makes the lease key on the MAC, which is what
			# the gateway's reservation list keys on too.
			nm_wifi() {
				local name="$1" ssid="$2" psk="$3" prio="$4"
				nm_conn "$name" <<-EOF
					[connection]
					id=$name
					type=wifi
					interface-name=$WLAN_IF
					autoconnect=true
					autoconnect-priority=$prio

					[wifi]
					mode=infrastructure
					ssid=$ssid
					cloned-mac-address=permanent

					[wifi-security]
					key-mgmt=wpa-psk
					psk=$psk

					[ipv4]
					method=auto
					route-metric=$WLAN_METRIC
					dhcp-client-id=mac
					dhcp-send-hostname=true
					dhcp-hostname=$HOSTNAME_NEW

					[ipv6]
					method=auto
					route-metric=$WLAN_METRIC
				EOF
				log "  wrote $name (ssid '$ssid', autoconnect-priority $prio, route metric $WLAN_METRIC)"
			}

			nm_wifi fleet-wifi-primary "$WIFI_SSID" "$WIFI_PSK" "$PRIO1"
			if [ -n "$WIFI_SSID2" ] && [ "$WIFI_SSID2" != "$WIFI_SSID" ]; then
				nm_wifi fleet-wifi-fallback "$WIFI_SSID2" "$WIFI_PSK2" "$PRIO2"
			else
				# The SSID-rename outage is the reason this is a warning and not a
				# shrug: a node holding one SSID is one gateway rename from stranded.
				warn "only one SSID supplied — this node has no second-band fallback, and an SSID rename would strand it (2026-09-07 is the precedent)"
			fi

			# Hand the installer's interfaces over. NM's ifupdown plugin ships
			# managed=false, so without this it refuses to touch anything named in
			# /etc/network/interfaces — which is exactly the wired port.
			write_file /etc/NetworkManager/conf.d/10-fleet-managed.conf <<-EOF
				# Written by node-bootstrap.sh. NM's ifupdown plugin defaults to
				# managed=false, which would leave the wired port on ifupdown while
				# NM held only the radio — the split that makes a pulled cable
				# blackhole the box (the stale wired default route outlives the
				# carrier). One manager owns both interfaces, or neither.
				[ifupdown]
				managed=true
			EOF

			# Neutralise the d-i wired stanza. `lo` is LEFT ALONE deliberately:
			# NM does not manage loopback, and commenting it out would leave the
			# box without 127.0.0.1 if NM ever failed to start.
			if [ -f /etc/network/interfaces ]; then
				awk '
					/^[[:space:]]*(auto|allow-hotplug)[[:space:]]+lo([[:space:]]|$)/ { print; next }
					/^[[:space:]]*iface[[:space:]]+lo([[:space:]]|$)/ { inlo=1; print; next }
					/^[[:space:]]*(auto|allow-hotplug|iface)[[:space:]]/ {
						inlo=0
						print "# fleet: managed by NetworkManager (node-bootstrap 11b) -- " $0
						next
					}
					inlo { print; next }
					/^[[:space:]]*(address|netmask|gateway|dns-|wpa-|hwaddress|pre-up|post-up|up|down)/ {
						print "# fleet: managed by NetworkManager (node-bootstrap 11b) -- " $0
						next
					}
					{ print }
				' "$IFACES_BACKUP" >/etc/network/interfaces.fleet-new &&
					mv /etc/network/interfaces.fleet-new /etc/network/interfaces
				log "  commented the installer's wired stanza out of /etc/network/interfaces (backup: $IFACES_BACKUP)"
			fi

			# `/etc/network/interfaces` is `source`d from `interfaces.d/*`, and the
			# awk above only rewrites the main file. Nothing in this repo writes a
			# stanza there — the preseed's WIRED_LATE and claw-fix.sh both append to
			# the main file — so this is a warning rather than a second rewrite: a
			# stanza in a file nobody here writes is somebody else's, and refusing to
			# guess is this directory's rule. It is SAID, because a stanza that
			# survives here re-ups its interface on the next boot and puts the box
			# straight back into the split this section exists to prevent.
			for _d in /etc/network/interfaces.d/*; do
				[ -f "$_d" ] || continue
				if grep -qE '^[[:space:]]*(auto|allow-hotplug|iface)[[:space:]]+([^l]|l[^o])' "$_d" 2>/dev/null; then
					warn "$_d declares an interface and was NOT neutralised — NetworkManager and ifupdown will both claim it on the next boot"
				fi
			done

			# HAND THE RUNNING INTERFACES OVER, NOT JUST THE CONFIG.
			#
			# Commenting the stanza out changes what happens at the NEXT boot and
			# nothing at all about right now: ifupdown has already brought the
			# interface up, its dhclient still holds the lease, and
			# /run/network/ifstate still records it as configured. NM declines to
			# touch a device another stack is on, so the box runs with TWO managers
			# until somebody reboots it — and the stale default route outlives the
			# carrier it was learned on, which is the exact way a pulled cable
			# blackholes a box.
			#
			# MEASURED, not theorised: claw-7 was converted by this section on
			# 2026-09-08 and on 2026-09-09 still reported ifupdown holding enp8s0,
			# with two default routes — metric 600 (NM, wifi) and 1002 (the
			# installer's dhclient, wired). The verification below could not see it,
			# because a stale route satisfies "is there a default route".
			#
			# `--force`, never a bare `ifdown`: the 2026-09-07 claw-3 outage was a
			# plain `ifdown` failing, leaving ifstate saying the interface was still
			# configured, and the following `ifup` treating it as a no-op. The
			# interface is down for well under a second before NM is restarted below,
			# and if NM does not pick it up, the rollback at the end of this section
			# restores ifupdown and restarts networking.
			if [ -f /run/network/ifstate ] && command -v ifdown >/dev/null 2>&1; then
				while IFS='=' read -r _if _; do
					[ -n "$_if" ] && [ "$_if" != lo ] || continue
					ifdown --force "$_if" >/dev/null 2>&1 || true
					log "  released $_if from ifupdown (--force; a plain ifdown is the 2026-09-07 trap)"
				done </run/network/ifstate
			fi

			# THE THIRD STACK. ifupdown is not the only thing that may already own a
			# link on a box imaged from this stick: when the preseed is built with
			# wifi credentials, its late_command installs wpasupplicant, writes
			# /etc/systemd/network/25-wireless.network matching `wl*`, and enables
			# systemd-networkd — see lib/make-preseed.sh, WIFI_LATE. So a freshly
			# imaged wireless box arrives with ifupdown on the cable AND
			# networkd+wpa_supplicant on the radio.
			#
			# Two managers configuring one interface is not a merge, it is a race:
			# both run DHCP, both install a default route, and which one answers is
			# whichever settled last. Masked rather than disabled, for the same
			# reason the sleep targets above are — `disable` does not stop something
			# else pulling the unit back in as a dependency.
			for _u in wpa_supplicant systemd-networkd systemd-networkd.socket; do
				if systemctl is-enabled "$_u" >/dev/null 2>&1 || systemctl is-active "$_u" >/dev/null 2>&1; then
					systemctl stop "$_u" >/dev/null 2>&1 || true
					systemctl disable "$_u" >/dev/null 2>&1 || true
					log "  stopped $_u — NetworkManager owns the radio now"
				fi
			done
			# The templated instance the preseed enables by name. It is NOT covered
			# by the loop above: `systemctl is-enabled wpa_supplicant` says nothing
			# about `wpa_supplicant@wlan0`, which is a different unit.
			while read -r _inst; do
				[ -n "$_inst" ] || continue
				systemctl stop "$_inst" >/dev/null 2>&1 || true
				systemctl disable "$_inst" >/dev/null 2>&1 || true
				log "  stopped $_inst"
			done < <(systemctl list-unit-files 'wpa_supplicant@*' --no-legend 2>/dev/null | awk '{print $1}')

			systemctl enable NetworkManager >/dev/null 2>&1 || true
			systemctl restart NetworkManager >/dev/null 2>&1 || true

			# VERIFY, THEN KEEP OR ROLL BACK. "I could not look" must never render
			# as "nothing is wrong" — and here the thing being looked at is the
			# link this script is running over. Up to 30s because DHCP plus a WPA
			# association is genuinely slower than a wired renew.
			#
			# THREE CONDITIONS, AND THE FIRST ONE IS THE ONE THAT WAS MISSING.
			# "Is there a default route and does DNS resolve" asks whether THE
			# NETWORK works, not whether THE CONVERSION worked, and the stack this
			# section is replacing satisfies it perfectly: an ifupdown dhclient that
			# was already running answers both. That is the reader-may-not-read-what-
			# the-writer-wrote rule, and it is why claw-7 came out of this section
			# green while still split. So the radio must be `connected` under a
			# connection THIS section wrote, from NetworkManager's own device list.
			WIFI_OK=false
			for _i in $(seq 1 15); do
				_NM_CONN="$(nmcli -t -f DEVICE,STATE,CONNECTION device status 2>/dev/null |
					awk -F: -v d="$WLAN_IF" '$1 == d && $2 == "connected" { print $3 }' | head -1)"
				case "$_NM_CONN" in
				fleet-wifi-*)
					if ip route show default 2>/dev/null | grep -q . &&
						getent hosts deb.debian.org >/dev/null 2>&1; then
						WIFI_OK=true
						break
					fi
					;;
				esac
				sleep 2
			done

			# Read from ifupdown's OWN state file, not from the config this script
			# just rewrote. /run is tmpfs, so anything still listed here is an
			# interface ifupdown brought up and has not released.
			_STILL_IFUPDOWN=""
			if [ -f /run/network/ifstate ]; then
				_STILL_IFUPDOWN="$(awk -F= '$1 != "lo" && $1 != "" { printf " %s", $1 }' /run/network/ifstate)"
			fi

			if [ "$WIFI_OK" = true ]; then
				WIFI_STATE="ok networkmanager"
				# A conversion that leaves the other stack holding an interface is
				# not finished, and it does not fail quietly on its own — it fails
				# when the cable comes out weeks later.
				[ -z "$_STILL_IFUPDOWN" ] ||
					warn "ifupdown still holds:$_STILL_IFUPDOWN — two managers on one box. Reboot this node before trusting its fallback."
				log "  NetworkManager has the network: $(ip route show default 2>/dev/null | head -1)"
				nmcli -t -f NAME,DEVICE,STATE con show --active 2>/dev/null |
					while IFS= read -r _l; do log "  active: $_l"; done
			else
				WIFI_STATE="no verify-failed-rolled-back"
				err "NetworkManager did not bring the network back within 30s. ROLLING BACK to ifupdown."
				# SAY WHICH OF THE THREE. A rate limit, a wrong PSK and a stale
				# ifupdown lease are three different jobs, and a rollback that
				# discards the reason makes the next attempt a guess.
				err "  $WLAN_IF under NetworkManager: $(nmcli -t -f DEVICE,STATE,CONNECTION device status 2>/dev/null | awk -F: -v d="$WLAN_IF" '$1 == d { print $2 " on " ($3 == "" ? "<no connection>" : $3) }' | head -1 || echo '<nmcli said nothing>')"
				err "  default route: $(ip route show default 2>/dev/null | head -1 || true)${_STILL_IFUPDOWN:+ (ifupdown still holds:$_STILL_IFUPDOWN)}"
				err "  DNS: $(getent hosts deb.debian.org >/dev/null 2>&1 && echo resolves || echo 'deb.debian.org does not resolve')"
				cp -a "$IFACES_BACKUP" /etc/network/interfaces
				rm -f /etc/NetworkManager/conf.d/10-fleet-managed.conf
				systemctl stop NetworkManager >/dev/null 2>&1 || true
				systemctl disable NetworkManager >/dev/null 2>&1 || true
				systemctl restart networking >/dev/null 2>&1 || true
				err "  rolled back. The connection files are still in /etc/NetworkManager/system-connections/ for inspection; the PSK in them is the one you supplied."
			fi
		fi
	fi
fi

# ════════════════════════════════════════════════════════════════════════════
# 12. MEASURE, AND EMIT THE ENROLLMENT RECORD
# ════════════════════════════════════════════════════════════════════════════
step "12/12 — measuring this node"

MEM_TOTAL_KB="$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null)"
[ -n "$MEM_TOTAL_KB" ] || MEM_TOTAL_KB=""
MEM_AVAIL_KB="$(awk '/^MemAvailable:/{print $2}' /proc/meminfo 2>/dev/null)"

ROOT_SRC="$(findmnt -no SOURCE / 2>/dev/null | sed 's/\[.*//' || true)"
ROOT_DISK="$(lsblk -sln -o NAME,TYPE "$ROOT_SRC" 2>/dev/null | awk '$2=="disk"{print $1; exit}')"
DISK_MODEL="$(lsblk -ndo MODEL "/dev/$ROOT_DISK" 2>/dev/null | sed 's/  */ /g;s/^ //;s/ *$//')"
DISK_FREE_GB="$(df -BG --output=avail / 2>/dev/null | tail -1 | tr -dc '0-9')"

# `sudo -n` from the fleet user, executed. Reading /etc/sudoers.d would be
# reading this script's own write.
SUDO_OK=no
SUDO_DETAIL="sudo -n refused"
if runuser -u "$FLEET_USER" -- sudo -n true >/dev/null 2>&1; then
	SUDO_OK=ok
	SUDO_DETAIL="sudo -n succeeded"
fi

# WHAT THIS CAN AND CANNOT KNOW. The node cannot reach out and ask the control
# host to ssh in — that is the control host's half of enrollment. What it CAN
# say is whether a control host is talking to it right now: if this script is
# running inside an ssh session from a trusted CIDR, that host demonstrably
# reached this box. At a console there is no such evidence, and the honest
# answer is `unknown`, never `ok`.
SSH_FROM_CONTROL=unknown
SSH_FROM_DETAIL="console-session; no inbound connection to observe"
if [ -n "${SSH_CONNECTION:-}" ]; then
	PEER="$(printf '%s' "$SSH_CONNECTION" | awk '{print $1}')"
	SSH_FROM_CONTROL=ok
	SSH_FROM_DETAIL="inbound-ssh-from $PEER"
fi

CAP_LINES=""
CAP_STATUS=missing
if [ -r "$PROBE" ]; then
	# Run it AS THE FLEET USER: the probe looks under $HOME for a runner binary,
	# and creates a venv, and root's answers to both are not the ones that matter.
	CAP_LINES="$(runuser -u "$FLEET_USER" -- bash "$PROBE" 2>/dev/null | grep '^CAP ' || true)"
	[ -n "$CAP_LINES" ] && CAP_STATUS=ran
else
	warn "capability probe not found at $PROBE — the toolchain floor is UNPROVEN on this node"
fi

# The declared floor, PROVEN by execution. A capability the probe could not run
# is `unknown`, not `no`: "nobody looked" and "it cannot" are different answers,
# and folding the first into the second turns an unmeasured box into a decision.
FLOOR_UNMET=""
while read -r want; do
	[ -n "$want" ] || continue
	if [ "$CAP_STATUS" != ran ]; then
		CAP_LINES="${CAP_LINES}
CAP $want unknown probe-did-not-run"
		FLOOR_UNMET="$FLOOR_UNMET $want"
		continue
	fi
	state="$(printf '%s\n' "$CAP_LINES" | awk -v c="$want" '$2==c{print $3; exit}')"
	case "$state" in
	ok) : ;;
	'')
		CAP_LINES="${CAP_LINES}
CAP $want unknown probe-emitted-no-line"
		FLOOR_UNMET="$FLOOR_UNMET $want"
		;;
	*) FLOOR_UNMET="$FLOOR_UNMET $want" ;;
	esac
done < <(parr .capabilities)

# ROOT-OWNED ENTRIES IN THE FLEET USER'S HOME.
#
# This script runs as root, so anything it invokes that writes to $HOME writes
# there as root -- and under `sudo -E`, $HOME IS THE FLEET USER'S. claw-7 came
# out of exactly that with ~/.cache and ~/.local owned by root:root, which is
# invisible until the fleet user needs to write there: seeding the playwright
# browsers failed with "Permission denied" AFTER transferring 5.5GB, and
# playwright is a required capability, so the node was blocked from earning
# hadoku-builder by a directory owner.
#
# Reported, and REPAIRED, because unlike a driver or a card this one is
# unambiguous: nothing in the fleet user's home should be owned by anyone else,
# and chown is reversible in a way that removing hardware is not.
HOME_FOREIGN=""
while IFS= read -r _p; do
	[ -n "$_p" ] || continue
	HOME_FOREIGN="$HOME_FOREIGN $(basename "$_p")"
	run chown -R "$FLEET_USER:$FLEET_USER" "$_p"
done < <(find "$FLEET_HOME" -maxdepth 1 -mindepth 1 ! -user "$FLEET_USER" 2>/dev/null)
if [ -n "$HOME_FOREIGN" ]; then
	warn "these entries in $FLEET_HOME were not owned by $FLEET_USER:$HOME_FOREIGN"
	warn "  Almost always \`sudo -E\`, which preserves HOME so root writes into the fleet user's home."
	log "  ownership repaired"
fi

READY=ok
READY_DETAIL="converged"
unready() {
	READY=no
	READY_DETAIL="$1"
}
[ "$KEYS_INSTALLED" = true ] || unready "no ssh key installed"
[ "$SUDO_OK" = ok ] || unready "passwordless sudo does not work for $FLEET_USER"
[ -z "$FLOOR_UNMET" ] || unready "toolchain floor unmet:${FLOOR_UNMET}"
[ "$SSH_KEY_AUTH" != no ] || unready "key auth failed the loopback test; sshd fell back to password auth"
# A DECLARED FALLBACK THAT DID NOT CONVERGE IS NOT READY. The whole value of the
# thing is that somebody acts on it — the cable comes out because the box is
# believed to survive it. Reporting `converged` on a node whose radio never came
# up hands the operator that belief without the fallback behind it. `none ...`
# (no policy, or no wireless hardware) is NOT this case and passes: those are
# statements about the box, and a wired-only node is a perfectly good node.
case "${WIFI_STATE:-}" in
no\ *) unready "the declared wireless fallback did not converge (${WIFI_STATE#no }); this node will NOT come back if its cable is pulled" ;;
esac

# `unknown <reason>` for anything that could not be measured — present, and
# honest about being unknown. NEVER omitted, and never defaulted to zero: null
# means nobody looked, 0 means somebody looked and found none.
u() {
	if [ -n "${1:-}" ]; then
		printf '%s' "$1"
	else
		printf 'unknown %s' "$2"
	fi
}

printf '\n'
echo "ENROLL-BEGIN v1"
echo "ENROLL recordedAt $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "ENROLL hostname $HOSTNAME_NEW"
echo "ENROLL profile $PROFILE_ID"
echo "ENROLL role $ROLE"
echo "ENROLL chassis $CHASSIS"
echo "ENROLL cores $(u "$CORES" 'nproc returned nothing')"
echo "ENROLL memTotalKb $(u "$MEM_TOTAL_KB" '/proc/meminfo unreadable')"
echo "ENROLL memAvailableKb $(u "$MEM_AVAIL_KB" '/proc/meminfo unreadable')"
echo "ENROLL diskModel $(u "$DISK_MODEL" "no MODEL for /dev/${ROOT_DISK:-?}")"
echo "ENROLL rootDisk $(u "$ROOT_DISK" 'could not resolve the root disk')"
echo "ENROLL diskFreeGb $(u "$DISK_FREE_GB" 'df returned nothing')"
echo "ENROLL osId $(u "$DISTRO_ID" '/etc/os-release unreadable')"
echo "ENROLL osCodename $(u "$DISTRO_CODENAME" '/etc/os-release unreadable')"
echo "ENROLL kernel $(u "$KERNEL_REL" 'uname failed')"
echo "ENROLL dmiVendor $(u "$DMI_VENDOR" '/sys/class/dmi/id/sys_vendor unreadable')"
# THE GPU, AS THREE SEPARATE FACTS. `gpuPci` is what is on the bus and is true
# whether or not anything can drive it; `gpuDriver` is the tristate that keeps a
# card from being written off — `pending-reboot` is neither `ok` nor `no`, and
# collapsing it into `no` would report an unrebooted box's silence as a hardware
# verdict. `gpuModel` comes from nvidia-smi, which only answers once the module
# is loaded, so on a pending-reboot box it is honestly unknown.
echo "ENROLL gpuPci $(u "${GPU_VENDOR:-}${GPU_VENDOR:+:}${GPU_DEV:-}" 'no display controller on the PCI bus')"
echo "ENROLL gpuDriver ${GPU_DRIVER_STATE:-unknown section-5d-did-not-run}"
# STATUS FIRST, THEN TRIM — never `nvidia-smi ... | head -1`.
#
# nvidia-smi writes its failure to STDOUT, not stderr, so `2>/dev/null` does not
# suppress it; and a command substitution takes the exit status of the LAST
# command in a pipeline, where `head` succeeds on anything. Measured on claw-7,
# 2026-09-08: the record came back carrying
#
#   ENROLL gpuModel NVIDIA-SMI has failed because it couldn't communicate ...
#
# as the FIELD VALUE — multi-line prose in a record that
# scripts/lib/enrollment-record.mjs parses line by line, from a box whose only
# fault was not having rebooted yet.
#
# capability-probe.sh already carries this exact lesson for `gh`, in a comment
# written after the same mistake produced `CAP gh ok` on a box with no gh. Same
# shape, different file: ask for the status, and only then trim.
_GPU_NAME=""
_GPU_VRAM=""
if _o="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null)" && [ -n "$_o" ]; then
	_GPU_NAME="$(printf '%s\n' "$_o" | head -1)"
fi
if _o="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null)" && [ -n "$_o" ]; then
	_GPU_VRAM="$(printf '%s\n' "$_o" | head -1 | tr -dc '0-9')"
fi
echo "ENROLL gpuModel $(u "$_GPU_NAME" 'nvidia-smi did not answer (no driver loaded, or not an NVIDIA card)')"
echo "ENROLL gpuVramMb $(u "$_GPU_VRAM" 'nvidia-smi did not answer')"
# THE WIRELESS MAC IS THE ONE FIELD AN OPERATOR HAS TO ACT ON. hokon reaches
# every claw by a hardcoded LAN IP in ~/.ssh/config, and a node that draws a new
# DHCP lease when its cable is pulled goes dark to every gate — which this
# codebase reports as a FAILURE, correctly. The reservation is made against this
# address, so the record has to carry it rather than leave it to be dug out of
# the box later.
echo "ENROLL wirelessIf $(u "${WLAN_IF:-}" 'no wireless hardware on this box')"
echo "ENROLL wirelessMac $(u "${WIFI_MAC:-}" 'no wireless hardware on this box')"
echo "ENROLL wirelessDriver $(u "${WIFI_DRIVER:-}" 'no wireless hardware, or no driver bound to it')"
echo "ENROLL wirelessFallback ${WIFI_STATE:-unknown section-11b-did-not-run}"
echo "ENROLL fleetUser $FLEET_USER"
echo "ENROLL sshPort $SSH_PORT"
echo "ENROLL authMode $AUTH_MODE"
echo "ENROLL sudoNoPasswd $SUDO_OK $SUDO_DETAIL"
echo "ENROLL sshKeyAuthLoopback $SSH_KEY_AUTH $SSH_KEY_AUTH_DETAIL"
echo "ENROLL sshFromControl $SSH_FROM_CONTROL $SSH_FROM_DETAIL"
echo "ENROLL ready $READY $READY_DETAIL"
printf '%s\n' "$CAP_LINES" | sed '/^$/d'
echo "ENROLL-END $HOSTNAME_NEW"
printf '\n'

cat <<EOF
The block above is the ENROLLMENT RECORD. Keep it — it is the only measurement
of this node that anything has, and \`fleet enroll\` reads exactly that shape
(scripts/lib/enrollment-record.mjs). Capture it with:

    ... 2>&1 | tee $KIT_ROOT/enrollment-$HOSTNAME_NEW.txt

Still to do, by hand, and deliberately not automated here:
  1. reboot (a vendor kernel and the GRUB change need one; this script does not
     reboot, because a script that reboots is one whose output you read or not)
  2. $TS_UP
  3. hand the record to \`fleet enroll\`, which writes a PROPOSED manifest entry
     and exits non-zero until a human commits it. Measurement is automated;
     DECLARATION STAYS A HUMAN ACT.
EOF

[ "$READY" = ok ] || {
	err "this node is NOT ready: $READY_DETAIL"
	# Non-zero, with a complete record already on stdout. Parseable stdout wins
	# over the exit code — the record is what the caller needs, and the exit code
	# is what tells it the node did not converge.
	exit 1
}
log "node $HOSTNAME_NEW converged against profile $PROFILE_ID"
