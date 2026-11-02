/** Debian package checks shared by every script that asks "is it installed?". */

/**
 * A shell test: is Debian package `pkg` installed for THIS node's own
 * architecture (or `all`)? `pkg` is spliced in as a shell word, so pass a
 * quoted variable (`'"$p"'`) or a literal name.
 *
 * NOT `dpkg -s`. With a foreign architecture enabled, a Multi-Arch: same
 * library installed for both is two instances, and `dpkg -s libgbm1` refuses
 * ("ambiguous package name ... with more than one installed instance", exit 2)
 * instead of answering. hokon carries i386 for Steam and wine, so 13 of the
 * floor's libraries read as MISSING there on 2026-11-02, every converge
 * reinstalled packages that were already installed, and the node stayed
 * "STILL DRIFTED" after a successful install. Checking the native arch, not
 * "any instance", keeps an i386-only copy (`steam-libs-i386`) from passing for
 * amd64.
 */
export function debInstalled(pkg) {
	return (
		"dpkg-query -W -f='${db:Status-Abbrev}${Architecture}\\n' " +
		pkg +
		' 2>/dev/null | grep -Eq "^ii ($(dpkg --print-architecture)|all)\\$"'
	);
}
