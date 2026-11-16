/**
 * The toolchain floor's system-Node entries. toolchain-floor.mjs's REPAIRS
 * table spreads them in; they live here because that file is at its size
 * ceiling. toolchain-floor.mjs documents every field.
 *
 * NODE 24 ON EVERY NODE (fleet-manager#95, operator 2026-11-15). It was a
 * services-host tool only, so the rest of the fleet stayed on 22 and a CI
 * job calling bare `node` without setup-node got a different major by claw.
 * `NODE_MAJOR` is the one declaration; node-profiles.json's `toolchain.node`
 * is held to it by toolchain-node.test.mjs, so a new node bootstraps onto
 * it. A major move is applied in a drain, never beside a live job.
 */

/**
 * THE Node major every node runs (fleet-manager#95). node-profiles.json's
 * `toolchain.node` must equal it; toolchain-node.test.mjs holds the two.
 */
export const NODE_MAJOR = 24;
/** The names the nodejs package ships in /usr/bin. */
export const NODE_APT_BINS = ['node', 'npm', 'npx', 'corepack'];
/**
 * Prints `SHADOWED <path>` for the first of {@link NODE_APT_BINS} that PATH
 * resolves somewhere other than /usr/bin, else OK. A name not on PATH at all
 * is `node24`'s to report, not this one's.
 */
const NODE_APT_PATH_DETECT =
	`for b in ${NODE_APT_BINS.join(' ')}; do p="$(command -v "$b")" || continue; ` +
	'[ "$p" = "/usr/bin/$b" ] || { echo "SHADOWED $p"; exit 0; }; done; echo OK';

/**
 * `node24` and `node-apt-path`, keyed as REPAIRS keys them. Neither declares a
 * `when`: every node, and bootcamp (which installs only scoped tools) leaves
 * them to node-bootstrap, converge-toolchain and the refresh cycle.
 */
export const NODE_REPAIRS = {
	node24: {
		apt: 'nodejs',
		why:
			`every node runs one Node major (${NODE_MAJOR}): a CI job calling bare \`node\`, pm2 and a ` +
			'tenant’s pm2 unit all run the system node. nodesource’s line, apt-tracked so its ' +
			'security releases land.',
		detect: `node --version 2>/dev/null | grep -q "^v${NODE_MAJOR}\\." && echo OK`,
		// The source line moves to this major, then apt installs it. A node with no
		// nodesource source gets it from nodesource's own setup script, the one
		// node-bootstrap runs (hokon had none until 2026-11-15).
		repair: [
			'set -e',
			'src=/etc/apt/sources.list.d/nodesource.sources',
			'if [ ! -f "$src" ]; then',
			`  curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | sudo -n bash - >/dev/null`,
			'fi',
			`grep -q 'node_${NODE_MAJOR}.x' "$src" || sudo -n sed -i 's#/node_[0-9]*\\.x#/node_${NODE_MAJOR}.x#' "$src"`,
			'sudo -n apt-get update -qq',
			'sudo -n apt-get install -y nodejs',
		].join('\n'),
	},
	/*
	 * NOTHING AHEAD OF APT'S NODE (fleet-manager#95). hokon ran a hand-copied
	 * /usr/local/bin/node for nine months: the package could not have updated
	 * it, and nothing reported it. The nodejs package ships these four names in
	 * /usr/bin, so a copy of any of them earlier on PATH is one no security
	 * release reaches. Not a repair: the file is someone's, and the fleet does
	 * not delete from /usr/local/bin. ADVISORY since 2026-11-15; promote it only
	 * with the count of real catches and false positives over at least 7 days.
	 */
	'node-apt-path': {
		advisory: true,
		shadowOver: '/usr/bin',
		why:
			'`node`, `npm`, `npx` and `corepack` must be the nodejs package’s own in /usr/bin; a ' +
			'copy earlier on PATH is outside apt and gets no updates.',
		detect: NODE_APT_PATH_DETECT,
		repair: 'echo "a shadowing copy is removed by hand, never by a repair" >&2\nexit 1',
	},
};
