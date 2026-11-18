/**
 * The toolchain floor's `pm2-boot` entry: the admin user's pm2 under its own
 * systemd unit, enabled, active and BOUNDED. toolchain-floor.mjs's REPAIRS
 * table spreads it in with its `when` (a `services: "pm2"` node); it lives
 * here because the table's file is at its size ceiling.
 *
 * `$(id -un)` is how this entry names its user: it runs as the admin role
 * (`role: 'admin'`), and pm2 is admin's.
 */

/**
 * The admin pm2's memory ceiling, in MB, where the manifest declares no
 * `pm2MemoryMaxMb` for the node. Sized for an IDLE daemon (~40 MB measured on
 * claw-4 and claw-6, 2026-11-02): a pm2 that supervises apps holds them in the
 * same cgroup, and the `pm2-boot` repair refuses this default for one.
 */
export const PM2_MEMORY_MAX_MB_DEFAULT = 512;

/** The drop-in that orders the unit after a usable network and resolver. */
export const NETWORK_ONLINE_DROP_IN = '20-network-online.conf';

/** True when systemd has loaded `$s` as wanting AND ordered after network-online.target. */
const NETWORK_ORDERED =
	'systemctl show "$s" -p After --value 2>/dev/null | tr " " "\\n" | grep -qx network-online.target && ' +
	'systemctl show "$s" -p Wants --value 2>/dev/null | tr " " "\\n" | grep -qx network-online.target';

/** The entry minus its `when`; toolchain-floor.mjs documents every field. */
export const PM2_BOOT = {
	why:
		'services must come back after a reboot without a human: pm2 runs under ' +
		'pm2-<user>.service (pm2 resurrect), as claw-4 does. A daemon started by hand dies ' +
		'with the box and takes every service with it. The unit carries a memory ceiling, so ' +
		'what it may hold is budgeted rather than guessed (hosting-offers charges it).',
	// Enabled AND active: an enabled unit that failed to start is a box whose
	// services did not come back, which is the thing this entry exists for.
	// AND BOUNDED, read from the KERNEL: the unit's own cgroup `memory.max`,
	// never `systemctl show -p MemoryMax`, which reports what the drop-in
	// asked for whether or not it took (the reader may not read the writer).
	// claw-4 and claw-6 ran an idle admin pm2 at `max` until 2026-11-02, which
	// hosting-claims reported as `app-layer-idle` every night.
	// AND ORDERED AFTER THE NETWORK: `pm2 startup` writes only
	// `After=network.target`, so on a boot pm2 resurrects its apps before DNS
	// answers. A tunnel's first SRV lookup failed and paged that way on
	// 2026-11-18 (fleet-manager#115); every pm2 claw carried the same unit.
	// Read from systemd's LOADED dependencies (`show -p After/Wants`), not the
	// drop-in file: a drop-in nobody reloaded orders nothing.
	role: 'admin',
	detect:
		'u="$(id -un)"; s="pm2-$u.service"; systemctl is-enabled "$s" >/dev/null 2>&1 && ' +
		'systemctl is-active "$s" >/dev/null 2>&1 && ' +
		'cg="$(systemctl show "$s" -p ControlGroup --value 2>/dev/null)" && [ -n "$cg" ] && ' +
		'grep -qx "[0-9][0-9]*" "${CGROUP_ROOT:-/sys/fs/cgroup}$cg/memory.max" 2>/dev/null && ' +
		`${NETWORK_ORDERED} && echo OK`,
	repair: [
		'set -e',
		'u="$(id -un)"',
		's="pm2-$u.service"',
		'if ! systemctl is-enabled --quiet "$s" || ! systemctl is-active --quiet "$s"; then',
		'  sudo -n env PATH="$PATH" "$(command -v pm2)" startup systemd -u "$u" --hp "$HOME" >/dev/null',
		// ONE DAEMON, AND THE UNIT OWNS IT. Any `pm2` command spawns a daemon
		// if none answers, so by now one may be running OUTSIDE the unit; the
		// unit's `pm2 resurrect` then attaches to it instead of forking, never
		// writes pm2.pid, and systemd fails it (`Failed with result 'protocol'`)
		// — claw-6, 2026-10-25, and the reason claw-4's daemon was moved by
		// hand on 2026-10-12. Moved here only while it supervises NOTHING:
		// killing a daemon with services under it restarts them, which is an
		// operator's call on a production host.
		//
		// AND ASKING SPAWNS ONE. `pm2 jlist` starts a daemon when none runs, so
		// counting apps after the kill below started a fresh one OUTSIDE the
		// unit again, and the unit failed exactly as described (claw-10,
		// 2026-11-03, the first node to take this repair fresh). `apps` asks
		// only a daemon that is already running.
		'  apps() { pgrep -u "$u" -f "God Daemon \\($HOME/\\.pm2\\)" >/dev/null || { echo 0; return; }; pm2 jlist 2>/dev/null | tr -cd "{" | wc -c; }',
		'  if ! systemctl is-active --quiet "$s"; then',
		'    n="$(apps)"',
		'    if [ "$n" -gt 0 ]; then',
		'      echo "a pm2 daemon outside $s supervises processes; moving it under the unit restarts them" >&2',
		'      exit 1',
		'    fi',
		'    pm2 kill >/dev/null 2>&1 || true',
		'    sudo -n systemctl reset-failed "$s" 2>/dev/null || true',
		'  fi',
		// Saving an EMPTY list over a populated dump would make the next boot
		// resurrect nothing, so only save when pm2 is supervising something.
		'  [ "$(apps)" -gt 0 ] && pm2 save >/dev/null || true',
		'  sudo -n systemctl enable --now "$s"',
		'fi',
		'd="${SYS_DIR:-/etc/systemd/system}/$s.d"',
		// THE NETWORK ORDER, for the NEXT boot: a daemon-reload, never a restart
		// of a pm2 that supervises services now.
		`if ! { ${NETWORK_ORDERED}; }; then`,
		'  sudo -n mkdir -p "$d"',
		`  printf "[Unit]\\nWants=network-online.target\\nAfter=network-online.target nss-lookup.target\\n" | sudo -n tee "$d/${NETWORK_ONLINE_DROP_IN}" >/dev/null`,
		'  sudo -n systemctl daemon-reload',
		'fi',
		// THE CEILING, applied LIVE: a drop-in for every later boot, and
		// `set-property --runtime` for the cgroup now. Neither restarts the
		// daemon. Only where the kernel reads none, so a hand-set ceiling stands.
		// Its apps run INSIDE this cgroup, so a ceiling below what they hold
		// would OOM-kill them: refused when the unit holds 80% of it or more,
		// and the 512 MB default is refused outright for a pm2 that supervises
		// anything. The manifest's `pm2MemoryMaxMb` is the operator's answer.
		'cg="$(systemctl show "$s" -p ControlGroup --value)"',
		'cgdir="${CGROUP_ROOT:-/sys/fs/cgroup}$cg"',
		'if [ -n "$cg" ] && ! grep -qx "[0-9][0-9]*" "$cgdir/memory.max" 2>/dev/null; then',
		`  mb="\${PM2_MEMORY_MAX_MB:-${PM2_MEMORY_MAX_MB_DEFAULT}}"`,
		'  n="$(pm2 jlist 2>/dev/null | tr -cd "{" | wc -c)"',
		'  if [ -z "${PM2_MEMORY_MAX_MB:-}" ] && [ "$n" -gt 0 ]; then',
		'    echo "$s supervises $n app(s) with no ceiling; the default ${mb}M would bound them too. Declare pm2MemoryMaxMb for this node in the fleet manifest" >&2',
		'    exit 1',
		'  fi',
		'  held="$(cat "$cgdir/memory.current" 2>/dev/null || echo 0)"',
		'  if [ "$held" -ge $((mb * 1048576 * 8 / 10)) ]; then',
		'    echo "$s holds $((held / 1048576))M, at or above 80% of a ${mb}M ceiling; raise pm2MemoryMaxMb rather than OOM-kill what it runs" >&2',
		'    exit 1',
		'  fi',
		'  sudo -n mkdir -p "$d"',
		'  printf "[Service]\\nMemoryMax=%sM\\n" "$mb" | sudo -n tee "$d/10-ceiling.conf" >/dev/null',
		'  sudo -n systemctl daemon-reload',
		'  sudo -n systemctl set-property --runtime "$s" "MemoryMax=${mb}M"',
		'fi',
	].join('\n'),
};
