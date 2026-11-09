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
				sub: 'identity',
				args: ['--json'],
				contract: 'json',
				// `gh api` reads of the fleet's registrations plus ssh to the
				// candidate nodes — the fleet's own identity, never this box's own
				// state. Same class as boundary-contracts, not egress-slices/
				// history-coverage's own cgroup/deploy-clone.
				hostBound: false,
				detectionBudget: '48h',
				why: 'A listener that escaped its systemd unit reports ONLINE to GitHub and is never restarted; every other runner check asks GitHub, which cannot see this class. Migrated to GateDoc, wave 5j lane B.',
			},
			{
				sub: 'history-coverage',
				args: ['--json'],
				contract: 'json',
				// Reads `job-history.jsonl` under HADOKU_STATE_DIR — THIS process's
				// own recorded ingest, "safe to hand from one controller to the
				// next but not safe for two to read/write with different beliefs"
				// (docs/control-plane.md §2) — a different answer on a passive
				// replica than on the active controller, same class as egress-slices.
				hostBound: true,
				detectionBudget: '48h',
				why: 'Every speed/placement statistic the fleet reports is over job-history.jsonl; this is whether that file is actually recording. Migrated to GateDoc, wave 5f lane B.',
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
	// ---- ci:vault-audit (0 13 * * *, fleet-audits; the vault-privileged half
	// runs in-process in mgmt-api, but one of its three gates — merged in
	// wave gates2 lane S2 from the retired standalone `ci:site-token` cron —
	// still spawns this CLI directly (vault-audit.ts's `runSiteTokenGate`),
	// so `fleet check-schedule`'s rule (c) (an mgmt-api route that imports
	// `fleetCli` with no row here) needs a row even though the job's OWN
	// name was never `ci:check-site-token`. ----
	{
		name: 'ci:vault-audit',
		sub: 'check-site-token',
		args: ['--json'],
		kind: 'gate',
		detectionBudget: '48h',
		cadence: { cron: '0 13 * * *' },
		// vault-audit.ts's own SITE_TOKEN_TIMEOUT_MS = 240_000 — the real spawn
		// timeout, read from the route file rather than copied from the
		// retired ci:site-token row (which carried 300, unverified against it).
		timeoutS: 240,
		hostBound: false,
		mgmtApiFile: 'services/mgmt-api/src/routes/jobs/vault-audit.ts',
		contract: 'json',
		why: "Is HADOKU_SITE_TOKEN held only by the hub and the declared siteTokenHolders — the same question the retired `ci:site-token` cron asked, now one of three gates `ci:vault-audit` runs under one page instead of four. The other two gates (check:key-sync, check:credential-coverage) spawn the site's own admin scripts directly, never this CLI, so they carry no row here.",
	},
];
