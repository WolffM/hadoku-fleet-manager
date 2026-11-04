/**
 * The memory ceiling the KERNEL enforces on a cgroup: the tightest finite
 * `memory.max` from the cgroup itself up through every ancestor. One shell
 * function, shared by every probe that judges whether a pm2 manager is bounded.
 *
 * WHY. A service tenant's pm2 runs as `hosting.slice/hosting-<tenant>.slice/
 * pm2-<tenant>-svc.service`. The fleet bounds the tenant SLICE (its declared
 * memory) and leaves the unit at `max`, so reading the unit's own file called
 * every tenant pm2 unbounded. `not-beside-unbounded` then refused every node
 * hosting a service: on 2026-11-04 the standbys placed on claw-8 (watchparty,
 * slice 1536 MiB) and claw-9 (archivebot) pushed cardtable off both, its two
 * best hosts, onto claw-5 and claw-10. The kernel reads the whole path; so
 * does this.
 *
 * UNREADABLE IS NOT BOUNDED. Any level that cannot be read, or reads as
 * something other than a number or `max`, makes the whole answer the caller's
 * unreadable token, never a number: the rule "only a number is bounded" is
 * kept, and a ceiling the probe could not see is not claimed.
 */

/**
 * Defines `effmax <cgroup-path> <unreadable-token>` in the probe's shell. It
 * prints the tightest finite ceiling in bytes, `max` when no level has one, or
 * the token. `CGROUP_ROOT` (default /sys/fs/cgroup) is how the fake-node
 * harness points it at a fixture tree.
 */
export const EFFECTIVE_MEMORY_MAX_SH =
	'effmax() { [ -n "$1" ] || { echo "$2"; return; }; m=""; p="$1"; ' +
	'while [ -n "$p" ] && [ "$p" != "/" ]; do ' +
	'v=$(cat "${CGROUP_ROOT:-/sys/fs/cgroup}$p/memory.max" 2>/dev/null) || { echo "$2"; return; }; ' +
	'case "$v" in max) ;; ""|*[!0-9]*) echo "$2"; return ;; ' +
	'*) if [ -z "$m" ] || [ "$v" -lt "$m" ]; then m=$v; fi ;; esac; ' +
	'p=$(dirname "$p"); done; echo "${m:-max}"; }';
