/**
 * THE LAYER MAP — every non-test source file's place in the target shape
 * (refactor plan 2026-10-28 §3.1–§3.5), as DATA.
 *
 * This file decides nothing by itself. `measure-layers.mjs` reads it to walk
 * the real import graph and count violations for four candidate cuts;
 * `layer-guard.test.mjs` reads it (through `measure-layers.mjs`) to fail a
 * NEW violation; and `--table` regenerates plan §3.5 from it, so the doc
 * cannot drift from what the guard enforces — the same derive-don't-copy rule
 * `json-contract.mjs` already follows for cron jobs.
 *
 * SCOPE: `.ts` and `.mjs` files under `src/`, `scripts/`, and `scripts/lib/`
 * only, excluding tests (`*.test.ts`, `*.test.mjs`, everything under
 * `src/tests/`). `.sh`, `.py` and `.json` files have no ES import graph for
 * `measure-layers.mjs` to walk, so they are out of scope for this
 * measurement; "the map is total" is a claim about the file set
 * `measure-layers.mjs` actually enumerates (see `listSourceFiles()` there),
 * not about every file in these three directories. A `.sh`/`.py` onboarding
 * script is still real lifecycle-domain content — it is just not MEASURED
 * here, because there is no import statement to read.
 *
 * SEVEN LAYERS. Only the `domain` layer carries `domain` (lifecycle |
 * ci-scheduling | tenancy | observation) and `part` (core | run — core is a
 * pure decision, run is the I/O around it). The other six layers
 * (composition, surfaces, automation, state, access, config) are FLAT: the
 * plan's diagram (§3.1) draws them as single bands, with no per-domain
 * subdivision, so a state ledger or an access reader carries no domain tag
 * even when its CONTENT is domain-specific (job-history's rolling window is
 * ci-scheduling's data, but the state layer is where every domain's runtime
 * records live — rule 3 of §3.2).
 *
 * HOW A FILE WAS PLACED, IN ORDER OF AUTHORITY:
 *   1. Plan §3.5's own "today" column, where it names the file explicitly.
 *      `src/runners/census.ts` is listed under OBSERVATION there even though
 *      `src/runners/*` is also named under CI-SCHEDULING — the specific
 *      listing wins over the directory-level one, which is exactly why this
 *      map uses ORDERED entries rather than one glob per directory.
 *   2. Plan §3.2's placement rule, applied by hand where §3.5 is silent:
 *      declarative input → config; another system's data → access; this
 *      package's own runtime record (one declared writer, something else
 *      reads it back) → state, REGARDLESS of which domain the record is
 *      about; a decision → a domain's core; the I/O around that decision →
 *      the same domain's run; a converger's repair logic stays in its domain,
 *      the generic scheduling/paging machinery it plugs into is automation.
 *   3. Where neither says anything (a handful of generic, domain-blind
 *      utilities — `concurrency.ts`, `stdin.mjs`, `blank-comments.mjs`,
 *      `emit.mjs`, `yaml-comments.mjs`, the two usage-log halves, the two
 *      test-identity helpers, `f-guards/lib.mjs`) they are filed under
 *      `automation` as the least-wrong flat layer, since automation's own
 *      definition ("job runner, scheduler, pager ledger, report shapes") is
 *      already the plan's bucket for generic cross-cutting mechanics. This is
 *      a judgment call, named here rather than hidden: a later wave may want
 *      a dedicated layer for domain-blind utilities instead of folding them
 *      into automation.
 *
 * A FEW DELIBERATE DEPARTURES FROM A LITERAL READING OF SRC/RUNNERS/* AS
 * "CI-SCHEDULING": `drain.ts`, `hosting-record.ts`, `backstop-force.ts`,
 * `backstop-hold.ts`, `capacity-ledger.ts`, `dispatch-daily.ts`,
 * `schedulable.ts` and `decision-log.ts` are each "the one state file with a
 * declared writer, read back by something else" shape — the STATE pattern
 * rule 3 describes — so they are classified `state`, not `ci-scheduling`,
 * even though §3.5's blanket "ci-scheduling: src/runners/*" line would put
 * them there. `prove-job.ts` is `lifecycle` per §3.5's own misplacement note
 * ("sits in runners/ but is an operator library"). `host-lease.ts` is kept
 * under `tenancy` because §3.5 names it there explicitly ("host-lease
 * (actually pm2-host reservation)") even though its shape also resembles a
 * state record — the explicit listing is followed rather than second-guessed.
 *
 * `node-reservation.ts` (ci-scheduling) importing `host-lease.ts` (tenancy)
 * directly, rather than through a state record, is exactly the rule-5
 * violation §3.2 describes ("a domain reads another domain's facts through a
 * state record") — left in place on purpose, as a real finding for the
 * measurement to surface, not fixed here (this wave MEASURES, it does not
 * move code).
 */

/** @typedef {'composition'|'surfaces'|'domain'|'automation'|'state'|'access'|'config'} Layer */
/** @typedef {'lifecycle'|'ci-scheduling'|'tenancy'|'observation'} Domain */
/** @typedef {'core'|'run'} Part */

export const LAYERS = Object.freeze([
	'composition',
	'surfaces',
	'domain',
	'automation',
	'state',
	'access',
	'config',
]);

export const DOMAINS = Object.freeze(['lifecycle', 'ci-scheduling', 'tenancy', 'observation']);

export const PARTS = Object.freeze(['core', 'run']);

/**
 * One entry per glob. FIRST MATCH WINS, which is why the specific files named
 * in plan §3.5 (census.ts, drain.ts, hosting-record.ts, prove-job.ts, …) are
 * listed ahead of any directory-level glob that would otherwise catch them.
 * A glob is either an exact relative path, or may use `*` (any run of
 * characters except `/`) and `**` (any run of characters including `/`).
 *
 * @type {Array<{glob: string, layer: Layer, domain?: Domain, part?: Part}>}
 */
export const LAYER_MAP = [
	// ---------------------------------------------------------------- state
	// "One declared writer, read back by something else" — rule 3 of §3.2 —
	// regardless of which domain the record is about. Listed first because
	// several of these sit under src/runners/, which a later glob also claims
	// for ci-scheduling.
	{ glob: 'src/runners/drain.ts', layer: 'state' },
	{ glob: 'src/runners/hosting-record.ts', layer: 'state' },
	{ glob: 'src/runners/backstop-force.ts', layer: 'state' },
	{ glob: 'src/runners/backstop-hold.ts', layer: 'state' },
	{ glob: 'src/runners/capacity-ledger.ts', layer: 'state' },
	{ glob: 'src/runners/dispatch-daily.ts', layer: 'state' },
	{ glob: 'src/runners/schedulable.ts', layer: 'state' },
	{ glob: 'src/runners/decision-log.ts', layer: 'state' },
	{ glob: 'src/capability-revocations.ts', layer: 'state' },
	{ glob: 'src/lib/measured.ts', layer: 'state' },
	{ glob: 'src/job-history.ts', layer: 'state' }, // store part; see the analytics-part note below
	{ glob: 'src/job-rollup-store.ts', layer: 'state' },
	{ glob: 'scripts/lib/enrollment-record.mjs', layer: 'state' },
	{ glob: 'scripts/lib/job-proof-record.mjs', layer: 'state' },

	// ------------------------------------------------------------- composition
	{ glob: 'src/index.ts', layer: 'composition' },
	{ glob: 'src/host.ts', layer: 'composition' },
	{ glob: 'src/standalone.ts', layer: 'composition' },
	{ glob: 'src/serve.ts', layer: 'composition' },

	// ---------------------------------------------------------------- surfaces
	{ glob: 'src/cli.ts', layer: 'surfaces' },
	{ glob: 'src/server.ts', layer: 'surfaces' },
	{ glob: 'src/routes/fleet.ts', layer: 'surfaces' },
	{ glob: 'src/fleet-report-types.ts', layer: 'surfaces' },
	{ glob: 'src/telemetry-vocabulary.ts', layer: 'surfaces' },
	// herdr/ plugin support: physically under scripts/lib, but it IS the
	// surfaces-layer herdr door (plan §3.5: "surfaces: … herdr/").
	{ glob: 'scripts/lib/herdr-fleet.mjs', layer: 'surfaces' },
	{ glob: 'scripts/lib/herdr-fleet-freshness.mjs', layer: 'surfaces' },
	{ glob: 'scripts/lib/herdr-pm2.mjs', layer: 'surfaces' },

	// ------------------------------------------------------------- automation
	{ glob: 'src/scheduled-converger.ts', layer: 'automation' },
	{ glob: 'src/claw-reboot.ts', layer: 'automation' },
	{ glob: 'src/lib/concurrency.ts', layer: 'automation' },
	{ glob: 'src/lib/usage-log.ts', layer: 'automation' },
	{ glob: 'src/lib/usage-store.ts', layer: 'automation' },
	{ glob: 'scripts/fleet-usage.mjs', layer: 'automation' },
	{ glob: 'scripts/lib/emit.mjs', layer: 'automation' },
	{ glob: 'scripts/lib/blank-comments.mjs', layer: 'automation' },
	{ glob: 'scripts/lib/yaml-comments.mjs', layer: 'automation' },
	{ glob: 'scripts/lib/stdin.mjs', layer: 'automation' },
	{ glob: 'scripts/lib/test-git-identity.mjs', layer: 'automation' },
	{ glob: 'scripts/lib/test-tmpdir.mjs', layer: 'automation' },
	// Lane D's shared debt-list mechanics for the F-item guards: the same
	// "generic, domain-blind, cross-cutting" shape as blank-comments.mjs.
	{ glob: 'scripts/lib/f-guards/*.mjs', layer: 'automation' },

	// -------------------------------------------------------------------- access
	{ glob: 'src/lib/node-identity.ts', layer: 'access' },
	{ glob: 'src/lib/node-users.ts', layer: 'access' },
	{ glob: 'src/node-shell.ts', layer: 'access' },
	{ glob: 'src/gh-budget.ts', layer: 'access' },
	{ glob: 'src/conditional-cache-store.ts', layer: 'access' },
	{ glob: 'scripts/lib/fleet-exec.mjs', layer: 'access' },
	{ glob: 'scripts/fleet-source.mjs', layer: 'access' },
	{ glob: 'scripts/lib/fleet-source.mjs', layer: 'access' },
	{ glob: 'scripts/lib/fleet-source-fixture.mjs', layer: 'access' },
	{ glob: 'scripts/lib/fake-node.mjs', layer: 'access' },
	{ glob: 'scripts/lib/gh-app.mjs', layer: 'access' },
	{ glob: 'scripts/lib/gh-reserve.mjs', layer: 'access' },
	{ glob: 'scripts/lib/sibling-repos.mjs', layer: 'access' },
	{ glob: 'scripts/lib/service-tunnels.mjs', layer: 'access' },
	{ glob: 'scripts/lib/session-index.mjs', layer: 'access' },
	{ glob: 'scripts/lib/spawn-json.mjs', layer: 'access' },
	{ glob: 'scripts/lib/run-fleet-script.mjs', layer: 'access' },
	{ glob: 'scripts/lib/node-users-facet.mjs', layer: 'access' },
	{ glob: 'scripts/node-users.mjs', layer: 'access' },
	// Commits a manifest edit onto hadoku_site's main — another system's repo.
	{ glob: 'scripts/lib/manifest-target.mjs', layer: 'access' },

	// -------------------------------------------------------------------- config
	{ glob: 'src/capabilities.ts', layer: 'config' }, // registry part; see the decision note below
	{ glob: 'src/lib/fleet-config.ts', layer: 'config' },
	{ glob: 'src/lib/fleet-paths.ts', layer: 'config' },
	{ glob: 'src/lib/node-role.ts', layer: 'config' },
	{ glob: 'src/lib/provenance.ts', layer: 'config' },
	{ glob: 'scripts/lib/json-contract.mjs', layer: 'config' },
	{ glob: 'scripts/lib/node-profiles.mjs', layer: 'config' },
	{ glob: 'scripts/lib/tenant-registry.mjs', layer: 'config' },
	{ glob: 'scripts/lib/toolchain-floor.mjs', layer: 'config' },
	{ glob: 'scripts/lib/paths.mjs', layer: 'config' },
	{ glob: 'scripts/lib/fleet-roster.mjs', layer: 'config' },
	{ glob: 'scripts/lib/capability-seeds.mjs', layer: 'config' },
	{ glob: 'scripts/lib/prettier-json.mjs', layer: 'config' },
	{ glob: 'scripts/lib/script-provenance.mjs', layer: 'config' },
	{ glob: 'scripts/lib/site-token.mjs', layer: 'config' },
	{ glob: 'scripts/version-bump.mjs', layer: 'config' },
	// This file and measure-layers.mjs are themselves DATA/measurement about
	// the target shape — config is the layer for the package's own
	// declarative inputs, which this is.
	{ glob: 'scripts/lib/layer-map.mjs', layer: 'config' },

	// ----------------------------------------------------------- domain: lifecycle
	{ glob: 'src/runners/prove-job.ts', layer: 'domain', domain: 'lifecycle', part: 'run' },
	{ glob: 'src/provisioning-converge.ts', layer: 'domain', domain: 'lifecycle', part: 'run' },
	{ glob: 'scripts/bootcamp.mjs', layer: 'domain', domain: 'lifecycle', part: 'run' },
	{ glob: 'scripts/provision-fleet.mjs', layer: 'domain', domain: 'lifecycle', part: 'run' },
	{ glob: 'scripts/converge-provisioning.mjs', layer: 'domain', domain: 'lifecycle', part: 'run' },
	{ glob: 'scripts/converge-toolchain.mjs', layer: 'domain', domain: 'lifecycle', part: 'run' },
	{ glob: 'scripts/reboot-claws.mjs', layer: 'domain', domain: 'lifecycle', part: 'run' },
	{ glob: 'scripts/drain-node.mjs', layer: 'domain', domain: 'lifecycle', part: 'run' },
	{ glob: 'scripts/enroll-node.mjs', layer: 'domain', domain: 'lifecycle', part: 'run' },
	{ glob: 'scripts/lan-reserve.mjs', layer: 'domain', domain: 'lifecycle', part: 'run' },
	{ glob: 'scripts/prove-job.mjs', layer: 'domain', domain: 'lifecycle', part: 'run' },
	{
		glob: 'scripts/reconcile-fleet-runners.mjs',
		layer: 'domain',
		domain: 'lifecycle',
		part: 'run',
	},
	{ glob: 'scripts/seed-node-cache.mjs', layer: 'domain', domain: 'lifecycle', part: 'run' },
	{ glob: 'scripts/seed-runner-python.mjs', layer: 'domain', domain: 'lifecycle', part: 'run' },
	{ glob: 'scripts/toolpack.mjs', layer: 'domain', domain: 'lifecycle', part: 'run' },
	{ glob: 'scripts/clean-runner-debris.mjs', layer: 'domain', domain: 'lifecycle', part: 'run' },
	{ glob: 'scripts/deploy-ci-throttle.mjs', layer: 'domain', domain: 'lifecycle', part: 'run' },
	{ glob: 'scripts/deploy-runners-slice.mjs', layer: 'domain', domain: 'lifecycle', part: 'run' },
	{ glob: 'scripts/apt-security.mjs', layer: 'domain', domain: 'lifecycle', part: 'run' },
	{ glob: 'scripts/node-users-cutover.mjs', layer: 'domain', domain: 'lifecycle', part: 'run' },
	{ glob: 'scripts/lib/apt-security.mjs', layer: 'domain', domain: 'lifecycle', part: 'core' },
	{ glob: 'scripts/lib/idle-measure.mjs', layer: 'domain', domain: 'lifecycle', part: 'run' },
	{ glob: 'scripts/lib/node-interfaces.mjs', layer: 'domain', domain: 'lifecycle', part: 'core' },
	{ glob: 'scripts/lib/node-users-cutover.mjs', layer: 'domain', domain: 'lifecycle', part: 'run' },
	{ glob: 'scripts/lib/probe-script.mjs', layer: 'domain', domain: 'lifecycle', part: 'core' },
	{ glob: 'scripts/lib/proof-drain.mjs', layer: 'domain', domain: 'lifecycle', part: 'core' },
	{ glob: 'scripts/lib/prove-job-guest.mjs', layer: 'domain', domain: 'lifecycle', part: 'run' },
	{
		glob: 'scripts/lib/provisioning-converge.mjs',
		layer: 'domain',
		domain: 'lifecycle',
		part: 'run',
	},
	{ glob: 'scripts/lib/reboot-cycle.mjs', layer: 'domain', domain: 'lifecycle', part: 'core' },
	{ glob: 'scripts/lib/refresh-cycle.mjs', layer: 'domain', domain: 'lifecycle', part: 'core' },
	{
		glob: 'scripts/lib/roster-eligibility.mjs',
		layer: 'domain',
		domain: 'lifecycle',
		part: 'core',
	},
	{
		glob: 'scripts/lib/slice-inventory-run.mjs',
		layer: 'domain',
		domain: 'lifecycle',
		part: 'run',
	},
	{ glob: 'scripts/lib/slice-split.mjs', layer: 'domain', domain: 'lifecycle', part: 'run' },
	{ glob: 'scripts/lib/tool-caches.mjs', layer: 'domain', domain: 'lifecycle', part: 'core' },
	{ glob: 'scripts/lib/toolpack-rules.mjs', layer: 'domain', domain: 'lifecycle', part: 'core' },
	{ glob: 'scripts/lib/tool-release.mjs', layer: 'domain', domain: 'lifecycle', part: 'core' },

	// --------------------------------------------------------- domain: ci-scheduling
	{ glob: 'src/fleet-loop.ts', layer: 'domain', domain: 'ci-scheduling', part: 'run' },
	{ glob: 'src/ci-runner-fallback.ts', layer: 'domain', domain: 'ci-scheduling', part: 'run' },
	{ glob: 'src/node-reservation.ts', layer: 'domain', domain: 'ci-scheduling', part: 'run' },
	{ glob: 'src/runners/backstop.ts', layer: 'domain', domain: 'ci-scheduling', part: 'core' },
	{ glob: 'src/runners/dispatcher.ts', layer: 'domain', domain: 'ci-scheduling', part: 'core' },
	{ glob: 'src/runners/dispatch-pass.ts', layer: 'domain', domain: 'ci-scheduling', part: 'run' },
	{ glob: 'src/runners/dispatch-tick.ts', layer: 'domain', domain: 'ci-scheduling', part: 'run' },
	{ glob: 'src/runners/ephemeral.ts', layer: 'domain', domain: 'ci-scheduling', part: 'core' },
	{ glob: 'src/runners/ephemeral-exec.ts', layer: 'domain', domain: 'ci-scheduling', part: 'run' },
	{ glob: 'src/runners/ephemeral-tick.ts', layer: 'domain', domain: 'ci-scheduling', part: 'run' },
	{ glob: 'src/runners/node-script.ts', layer: 'domain', domain: 'ci-scheduling', part: 'run' },
	{ glob: 'src/runners/placement.ts', layer: 'domain', domain: 'ci-scheduling', part: 'core' },
	{
		glob: 'src/runners/queue-discovery.ts',
		layer: 'domain',
		domain: 'ci-scheduling',
		part: 'core',
	},
	{ glob: 'src/runners/speed-tier.ts', layer: 'domain', domain: 'ci-scheduling', part: 'core' },
	{ glob: 'src/runners/traffic.ts', layer: 'domain', domain: 'ci-scheduling', part: 'core' },
	{ glob: 'src/lib/job-kind.ts', layer: 'domain', domain: 'ci-scheduling', part: 'core' },
	{ glob: 'scripts/backstop-switch.mjs', layer: 'domain', domain: 'ci-scheduling', part: 'run' },
	{ glob: 'scripts/fleet-decisions.mjs', layer: 'domain', domain: 'ci-scheduling', part: 'run' },
	{ glob: 'scripts/fleet-inventory.mjs', layer: 'domain', domain: 'ci-scheduling', part: 'run' },
	{ glob: 'scripts/traffic-status.mjs', layer: 'domain', domain: 'ci-scheduling', part: 'run' },
	{
		glob: 'scripts/lib/fleet-inventory.mjs',
		layer: 'domain',
		domain: 'ci-scheduling',
		part: 'core',
	},
	{ glob: 'scripts/lib/floor-probe.mjs', layer: 'domain', domain: 'ci-scheduling', part: 'core' },
	{ glob: 'scripts/floor-probe.mjs', layer: 'domain', domain: 'ci-scheduling', part: 'run' },
	{
		glob: 'scripts/lib/placement-rules.mjs',
		layer: 'domain',
		domain: 'ci-scheduling',
		part: 'core',
	},
	{ glob: 'scripts/lib/runner-var.mjs', layer: 'domain', domain: 'ci-scheduling', part: 'core' },
	// §3.5's own blanket line: everything else left under src/runners/* that
	// is not named individually above (and not already carved to `state` or
	// `observation` elsewhere in this file) is ci-scheduling's run half.

	// -------------------------------------------------------------- domain: tenancy
	{ glob: 'src/host-lease.ts', layer: 'domain', domain: 'tenancy', part: 'run' }, // §3.5 names it here explicitly, despite the state-record shape
	{ glob: 'src/hosting-converge.ts', layer: 'domain', domain: 'tenancy', part: 'run' },
	{ glob: 'scripts/hosting.mjs', layer: 'domain', domain: 'tenancy', part: 'run' },
	{ glob: 'scripts/hosting-converge.mjs', layer: 'domain', domain: 'tenancy', part: 'run' },
	{ glob: 'scripts/hosting-demand.mjs', layer: 'domain', domain: 'tenancy', part: 'run' },
	{ glob: 'scripts/hosting-offers.mjs', layer: 'domain', domain: 'tenancy', part: 'run' },
	{ glob: 'scripts/hosting-plan.mjs', layer: 'domain', domain: 'tenancy', part: 'run' },
	{ glob: 'scripts/hosting-request.mjs', layer: 'domain', domain: 'tenancy', part: 'run' },
	{ glob: 'scripts/node-status.mjs', layer: 'domain', domain: 'tenancy', part: 'run' },
	{ glob: 'scripts/service-inventory.mjs', layer: 'domain', domain: 'tenancy', part: 'run' },
	{ glob: 'scripts/lib/hosting.mjs', layer: 'domain', domain: 'tenancy', part: 'core' },
	{ glob: 'scripts/lib/hosting-converge.mjs', layer: 'domain', domain: 'tenancy', part: 'core' },
	{ glob: 'scripts/lib/hosting-demand.mjs', layer: 'domain', domain: 'tenancy', part: 'core' },
	{ glob: 'scripts/lib/hosting-offers.mjs', layer: 'domain', domain: 'tenancy', part: 'core' },
	{ glob: 'scripts/lib/hosting-plan.mjs', layer: 'domain', domain: 'tenancy', part: 'core' },
	{ glob: 'scripts/lib/hosting-request.mjs', layer: 'domain', domain: 'tenancy', part: 'core' },
	{ glob: 'scripts/lib/hosting-artifacts.mjs', layer: 'domain', domain: 'tenancy', part: 'core' },
	{ glob: 'scripts/lib/hosting-claims.mjs', layer: 'domain', domain: 'tenancy', part: 'core' },
	{ glob: 'scripts/lib/hosting-placement.mjs', layer: 'domain', domain: 'tenancy', part: 'core' },
	{ glob: 'scripts/lib/hosting-runtimes.mjs', layer: 'domain', domain: 'tenancy', part: 'core' },
	{ glob: 'scripts/lib/collect-offers.mjs', layer: 'domain', domain: 'tenancy', part: 'run' },
	{ glob: 'scripts/lib/service-inventory.mjs', layer: 'domain', domain: 'tenancy', part: 'run' },
	{ glob: 'scripts/lib/service-peers.mjs', layer: 'domain', domain: 'tenancy', part: 'core' },

	// ----------------------------------------------------------- domain: observation
	{ glob: 'src/runners/census.ts', layer: 'domain', domain: 'observation', part: 'core' }, // §3.5 names this under observation despite the ci-scheduling directory
	{ glob: 'src/runner-health.ts', layer: 'domain', domain: 'observation', part: 'run' },
	{ glob: 'src/runner-supervision.ts', layer: 'domain', domain: 'observation', part: 'run' },
	{ glob: 'src/ci-alerts.ts', layer: 'domain', domain: 'observation', part: 'run' },
	{ glob: 'src/label-floor.ts', layer: 'domain', domain: 'observation', part: 'core' },
	{ glob: 'src/job-rollups.ts', layer: 'domain', domain: 'observation', part: 'run' },
	{ glob: 'src/run-listing-gap.ts', layer: 'domain', domain: 'observation', part: 'run' },
	{ glob: 'src/runners/claw-state.ts', layer: 'domain', domain: 'observation', part: 'core' },
	{ glob: 'src/runners/disk-watch.ts', layer: 'domain', domain: 'observation', part: 'run' },
	{ glob: 'src/runners/node-regression.ts', layer: 'domain', domain: 'observation', part: 'run' },
	{ glob: 'scripts/measure-layers.mjs', layer: 'domain', domain: 'observation', part: 'run' },
	{
		glob: 'scripts/backfill-failed-steps.mjs',
		layer: 'domain',
		domain: 'observation',
		part: 'run',
	},
	{ glob: 'scripts/benchmark-fleet.mjs', layer: 'domain', domain: 'observation', part: 'run' },
	{ glob: 'scripts/ci-watch.mjs', layer: 'domain', domain: 'observation', part: 'run' },
	{ glob: 'scripts/collect-job-metrics.mjs', layer: 'domain', domain: 'observation', part: 'run' },
	{ glob: 'scripts/job-rollups.mjs', layer: 'domain', domain: 'observation', part: 'run' },
	{
		glob: 'scripts/join-workload-benchmark.mjs',
		layer: 'domain',
		domain: 'observation',
		part: 'run',
	},
	{
		glob: 'scripts/reconcile-runner-identity.mjs',
		layer: 'domain',
		domain: 'observation',
		part: 'run',
	},
	// Lane D's split-check (plan §4.1 step 1, §10): a repo-hygiene review tool
	// in the same bucket as check-exports.mjs/check-version-ahead.mjs below —
	// it audits a DIFF, not fleet state, but "observation: check-*" is this
	// map's home for exactly that shape of meta/repo-tooling script.
	{ glob: 'scripts/split-check.mjs', layer: 'domain', domain: 'observation', part: 'run' },
	{
		glob: 'scripts/lib/bootcamp-required.mjs',
		layer: 'domain',
		domain: 'observation',
		part: 'core',
	},
	{
		glob: 'scripts/lib/ci-watch-jobnames.mjs',
		layer: 'domain',
		domain: 'observation',
		part: 'core',
	},
	{ glob: 'scripts/lib/demand-derive.mjs', layer: 'domain', domain: 'observation', part: 'core' },
	{ glob: 'scripts/lib/doctor.mjs', layer: 'domain', domain: 'observation', part: 'core' },
	{ glob: 'scripts/lib/doctor-run.mjs', layer: 'domain', domain: 'observation', part: 'run' },
	{
		glob: 'scripts/lib/drain-enforcement.mjs',
		layer: 'domain',
		domain: 'observation',
		part: 'core',
	},
	{ glob: 'scripts/lib/expected-down.mjs', layer: 'domain', domain: 'observation', part: 'core' },
	{ glob: 'scripts/lib/job-metrics.mjs', layer: 'domain', domain: 'observation', part: 'core' },
	{ glob: 'scripts/lib/mf-built.mjs', layer: 'domain', domain: 'observation', part: 'core' },
	{ glob: 'scripts/lib/preflight.mjs', layer: 'domain', domain: 'observation', part: 'run' },
	{ glob: 'scripts/lib/queue-health.mjs', layer: 'domain', domain: 'observation', part: 'core' },
	{ glob: 'scripts/lib/reap-trend.mjs', layer: 'domain', domain: 'observation', part: 'core' },
	{
		glob: 'scripts/lib/runner-env-drift.mjs',
		layer: 'domain',
		domain: 'observation',
		part: 'core',
	},
	{
		glob: 'scripts/lib/runner-unit-audit.mjs',
		layer: 'domain',
		domain: 'observation',
		part: 'run',
	},
	{ glob: 'scripts/lib/runs-on-demand.mjs', layer: 'domain', domain: 'observation', part: 'core' },
	{ glob: 'scripts/lib/slice-summary.mjs', layer: 'domain', domain: 'observation', part: 'run' },
	{ glob: 'scripts/lib/srv-drift.mjs', layer: 'domain', domain: 'observation', part: 'core' },
	{ glob: 'scripts/lib/tier-detectors.mjs', layer: 'domain', domain: 'observation', part: 'core' },
	{ glob: 'scripts/lib/warm-canary.mjs', layer: 'domain', domain: 'observation', part: 'core' },

	// Directory-level fallbacks, LAST: everything under src/runners/* or
	// scripts/check-*.mjs not named explicitly above falls through to these.
	// Because matching is a single ordered pass (first match in this array
	// wins), every specific override for a runners/* or check-*.mjs file
	// above MUST stay ahead of its catch-all here.
	{ glob: 'src/runners/*.ts', layer: 'domain', domain: 'ci-scheduling', part: 'run' },
	{ glob: 'scripts/check-*.mjs', layer: 'domain', domain: 'observation', part: 'run' },
];

/** Escape every regex metacharacter except the glob's own `*`. */
function globToRegExp(glob) {
	let out = '';
	for (let i = 0; i < glob.length;) {
		if (glob.slice(i, i + 2) === '**') {
			out += '.*';
			i += 2;
			continue;
		}
		const c = glob[i];
		if (c === '*') {
			out += '[^/]*';
		} else {
			out += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
		}
		i += 1;
	}
	return new RegExp(`^${out}$`);
}

const compiled = LAYER_MAP.map((entry) => ({
	entry,
	exact: !entry.glob.includes('*'),
	re: entry.glob.includes('*') ? globToRegExp(entry.glob) : undefined,
}));

/**
 * The FIRST entry whose glob matches `relPath` (posix-separated, relative to
 * the repo root, e.g. `src/runners/census.ts`), or `undefined` if nothing
 * matches — the caller (`measure-layers.mjs`) turns that into a test failure,
 * because the map is meant to be total over the files it enumerates.
 *
 * ONE ORDERED PASS, exactly as declared in `LAYER_MAP` above — "first match
 * wins" over the single list, with no special-casing of exact entries over
 * wildcards. That is why every per-file override in this module is written
 * ahead of the directory-level catch-alls (`src/runners/*.ts`,
 * `scripts/check-*.mjs`) at the end of the array: a single ordered pass would
 * otherwise let a catch-all shadow a more specific entry declared after it.
 */
export function matchLayer(relPath) {
	for (const { entry, exact, re } of compiled) {
		if (exact ? entry.glob === relPath : re.test(relPath)) return entry;
	}
	return undefined;
}
