# onboarding-preflight.sh — the tool-preflight helpers for
# scripts/onboarding.sh: have (PATH + sbin check) and tool_pkg (tool ->
# apt package). Sourced by it; not standalone.

have() {
	command -v "$1" >/dev/null 2>&1 && return 0
	for d in /usr/local/sbin /usr/sbin /sbin; do [ -x "$d/$1" ] && return 0; done
	return 1
}

# tool -> the Debian package that provides it
tool_pkg() {
	case "$1" in
	curl) echo curl ;;
	sha256sum) echo coreutils ;;
	lsblk | blkid | sfdisk) echo util-linux ;;
	mkfs.ext4) echo e2fsprogs ;;
	partprobe) echo parted ;;
	*) echo "" ;;
	esac
}
