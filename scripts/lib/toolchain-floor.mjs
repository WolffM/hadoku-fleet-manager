/**
 * toolchain-floor — the pure half of `fleet converge-toolchain`.
 *
 * Extracted from the command for the same reason `runners/census.ts` was
 * extracted from the tick: the arithmetic that decides WHAT a node must carry
 * has nothing to do with ssh, and while it lived next to the code that makes
 * the connections it could not be checked against a hand-written manifest.
 */

import { readFileSync, existsSync } from 'node:fs';

import { nodeOffer } from '../../dist/capabilities.js';
import { hostsPm2Services, isGuestNode } from '../../dist/lib/node-role.js';
import { DEFAULT_MIN_AGE_MINUTES, lookupLatest, parseVersion } from './tool-release.mjs';

/**
 * The installed-RAM floor jdk21/maven apply through `when` (cardtable#5,
 * added 2026-10-05). forge-e2e/forge-jvm peak at p50 2.9 GB, p95 5.5 GB,
 * max 10 GB ON TOP OF whatever else the node is running — measured on the
 * production host over the 14 days to 2026-10-04. A node whose ENTIRE
 * installed memory sits at or below the fleet's two smallest buckets (claw-2/
 * claw-6 at 7 GB, claw-1 at 11 GB) cannot absorb that footprint without
 * starving its own CI concurrency; every node the fleet has MEASURED at
 * 15 GB or more (claw-3/4/5/8) or 31 GB (claw-9) clears it with room to
 * spare. 12 GiB sits strictly between the two buckets, so the boundary does
 * not ride on any one node's exact figure.
 */
export const JDK21_MIN_INSTALLED_MB = 12 * 1024;

/**
 * A node's measured installed RAM, in MiB, or `null` when nothing measured it.
 *
 * `$measured.memTotalMb` (written by `fleet enroll`, `scripts/enroll-node.mjs`)
 * is the UNROUNDED figure and is preferred; `ramGb` (the declared, floored
 * figure every node carries) is the fallback for a node enrolled before
 * `$measured` existed — today that is claw-1/2/3 on this package's own
 * fixture manifest. `null` means "could not look", and the `when` predicate
 * below treats that as NOT qualifying — an unmeasured node must not be
 * silently granted a multi-GB toolchain it was never shown to have room for.
 */
export function installedMb(node) {
	const measured = Number(node?.$measured?.memTotalMb);
	if (Number.isFinite(measured) && measured > 0) return measured;
	const declared = Number(node?.ramGb);
	if (Number.isFinite(declared) && declared > 0) return declared * 1024;
	return null;
}

/**
 * A `when` predicate (see `toolAppliesTo`): offers only above a measured RAM
 * floor.
 *
 * `toString()` IS OVERRIDDEN, DELIBERATELY. `bootcamp.mjs` prints
 * `installed for ${tool.when}` on a successful install, and a bare function
 * for `when` would coerce to its own SOURCE TEXT in that template literal —
 * which would then land in the `$capabilities` record bootcamp writes and
 * commits to hadoku_site. A readable sentence here is what keeps that record
 * legible instead of carrying a few lines of this module's own source.
 */
function installedRamAtLeast(mb) {
	const predicate = (node) => {
		const have = installedMb(node);
		return have !== null && have >= mb;
	};
	predicate.toString = () => `installed RAM >= ${mb} MiB`;
	return predicate;
}

/**
 * Scope for the pm2 services-host tools (#6): a node declaring
 * `services: "pm2"`. A predicate rather than a capability id because `pm2-host`
 * — the obvious id — is the HUB's routing label, and claw-4 hosts services
 * without being the hub; see `hostsPm2Services` in src/lib/node-role.ts.
 */
const pm2ServicesHost = (node) => hostsPm2Services(node);
pm2ServicesHost.toString = () => 'services: "pm2"';

/** Claude's reachability repair; see REPAIRS.claude.link. One text, shared by `link` and `repair`. */
const CLAUDE_LINK = [
	'set -e',
	'if ! [ -x "$HOME/.local/bin/claude" ]; then',
	'  newest="$(ls -v "$HOME/.local/share/claude/versions" 2>/dev/null | tail -n 1 || true)"',
	'  if [ -z "$newest" ]; then',
	'    echo "no claude binary under ~/.local/bin or ~/.local/share/claude/versions; a link cannot fix that" >&2',
	'    exit 1',
	'  fi',
	'  mkdir -p "$HOME/.local/bin"',
	'  ln -sfn "$HOME/.local/share/claude/versions/$newest" "$HOME/.local/bin/claude"',
	'fi',
	'sudo -n ln -sfn "$HOME/.local/bin/claude" /usr/local/bin/claude',
].join('\n');

/**
 * NON-APT capabilities, each with a detector and a repair.
 *
 * A package list cannot express these: rustup is a curl-to-shell installer and
 * a docker daemon needs enabling plus a group. These are the things that were
 * done by hand on 2026-09-10, written down so they are never done by hand again.
 *
 * INVARIANT, held by the test beside this file: no `detect` may widen PATH.
 * That is the whole lesson of the rust entry — a detector that reaches into
 * ~/.cargo/bin answers a question no CI step ever asks. That covers `version`
 * too: it reads the version a CI step would get, from the stock PATH.
 *
 * ONE DECLARATION, THREE CONSUMERS (issue #69). The refresh cycle, the doctor
 * (`check-fleet-toolchain`) and bootcamp all read this table, so the three
 * cannot keep diverging lists. Fields:
 *
 *   why      operator-facing reason the tool is carried. Required.
 *   detect   stock-PATH presence check, prints OK. Required. Never widens PATH.
 *   repair   idempotent install script (the INSTALL procedure: binary, links,
 *            and reachability from a non-login shell). Required. A tool whose
 *            install takes a target version reads `$TARGET_VERSION`; build the
 *            runnable text with {@link installScript}.
 *   when     OPTIONAL capability id. Absent = every managed node (`rust`,
 *            `docker`). Present = only nodes that OFFER that capability, as
 *            answered by `nodeOffer` — the one derivation the mint uses — never
 *            by a second reader. See {@link toolAppliesTo}.
 *   link     OPTIONAL reachability-only repair: creates the stock-PATH link for a
 *            tool whose binary is present but visible only to a login shell. It
 *            never installs. When declared, the cycle uses it (not `repair`) for
 *            the "installed, but login-only" diagnosis, so a working binary that
 *            is newer than the pin is never reinstalled over. Read it through
 *            {@link linkScript}.
 *   version  OPTIONAL shell command printing the installed version, stock PATH.
 *   latest   OPTIONAL upstream declaration, `{ source: { package } }`, resolved
 *            by `tool-release.mjs` (npm per-version `time` map: version AND
 *            publish date). A tool with no `version`+`latest` is presence-only:
 *            the cadence and the doctor's currency check skip it.
 *   minAge   OPTIONAL minutes a release must have been public before it is
 *            installed. Default {@link DEFAULT_MIN_AGE_MINUTES} (seven days;
 *            hadoku_site/pnpm-workspace.yaml:36 `minimumReleaseAge`). Read it
 *            through {@link minAgeOf}.
 */
/**
 * APT-TRACKED TOOLS (2026-10-09). gh and ffmpeg are Debian packages, and nothing
 * ever upgraded them: the fleet carried gh 2.92 (claw-1/2/3) to 2.101 (claw-9)
 * with 2.102.0 sitting in apt as the candidate on EVERY claw, and claw-1 ran
 * ffmpeg 7.1.3 with 7.1.5 waiting. They were presence-only, so the daily refresh
 * called all of that "current".
 *
 * `apt: '<package>'` makes apt's own candidate the target, compared ON THE NODE
 * with `dpkg --compare-versions` (epochs and Debian revisions included — no
 * parsing here). The upgrade runs in the refresh cycle like any other update:
 * drained, one node at a time. Behind is ADVISORY, not a finding: the repo
 * publishes without a debounce this side can see, so a release must not page
 * `ci:fleet-toolchain` before the next cycle has had its chance to act.
 */
const aptRepair = (pkg) =>
	[
		'set -e',
		'sudo apt-get update -qq',
		`if dpkg -s ${pkg} >/dev/null 2>&1; then sudo apt-get install -y --only-upgrade ${pkg}; ` +
			`else sudo apt-get install -y ${pkg}; fi`,
	].join('\n');

export const REPAIRS = {
	gh: {
		apt: 'gh',
		why:
			'workflow steps across the fleet shell out to gh; it comes from cli.github.com’s apt ' +
			'repo, so apt’s candidate is the version every node converges to.',
		detect: 'gh --version >/dev/null 2>&1 && echo OK',
		repair: aptRepair('gh'),
	},
	ffmpeg: {
		apt: 'ffmpeg',
		why: 'required of every managed node; Debian’s own security updates are the version to track.',
		detect: 'ffmpeg -version >/dev/null 2>&1 && echo OK',
		repair: aptRepair('ffmpeg'),
	},
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
		repair: [
			'if ! [ -x "$HOME/.cargo/bin/rustup" ]; then',
			"  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs |" +
				' sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path',
			'fi',
			'export PATH="$HOME/.cargo/bin:$PATH"',
			'rustup component add rustfmt clippy >/dev/null 2>&1 || true',
			'rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true',
			'for b in rustup cargo rustc rustdoc rustfmt cargo-fmt cargo-clippy clippy-driver; do',
			'  [ -e "$HOME/.cargo/bin/$b" ] && sudo -n ln -sfn "$HOME/.cargo/bin/$b" "/usr/local/bin/$b"',
			'done',
		].join('\n'),
	},
	'rust-wasm32': {
		why: 'brave-quartet’s wasm-size job builds for wasm32-unknown-unknown.',
		detect:
			'command -v rustup >/dev/null 2>&1 && ' +
			'rustup target list --installed 2>/dev/null | grep -qx wasm32-unknown-unknown && echo OK',
		repair: 'export PATH="$HOME/.cargo/bin:$PATH"; rustup target add wasm32-unknown-unknown',
	},
	docker: {
		why:
			'brave-quartet’s publish-server-image job builds an image with buildx. Grants no ' +
			'privilege the runner user did not already have — `hadoku` has NOPASSWD sudo, so ' +
			'the docker group is not an escalation, only a convenience.',
		// `docker info` rather than `command -v docker`: the CLI is present and
		// useless when the daemon is not running, and a build needs the daemon.
		detect: 'docker info >/dev/null 2>&1 && echo OK',
		repair: [
			'if ! command -v docker >/dev/null 2>&1; then',
			'  sudo -n apt-get install -y -qq --no-install-recommends docker.io docker-cli docker-buildx',
			'fi',
			'sudo -n systemctl enable --now docker',
			'id -nG "$USER" | tr " " "\\n" | grep -qx docker || sudo -n usermod -aG docker "$USER"',
		].join('\n'),
	},
	claude: {
		when: 'taskauto',
		why:
			'`drain the board` (taskauto) runs the Claude Code CLI as its judge via ' +
			'TASKAUTO_CLAUDE_BIN, so a node that offers taskauto must be able to run `claude` ' +
			'from a workflow step. Claw-8 had the binary and failed anyway: no ~/.local/bin ' +
			'symlink, and ~/.local/bin on the PATH only a login shell builds.',
		// STOCK PATH, NOT `bash -lc`. On 2026-09-30 claw-8 answered `bash -lc` with a
		// path and `bash --noprofile --norc -c` with NOT-ON-PATH; a detector that
		// widens PATH reports that node healthy. Running the binary, not just finding
		// it, is the capability.
		detect: 'command -v claude >/dev/null 2>&1 && claude --version >/dev/null 2>&1 && echo OK',
		version: 'claude --version 2>/dev/null',
		// Verified against hokon 2026-09-30: the native installer lays
		// ~/.local/share/claude/versions/<x.y.z> and symlinks ~/.local/bin/claude to
		// the newest, and every such <x.y.z> (2.1.284, .285, .286) is a key in the
		// npm `time` map of @anthropic-ai/claude-code — so npm is the authority for
		// "what versions exist and when", even though npm is not how it is installed.
		latest: { source: { package: '@anthropic-ai/claude-code' } },
		// REACHABILITY, declared SEPARATELY from the install (issue #69, claw-8). The
		// binary can be present and working and still invisible to a workflow step:
		// `/usr/local/bin` is on the STOCK PATH, `~/.local/bin` only on a login
		// shell's. That fault needs a symlink, not an install — and an install pinned
		// to the newest DEBOUNCE-CLEARED release would DOWNGRADE a binary that is
		// already newer than it. The cycle, the doctor's diagnosis and bootcamp all
		// read this one text. It never installs: if the binary is missing it fails
		// with a reason, which is a finding, not a repair.
		link: CLAUDE_LINK,
		// The INSTALL, for a node where the tool is ABSENT or BEHIND. It never moves
		// a binary BACKWARD: the installer runs only when nothing is installed, or
		// when `$TARGET_VERSION` is strictly newer than what is (sort -V). An
		// unreadable version with a binary on disk falls back to the newest
		// versions/ entry, and failing that is treated as present-by-link — it is
		// never reinstalled over. The link then runs every time, so a node that has
		// the binary but not the links is repaired too.
		repair:
			[
				'set -e',
				'cur="$("$HOME/.local/bin/claude" --version 2>/dev/null | cut -d" " -f1 || true)"',
				'[ -n "$cur" ] || cur="$(ls -v "$HOME/.local/share/claude/versions" 2>/dev/null | tail -n 1 || true)"',
				'if [ -z "$cur" ] || { [ -n "${TARGET_VERSION:-}" ] && [ "$cur" != "$TARGET_VERSION" ] &&',
				'  [ "$(printf \'%s\\n%s\\n\' "$cur" "$TARGET_VERSION" | sort -V | head -n 1)" = "$cur" ]; }; then',
				'  curl -fsSL https://claude.ai/install.sh | bash -s -- ${TARGET_VERSION:-}',
				'fi',
			].join('\n') + `\n${CLAUDE_LINK.split('\n').slice(1).join('\n')}`,
	},
	/*
	 * THE PM2 SERVICES HOST (#6). claw-4 was made one on 2026-10-12 by a script
	 * the operator ran by hand (docs/planning/handoff-2026-10-12.md), and nothing
	 * here would have rebuilt it on a fresh image. These three are that script,
	 * written down, in the order a fresh box needs them: pm2, then its boot unit
	 * (which runs pm2), then the tunnel daemon. The tunnel itself — its
	 * credentials and config.yml — needs the Cloudflare account and stays an
	 * operator step; hadoku_site's cutover refuses a host whose `tunnel` is unset.
	 */
	pm2: {
		when: pm2ServicesHost,
		why:
			'the supervisor every hadoku service runs under; mgmt-api deploys to it over ssh and ' +
			'reads `pm2 jlist` back. Global npm install, as on claw-4 (/usr/lib/node_modules/pm2).',
		detect: 'command -v pm2 >/dev/null 2>&1 && pm2 --version >/dev/null 2>&1 && echo OK',
		// PRESENCE-ONLY, deliberately: no `version`/`latest`, so the daily refresh
		// never upgrades it. Upgrading pm2 under live services means `pm2 update`,
		// which kills and resurrects the daemon — every service on the box restarts.
		// That is an operator's call on a production host, not a cadence's.
		repair: [
			'set -e',
			'command -v pm2 >/dev/null 2>&1 || sudo -n npm install -g --no-fund --no-audit pm2',
		].join('\n'),
	},
	'pm2-boot': {
		when: pm2ServicesHost,
		why:
			'services must come back after a reboot without a human: pm2 runs under ' +
			'pm2-<user>.service (pm2 resurrect), as claw-4 does. A daemon started by hand dies ' +
			'with the box and takes every service with it.',
		// Enabled AND active: an enabled unit that failed to start is a box whose
		// services did not come back, which is the thing this entry exists for.
		detect:
			'u="$(id -un)"; systemctl is-enabled "pm2-$u.service" >/dev/null 2>&1 && ' +
			'systemctl is-active "pm2-$u.service" >/dev/null 2>&1 && echo OK',
		repair: [
			'set -e',
			'u="$(id -un)"',
			'sudo -n env PATH="$PATH" "$(command -v pm2)" startup systemd -u "$u" --hp "$HOME" >/dev/null',
			// Saving an EMPTY list over a populated dump would make the next boot
			// resurrect nothing, so only save when pm2 is supervising something.
			'[ "$(pm2 jlist 2>/dev/null | tr -cd "{" | wc -c)" -gt 0 ] && pm2 save >/dev/null || true',
			'sudo -n systemctl enable --now "pm2-$u.service"',
		].join('\n'),
	},
	cloudflared: {
		when: pm2ServicesHost,
		why:
			'a services host runs its OWN tunnel (operator decision 2026-10-11), so a hub outage ' +
			'does not take its hostnames down. Cloudflare apt repo, as on claw-4.',
		detect: 'cloudflared --version >/dev/null 2>&1 && echo OK',
		// PRESENCE-ONLY, NOT `apt:` — for the pm2 entry's reason. An apt-tracked
		// tool is upgraded by the refresh cycle, and upgrading cloudflared restarts
		// the tunnel every hostname on this box answers through.
		repair: [
			'set -e',
			'if [ ! -f /etc/apt/sources.list.d/cloudflared.list ]; then',
			'  sudo -n mkdir -p --mode=0755 /usr/share/keyrings',
			'  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo -n tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null',
			"  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' |",
			'    sudo -n tee /etc/apt/sources.list.d/cloudflared.list >/dev/null',
			'fi',
			'command -v cloudflared >/dev/null 2>&1 || { sudo -n apt-get update -qq && sudo -n apt-get install -y cloudflared; }',
		].join('\n'),
	},
	/*
	 * JDK21 + MAVEN (cardtable#5, added 2026-10-05): forge-e2e/forge-jvm move
	 * off the production host onto whichever claws can hold their footprint. TWO entries, not
	 * one, because Temurin and Maven are independently versioned, independently
	 * released, and read from independently-shaped feeds — `isVersionManaged`,
	 * `minAgeOf` and `resolveInstallTarget` all key off ONE `version`+`latest`
	 * pair per tool, and merging the two would force one minAge clock and one
	 * `latest` shape onto two vendors that do not share either. The CAPABILITY
	 * (`src/capabilities.ts` `jdk21`) is still singular: a node either proves
	 * both halves by execution or it does not earn the label.
	 *
	 * SCOPED BY MEMORY, NOT BY NAME (`installedRamAtLeast`, above) — forge's
	 * footprint fits some claws and not others, and which ones is a measured
	 * fact, not a guess made once about today's hostnames.
	 */
	jdk21: {
		when: installedRamAtLeast(JDK21_MIN_INSTALLED_MB),
		why:
			"cardtable's forge-e2e/forge-jvm (#5) move off the production host onto a claw with room for the " +
			'JVM: p50 2.9 GB, p95 5.5 GB, max 10 GB on top of whatever else the node runs. ' +
			'`command -v java` is not proof — only compiling and running a class, and running ' +
			'`mvn -v`, show the toolchain actually works from a workflow step.',
		// STOCK PATH. Compiles and RUNS a one-class program rather than asking `java
		// -version`: a `java`/`javac` that exists and exits non-zero (the shape a
		// stub or a half-broken install takes) must read as absent, not present.
		detect:
			'd="$(mktemp -d)" && printf ' +
			'\'public class Probe{public static void main(String[] a){System.out.println("JDK21-PROBE-OK");}}\' ' +
			'> "$d/Probe.java" && javac -d "$d" "$d/Probe.java" >/dev/null 2>&1 && ' +
			'[ "$(java -cp "$d" Probe 2>/dev/null)" = JDK21-PROBE-OK ] && rm -rf "$d" && echo OK',
		// major.minor.security ONLY — never the raw banner. `check-fleet-toolchain.mjs`'s
		// `judgeTool` reads this through the SHARED `parseInstalledVersion`
		// (`tool-release.mjs`), which looks for the FIRST run of three dotted
		// numbers not immediately followed by another `.` or digit. Temurin's own
		// banner is `openjdk version "21.0.12.1" …` — a FOURTH component — and on
		// that raw text the shared regex backtracks past "21.0.12" (rejected: the
		// next character is still `.`) and matches "0.12.1" instead, silently
		// misreading a real, currently-shipping release as version "0.12.1".
		// Measured live on this exact Temurin build (2026-10-05). Every OTHER
		// REPAIRS entry's `version` already prints a bare x.y.z banner (`claude
		// --version`), so the shared regex was never wrong until a tool's own
		// vendor used a fourth component — fixed HERE, not in the shared parser,
		// whose contract every other tool already relies on unchanged.
		version: "java -version 2>&1 | sed -n '1s/.*\"\\([0-9]*\\.[0-9]*\\.[0-9]*\\).*/\\1/p'",
		// The newest Temurin 21 GA that has cleared the debounce. `feature: 21` is
		// explicit rather than implied by the key, because `lookupAdoptiumLatest`
		// is generic over the feature-release line and a future jdkNN capability
		// should not have to re-derive the number from an id string.
		latest: { source: { kind: 'adoptium', feature: 21 } },
		// THE INSTALL. Re-resolves the FULL Adoptium release tag from the pinned
		// x.y.z (see `lookupAdoptiumLatest`'s header for why the tag is not
		// threaded through), downloads the linux/x64/hotspot tarball Adoptium's
		// binary-redirect endpoint names, VERIFIES its published sha256 BEFORE
		// extracting, and lays it at `~/.local/opt/jdk-<release>` — the layout
		// hokon already uses by hand. Links land in `/usr/local/bin`, the STOCK
		// PATH, never only `~/.local/bin` — the exact claw-8/claude lesson this
		// file's header names. NEVER MOVES BACKWARD: a `java` that already
		// reports the pinned version or newer skips the download but still
		// re-links, the same shape `rust` and `claude` use for a tool that is
		// present but unreachable from a workflow step.
		repair: [
			'set -eu',
			'want="$TARGET_VERSION"',
			'[ -n "$want" ] || { echo "jdk21 repair needs \\$TARGET_VERSION" >&2; exit 1; }',
			'cur="$(java -version 2>&1 | sed -n \'1s/.*"\\([0-9][0-9.]*\\)".*/\\1/p\' 2>/dev/null || true)"',
			'if [ -n "$cur" ] && { [ "$cur" = "$want" ] || ' +
				'[ "$(printf \'%s\\n%s\\n\' "$cur" "$want" | sort -V | tail -n 1)" = "$cur" ]; }; then',
			'  : # already current or newer than the pin -- never move backward',
			'else',
			'  want_re="$(printf \'%s\' "$want" | sed \'s/\\./\\\\./g\')"',
			'  feed="https://api.adoptium.net/v3/assets/feature_releases/21/ga?image_type=jdk&os=linux&architecture=x64&jvm_impl=hotspot&heap_size=normal&vendor=eclipse&page_size=20"',
			// Adoptium's JSON comes back PRETTY-PRINTED (`"release_name": "jdk-…"`,
			// a space after the colon) — the ` *` is load-bearing, measured against
			// the live feed, not a guess at the shape.
			'  rel="$(curl -fsSL "$feed" | ' +
				'grep -oE "\\"release_name\\": *\\"jdk-${want_re}(\\\\.[0-9]+)?\\\\+[0-9]+[^\\"]*\\"" | ' +
				'head -n 1 | sed -E \'s/.*"(jdk-[^"]+)".*/\\1/\')"',
			'  [ -n "$rel" ] || { echo "no Adoptium release matches pinned version $want" >&2; exit 1; }',
			'  enc="$(printf \'%s\' "$rel" | sed \'s/+/%2B/g\')"',
			'  bin_url="https://api.adoptium.net/v3/binary/version/${enc}/linux/x64/jdk/hotspot/normal/eclipse?project=jdk"',
			'  asset_url="$(curl -fsSI "$bin_url" | tr -d \'\\r\' | ' +
				"awk -F': ' 'tolower($1)==\"location\"{u=$2} END{print u}')\"",
			'  [ -n "$asset_url" ] || { echo "Adoptium gave no download location for $rel" >&2; exit 1; }',
			'  tmp="$(mktemp -d)"',
			'  curl -fsSL "$asset_url" -o "$tmp/jdk.tar.gz"',
			'  curl -fsSL "${asset_url}.sha256.txt" -o "$tmp/jdk.tar.gz.sha256"',
			// Compared by HASH, not by `sha256sum -c`: Adoptium's .sha256.txt names
			// the ORIGINAL asset filename, and the tarball is saved locally under a
			// fixed name — `-c` would fail on a filename mismatch, never on the
			// bytes, which is not the check this is.
			'  exp="$(awk \'{print $1}\' "$tmp/jdk.tar.gz.sha256" | tr -d \'[:space:]\')"',
			'  got="$(sha256sum "$tmp/jdk.tar.gz" | awk \'{print $1}\')"',
			'  [ -n "$exp" ] && [ "$exp" = "$got" ] || ' +
				'{ echo "sha256 mismatch for $asset_url -- refusing to extract" >&2; rm -rf "$tmp"; exit 1; }',
			'  dest="$HOME/.local/opt/${rel}"',
			'  rm -rf "${dest}.incoming" "$dest"',
			'  mkdir -p "${dest}.incoming"',
			'  tar -xzf "$tmp/jdk.tar.gz" -C "${dest}.incoming" --strip-components=1',
			'  mv "${dest}.incoming" "$dest"',
			'  rm -rf "$tmp"',
			'fi',
			'cur_dest="$(ls -d "$HOME"/.local/opt/jdk-"$want"* 2>/dev/null | sort -V | tail -n 1)"',
			'[ -n "$cur_dest" ] || cur_dest="$(ls -d "$HOME"/.local/opt/jdk-* 2>/dev/null | sort -V | tail -n 1)"',
			'[ -n "$cur_dest" ] || { echo "no jdk under ~/.local/opt after repair" >&2; exit 1; }',
			'for b in java javac; do',
			'  sudo -n ln -sfn "$cur_dest/bin/$b" "/usr/local/bin/$b"',
			'done',
		].join('\n'),
	},
	maven: {
		// SAME FLOOR AS jdk21, deliberately re-derived rather than literal-copied:
		// Maven is forge's build tool, carried only where the JDK it drives is
		// — a claw offering one without the other is a half-capability no job
		// can use.
		when: installedRamAtLeast(JDK21_MIN_INSTALLED_MB),
		why:
			'forge-e2e/forge-jvm build with Maven, not a bare javac invocation. `command -v mvn` ' +
			'is not proof — a `mvn` that cannot actually run (no JAVA_HOME it can resolve, a ' +
			'corrupt wrapper) exits non-zero on `-v` the same way an absent one does.',
		detect: 'mvn -v 2>&1 | grep -q "Apache Maven" && echo OK',
		version: 'mvn -v 2>/dev/null | head -n1',
		latest: { source: { kind: 'maven-metadata', majorMinor: '3.9' } },
		// Apache publishes SHA-512 for its release tarballs, not SHA-256 — the
		// brief's "verify the published sha256" is Adoptium's shape, and this
		// verifies whatever the vendor actually published rather than the wrong
		// algorithm for the sake of matching that prose literally.
		// `archive.apache.org`, never `dlcdn.apache.org`: the CDN mirror only
		// ever serves the CURRENT release, so a pinned (debounced, possibly
		// one-release-old) version is a 404 there the day the next one ships.
		repair: [
			'set -eu',
			'want="$TARGET_VERSION"',
			'[ -n "$want" ] || { echo "maven repair needs \\$TARGET_VERSION" >&2; exit 1; }',
			'cur="$(mvn -v 2>/dev/null | sed -n \'1s/Apache Maven \\([0-9][0-9.]*\\).*/\\1/p\')"',
			'if [ -n "$cur" ] && { [ "$cur" = "$want" ] || ' +
				'[ "$(printf \'%s\\n%s\\n\' "$cur" "$want" | sort -V | tail -n 1)" = "$cur" ]; }; then',
			'  : # already current or newer than the pin -- never move backward',
			'else',
			'  base="https://archive.apache.org/dist/maven/maven-3/${want}/binaries/apache-maven-${want}-bin.tar.gz"',
			'  tmp="$(mktemp -d)"',
			'  curl -fsSL "$base" -o "$tmp/maven.tar.gz"',
			'  curl -fsSL "${base}.sha512" -o "$tmp/maven.tar.gz.sha512"',
			'  exp="$(awk \'{print $1}\' "$tmp/maven.tar.gz.sha512" | tr -d \'[:space:]\')"',
			'  got="$(sha512sum "$tmp/maven.tar.gz" | awk \'{print $1}\')"',
			'  [ "$exp" = "$got" ] || ' +
				'{ echo "sha512 mismatch for apache-maven-$want -- refusing to extract" >&2; rm -rf "$tmp"; exit 1; }',
			'  dest="$HOME/.local/opt/apache-maven-${want}"',
			'  rm -rf "${dest}.incoming" "$dest"',
			'  mkdir -p "${dest}.incoming"',
			'  tar -xzf "$tmp/maven.tar.gz" -C "${dest}.incoming" --strip-components=1',
			'  mv "${dest}.incoming" "$dest"',
			'  rm -rf "$tmp"',
			'fi',
			'cur_dest="$(ls -d "$HOME"/.local/opt/apache-maven-* 2>/dev/null | sort -V | tail -n 1)"',
			'[ -n "$cur_dest" ] || { echo "no maven under ~/.local/opt after repair" >&2; exit 1; }',
			'sudo -n ln -sfn "$cur_dest/bin/mvn" /usr/local/bin/mvn',
		].join('\n'),
	},
};

/**
 * The runnable install text for one tool, optionally pinned to a version.
 *
 * The version is VALIDATED as a strict x.y.z before it is interpolated into a
 * shell script — it comes from a registry response, which is not ours.
 *
 * A VERSION-MANAGED TOOL (one that declares `latest`) REFUSES WITH NO VERSION
 * (issue #70). Its `repair` text installs whatever the vendor published most
 * recently when `$TARGET_VERSION` is unset — that is correct as the tail half
 * of a PINNED install (see the `claude` repair), and a silent bypass of the
 * 7-day debounce for any caller that omits one. `bootcamp.mjs:277` was exactly
 * that caller: it called `installScript(id)` with no version on the one path
 * that puts a tool on a FRESH node, so a box earning `taskauto` got whatever
 * `@anthropic-ai/claude-code` had published an hour earlier. The debounced
 * release must be resolved through {@link resolveInstallTarget} FIRST — there
 * is no second way to get an installable version out of this function.
 * Presence-only tools (rust, docker — no `latest`) are unaffected: they have
 * no vendor-latest to bypass, and `installScript(id)` with no version is the
 * only call they ever need.
 */
export function installScript(id, version) {
	const r = REPAIRS[id];
	if (!r) throw new Error(`unknown tool ${JSON.stringify(id)}`);
	// apt installs ITS candidate — the version the probe compared against.
	if (r.apt) return r.repair;
	if (version === undefined || version === null) {
		if (isVersionManaged(r)) {
			throw new Error(
				`installScript(${JSON.stringify(id)}) needs a resolved version: this tool declares ` +
					"'latest', so installing with none would run whatever the vendor published most " +
					'recently and bypass the debounce (issue #70). Resolve one with ' +
					'resolveInstallTarget() first.'
			);
		}
		return r.repair;
	}
	if (!parseVersion(version))
		throw new Error(`refusing to install non x.y.z version ${JSON.stringify(version)}`);
	return `TARGET_VERSION='${version}'\nexport TARGET_VERSION\n${r.repair}`;
}

/**
 * The reachability-only repair for one tool, or null when the tool declares none.
 * It creates the stock-PATH link and NEVER installs or changes a version.
 */
export function linkScript(id) {
	const r = REPAIRS[id];
	if (!r) throw new Error(`unknown tool ${JSON.stringify(id)}`);
	return r.link ?? null;
}

/** Minutes a release must have been public before this tool is moved to it. */
export function minAgeOf(tool) {
	return Number.isFinite(tool?.minAge) && tool.minAge >= 0 ? tool.minAge : DEFAULT_MIN_AGE_MINUTES;
}

/**
 * True when the tool declares both halves of a currency check. Otherwise it
 * is presence-only.
 *
 * `source` need only be truthy, not specifically carry `.package` — that was
 * right while every version-managed tool was an npm package (`claude`), and
 * is too narrow for `jdk21`/`maven`, whose `source.kind` picks Adoptium or
 * Maven Central instead (`createReleaseLookup` in `tool-release.mjs` reads
 * it). `claude`'s source is still truthy either way, so this is additive,
 * not a behaviour change.
 */
export function isVersionManaged(tool) {
	return Boolean(tool?.version && tool?.latest?.source);
}

/**
 * THE ONE RESOLVER (issue #70): the install target for a tool, i.e. the newest
 * release that has cleared its debounce. Bootcamp and the refresh cycle both
 * call this rather than each computing "what to install" its own way — two
 * resolvers is #69's bug again, this time over the target version instead of
 * the declaration.
 *
 * A presence-only tool (no `latest`) has nothing to resolve:
 * `{ status: 'presence-only' }`. `installScript(id)` with no version is the
 * correct and only call for one of those.
 *
 * "COULD NOT LOOK" REFUSES, IT NEVER FALLS BACK. An unreachable, rate-limited
 * or malformed registry answer returns `{ status: 'unknown', reason }` and
 * NEVER a version — there is no path from here back to vendor-latest behind a
 * failed lookup. `installScript` enforces the other half: it throws rather
 * than install a version-managed tool with no version, so a caller cannot
 * skip this resolver and still get an install.
 *
 * @param {object} tool  a REPAIRS entry
 * @param {object} [opts]
 * @param {typeof lookupLatest} [opts.lookup]  injectable; defaults to a bare
 *        npm lookup, which is right for a presence-only or npm-sourced tool
 *        and wrong for `jdk21`/`maven`'s non-npm sources — every real caller
 *        (bootcamp, the refresh cycle, the doctor) passes
 *        `createReleaseLookup()`'s result instead, which dispatches on the
 *        tool's own `latest.source.kind` (npm, Adoptium or Maven Central) and
 *        is the one this function should always be handed in production.
 * @returns {Promise<{status:'presence-only'}
 *          | {status:'known', version:string, publishedAt:string}
 *          | {status:'unknown', reason:string}>}
 */
export async function resolveInstallTarget(tool, opts = {}) {
	if (!isVersionManaged(tool)) return { status: 'presence-only' };
	const { lookup = lookupLatest, ...rest } = opts;
	const latest = await lookup(tool.latest.source, { minAge: minAgeOf(tool), ...rest });
	if (latest.status !== 'known') return { status: 'unknown', reason: latest.reason };
	return { status: 'known', version: latest.version, publishedAt: latest.publishedAt };
}

/**
 * Does this tool apply to this node?
 *
 *   - A GUEST is never touched by the fleet chain by DEFAULT (hokon) — the
 *     fleet never converges, repairs or bootcamps it.
 *   - No `when` => every managed node (every included guest, too).
 *   - `when` AS A STRING => the node must OFFER that capability per
 *     `nodeOffer` — the same derivation `ephemeral-tick.ts` mints with.
 *     `taskauto` is ASSIGNED, not probed, so bootcamp's `$capabilities.earned`
 *     alone would say no node carries it; `nodeOffer` is the one place that
 *     knows both kinds.
 *   - `when` AS A FUNCTION `(node) => boolean` => a predicate over the node's
 *     own manifest fields, for a scoping rule that is not itself a capability
 *     — `jdk21`/`maven`'s installed-RAM floor (`installedRamAtLeast`) is the
 *     case that exists. It runs AFTER the guest check below, so it never
 *     needs to re-derive "never hokon" itself.
 *
 * `includeGuests` is the ONE door that lifts the guest exclusion, and it exists
 * for exactly one caller: the read-only doctor (`check-fleet-toolchain.mjs`),
 * asking "could this guest take over" rather than "repair this guest" — the
 * guest rule covers MUTATION, not VERIFICATION (operator, 2026-10-01). Every
 * mutating caller (bootcamp, `converge-toolchain`, the refresh cycle) leaves it
 * at the default `false`, so this stays exactly as uninvolved with a guest as
 * it always was for anything that installs or repairs.
 *
 * INVARIANT 2: a node for which this is false neither gets the tool nor is
 * reported broken for lacking it. Consumers MUST filter through this.
 *
 * @param {string} id     REPAIRS key
 * @param {object} node   a manifest machine entry (`labels`, `role`, `$capabilities`)
 * @param {{includeGuests?: boolean}} [opts]
 */
export function toolAppliesTo(id, node, { includeGuests = false } = {}) {
	const tool = REPAIRS[id];
	if (!tool) throw new Error(`unknown tool ${JSON.stringify(id)}`);
	if (isGuestNode(node) && !includeGuests) return false;
	if (!tool.when) return true;
	if (typeof tool.when === 'function') return tool.when(node ?? {});
	return nodeOffer(node ?? {}, { eligible: false }).includes(tool.when);
}

/** `[id, tool]` for every REPAIRS entry that applies to this node. */
export function applicableRepairs(node, opts = {}) {
	return Object.entries(REPAIRS).filter(([id]) => toolAppliesTo(id, node, opts));
}

/**
 * The package floor every managed node must carry, read from the profiles that
 * IMAGE the nodes.
 *
 * THROWS on a missing file rather than returning an empty floor. Same rule the
 * manifest resolver follows and for the same reason: a floor that resolves to
 * nothing reports a perfectly converged fleet of zero requirements.
 *
 * THE MESSAGE NAMES `FLEET_MANIFEST_DIR` FIRST, and that ordering is issue #58.
 * It named only `FLEET_NODE_PROFILES`, which is the one-file override — so an
 * operator hitting this from a deployed CLI was told to pin a path by hand
 * instead of being told the profile manifest is operator config that lives
 * beside the fleet manifest. The caller resolves it through
 * `profileManifestPath()` now, and the advice has to point at the same door.
 */
export function declaredPackages(path) {
	if (!path || !existsSync(path)) {
		throw new Error(
			`node-profiles.json not found at ${path}. It is the DECLARATION this command ` +
				'converges toward; without it there is nothing to converge to, and an empty ' +
				'floor would report every node perfectly converged. It is operator config and ' +
				'lives beside fleet-runner-manifest.json: point FLEET_MANIFEST_DIR at that ' +
				'directory, or FLEET_NODE_PROFILES at one profile manifest to override.'
		);
	}
	const profiles = JSON.parse(readFileSync(path, 'utf8')).profiles ?? {};
	const lists = Object.entries(profiles)
		.filter(([id]) => !id.startsWith('$'))
		.map(([id, p]) => [id, p?.toolchain?.packages ?? []]);
	if (!lists.length) throw new Error(`${path} declares no profiles`);

	// The floor is what EVERY profile agrees on. A package only one chassis
	// declares is that chassis's business — installing a laptop's set on a
	// desktop would converge toward a machine that does not exist.
	const [, first] = lists[0];
	const common = first.filter((pkg) => lists.every(([, l]) => l.includes(pkg)));
	const divergent = new Set();
	for (const [, l] of lists) for (const pkg of l) if (!common.includes(pkg)) divergent.add(pkg);
	return { common, divergent: [...divergent].sort(), profileIds: lists.map(([id]) => id) };
}

/**
 * Measured CPU THREADS below which `fleet bootcamp --prove` skips a
 * capability's workload CANARY — never a reason to withhold the label itself
 * (wave 4e, #102). claw-3 (i7-6600U, 2c/4t) is the case this exists for: one
 * `forge-e2e` job alone runs two Forge JVMs at ~190% CPU each plus the server
 * and Chromium, which saturates a 4-thread box before match creation can even
 * finish inside the harness's fixed 20s timeout — a doomed canary that still
 * costs 15+ minutes of a node's time and an Actions runner slot to find that
 * out. claw-4 (i7-6700, 8t), claw-8 (i7-9700F, 8t) and claw-9 (i7-5930K, 12t)
 * all clear it.
 *
 * 6 sits in the gap between the measured 4 and 8 — the same "wide empty band"
 * shape `cargo-bevy`'s throughput bar uses, so the one node on either side of
 * today's four measurements cannot flip the boundary.
 *
 * `node.cores` (NOT a `$measured`/state-dir field): `fleet enroll` measures it
 * from a live `nproc` and treats a claimed/measured mismatch as FATAL
 * (`scripts/enroll-node.mjs`), so it is already the trustworthy, re-verified
 * figure this needs — no new measurement to add.
 */
export const JDK21_CANARY_MIN_THREADS = 6;

/**
 * Per-capability CPU floor for the workload CANARY. A capability absent here
 * has no floor: it qualifies by default, since not every workload-gated
 * capability needs one (the floor is a property of the WORKLOAD, not of this
 * mechanism).
 */
const CANARY_CPU_FLOOR = { jdk21: JDK21_CANARY_MIN_THREADS };

/**
 * Should `fleet bootcamp --prove` even ATTEMPT `capabilityId`'s workload
 * canary on this node?
 *
 * THE CANARY REMAINS THE AUTHORITY — this is a PRE-FILTER, not a verdict. It
 * can only SKIP a run that would very likely fail on an obviously undersized
 * box, to save the 15+ minutes a doomed canary costs; it can never GRANT the
 * label by itself, and a node it skips is reported as SKIPPED, never as
 * proven. An unmeasured node (`node.cores` missing or not finite) does not
 * qualify — "could not look" is not "small enough to skip for free", and a
 * floor a box cannot be shown to clear is not a floor it has cleared.
 */
export function qualifiesForCanary(capabilityId, node) {
	const floor = CANARY_CPU_FLOOR[capabilityId];
	if (floor === undefined) return true;
	const threads = Number(node?.cores);
	return Number.isFinite(threads) && threads >= floor;
}

/** Parse one node's observed state out of the probe's lines. */
export function parseObservation(out) {
	const missingPackages = [...String(out).matchAll(/^PKG-MISSING (\S+)$/gm)].map((m) => m[1]);
	const brokenCapabilities = [...String(out).matchAll(/^REPAIR (\S+) (\S*)$/gm)]
		.filter((m) => m[2] !== 'OK')
		.map((m) => m[1]);
	return { missingPackages, brokenCapabilities };
}
