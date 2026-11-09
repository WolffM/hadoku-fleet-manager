import type { Command } from './cli-types.js';

export const commandsFleetOps: Record<string, Command> = {
	reconcile: {
		script: 'reconcile-fleet-runners.mjs',
		kind: 'converger',
		summary: 'converge runner coverage (--confirm to apply)',
	},
	slice: {
		script: 'deploy-runners-slice.mjs',
		kind: 'mutator',
		summary: 'cgroup slice + memory ceilings (--check)',
	},
	throttle: {
		script: 'deploy-ci-throttle.mjs',
		kind: 'mutator',
		summary: 'per-node CI concurrency hook (--check)',
	},
	'converge-provisioning': {
		script: 'converge-provisioning.mjs',
		kind: 'converger',
		flags: ['--dry-run', '--json'],
		summary:
			'REPAIRS by default: drifted throttle env + slice placement on idle runners and claw security upgrades, then re-check (--dry-run: report only)',
	},
	'apt-security': {
		script: 'apt-security.mjs',
		kind: 'converger',
		summary:
			'will each claw install Debian security updates — RUNS the dry run (--confirm repairs)',
	},
	'reboot-claws': {
		script: 'reboot-claws.mjs',
		kind: 'converger',
		help: true,
		summary:
			'reboot ONE claw that needs it: drain, wait idle, reboot, verify kernel + runners, undrain',
	},
	identity: {
		script: 'reconcile-runner-identity.mjs',
		kind: 'gate',
		summary: 'runner identity/ownership drift',
	},
	traffic: {
		script: 'traffic-status.mjs',
		kind: 'operator',
		help: true,
		summary: 'where the next job would go, and why every other node did not get it',
	},
	decisions: {
		script: 'fleet-decisions.mjs',
		kind: 'operator',
		help: true,
		summary: 'where past jobs went and why the other nodes refused them (--job|--run|--node)',
	},
	drain: {
		script: 'drain-node.mjs',
		kind: 'mutator',
		help: true,
		summary: 'soft-close a node: no new jobs, current work finishes',
	},
	retire: {
		script: 'retire-node.mjs',
		kind: 'mutator',
		help: true,
		summary:
			'take a node out of the fleet for good: drain, deregister, un-declare, ledger its name',
	},
	backstop: {
		script: 'backstop-switch.mjs',
		kind: 'mutator',
		help: true,
		summary: 'the green light: --force <node> holds it eligible for CI; --status says why not',
	},
	'converge-toolchain': {
		script: 'converge-toolchain.mjs',
		kind: 'converger',
		// `--refresh` drains and updates nodes, and `--plan` is what makes it a
		// dry run: a typo of the one must never fall through to the other.
		flags: [
			'--json',
			'--write',
			'--refresh',
			'--plan',
			'--operator-sudo',
			'--machine=',
			'--budget-min=',
			'--out=',
		],
		summary: 'check — and with --write, REFRESH — the build toolchain on every node',
	},
	toolpack: {
		script: 'toolpack.mjs',
		kind: 'converger',
		help: true,
		summary: 'the instruments a node needs before its measurements are trustworthy',
	},
	scan: {
		script: 'benchmark-fleet.mjs',
		kind: 'operator',
		help: true,
		args: ['--scan'],
		summary: 'measure any reachable box, in the fleet or not — nothing is written',
	},
	benchmark: {
		script: 'benchmark-fleet.mjs',
		// A recorder, not an operator report: automated since 2026-10-04
		// (#87/#93) under `--cadence`, which writes ONE declared record
		// (<stateDir>/benchmark.json) per run — plan §3.2 rule 6's definition.
		// Corrected 2026-10-31 (wave 5e lane D); job-registry.ts's
		// `ci:fleet-benchmark` entry used to carry a `kindDrift` recording
		// this exact disagreement.
		kind: 'recorder',
		help: true,
		summary: 'measure every node and put the numbers side by side',
	},
	'benchmark-join': {
		script: 'join-workload-benchmark.mjs',
		kind: 'operator',
		help: true,
		summary: 'hardware x job-metrics x job-history — is peak memory the workload or the node',
	},
	stress: {
		script: 'stress-node.sh',
		kind: 'node-side',
		flags: ['--minutes=', '--quick', '--force'],
		summary: 'semi-annual wear check: RAM, CPU/thermal, SMART (runs ON the node)',
	},
	capabilities: {
		// DELETED wave gates2 lane F1a (operator-approved): redundant with
		// bootcamp's probe registry + revocation. The one thing this
		// subcommand uniquely checked, the ephemeral dispatcher's --jitconfig
		// dependency, moved to `fleet boundary-contracts`. The mgmt-api
		// `check:capabilities` audit-gates row that used to call this bare
		// retired wave gates2 lane F2. This thin, real alias
		// (scripts/capabilities.mjs) stays: bare, a no-op (mgmt-api's old
		// fleet-wide case needed nothing more); with `--machine`, it is a REAL
		// re-probe — `fleet:reboot-claws`'s own re-prove step
		// (scripts/reboot-claws.mjs) spawns it directly by script path after a
		// reboot, before undraining (MANUAL['capabilities'] in
		// src/lib/job-registry.ts).
		script: 'capabilities.mjs',
		kind: 'gate',
		summary: 'RETIRED alias — see fleet bootcamp and fleet boundary-contracts',
	},
	'job-metrics': {
		script: 'collect-job-metrics.mjs',
		kind: 'operator',
		help: true,
		summary: 'peak memory per job, joined to job history',
	},
	'service-inventory': {
		script: 'service-inventory.mjs',
		// A recorder: `--slices --write` is the WRITER of the kind:'slice'
		// resident rows in the demand ledger, not a read-only report — plan
		// §3.2 rule 6. Corrected 2026-10-31 (wave 5e lane D); job-registry.ts's
		// `ci:slice-inventory` entry used to carry a `kindDrift` recording this
		// exact disagreement.
		kind: 'recorder',
		summary:
			'every RESIDENT workload on this node, measured; --slices: every declared hosting slice (--write merges the demand ledger)',
	},
};
