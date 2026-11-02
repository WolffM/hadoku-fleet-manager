/**
 * SHADOWED: the fleet's install of a tarball tool (jdk21, maven) is sound and
 * linked from /usr/local/bin, but `command -v` finds another copy first. A
 * reinstall rewrites the link and changes nothing, so a detect answers
 * `SHADOWED <path>` instead of nothing, and every reader turns that into
 * "remove or rename <path>", never a repair. On hokon (2026-11-02) the
 * operator's own ~/.local/bin/mvn won, and the advice was a root repair that
 * could not move it.
 */

/** Where the fleet links a tarball tool's binaries. `FLEET_TOOL_BIN` exists for the tests and nothing else. */
export const TOOL_BIN = '/usr/local/bin';

/**
 * Shell: prints `SHADOWED <path>` when `bin` on PATH resolves outside the opt
 * root while the fleet's own link resolves inside it; otherwise fails, so a
 * detect that ends `|| <this>` still reads MISSING when the fix IS a repair.
 */
export const shadowedBy = (bin, optRoot) =>
	`{ p="$(command -v ${bin})" && o="\${FLEET_TOOL_OPT:-${optRoot}}" && ` +
	`case "$(readlink -f "$p")" in "$o"/*) false ;; esac && ` +
	`case "$(readlink -f "\${FLEET_TOOL_BIN:-${TOOL_BIN}}/${bin}")" in "$o"/*) echo "SHADOWED $p" ;; *) false ;; esac; }`;

/** The path a detect's answer names as the shadow, or null. */
export function parseShadow(said) {
	const m = /^SHADOWED (.+)$/.exec(said ?? '');
	return m ? m[1] : null;
}

/** The one sentence for a shadowed tool: which file wins, over which link, for which role. */
export function shadowNote(path, role) {
	const bin = path.split('/').pop();
	return (
		`${path} comes before ${TOOL_BIN}/${bin} on the ${role} role's PATH. ` +
		`The fleet's install is fine, so a repair cannot help: remove or rename ${path}.`
	);
}

/**
 * The doctor's verdict for a shadowed tool, or null: absent and a finding, as
 * before, but carrying the path, so the cadence plans no install over it.
 */
export function shadowVerdict(id, detect, role) {
	const shadowed = parseShadow(detect);
	if (!shadowed) return null;
	return { id, status: 'absent', finding: true, shadowed, reason: shadowNote(shadowed, role) };
}
