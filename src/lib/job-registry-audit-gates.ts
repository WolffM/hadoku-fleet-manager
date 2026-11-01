import type { JobEntry } from './job-registry-types.js';

export const jobRegistryAuditGates: JobEntry[] = [
	// ---- ci:audit-gates (0 13 * * *, daily; the inner `fleet` checks in coversSubs) ----
	{
		name: 'ci:audit-gates',
		args: [],
		kind: 'gate',
		detectionBudget: '48h',
		cadence: { cron: '0 13 * * *' },
		timeoutS: 1500,
		hostBound: false,
		mgmtApiFile: 'services/mgmt-api/src/routes/jobs/audit-gates.ts',
		contract: 'prose',
		why: "Runs the `fleet <sub>` checks in `coversSubs` (count them there — see scripts/lib/json-contract.mjs's own warning not to trust a number in prose) through hadoku_site's GATES table, each judged by its GateDoc or, for the unmigrated ones, a regex over stdout+stderr, under FLEET_NO_BANNER=1. Every covered sub's budget is one this daily cadence can meet; a liveness check that needs a tighter one gets its own row (ci:warm-canary, ci:label-floor — fleet-manager#38).",
		coversSubs: [
			{
				sub: 'tier-fleet',
				args: ['--json'],
				contract: 'json',
				// Default args, never `--worktree` — it reads each repo's shipped
				// default branch through `lib/fleet-source.mjs`, fetched fresh by
				// the reader itself, so any host gives the same answer (see
				// docs/control-plane.md §4: "since fleet-manager#7 ... hostBound:
				// false").
				hostBound: false,
				detectionBudget: '48h',
				why: 'The child-repo half of the tier model; an incomplete vocabulary fails closed and silently. Migrated to GateDoc, wave 5h lane B.',
			},
			{
				sub: 'mf-externals',
				args: ['--json'],
				contract: 'json',
				// Default args, never `--worktree` — it reads each repo's shipped
				// default branch through `lib/fleet-source.mjs`, and the built half
				// fetches the SAME deployed site regardless of which host asks —
				// same reasoning as tier-fleet's own entry above (docs/control-plane.md
				// §4: "any host gives the same answer... hostBound: false").
				hostBound: false,
				detectionBudget: '48h',
				why: 'A micro-frontend that inlines a mapped singleton breaks only in the browser, invisible to typecheck/lint/build/tests. Migrated to GateDoc, wave 5j lane B.',
			},
			{
				sub: 'throttle',
				args: ['--check', '--json'],
				contract: 'json',
				// ssh to the candidate nodes, never this box's own state — the
				// same class as warm-canary/capabilities, not reap-trend/
				// egress-slices/srv-drift. RESERVE_FILE is resolved locally but
				// only ever written into the LOCAL node's own rendered conf,
				// never read back as a fact about the fleet.
				hostBound: false,
				detectionBudget: '48h',
				why: "The runner job-started hook, read-only: is the fleet's only real concurrency limit actually wired. Migrated to GateDoc, wave 5i lane B.",
			},
			{
				sub: 'slice',
				args: ['--check'],
				detectionBudget: '48h',
				why: 'The memory half of the same idea, read-only: is the cgroup memory ceiling actually applied.',
			},
			{
				sub: 'identity',
				args: ['--json'],
				contract: 'json',
				// `gh api` reads of the fleet's registrations plus ssh to the
				// candidate nodes — the fleet's own identity, never this box's own
				// state. Same class as boundary-contracts/capabilities, not
				// reap-trend/egress-slices/srv-drift.
				hostBound: false,
				detectionBudget: '48h',
				why: 'A listener that escaped its systemd unit reports ONLINE to GitHub and is never restarted; every other runner check asks GitHub, which cannot see this class. Migrated to GateDoc, wave 5j lane B.',
			},
			{
				sub: 'capabilities',
				args: ['--json'],
				contract: 'json',
				// ssh to the candidate nodes, never this box's own state — the
				// same class as warm-canary/boundary-contracts, not reap-trend/
				// egress-slices/srv-drift.
				hostBound: false,
				detectionBudget: '48h',
				why: 'Capabilities are probed by EXECUTING them, not by trusting a declaration. Migrated to GateDoc, wave 5h lane B.',
			},
			{
				sub: 'tool-inventory',
				args: [],
				detectionBudget: '48h',
				why: 'A workflow may invoke a tool its assigned machines lack — invisible as anything but flaky CI.',
			},
			{
				sub: 'ci-watch',
				args: ['--check'],
				detectionBudget: '48h',
				why: 'The CI-alert watch list is DERIVED from the fleet roster; read-only check that the derivation is current.',
			},
			{
				sub: 'history-coverage',
				args: ['--json'],
				contract: 'json',
				// Reads `job-history.jsonl` under HADOKU_STATE_DIR — THIS process's
				// own recorded ingest, "safe to hand from one controller to the
				// next but not safe for two to read/write with different beliefs"
				// (docs/control-plane.md §2) — a different answer on a passive
				// replica than on the active controller, same class as reap-trend.
				hostBound: true,
				detectionBudget: '48h',
				why: 'Every speed/placement statistic the fleet reports is over job-history.jsonl; this is whether that file is actually recording. Migrated to GateDoc, wave 5f lane B.',
			},
			{
				sub: 'contract-consumers',
				args: ['--json'],
				contract: 'json',
				// Reads a real `hadoku_site` checkout off local disk (`siteRoot()`,
				// which falls back to `reposDir()`) rather than through
				// `lib/fleet-source.mjs` — the pre-#7 class of host-bound gate: a
				// passive replica with no sibling checkout on disk gets a
				// different (worse) answer than the active controller.
				hostBound: true,
				detectionBudget: '48h',
				why: 'The other half of the --json contract: that every JSON_CONTRACT/PROSE_CONTRACT consumer file actually exists in hadoku_site. Migrated to GateDoc, wave 5f lane B.',
			},
			{
				sub: 'boundary-contracts',
				args: ['--json'],
				contract: 'json',
				// `gh api` reads plus ssh to the candidate nodes — the fleet's own
				// boundaries, never this box's own state.
				hostBound: false,
				detectionBudget: '48h',
				why: "The real shape of every boundary this package's own tests mock (network + ssh), checked from fleet-manager's own install so it resolves the real fleet-exec. Migrated to GateDoc, wave 5h lane B.",
			},
		],
	},
];
