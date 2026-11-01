/**
 * `fleet bootcamp`'s PASS 1 orchestration — split out of scripts/bootcamp.mjs
 * (wave 5p lane D) so the CLI stays under the 800-line ceiling.
 *
 * `probe` and `ensureTools` THEMSELVES STAY IN THE CLI FILE, not here: they
 * are the two places bootcamp calls `runOn`, and
 * `scripts/lib/expected-down-guard.test.mjs` scans only top-level
 * `scripts/*.mjs` files for that pairing with `deferralFor` — moving the
 * `runOn` call into a `scripts/lib/**` module would silently drop bootcamp
 * out of that guard's scan rather than satisfy it. This module takes both
 * functions through `ctx`, never importing the CLI.
 */

/**
 * PASS 1 — every node at once, exactly as before: install, then probe.
 *
 * BEFORE THE PROBE, so what the probe executes is what the node now has —
 * except under --check-only, where nothing is installed.
 */
export async function runPass1(ctx) {
	const { nodes, CHECK_ONLY, toolResults, probed, unreachable, log, ensureTools, probe } = ctx;
	await Promise.all(
		nodes.map(async ([name, m]) => {
			// BEFORE THE PROBE, so what the probe executes is what the node now has —
			// except under --check-only, where nothing is installed.
			if (CHECK_ONLY) {
				toolResults[name] = [];
				log(`── ${name}  --check-only: nothing will be installed or seeded`);
			} else {
				toolResults[name] = await ensureTools(name, m);
			}
			const got = await probe(name);
			if (got === null) {
				unreachable.push(name);
				return;
			}
			probed[name] = got;
		})
	);
}
