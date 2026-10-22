/**
 * WHICH FILES `fleet throttle` PUTS ON A NODE, AND HOW EACH ONE IS VERIFIED.
 *
 * docs/planning/deployed-not-published-2026-09-05.md names four trees the same
 * code can live in, and a claw's `~/.hadoku/` is the one that updates ONLY when
 * a deployer runs. Nothing verified it. `~/.hadoku/runner.env` was missing on
 * 6/6 claws two days after the version that writes it shipped, and
 * `fleet throttle --check` reported every runner wired the whole time, because
 * it read the `.env` CONTENTS and never asked whether the scripts beside it were
 * the ones this package ships.
 *
 * THE LIST BELOW IS THE DECLARATION, in the sense `json-contract.mjs` uses that
 * word. It is not documentation of the payload — the driver reads it to build
 * the payload's expectations, and the gate beside this file fails the build when
 * `ci-throttle-install.sh` writes a file that appears in neither list. That is
 * the blind spot worth gating: a fourth node-side file added to the payload with
 * no hash beside it would make `--check` cover LESS while still saying "every
 * node-side script matches", which is the same shape as a verifier reading its
 * own writer's artifact.
 *
 * BY CONTENT HASH, NOT BY A VERSION MARKER WRITTEN INTO THE FILE. A marker is a
 * declaration about bytes rather than the bytes; it says what the last editor
 * believed, and this repo has read a comment as evidence three times. It also
 * needs a single owner per file, and `job-metrics.sh` has two editors right now
 * — a marker line there would be a merge conflict every release. sha256 needs no
 * cooperation from any editor and cannot go stale.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every file the payload copies VERBATIM out of this package onto a node.
 *
 * `b64` is the variable `deploy-ci-throttle.mjs` sends it under and
 * `ci-throttle-install.sh` decodes; `summaryKey` is what the node half reports
 * its sha256 as. Both are named here so the gate can hold the three halves —
 * driver, node script, and this list — in step.
 *
 * `everyNode: false` means the manifest decides. The provisioner ships only to
 * nodes marked `ephemeral: true`, so its ABSENCE elsewhere is correct and only
 * the driver, which has the manifest, can tell absent-and-fine from absent-and-
 * broken.
 *
 * `dest` is where the node half writes the file. Everything defaults to
 * `~/.hadoku/<file>`; the one exception is the harvester's USER UNIT, because
 * the user manager only reads `~/.config/systemd/user` — a drift finding must
 * name the path that was actually hashed, or a reader hunting `~/.hadoku/`
 * finds nothing and concludes the check lied.
 */
export const NODE_SIDE_FILES = [
	{ file: 'ci-throttle.sh', b64: 'HOOK_B64', summaryKey: 'hooksha', everyNode: true },
	{ file: 'job-metrics.sh', b64: 'METRICS_B64', summaryKey: 'metricssha', everyNode: true },
	{ file: 'jit-provision.sh', b64: 'JIT_B64', summaryKey: 'jitsha', everyNode: false },
	// THE MEMORY HARVESTER (#47), sampler + unit, every node. Until 2026-09-22
	// these were hand-installed on three claws and absent from the other five,
	// and the harvest behind every memory cap on the fleet was weeks stale with
	// nothing able to see it. Shipped through this payload because it is the
	// path that already reaches every node with `job-metrics.sh`.
	// No `dest`: the sampler lands at the default `~/.hadoku/<file>`, and
	// spelling that out again would be a second copy of one path.
	{ file: 'runner-mem-harvest.py', b64: 'HARVEST_B64', summaryKey: 'harvestsha', everyNode: true },
	{
		file: 'units/runner-mem-harvest.service',
		b64: 'HARVEST_UNIT_B64',
		summaryKey: 'harvestunitsha',
		everyNode: true,
		dest: '~/.config/systemd/user/runner-mem-harvest.service',
	},
];

/**
 * What the payload writes that is NOT a copy of a shipped file, and why a hash
 * would be the wrong question for it.
 *
 * Declared rather than omitted. An empty exclusion list and a forgotten file
 * look identical from the gate's side, and "nobody wrote it down" is how a
 * deliberate decision decays into a gap nobody can date.
 */
export const RENDERED_NOT_SHIPPED = [
	{
		b64: 'CONF_B64',
		file: 'ci-throttle.conf',
		why:
			'RENDERED per node from fleet-runner-manifest.json, so there is no package ' +
			'file to hash it against. A difference means the MANIFEST moved and the node ' +
			'was never re-deployed — a real question, but a different one with a different ' +
			'fix, and folding it in would make one finding mean two things. That question is ' +
			'asked by throttleSummaryDrift (runner-env-drift.mjs), as its own finding.',
	},
];

/** sha256 of a file, as hex. The same bytes the payload base64s. */
export function sha256File(path) {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** `{ file -> sha256 }` for everything in {@link NODE_SIDE_FILES}. */
export function shippedHashes(scriptsDir) {
	return Object.fromEntries(
		NODE_SIDE_FILES.map(({ file }) => [file, sha256File(join(scriptsDir, file))])
	);
}

/**
 * One deployed file's verdict, or null when it is current.
 *
 * SAY WHY. `absent`, `unreadable` and a hash that simply differs are three
 * different jobs — a missing file needs a deploy, an unreadable one needs an
 * operator on the box, and a mismatch needs to know which version is on there.
 * Collapsing them would make the finding unactionable, which is what
 * `check-queue-health` did until 2026-09-07.
 *
 * A MISSING KEY IS NOT A MATCH. A node half older than this driver, or a run
 * that died before its SUMMARY, reports no hash at all; reading
 * `undefined === undefined` as agreement is precisely "I could not look"
 * rendering as "nothing is wrong".
 */
export function provenanceDrift(node, file, deployed, want, version, dest = `~/.hadoku/${file}`) {
	if (deployed === undefined) {
		return (
			`${node}: reported no hash for ${dest} — the node half is older than ` +
			`this driver, or the run did not reach its SUMMARY. Nothing about that file was verified`
		);
	}
	if (deployed === 'absent') {
		return `${node}: ${dest} is not deployed at all (fleet-manager ${version} ships it)`;
	}
	if (deployed === 'unreadable') {
		return `${node}: could not hash ${dest} — it is there and sha256sum could not read it`;
	}
	if (deployed !== want) {
		return (
			`${node}: ~/.hadoku/${file} is NOT the copy fleet-manager ${version} ships ` +
			`(node ${deployed.slice(0, 12)}, package ${want.slice(0, 12)}) — that node is running ` +
			`an older deploy, so anything fixed in that file since is inert there`
		);
	}
	return null;
}
