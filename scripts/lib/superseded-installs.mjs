/**
 * Superseded tool installs: a JDK or Maven left in a node user's home after
 * the fleet's copy moved under the opt root (`TOOL_OPT`, toolchain-floor.mjs).
 *
 * WHY THIS EXISTS. Until 0.34.172 the jdk21/maven repairs extracted into the
 * home of whoever ran them, and the node-users cutover then moved that home's
 * `.local` to the ci user. After the move to `/opt/fleet-tools`, ~300 MB per
 * install was left behind in admin's AND ci's homes on claw-4 and claw-5, and
 * nothing pointed at it. Nothing else would ever remove it.
 *
 * WHAT IS REMOVED: `$HOME/.local/opt/{jdk-*,apache-maven-*}` in ADMIN's home,
 * and only when ALL of these hold:
 *   - the opt root holds an install of the same tool (never delete the only one);
 *   - no symlink in the link dir resolves into it;
 *   - no runner env file (`.env`, `runner.env`) names it, as a JAVA_HOME would;
 *   - no live process runs an executable from inside it.
 * Anything else prints KEEP or BUSY with the reason and is left alone.
 *
 * NEVER ci's home. A job's own scripts install toolchains there and reuse them
 * (cardtable's Forge spike extracts a JDK and Maven into `~/.local/opt`), and
 * a fleet leftover is indistinguishable from that working cache by name. No CI
 * runs as admin since the node-users cutover, so admin's `.local/opt` holds
 * only what the fleet's own repairs put there before /opt/fleet-tools.
 *
 * Run as ADMIN; sudo reads other users' /proc entries.
 */

import { TOOL_OPT } from './toolchain-floor.mjs';

const TOOLS = [
	{ glob: 'jdk-*[0-9]', opt: 'jdk-*[0-9]' },
	{ glob: 'apache-maven-*[0-9]', opt: 'apache-maven-*[0-9]' },
];

/**
 * The node-side sweep. `apply` false prints WOULD lines and removes nothing.
 * Output, one line per candidate:
 *   REMOVED <dir> <MB> | WOULD <dir> <MB> | KEEP <dir> <why> | BUSY <dir> | FAILED <dir>
 *
 * @param {{ ciUser?: string, apply: boolean }} opts  `ciUser`: whose runner envs
 *        are also read for a reference (a ci job's JAVA_HOME pointing here keeps it)
 */
export function supersededScript({ ciUser, apply }) {
	const sweeps = TOOLS.map(
		(t) => `
	for d in "$h"/.local/opt/${t.glob}; do
		[ -d "$d" ] || continue
		sweep_one "$d" '${t.opt}'
	done`
	).join('');
	return `set -u
opt="\${FLEET_TOOL_OPT:-${TOOL_OPT}}"
links="\${FLEET_LINK_DIR:-/usr/local/bin}"
apply=${apply ? 1 : 0}
ci_user=${JSON.stringify(ciUser ?? '')}
env_homes="$HOME"
if [ -n "$ci_user" ]; then
	ci_home="$(getent passwd "$ci_user" | cut -d: -f6)"
	[ -n "$ci_home" ] && env_homes="$env_homes $ci_home"
fi
sweep_one() {
	d="$1"; pat="$2"
	set -- "$opt"/$pat
	[ -d "$1" ] || { echo "KEEP $d no install of this tool under $opt"; return; }
	for l in "$links"/*; do
		[ -L "$l" ] || continue
		case "$(sudo -n readlink -f "$l")" in "$d"/*) echo "KEEP $d $l points into it"; return ;; esac
	done
	for eh in $env_homes; do
		if sudo -n grep -rqsF --include=.env --include=runner.env -- "$d" "$eh/.hadoku" "$eh/runners" 2>/dev/null; then
			echo "KEEP $d a runner env names it"; return
		fi
	done
	if [ -n "$(sudo -n find /proc/[0-9]* -maxdepth 1 -name exe -lname "$d/*" -print -quit 2>/dev/null)" ]; then
		echo "BUSY $d"; return
	fi
	mb="$(sudo -n du -sm "$d" 2>/dev/null | cut -f1)"
	if [ "$apply" = 1 ]; then
		if sudo -n rm -rf -- "$d"; then echo "REMOVED $d \${mb:-?}"; else echo "FAILED $d"; fi
	else
		echo "WOULD $d \${mb:-?}"
	fi
}
h="$HOME"${sweeps}
echo SWEPT
`;
}

/**
 * Parse the sweep's output. A run without the SWEPT trailer was cut short and
 * reads as unreadable, never as "nothing to remove".
 */
export function parseSuperseded(out) {
	const lines = String(out ?? '').split('\n');
	const complete = lines.some((l) => l.trim() === 'SWEPT');
	const entries = [];
	for (const l of lines) {
		const m = /^(REMOVED|WOULD|KEEP|BUSY|FAILED) (\S+)(?: (.*))?$/.exec(l.trim());
		if (m) entries.push({ status: m[1].toLowerCase(), dir: m[2], detail: m[3] ?? null });
	}
	return { complete, entries };
}
