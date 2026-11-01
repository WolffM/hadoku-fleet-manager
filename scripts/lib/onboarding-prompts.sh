# onboarding-prompts.sh — generic prompt helpers for scripts/onboarding.sh:
# fmt_mb (byte formatting), asksecret (no-echo read), pick (lettered menu).
# Sourced by it; not standalone.

# Bytes -> "755MB". Integer arithmetic only: this runs on a fresh Debian
# netinstall where bc and python are not guaranteed to exist.
fmt_mb() { [ "${1:-0}" -gt 0 ] 2>/dev/null && printf '%sMB' "$(( $1 / 1000000 ))" || printf '~755MB'; }

# asksecret <prompt> - read without echoing. `ask` echoes, which is wrong for a
# wifi PSK typed at a desk with someone else in the room, and wrong for anything
# that ends up in a scrollback the operator later pastes into a chat window.
asksecret() {
	local prompt="$1" reply
	[ -t 0 ] || die "onboarding is interactive and stdin is not a terminal."
	read -r -s -p "   $prompt: " reply </dev/tty || die "cancelled"
	printf '\n' >&2
	printf '%s' "$reply"
}

# pick <keys> - read one of them, or enter for the first.
#
# It owns the WHOLE prompt, which `ask` does not: `ask` appends its own
# "[default]", so a menu built on it rendered "Which profile? [ab] [a]:" — the
# option list and the default, both in brackets, meaning two different things.
# One function, one bracket convention, nothing to reconcile.
pick() {
	local keys="$1" prompt="$2" def="${3:-}" reply i k out=""
	[ -n "$def" ] || def="$(printf '%s' "$keys" | cut -c1)"
	i=1
	while [ "$i" -le "${#keys}" ]; do
		k="$(printf '%s' "$keys" | cut -c"$i")"
		# THE DEFAULT IS UPPERCASE, not a second bracketed value.
		#
		# `ask` appends its own "[default]", so a yes/no built on it rendered
		# "Preload wifi credentials? [no]:" — which the operator read as "no is
		# the only option", and reasonably so. The option list and the default
		# cannot both be brackets. Uppercase is how every other CLI says it.
		# All lowercase. Case-marking the default was a third attempt at encoding
		# two things in one bracket list, after "[ab] [a]" and "(a or b) [a]".
		# It produced "[A] [b]", which reads as a typo rather than as meaning.
		# The options are the options; enter takes the first.
		out="$out[$k] "
		i=$((i + 1))
	done
	[ -t 0 ] || die "onboarding is interactive and stdin is not a terminal. Run it from a shell."
	while :; do
		read -r -p "   $prompt ${out%% }: " reply </dev/tty || die "cancelled"
		reply="$(printf '%s' "$reply" | tr 'A-Z' 'a-z')"
		# People type the whole word. Rejecting "yes" at a prompt that shows
		# [Y] [n] is technically consistent and practically obnoxious.
		case "$reply" in
		yes) reply=y ;;
		no) reply=n ;;
		esac
		# Enter takes the first option. Never a destructive one — the erase is
		# confirmed separately by retyping the device path.
		[ -z "$reply" ] && { printf '%s' "$def"; return 0; }
		case "$keys" in *"$reply"*)
			[ "${#reply}" = 1 ] && { printf '%s' "$reply"; return 0; } ;;
		esac
		printf '   %s!%s pick one of: %s\n' "$Y" "$N" "$keys" >&2
	done
}
