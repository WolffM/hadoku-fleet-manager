/**
 * The toolchain floor's `rust` and `rust-wasm32` entries, and the wrapper that
 * installs a per-user tool FOR the ci role. toolchain-floor.mjs's REPAIRS
 * table spreads them in; they live here because that file is at its size
 * ceiling. toolchain-floor.mjs documents every field.
 */

/**
 * Run a heredoc as the ci role's user. A repair runs as admin and is told who
 * ci is through CI_USER (`installScript`); absent, or equal to admin, the node
 * is not cut over and the body runs as admin, exactly as before.
 */
export const AS_CI = [
	'CI="${CI_USER:-$USER}"',
	'as_ci() { if [ "$CI" = "$USER" ]; then bash -s; else sudo -n -u "$CI" -H bash -s; fi; }',
];

/** `rust` and `rust-wasm32`, keyed as REPAIRS keys them. */
export const RUST_REPAIRS = {
	rust: {
		why:
			'brave-quartet builds on the general pool, so rustc is a requirement of every ' +
			'managed node rather than a differentiator between them.',
		// THE STOCK PATH, deliberately. On 2026-09-10 all seven claws were given
		// rustup and a hand-check over ssh passed on all seven — because the check
		// exported ~/.cargo/bin first, the way a login shell does. A workflow
		// `run:` step is non-interactive and sources no profile, so the first fleet
		// run died on `rustup: command not found` against seven boxes that all
		// "had" rustup. Detecting with a widened PATH would reproduce that lie.
		detect: 'command -v rustc >/dev/null 2>&1 && echo OK',
		// Installs if absent, and ALWAYS re-links: the symlinks are the half that
		// was missing, and a node can have rustup without them.
		//
		// INTO THE CI USER'S HOME. Repairs run as admin, but rustup is per-user:
		// claw-10 (2026-11-03) was the first node cut over BEFORE its toolchain
		// existed, and the admin-run repair left rust in admin's home with every
		// /usr/local/bin link pointing there. ci then had a rustup with no
		// toolchain, and `rust-wasm32` could never converge. Every older claw
		// only worked because its cutover MOVED an admin-installed ~/.cargo.
		repair: [
			...AS_CI,
			"as_ci <<'RUSTUP'",
			'cd "$HOME"',
			'if ! [ -x "$HOME/.cargo/bin/rustup" ]; then',
			"  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs |" +
				' sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path',
			'fi',
			'export PATH="$HOME/.cargo/bin:$PATH"',
			'rustup component add rustfmt clippy >/dev/null 2>&1 || true',
			'rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true',
			'RUSTUP',
			'CI_HOME="$(getent passwd "$CI" | cut -d: -f6)"',
			'for b in rustup cargo rustc rustdoc rustfmt cargo-fmt cargo-clippy clippy-driver; do',
			'  sudo -n test -e "$CI_HOME/.cargo/bin/$b" && sudo -n ln -sfn "$CI_HOME/.cargo/bin/$b" "/usr/local/bin/$b"',
			'done',
		].join('\n'),
	},
	'rust-wasm32': {
		why: 'brave-quartet’s wasm-size job builds for wasm32-unknown-unknown.',
		detect:
			'command -v rustup >/dev/null 2>&1 && ' +
			'rustup target list --installed 2>/dev/null | grep -qx wasm32-unknown-unknown && echo OK',
		repair: [
			...AS_CI,
			"as_ci <<'RUSTUP'",
			'cd "$HOME"',
			'export PATH="$HOME/.cargo/bin:$PATH"',
			'rustup target add wasm32-unknown-unknown',
			'RUSTUP',
		].join('\n'),
	},
};
