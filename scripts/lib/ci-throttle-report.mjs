/**
 * ci-throttle-report — the post-loop halves of `deploy-ci-throttle.mjs`:
 * the `--confirm` stale-listener gate's own findings, the unbounded-node
 * warning, and the `--check` gate's fix-hint printing and exit.
 *
 * Moved out of `deploy-ci-throttle.mjs` (wave shrink-1 lane D), body
 * unchanged. See that file's header for #102 (the --confirm gate) and the
 * CHECK section's own comments for each fix hint's trigger.
 */

import { maySudo, rootAdvisory } from './operator-sudo.mjs';
import { staleRemainingFindings } from './runner-env-drift.mjs';

/**
 * #102: --confirm's own gate. A node this run never reached (expectedDown,
 * or ok:false) was not acted on at all, so it has nothing to say about
 * whether a stale listener survived THIS run — that is `failed`'s and the
 * deferral note's territory, not this one's.
 *
 * The hook and the scripts under ~/.hadoku are the node user's own, so the
 * backstop gets them like any claw. Restarting a SYSTEM unit's listener is
 * root, which the fleet does not have there (`fleetHasSudo`): its
 * NEEDS-OPERATOR line is an ADVISORY naming the hand-run, never this gate's
 * failure (lib/operator-sudo.mjs).
 *
 * @param {{results: object[], allNodes: [string, object][], CONFIRM: boolean}} args
 */
export function computeConfirmGate({ results, allNodes, CONFIRM }) {
	const sudoAdvisories = [];
	const confirmRemaining = CONFIRM
		? results.flatMap((r) => {
				if (!r.ok || r.expectedDown) return [];
				const found = staleRemainingFindings({
					name: r.machine,
					staleRemaining: r.staleRemaining ?? 0,
					notes: r.notes ?? [],
				});
				if (maySudo(Object.fromEntries(allNodes)[r.machine])) return found;
				const root = found.filter((f) => / NEEDS-OPERATOR /.test(f));
				for (const f of root)
					sudoAdvisories.push(
						rootAdvisory(
							r.machine,
							`restarting a system unit's stale listener (${f})`,
							`fleet throttle --machine ${r.machine} --confirm`
						)
					);
				return found.filter((f) => !root.includes(f));
			})
		: [];
	return { confirmRemaining, sudoAdvisories };
}

/**
 * Printed on EVERY run, not only under --check: a `--confirm` that quietly
 * skipped a node is exactly as misleading as an audit that did.
 *
 * @param {string[]} unbounded
 * @returns {string} the detail string, for the caller to push onto `drift` under --check
 */
export function reportUnbounded(unbounded) {
	const detail = unbounded
		.map((n) => `${n} declares no maxConcurrent/minFreeMb, so it was NOT deployed to`)
		.join('; ');
	console.error(
		`\n✗ ${unbounded.length} declared node(s) SKIPPED: ${unbounded.join(', ')}\n` +
			'  They are in the manifest and nothing bounds them. ci-throttle.sh would fall\n' +
			'  through to MAX_CONCURRENT=99, MIN_FREE_MB=0 on a node with no numbers, so the\n' +
			'  deployer refuses rather than writing that — but a node in this state is one\n' +
			'  label away from taking work with no limit at all.\n' +
			'  Fix: set maxConcurrent and minFreeMb on each, then re-run.'
	);
	return detail;
}

/**
 * The `--confirm` stale-listener gate: a stale (written but NOT LOADED)
 * listener surviving this run is not a clean pass just because every ssh
 * round-trip succeeded.
 *
 * @param {{confirmRemaining: string[], log: (msg: string) => void}} args
 */
export function runConfirmGate({ confirmRemaining, log }) {
	if (confirmRemaining.length) {
		console.error(
			`\n✗ throttle --confirm: ${confirmRemaining.length} stale listener(s) (written but ` +
				`NOT LOADED) remain after this run:`
		);
		for (const f of confirmRemaining) console.error(`  ${f}`);
		console.error(
			'\n  A busy one is left alone on purpose — re-run this command once the job ends.\n' +
				'  Anything else (restart-failed, no-unit, needs-operator) needs attention before\n' +
				'  the next job lands on it with no concurrency limit.'
		);
		process.exit(1);
	}
	log('\n✓ no stale (written but not loaded) listener remains.');
}

/**
 * The `--check` gate: prints every finding plus the fix hint each category
 * of drift implies, and exits 1 if anything was found. Prints the success
 * line and returns otherwise.
 *
 * @param {{drift: string[], VERSION: string, PKG_ROOT: string, log: (msg: string) => void}} args
 */
export function runCheckGate({ drift, VERSION, PKG_ROOT, log }) {
	if (drift.length) {
		// `drift` counts FINDINGS, not nodes — one node can be both partly
		// wrong on disk and partly stale, and calling that "2 nodes" when there
		// is one would be the same count-instead-of-content mistake this tool's
		// messages were just fixed for.
		console.error(`\n✗ throttle drift (${drift.length} finding(s)):`);
		for (const d of drift) console.error(`  ${d}`);
		if (drift.some((d) => d.includes('wrong env on disk'))) {
			console.error(
				'\n  Fix (wrong on disk): fleet throttle --confirm\n' +
					'  A runner whose env is wrong has NO concurrency limit and cannot see the\n' +
					'  seeded tool cache — the manifest values are inert until this has run there.'
			);
		}
		if (
			drift.some(
				(d) =>
					d.includes("does not match this package's copy") || d.includes('is not deployed at all')
			)
		) {
			console.error(
				`\n  Fix (mismatched or missing node-side script): fleet throttle --confirm, run from\n` +
					`  the tree you mean. This run resolved fleet-manager ${VERSION} at\n` +
					`  ${PKG_ROOT}. A node keeps whatever was last deployed to it and publishing a\n` +
					'  fix does not move it — but a hash difference does not say which side is old,\n' +
					'  and a --confirm from the wrong checkout deploys the wrong bytes over the right\n' +
					'  ones. See docs/planning/deployed-not-published-2026-09-05.md.'
			);
		}
		if (drift.some((d) => d.includes('NOT LOADED'))) {
			console.error(
				'\n  Fix (written but not loaded): fleet throttle --confirm. For a claw this is a\n' +
					'  systemctl --user unit and needs no sudo — --confirm stops it if idle (the warm\n' +
					'  pass or the unit itself then refills it) and leaves a busy one alone, reported.\n' +
					'  A node without passwordless sudo needs an operator to restart a stale\n' +
					'  listener by hand.'
			);
		}
		process.exit(1);
	}
	// The PATH, not just the version. A green line naming only a version is the
	// same claim from either of the four trees; naming the one that answered is
	// what makes it checkable.
	log(
		`✓ every runner on every node is wired to the throttle, every node has the ` +
			`standing-runner env, and every node-side script matches fleet-manager ` +
			`${VERSION} at ${PKG_ROOT}.`
	);
}
