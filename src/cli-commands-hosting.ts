import type { Command } from './cli-types.js';

export const commandsHosting: Record<string, Command> = {
	hosting: {
		script: 'hosting.mjs',
		kind: 'mutator',
		help: true,
		summary: 'lend a node to a tenant: CI off, declared resources served, agent supervised',
	},
	'hosting-offers': {
		script: 'hosting-offers.mjs',
		kind: 'operator',
		summary:
			'what each claw can lend to hosting, measured: memory, cores, disk, link, CI cost, neighbours',
	},
	'hosting-plan': {
		script: 'hosting-plan.mjs',
		kind: 'operator',
		summary:
			"where could a tenant's next slice go: its hosting.json against every claw's offer, ranked with reasons",
	},
	'hosting-placement': {
		script: 'hosting-placement.mjs',
		kind: 'operator',
		flags: ['--max-age', '--json'],
		summary:
			"where the fleet placed an app: { state, epoch, nodes, target } and each slice's state, for its deploy to follow",
	},
	'hosting-eligibility': {
		script: 'hosting-eligibility.mjs',
		kind: 'operator',
		flags: ['--json'],
		summary:
			'per node, the repos it holds a slice of (placed) and may be given one of (eligible), for service grants',
	},
	'hosting-demand': {
		script: 'hosting-demand.mjs',
		kind: 'recorder',
		flags: ['--slices', '--release-order', '--json'],
		summary:
			"a tenant's slice count, restated every poll (same N is a no-op); returns the converger's view of it",
	},
	'hosting-converge': {
		script: 'hosting-converge.mjs',
		kind: 'converger',
		flags: ['--dry-run', '--tenant', '--json'],
		summary:
			'ACTS for placement.auto tenants: declares and ends slices through `fleet hosting` to meet demand; plans for the rest (--dry-run: decide only)',
	},
	'hosting-verify': {
		script: 'hosting-verify.mjs',
		kind: 'converger',
		flags: ['--dry-run', '--json'],
		summary:
			'REPAIRS by default: every hosted slice checked from its node, and each one not guaranteed re-asserted from its record (--dry-run: report only)',
	},
	'backstop-tools': {
		script: 'backstop-tools.mjs',
		kind: 'gate',
		flags: ['--json'],
		summary:
			"the backstop's hand-installed yt-dlp and deno against their newest releases: stale is 30 days behind; installs nothing",
	},
	'hosting-request': {
		script: 'hosting-request.mjs',
		kind: 'gate',
		summary:
			"read an app's hosting.json the way the fleet will: normalized, or every problem with its reason",
	},
	'node-users': {
		script: 'node-users.mjs',
		// A gate AND a writer in one file: bare, it fails on any blocking
		// finding, same as a gate's contract; `--cutover` creates/moves the ci
		// user (docs/planning/node-users-2026-10-27.md P3). ci:node-users (the
		// bare mode's only automated caller) is RETIRED wave gates2 lane F2 —
		// see MANUAL['node-users'] in src/lib/job-registry.ts. Both modes stay
		// real, operator-run subcommands.
		kind: 'gate',
		summary:
			'per node: who runs CI (the ci role), read from the node — sudo, groups, keys, every runner uid',
	},
	'node-status': {
		script: 'node-status.mjs',
		kind: 'operator',
		help: true,
		summary: 'per node: reachable, health, drains and their notice, hosting — for a tenant to read',
	},
	'contract-consumers': {
		script: 'check-contract-consumers.mjs',
		// MOVED OFF ITS CRON wave gates2 lane F2: the old ci:audit-gates
		// coversSubs row is retired; hadoku_site's lint.yml now runs
		// `fleet contract-consumers --json` on every PR touching
		// services/mgmt-api/src/routes/jobs/**, HADOKU_SITE_ROOT pinned at
		// that checkout (MANUAL['contract-consumers'] in
		// src/lib/job-registry.ts).
		kind: 'gate',
		help: true,
		summary: 'every --json contract entry names a consumer that exists',
	},
	'runner-units': {
		// RENAMED wave gates2 lane F1a (from check-runner-units.mjs). The same
		// registration-vs-box audit now ALSO runs, in the other direction, from
		// `fleet identity` (reconcile-runner-identity.mjs) — see that file's
		// header. UNSCHEDULED wave gates2 lane F2: mgmt-api's `ci:runner-units`
		// cron (its only automated caller) is retired
		// (MANUAL['runner-units'] in src/lib/job-registry.ts). Kept as a real,
		// working subcommand for hand-running the install/unit half alone.
		script: 'runner-units.mjs',
		kind: 'gate',
		help: true,
		summary: 'standing runner units that name a renamed, archived or off-roster repo',
	},
	'check-runner-var': {
		// UNSCHEDULED wave gates2 lane F2: mgmt-api's `ci:runner-var` cron
		// (its only automated caller) is retired — `fleet reconcile`'s own
		// runnerVar finding (lib/runner-var.mjs, shared) now carries the SAME
		// check nightly as part of ci:fleet-coverage
		// (MANUAL['check-runner-var'] in src/lib/job-registry.ts). Kept as a
		// real, working subcommand: hadoku_site's fleet-coverage-check.ts
		// names it in its own finding message as the hand-run tool for more
		// detail.
		script: 'check-runner-var.mjs',
		kind: 'gate',
		summary: 'every repo asking for vars.CI_RUNNER actually has it',
	},
	'check-site-token': {
		script: 'check-site-token.mjs',
		kind: 'gate',
		summary: 'HADOKU_SITE_TOKEN is held only by the repos that need it',
	},
	'egress-slices': {
		script: 'check-egress-slices.mjs',
		kind: 'gate',
		summary: 'the cgroup taxonomy the split tunnel routes on — every PM2 app classified',
	},
};
