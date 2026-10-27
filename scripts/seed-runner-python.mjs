#!/usr/bin/env node
/**
 * seed-runner-python.mjs — put real Python interpreters in the `openclaw`
 * runners' tool cache so `actions/setup-python` resolves locally.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * `actions/setup-python` downloads from `actions/python-versions`, which
 * publishes per-DISTRO builds — and there is no Debian 13 build. The claws are
 * Debian 13 (trixie), so every `setup-python` step fails outright:
 *
 *     The version '3.12' with architecture 'x64' was not found for Debian 13.
 *
 * That single error took out CI on conjure, promptsmith, pygmalion and vibecheck
 * the moment their workflows moved onto the fleet. The system interpreter is
 * 3.13.5, which does not satisfy a `3.11`/`3.12` pin.
 *
 * WHY NOT JUST POINT AT /opt/hostedtoolcache
 * ------------------------------------------
 * It already holds 3.11.15 and 3.12.13 — and they are unusable here. That tree
 * is a SYMLINK FARM into `/home/hadoku` (uv-managed CPython), and `openclaw`
 * cannot traverse `/home/hadoku` on claw-1 or claw-2. Copying it yields dangling
 * symlinks PLUS a `.complete` sentinel claiming success — strictly worse than
 * absent, because setup-python would then resolve and hand the job a broken
 * interpreter. Do not "fix" this by copying that directory.
 *
 * WHAT IT INSTALLS
 * ----------------
 * `astral-sh/python-build-standalone` — portable, statically-relocatable CPython
 * that does not care which distro it lands on, which is exactly the property
 * `actions/python-versions` lacks. Laid out the way setup-python probes:
 *
 *     $RUNNER_TOOL_CACHE/Python/<x.y.z>/x64/         (bin/, lib/, ...)
 *     $RUNNER_TOOL_CACHE/Python/<x.y.z>/x64.complete (sentinel)
 *
 * Needs no root: it writes only inside openclaw's own home.
 *
 * USAGE
 *   fleet seed-python                 # dry run
 *   fleet seed-python --confirm
 *   fleet seed-python --confirm --version 3.12.13
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadManifest, machineArg, runOn, selectNodes } from './lib/fleet-exec.mjs';

/**
 * WHERE THE CACHE LIVES IS NOT THIS SCRIPT'S TO DECIDE.
 *
 * `lib/runner-toolcache.sh` states the rule once - the node's ci user owns
 * /opt/hostedtoolcache - and its header says it exists because the rule was
 * 'stated twice before, and the two copies disagreed'. This file was the third
 * copy, hardcoding the (since retired) openclaw branch for every node.
 *
 * The fleet's runners all run as hadoku today; the openclaw -b pool was retired
 * on 2026-08-24. So the hardcoded path was one no runner reads, and this command
 * reported MISSING on 2026-09-02 for all six claws while claw-1, claw-2 and
 * claw-3 each had a WORKING 3.11.15 and 3.12.13 under /opt. A seeder that cannot
 * tell seeded from unseeded is worse than no seeder: it invites a re-seed that
 * would `rm -rf` a cache the fleet is using.
 */
const TOOLCACHE_RULE = readFileSync(
	resolve(dirname(fileURLToPath(import.meta.url)), 'lib', 'runner-toolcache.sh'),
	'utf8'
);

/**
 * Nodes to seed — DERIVED from the manifest, never enumerated.
 *
 * This was `['claw-1', 'claw-2', 'claw-3']`. A new claw would have been
 * registered, throttled, contained and gated, and then silently skipped here —
 * so `setup-python` on it would find no interpreter and fall through to a
 * download that cannot succeed on Debian 13. That is the 2026-08-18 failure
 * arriving on day one of a node's life.
 *
 * A GUEST IS NOT SEEDED, AND THE SKIP IS PRINTED. It lends the fleet a
 * registration and is otherwise none of the fleet chain's business (operator,
 * 2026-09-14) — "never seeded" is one of the words in that decision, and this
 * unpacks a 60MB interpreter into another machine's home.
 *
 * BY ROLE, NOT BY LABEL. The exclusion here used to be `pm2-host`, which was
 * exact only while one machine carried that label and stopped being exact the
 * day Wave 3d made `pm2-host` an EARNED capability a claw can probe into: a claw
 * that earned it would have silently stopped being seeded, and `setup-python` on
 * it would then fall through to a download Debian 13 cannot satisfy — the
 * 2026-08-18 failure, reintroduced by a filter that was never about python.
 * `--machine <the guest>` still reaches it, deliberately.
 */
// `--machine` IS HONOURED HERE, and until 2026-09-08 it was silently dropped.
//
// This script took no scope argument at all, so `fleet seed-python --machine
// claw-7 --confirm` seeded EVERY claw. It was harmless because seeding is
// idempotent and the other six reported SKIP — but the operator asked for one
// node and got seven, and the next command shaped like this one may not be
// idempotent. `unconsumedArgs` cannot catch it either: `--machine` is a known
// value-flag, so it and its value are consumed and then ignored.
//
// machineArg is the ONE parser for "which node", for the same reason
// isLocalNode is the one answer to "is this me": this question had four
// implementations across the CLI and they disagreed.
const ONLY = machineArg(process.argv.slice(2), { valueFlags: ['--version'] });
const { nodes: selectedClaws, skippedByRole } = selectNodes(loadManifest(), {
	only: ONLY,
	where: (m) => m.placement !== 'excluded',
});
const CLAWS = selectedClaws.map(([name]) => name);
// SAID OUT LOUD. A node that stops being seeded without anyone noticing is the
// failure the skip exists to prevent.
for (const s of skippedByRole) console.log(`  ${s.node.padEnd(8)} [skipped: guest] — ${s.why}`);
if (!CLAWS.length) {
	console.error(
		`seed-runner-python: no node matches${ONLY ? ` --machine ${ONLY}` : ''}.\n` +
			'  A run that matched nothing must not report a clean pass over zero nodes.' +
			(skippedByRole.length
				? `\n  The only match is a guest (${skippedByRole.map((s) => s.node).join(', ')}), ` +
					'whose tool cache the fleet does not seed.'
				: '')
	);
	process.exit(1);
}

/**
 * Pinned patch versions, matching what `/opt/hostedtoolcache` already carries
 * for the `hadoku` pool — so both pools resolve the same interpreter and a job
 * cannot behave differently depending on which runner picked it up.
 */
const DEFAULT_VERSIONS = ['3.11.15', '3.12.13'];
const PBS_RELEASE = '20260807';

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');
const only = args.includes('--version') ? args[args.indexOf('--version') + 1] : null;
const VERSIONS = only ? [only] : DEFAULT_VERSIONS;

/**
 * The shared transport, not a bare ssh: this used to ssh unconditionally, so
 * seeding the host itself would have failed with a connection error rather than
 * running locally. Nothing has asked it to yet — CLAWS is claw-only — but the
 * hard-coded list is the reason, not the transport, and the two should not both
 * have to be right.
 */
const ssh = (node, script) =>
	runOn(node, script, { as: 'ci', timeoutMs: 15 * 60_000, maxBuffer: 8 * 1024 * 1024 });

function seedScript(version) {
	const asset = `cpython-${version}+${PBS_RELEASE}-x86_64-unknown-linux-gnu-install_only.tar.gz`;
	const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/${asset}`;
	return `
set -euo pipefail
${TOOLCACHE_RULE}
CACHE="$TOOLCACHE/Python/${version}"
if [ -f "$CACHE/x64.complete" ] && [ -x "$CACHE/x64/bin/python3" ]; then
  echo "SKIP ${version} (already seeded)"
  exit 0
fi
# A sentinel without a working interpreter is the dangerous half-state — clear
# both before rebuilding so a partial run can never masquerade as complete.
rm -rf "$CACHE"
mkdir -p "$CACHE"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -sSfL -o "$TMP/py.tar.gz" "${url}"
tar xzf "$TMP/py.tar.gz" -C "$TMP"
mv "$TMP/python" "$CACHE/x64"
"$CACHE/x64/bin/python3" -c "import sys,ssl,sqlite3;print('ok',sys.version.split()[0])"
touch "$CACHE/x64.complete"
echo "SEEDED ${version}"
`;
}

const results = [];
await Promise.all(
	CLAWS.map(async (claw) => {
		for (const version of VERSIONS) {
			if (!CONFIRM) {
				const probe = await ssh(
					claw,
					// EXECUTES the interpreter. The sentinel alone is the dangerous
					// half-state this script's own seedScript guards against, and a
					// dangling symlink farm satisfies `test -f` while handing a job a
					// broken python.
					`${TOOLCACHE_RULE}\n` +
						`P="$TOOLCACHE/Python/${version}/x64/bin/python3"; ` +
						`[ -x "$P" ] && "$P" -c 'pass' 2>/dev/null && echo present || echo MISSING`
				);
				results.push(`${claw}  ${version}  ${probe.stdout.trim() || 'unknown'}`);
				continue;
			}
			const res = await ssh(claw, seedScript(version));
			results.push(
				`${claw}  ${version}  ${res.ok ? res.stdout.trim().split('\n').pop() : `FAILED: ${res.stderr.trim().split('\n').pop()}`}`
			);
		}
	})
);

console.log(`${CONFIRM ? 'APPLY' : 'DRY RUN'} — python-build-standalone ${PBS_RELEASE}\n`);
for (const r of results.sort()) console.log(`  ${r}`);
const failed = results.filter((r) => r.includes('FAILED'));
if (failed.length) process.exit(1);
