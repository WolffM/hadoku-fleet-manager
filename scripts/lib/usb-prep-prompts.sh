# usb-prep-prompts.sh — the interactive walkthrough's menu plumbing for
# scripts/node-usb-prep.sh: interactive, ask, choose, oper_home, fleet_key,
# list_candidates. Sourced by it; not standalone.

# ── interactive walkthrough ─────────────────────────────────────────────────
# Only on a terminal. Prompting into a pipe either hangs a cron job forever or
# reads whatever the pipe happened to contain as an answer to "which disk shall I
# erase", and the second is far worse than the first.
interactive() { [ -t 0 ] && [ -t 1 ]; }

ask() {
	local prompt="$1" reply
	printf '%s' "$prompt" >&2
	IFS= read -r reply || die "input closed"
	printf '%s' "$reply"
}

# ── one shape for every question ──────────────────────────────────────────────
# This walkthrough used to ask three questions three different ways: type a
# whole device path, type a profile name, type a filesystem path. The operator
# had to already know the valid answer to each, and the formats did not even
# agree with one another. Every question is now the same numbered menu and the
# answer is always a number.
#
# Each item is "LABEL<TAB>VALUE": the label is shown, the value is returned. No
# tab means the two are the same string.
choose() {
	local title="$1"
	shift
	local -a items=("$@")
	local i reply n="$#"
	printf '\n  \033[1m%s\033[0m\n' "$title" >&2
	for i in "${!items[@]}"; do
		printf '    %2d) %s\n' "$((i + 1))" "${items[$i]%%$'\t'*}" >&2
	done
	while :; do
		printf '\n  number [1-%d]: ' "$n" >&2
		IFS= read -r reply || die "input closed"
		case "$reply" in
		'' | *[!0-9]*)
			printf '  not a number. Type one of 1-%d.\n' "$n" >&2
			continue
			;;
		esac
		if [ "$reply" -ge 1 ] && [ "$reply" -le "$n" ]; then
			printf '%s' "${items[$((reply - 1))]##*$'\t'}"
			return 0
		fi
		printf '  out of range. Type one of 1-%d.\n' "$n" >&2
	done
}

# WHOSE home, not root's. This script runs under sudo, so `$HOME` is /root and
# the operator's keys are not in it. `SUDO_USER` is the only thing that knows
# who actually invoked it.
oper_home() {
	if [ -n "${SUDO_USER:-}" ]; then
		getent passwd "$SUDO_USER" | cut -d: -f6
	else
		printf '%s' "$HOME"
	fi
}

# THE KEY THE FLEET ALREADY USES, read rather than guessed.
#
# A menu of every .pub in ~/.ssh is honest and useless: the operator's GitHub
# key and a landing-pull key look exactly as plausible as the fleet's, and
# picking one of those authorises a key no node holds and then hardens sshd
# around it — locking the fleet out of the box it just imaged.
#
# Whatever `IdentityFile` the claw Host blocks name IS that key, by definition:
# it is what every existing node already authorises. Empty output is fine and
# means "no opinion" — the menu just loses its marker.
fleet_key() {
	awk '
		/^[Hh]ost[ \t]/ { claw = ($0 ~ /claw/) }
		claw && $1 ~ /^[Ii]dentity[Ff]ile$/ { print $2; exit }
	' "$(oper_home)/.ssh/config" 2>/dev/null
}

# Candidates as menu items, one per line, "LABEL<TAB>/dev/NAME".
# Zero candidates is a FINDING, not an empty menu: a stick that is plugged in
# but not flagged removable is refused by the guard below anyway, so the caller
# stops rather than offering a menu with nothing in it.
list_candidates() {
	local name size model rm_flag
	while read -r name size model; do
		rm_flag="$(cat "/sys/block/$name/removable" 2>/dev/null || echo '?')"
		[ "$rm_flag" = 1 ] || continue
		printf '%-12s %-9s %s\t/dev/%s\n' "/dev/$name" "$size" "${model:-unknown}" "$name"
	done < <(lsblk -dno NAME,SIZE,MODEL 2>/dev/null)
}
