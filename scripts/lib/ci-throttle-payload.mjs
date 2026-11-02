/**
 * ci-throttle-payload — builds the node-side install payload
 * (`remotePayload`) and judges one deployed file's provenance against this
 * package's own copy (`fileDrift`).
 *
 * Moved out of `deploy-ci-throttle.mjs` (wave shrink-1 lane D), body
 * unchanged. `renderConf`/`resolveReserveFile` stay in that file:
 * `ci-throttle-deployer.test.mjs` extracts them by searching the CLI's own
 * source text for `function <name>(`, so moving them would break that
 * extraction rather than the behavior it tests.
 */

import { readFileSync } from 'node:fs';
import { provenanceDrift } from './script-provenance.mjs';

/**
 * Ship the node-side script with its inputs.
 *
 * The remote half lives in ci-throttle-install.sh — a REAL file, not a template
 * literal. Embedding it in one cost three separate parse failures (an octal
 * escape, a JS interpolation, and a backtick in a comment that ended the string)
 * and none of them were shell bugs; they broke the .mjs itself. Inputs are
 * prepended as plain variable assignments so nothing has to be substituted into
 * the script text at all.
 *
 * @param {{hook: string, conf: string, apply: boolean, restart: boolean,
 *   ephemeral: boolean, metricsSrc: string, harvestSrc: string,
 *   harvestUnitSrc: string, toolcacheRule: string, installSrc: string,
 *   standingEnvRule: string}} args
 */
export function remotePayload({
	hook,
	conf,
	apply,
	restart,
	ephemeral,
	metricsSrc,
	harvestSrc,
	harvestUnitSrc,
	toolcacheRule,
	installSrc,
	standingEnvRule,
}) {
	const b64 = (v) => Buffer.from(v, 'utf8').toString('base64');
	const preamble = [
		`APPLY=${apply ? 1 : 0}`,
		`RESTART=${restart ? 1 : 0}`,
		`HOOK_B64=${b64(hook)}`,
		`CONF_B64=${b64(conf)}`,
		// A node that mints gets runner.env for its slots. The minters themselves
		// are not shipped: they travel with each mint (src/runners/node-script.ts).
		`MINTS=${ephemeral ? 1 : 0}`,
		// Shipped to EVERY node. A standing runner and a
		// JIT slot both complete jobs, and the memory question is asked of the
		// whole fleet — a hook present on only half of it would produce a
		// comparison between measured and unmeasured boxes, which is the shape
		// of every bad conclusion in this repo's history.
		`METRICS_B64=${b64(readFileSync(metricsSrc, 'utf8'))}`,
		// The sampler behind that hook, plus the user unit that runs it. Same
		// every-node rule and for the same reason: a memory distribution sized
		// from half the fleet is not a distribution, and the 2026-09-22 finding
		// was that five of nine nodes had no sampler at all while every cap on
		// them was being set from data that no longer existed.
		`HARVEST_B64=${b64(readFileSync(harvestSrc, 'utf8'))}`,
		`HARVEST_UNIT_B64=${b64(readFileSync(harvestUnitSrc, 'utf8'))}`,
		'',
	].join('\n');
	// The tool-cache rule is PREPENDED as shell, not passed as a value: the
	// answer depends on `id -un` ON THE NODE, and this driver does not know
	// which user a given runner runs as. Deciding it here would reintroduce
	// exactly the hardcoding that made fix-runner-tool-cache.sh dangerous.
	return (
		preamble +
		readFileSync(toolcacheRule, 'utf8') +
		readFileSync(installSrc, 'utf8') +
		// APPENDED, not prepended: it publishes `$LINE`/`$TCLINE`/`$MLINE`, which
		// the node half derives, so it has to run after them. It emits its own
		// STANDING-ENV line rather than joining the SUMMARY, because SUMMARY is
		// already printed by the time it runs.
		readFileSync(standingEnvRule, 'utf8')
	);
}

/**
 * One deployed file's verdict — issue #13.
 *
 * TWO HASHES DIFFERING SAYS NOTHING ABOUT WHICH ONE IS OLD. The message this
 * replaced ended `— that node is running an older deploy, so anything fixed in
 * that file since is inert there`, which is a CONCLUSION from evidence that
 * cannot support it: a sha256 mismatch is equally consistent with the node being
 * behind, with the node being AHEAD (a newer deploy from another checkout), and
 * with this process having resolved the wrong package entirely — the four-trees
 * problem, which is the single most expensive mistake in this repo's history
 * (docs/planning/deployed-not-published-2026-09-05.md, six correct-and-inert
 * fixes). An operator who read "that node is stale" went and re-deployed from
 * the tree that was itself the stale one.
 *
 * So: say the two hashes DIFFER, name both, and name the package this run
 * resolved — version AND path — so the reader can settle which side is old from
 * facts rather than from this tool's assumption. The three cases that genuinely
 * ARE one-sided (no hash reported, absent, unreadable) still come from
 * `provenanceDrift`, because for those the evidence does support the verdict.
 *
 * @param {{version: string, pkgRoot: string}} provenance this run's own version/path
 */
export function fileDrift(node, file, deployed, want, provenance, dest = `~/.hadoku/${file}`) {
	if (deployed !== undefined && deployed !== 'absent' && deployed !== 'unreadable') {
		if (deployed === want) return null;
		return (
			`${node}: ${dest} does not match this package's copy ` +
			`(node ${deployed}, package ${want}). ` +
			`This run resolved fleet-manager ${provenance.version} at ${provenance.pkgRoot}. ` +
			`Which side is stale is NOT known from a hash difference — check that path is ` +
			`the tree you meant before deploying over the node`
		);
	}
	return provenanceDrift(node, file, deployed, want, provenance.version, dest);
}
