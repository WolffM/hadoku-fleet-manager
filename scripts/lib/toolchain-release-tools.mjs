/**
 * RELEASE-BINARY TOOLS: yt-dlp and deno, installed from their own GitHub
 * releases rather than apt or npm, in two places. A services host gets
 * system-wide copies in /usr/local/bin (a tenant's pm2 unit runs with
 * PATH=/usr/local/bin:/usr/bin:/bin). The backstop gets the admin's own copies
 * in ~/.local/bin, because the fleet has no sudo there and the operator's
 * scripts run them (fleet-manager#34). Spread into REPAIRS by
 * lib/toolchain-floor.mjs, which owns how every entry is read.
 */
import { hostsPm2Services, isBackstopNode } from '../../dist/lib/node-role.js';

/** A node declaring `services: "pm2"` (see hostsPm2Services in src/lib/node-role.ts). */
const pm2ServicesHost = (node) => hostsPm2Services(node);
pm2ServicesHost.toString = () => 'services: "pm2"';
/**
 * The backstop's OWN copies of operator tools, in the admin user's
 * `~/.local/bin` (fleet-manager#34). hokon runs no tenant service, but the
 * operator's and agents' scripts call yt-dlp there (watchparty's
 * playlist-add.py, the scraper's adapter), and the fleet has no sudo on it, so
 * the system-wide copies the services hosts get are not an option.
 */
const backstopNode = (node) => isBackstopNode(node);
backstopNode.toString = () => 'the backstop';

/**
 * WHERE A RELEASE BINARY GOES, and with what privilege: `/usr/local/bin` with
 * sudo on a services host, the admin's `~/.local/bin` without it on the
 * backstop. One script per tool for both, so the checksum and the extraction
 * gate cannot drift between them.
 */
const SYSTEM_BIN = { dir: '/usr/local/bin', run: 'sudo -n ', ytdlp: 'yt-dlp' };
const USER_BIN = { dir: '"$HOME/.local/bin"', run: '', ytdlp: '"$HOME/.local/bin/yt-dlp"' };

/** yt-dlp's install: the release's SHA2-256SUMS, one real extraction, then a rename. */
const ytdlpRepair = (bin) =>
	[
		'set -e',
		'v="${TARGET_VERSION:?a pinned version}"',
		'tmp="$(mktemp -d)"',
		'trap \'rm -rf "$tmp"\' EXIT',
		'base="https://github.com/yt-dlp/yt-dlp/releases/download/$v"',
		'curl -fsSL --max-time 300 -o "$tmp/yt-dlp" "$base/yt-dlp"',
		'curl -fsSL --max-time 60 -o "$tmp/SUMS" "$base/SHA2-256SUMS"',
		'want="$(awk \'$2 == "yt-dlp" { print $1 }\' "$tmp/SUMS")"',
		'[ -n "$want" ] && [ "$(sha256sum "$tmp/yt-dlp" | cut -d" " -f1)" = "$want" ] ||',
		'  { echo "yt-dlp $v: the download does not match its SHA2-256SUMS" >&2; exit 1; }',
		'chmod 0755 "$tmp/yt-dlp"',
		'got="$(cd "$tmp" && timeout 120 "$tmp/yt-dlp" --ignore-config --no-cache-dir --simulate --print id "ytsearch1:test" 2>"$tmp/err" || true)"',
		'[ -n "$got" ] || { echo "yt-dlp $v failed one real YouTube extraction, so the installed copy was kept (a stale deno is the usual cause): $(tail -n 3 "$tmp/err")" >&2; exit 1; }',
		`${bin.run}install -D -m 0755 "$tmp/yt-dlp" ${bin.dir}/.yt-dlp.new`,
		`${bin.run}mv -f ${bin.dir}/.yt-dlp.new ${bin.dir}/yt-dlp`,
	].join('\n');

/** deno's install: the release's sha256sum, an extraction by yt-dlp with the new deno first on PATH, a rename. */
const denoRepair = (bin) =>
	[
		'set -e',
		'v="${TARGET_VERSION:?a pinned version}"',
		'tmp="$(mktemp -d)"',
		'trap \'rm -rf "$tmp"\' EXIT',
		'f=deno-x86_64-unknown-linux-gnu.zip',
		'base="https://github.com/denoland/deno/releases/download/v$v"',
		'curl -fsSL --max-time 300 -o "$tmp/$f" "$base/$f"',
		'curl -fsSL --max-time 60 -o "$tmp/sum" "$base/$f.sha256sum"',
		'want="$(awk \'{ print $1; exit }\' "$tmp/sum")"',
		'[ -n "$want" ] && [ "$(sha256sum "$tmp/$f" | cut -d" " -f1)" = "$want" ] ||',
		'  { echo "deno $v: the download does not match its sha256sum" >&2; exit 1; }',
		'mkdir "$tmp/x"',
		'python3 -m zipfile -e "$tmp/$f" "$tmp/x"',
		'chmod 0755 "$tmp/x/deno"',
		'"$tmp/x/deno" --version >/dev/null',
		`if command -v ${bin.ytdlp} >/dev/null 2>&1; then`,
		`  got="$(cd "$tmp" && PATH="$tmp/x:$PATH" timeout 120 ${bin.ytdlp} --ignore-config --no-cache-dir --simulate --print id "ytsearch1:test" 2>"$tmp/err" || true)"`,
		'  [ -n "$got" ] || { echo "yt-dlp failed one real YouTube extraction with deno $v, so the installed deno was kept: $(tail -n 3 "$tmp/err")" >&2; exit 1; }',
		'fi',
		`${bin.run}install -D -m 0755 "$tmp/x/deno" ${bin.dir}/.deno.new`,
		`${bin.run}mv -f ${bin.dir}/.deno.new ${bin.dir}/deno`,
	].join('\n');

export const RELEASE_TOOLS = {
	'yt-dlp': {
		when: pm2ServicesHost,
		why:
			'a hosted service downloads with yt-dlp (watchparty submissions and search). The ' +
			'upstream release binary, into /usr/local/bin.',
		detect: 'yt-dlp --version >/dev/null 2>&1 && echo OK',
		version: 'yt-dlp --version 2>/dev/null',
		latest: { source: { kind: 'github-release', repo: 'yt-dlp/yt-dlp' } },
		// ONE DAY, not seven. YouTube breaks the release before last within weeks,
		// and a fix is useless held back a week: watchparty's search and
		// submissions fail behind a green /healthz meanwhile (watchparty,
		// 2026-10-28). The checksum and the extraction below are what the day buys.
		minAge: 1440,
		// CHECKED BEFORE IT REPLACES ANYTHING: the release's own SHA2-256SUMS, then
		// ONE REAL EXTRACTION by the new binary. A release that cannot extract
		// leaves the working copy in place and fails with the reason, so the
		// refresh reports it rather than installing a broken one. The swap is a
		// rename, so a service spawning yt-dlp mid-update runs one copy or the other.
		repair: ytdlpRepair(SYSTEM_BIN),
	},
	deno: {
		when: pm2ServicesHost,
		why:
			'yt-dlp runs YouTube’s player JavaScript through deno; without it, extraction fails. ' +
			'The upstream release binary, into /usr/local/bin.',
		detect: 'deno --version >/dev/null 2>&1 && echo OK',
		version: 'deno --version 2>/dev/null | head -n 1',
		latest: { source: { kind: 'github-release', repo: 'denoland/deno', tagPrefix: 'v' } },
		// Checked as yt-dlp is: the release's checksum, then, where yt-dlp is
		// installed, one extraction with the NEW deno first on PATH — deno exists
		// on these hosts for that, so that is what it must still do.
		repair: denoRepair(SYSTEM_BIN),
	},
	// THE BACKSTOP'S OWN COPIES (fleet-manager#34): the same feeds, checksum and
	// extraction gate as the services hosts', into the admin's ~/.local/bin with
	// no sudo. Detected by that path, not by PATH order, so a system copy cannot
	// stand in for a stale one. The yt-dlp binary replaces a `pip --user` wrapper
	// in place; every caller on hokon runs the binary, none imports the module.
	'yt-dlp-user': {
		when: backstopNode,
		role: 'admin',
		why:
			'the operator’s and agents’ scripts on the backstop call yt-dlp (watchparty’s ' +
			'playlist-add.py, the scraper). The upstream release binary, into ~/.local/bin.',
		detect: '"$HOME/.local/bin/yt-dlp" --version >/dev/null 2>&1 && echo OK',
		version: '"$HOME/.local/bin/yt-dlp" --version 2>/dev/null',
		latest: { source: { kind: 'github-release', repo: 'yt-dlp/yt-dlp' } },
		minAge: 1440,
		repair: ytdlpRepair(USER_BIN),
	},
	'deno-user': {
		when: backstopNode,
		role: 'admin',
		why:
			'yt-dlp on the backstop runs YouTube’s player JavaScript through deno. The upstream ' +
			'release binary, into ~/.local/bin (replacing a link into ~/.deno).',
		detect: '"$HOME/.local/bin/deno" --version >/dev/null 2>&1 && echo OK',
		version: '"$HOME/.local/bin/deno" --version 2>/dev/null | head -n 1',
		latest: { source: { kind: 'github-release', repo: 'denoland/deno', tagPrefix: 'v' } },
		repair: denoRepair(USER_BIN),
	},
};
