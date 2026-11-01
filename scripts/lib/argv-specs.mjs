/**
 * ONE DECLARATION PER MIGRATED SCRIPT (plan §4.1 F8, wave 5b §D step 2).
 *
 * Pure DATA — config layer, placement rule 1 ("fleet-manager's own
 * declarative inputs... → config"). No side effects on import, so BOTH sides
 * of the door can read it:
 *
 *   - the script itself imports its own entry and parses its own argv with it
 *     (`scripts/lib/argv.mjs`'s `parseStrict`);
 *   - `src/cli.ts` imports this same object (never a script module — scripts
 *     run on import) to derive `Command.flags` for a migrated subcommand,
 *     so the door's unknown-flag refusal and the script's own are the same
 *     check, read from the same place, rather than a hand-kept copy that can
 *     drift from what the script actually parses.
 *
 * Keyed by SCRIPT FILENAME (relative to `scripts/`), not by the operator's
 * subcommand name — `src/cli.ts`'s `Command.script` is the join key, and a
 * script having no fixed 1:1 subcommand (none of these six are shared the
 * way `benchmark-fleet.mjs` is between `benchmark` and `scan`) makes this the
 * stable key either way.
 *
 * A script not listed here is NOT YET STRICT — debt in the F8 guard
 * (`scripts/lib/f-guards/f8-guard.test.mjs`) until it migrates too. The door
 * keeps a hand-kept `flags:` for those, same as before this file existed.
 */

/** @typedef {import('./argv.mjs').ArgvSpec} ArgvSpec */

/** @type {Record<string, ArgvSpec>} */
export const ARGV_SPECS = {
	'reboot-claws.mjs': {
		usage: [
			'fleet reboot-claws [--plan] [--machine <claw>] [--force] [--json]',
			'  --plan     what would be rebooted, and why; touches nothing',
			"  --force    skip the notice a hosting node's tenant is owed",
			'  (no flag)  one REAL pass: drain one claw, reboot it, verify, undrain',
		].join('\n'),
		booleans: ['--plan', '--force', '--json'],
		valued: ['--machine'],
		positionals: false,
		// Pre-existing wording (`scripts/reboot-claws.test.mjs`, not on this F8
		// migration's file list): a reboot "touches" the node, and that test
		// already asserts the literal phrase.
		nothingDoneText: 'nothing was touched',
	},

	'drain-node.mjs': {
		usage: [
			'fleet drain <node> --reason "why" [--kind training|maintenance|lease]',
			'                  [--for 48h | --until <iso>] [--in 30m | --at <iso>] [--force]',
			'fleet drain <node> --undo           put it back (and cancel anything planned for it)',
			'',
			'  --kind training     the node is earning its labels; it comes back when it',
			'                      passes. Bootcamp sets this.',
			'  --kind maintenance  (default) a human took it out and a human puts it back.',
			'  --kind lease        lent to a tenant for a window; pair it with --for/--until.',
			'  --for / --until     the drain lapses by itself at that time.',
			'  --in / --at         schedule it instead of starting it now. A HOSTING node',
			'                      (fleet hosting) is owed 15 min notice; --force skips it.',
			'fleet drain --status                what is held, and has it gone quiet',
			'fleet drain-check [--json]          is each drain actually being ENFORCED',
			'',
			'',
			'Running jobs are never killed. New assignment stops; current work finishes.',
		].join('\n'),
		booleans: ['--status', '--undo', '--force'],
		valued: ['--reason', '--kind', '--for', '--until', '--in', '--at'],
		positionals: true,
	},

	'backstop-switch.mjs': {
		usage: [
			'fleet backstop --force <node> [--for 60m] [--reason "why"]',
			'                                hold the node ELIGIBLE for builder work, time-boxed',
			// `{CEILING_H}` is filled in by the script, which already imports the
			// real constant for its own logic — see the matching note on
			// job-rollups.mjs's entry above.
			'                                (default 60m, ceiling {CEILING_H}h; set again if the queue outlives it)',
			'fleet backstop --off <node>     end a force early',
			'fleet backstop --status [--json]',
			'                                the switch, the live gates on this box, and the',
			"                                controller's last verdict",
			'',
			'A force beats the saturation decision and the idle gate. It does NOT beat a',
			'drain, a quarantine, the pm2-host rung, or the dispatcher’s admission',
			'(memory, /tmp floor, maxConcurrent). Runner-health reads it on its next tick.',
		].join('\n'),
		booleans: ['--status', '--json'],
		valued: ['--force', '--off', '--for', '--reason'],
		positionals: false,
	},

	'toolpack.mjs': {
		usage: [
			'fleet toolpack [node...] [--confirm] [--json]',
			'',
			'  no nodes    every machine in the fleet manifest',
			'  --confirm   install what is missing (default is report only)',
			'  --json      machine-readable',
			'  --operator-sudo  the operator, on a node the fleet has no sudo on, after',
			'              sudo -v: install there too (otherwise an advisory)',
			'',
			'Derives each node’s packs from what the box IS, then checks the',
			'binaries are actually there. Run it after enrollment and before the',
			'first benchmark: the scan chooses the pack, so the scan must run first.',
		].join('\n'),
		booleans: ['--confirm', '--json', '--operator-sudo'],
		valued: [],
		positionals: true,
	},

	'traffic-status.mjs': {
		usage: [
			'fleet traffic [--labels a,b] [--live] [--json]',
			'',
			'  (no args)   current routing state: order, speed factor, admission, every node',
			'  --labels    simulate a job asking for these labels',
			'  --live      ssh each node for its actual running-job count',
			'',
			'Order: fewest busy, then fastest measured, then idle longest, then name.',
			'Admission is read live from MGMT_API_URL (default http://127.0.0.1:4000),',
			"and reads 'unknown' rather than 'admitted' when that cannot be reached.",
			'Simulates only. Nothing here places, labels or writes.',
		].join('\n'),
		booleans: ['--live', '--json'],
		valued: ['--labels'],
		positionals: false,
	},

	'job-rollups.mjs': {
		usage: [
			'fleet job-rollups — the daily CI rollups mgmt-api writes from job-history',
			'',
			'  --days <n>     closed days to show, counted back from today (default 14)',
			'  --node <name>  only this node, plus the fleet row for the same repo+kind',
			'  --repo <name>  only this repo (owner/name, or just name)',
			'  --json         the rows themselves',
			'',
			// `{SETTLE_HOURS}` is filled in by the script, which already imports the
			// real constant from `dist/job-rollups.js` for its own logic — this data
			// module stays a pure string table and does not import a build artifact
			// just to interpolate one number into its own help text.
			'A day is written {SETTLE_HOURS}h after it ends, so the newest two days are',
			'never here yet. Reads the state dir only; writes nothing.',
		].join('\n'),
		booleans: ['--json'],
		valued: ['--days', '--node', '--repo'],
		positionals: false,
	},

	'failures.mjs': {
		usage: [
			'fleet failures — per-node CI failure rate against the FLEET rate for the same repo+kind',
			'',
			'  --days <n>     closed days to look back, counted from today (default 14)',
			"  --node <name>  only this node's row (the statistic is still computed over every node)",
			'  --json         the full per-node statistic, every zone broken out',
			'',
			// `{SETTLE_HOURS}` — see the matching note on job-rollups.mjs's own entry.
			'A day is written {SETTLE_HOURS}h after it ends, so the newest two days are',
			'never here yet. A node (or cell) below the significance floor is reported',
			'"insufficient data", never folded into "healthy". Reads the state dir only;',
			'writes nothing. Replaces docs/planning/failures-by-node-*.md.',
		].join('\n'),
		booleans: ['--json'],
		valued: ['--days', '--node'],
		positionals: false,
	},

	'stats.mjs': {
		usage: [
			'fleet stats — the operator surface over the fleet telemetry stores (T2/T4/T5/T7)',
			'',
			'  --days <n>  the window for every section, counted back from today (default 14)',
			'  --json      every section, in full',
			'',
			'Five independent sections — daily jobs/queue/conclusions and per-repo totals',
			'(T2 rollups), automation health (T7 job-run sink), capacity/admission share',
			'(T4 samples) and GitHub budget peaks/top-callers (T5 history). A section with',
			'no store, or nothing in the window, reports COULD NOT LOOK on its own — never',
			'a silent zero — and the other sections still answer. Reads the state dir only;',
			'calls no GitHub endpoint, reaches no node.',
		].join('\n'),
		booleans: ['--json'],
		valued: ['--days'],
		positionals: false,
	},

	'floor-probe.mjs': {
		usage: [
			'fleet floor-probe [mode] [flags...] — the per-node floor for one (repo, job)',
			'',
			'  report      per-node zone table over the whole retention window (read-only)',
			'  table       (default) per-node table for one (repo, job)',
			'  candidates  the ordered candidate list for a unit — weakest-first',
			'  window      is this a quiet window to probe in, right now (a predicate)',
			'  probe       shadow-dispatch a workflow onto ONE named node (needs --confirm)',
			'  rerun       force a re-run of a failed job, excluding the node it failed on',
			'',
			'Flags, by the mode that reads them (MODE_FLAGS in lib/floor-probe.mjs is the',
			'authority; a flag given to the wrong mode is refused by name, not silently',
			'ignored):',
			'  report      --days <n> --repo <name>',
			'  table       --unit <repo#job>',
			'  candidates  --unit <repo#job> --timeout-sec <n>',
			'  probe       --repo <name> --workflow <file> --job <name> --node <claw>',
			'              --ref <branch> --confirm --ignore-window',
			'  rerun       --repo <name> --run <id> --onto <claw> --confirm',
			'  (every mode) --json',
			'',
			'Nothing is written without --confirm. See the file header for the full',
			'safety model (shadow-dispatch budget, blackout coordination, the slot',
			'reservation that keeps two operators from colliding).',
		].join('\n'),
		booleans: ['--confirm', '--ignore-window', '--json'],
		valued: [
			'--days',
			'--repo',
			'--unit',
			'--timeout-sec',
			'--workflow',
			'--job',
			'--node',
			'--ref',
			'--run',
			'--onto',
		],
		positionals: true,
	},

	'join-workload-benchmark.mjs': {
		usage: [
			'fleet benchmark-join — P2.4: benchmark x job-metrics x job-history',
			'',
			'  --json                    machine-readable',
			'  --min-nodes <n>           a unit must have this many QUALIFYING nodes to be',
			'                            compared across nodes (default 2)',
			'  --min-runs-per-node <n>   a node needs this many runs of a unit before its',
			'                            median counts toward Q1 (default 3) -- 1-2 runs is',
			"                            a single sample wearing a node's name, not a trend",
			'  --min-runs <n>            a (node, repo) cell needs this many rows before it',
			'                            enters the node x repo table (default 5)',
			'  --min-groups <n>          a repo needs this many nodes (and a node this many',
			'                            repos) before it can answer the variance question',
			'                            (default 3)',
			'  --write <path>            also save the JSON report to <path>',
			'',
			'Read-only. See the file header for what each of the three questions means',
			'and the CAVEAT on question 2 before quoting a number out of this report.',
		].join('\n'),
		booleans: ['--json'],
		valued: ['--min-nodes', '--min-runs-per-node', '--min-runs', '--min-groups', '--write'],
		positionals: false,
	},

	'prove-job.mjs': {
		usage: [
			'fleet prove-job --node <node> (--capability <id> | --repo R --workflow W --job J) [flags]',
			'',
			'  --node <name>            required. Any node, the backstop included.',
			'  --capability <id>        take the job from the registry; the node must carry it',
			'  --repo --workflow --job  name a job by hand (all three, without --capability)',
			'  --ref <ref>              default main',
			'  --evidence <regex>       log lines that show the capability ran (case-insensitive)',
			'  --input k=v              one workflow_dispatch input; repeatable. Overrides the',
			"                           capability's declared `inputs`, per key, when given",
			"  --labels-override a,b   labels for THIS proof runner instead of the workflow's runs-on",
			'  --attempts <n>           dispatch tries before `lost-race` (default 3, hard cap 6)',
			'  --reap-stale             tear down a proof runner a killed run left LIVE',
			'  --timeout-min <n>        whole-run bound (default 40)',
			'  --json                   one JSON document on stdout, whatever the exit code',
			'  --out <file>             also write the JSON there (the 8 KB pipe cliff does not apply)',
			'  --no-record             do not update the proof ledger (state dir, job-proofs.json)',
			'                           or the workload `$proof` facet',
			'',
			'Exit 0 only for a pass. See the header of scripts/prove-job.mjs for the full model.',
		].join('\n'),
		booleans: ['--json', '--reap-stale', '--no-record', '--under-own-drain'],
		valued: [
			'--node',
			'--capability',
			'--repo',
			'--workflow',
			'--job',
			'--ref',
			'--evidence',
			'--input',
			'--labels-override',
			'--attempts',
			'--timeout-min',
			'--out',
		],
		positionals: false,
	},

	'reconcile-runner-identity.mjs': {
		usage: [
			'fleet identity            # report',
			'fleet identity --confirm  # + reap JIT orphans',
			'fleet identity --json',
			'fleet identity --machine <node>  # one node only',
		].join('\n'),
		booleans: ['--confirm', '--json'],
		valued: ['--machine'],
		positionals: false,
	},

	'benchmark-fleet.mjs': {
		usage: [
			'fleet benchmark [node...] [--quick] [--force] [--write] [--json]',
			'fleet benchmark --due N --report [--json]   who is due; touches nothing',
			'fleet benchmark --due N --cadence [--json]  measure the ONE most-overdue idle',
			'                                             claw; drains, measures, writes, undrains',
			'fleet scan <host...> [--quick] [--json]   any box, fleet member or not',
			'',
			'  no nodes    every machine in the fleet manifest',
			'  --quick     skip the disk and network timings (inventory only)',
			'  --force     benchmark even a node that is currently building',
			'  --write     record each node in <stateDir>/benchmark.json and append a line',
			'              to <stateDir>/benchmark.log. No commit: the state dir is no checkout.',
			'  --from F    ingest a capture instead of running: sudo sh benchmark-node.sh > F',
			'  --json      machine-readable output',
			'  --due N     only nodes whose benchmark record is older than N days. A node',
			'              with NO record — no state file, nothing in the manifest — is due.',
			'  --max N     measure at most N nodes this run (bounds the load)',
			'  --report    LIST the nodes due against --due and stop. No ssh, no load,',
			'              no write. Needs --due; refuses --max and --write.',
			'  --cadence   measure exactly ONE node this run: the most-overdue claw that is',
			'              idle and not already held by someone else. Drains it the way',
			'              `ci:toolchain-refresh` does, waits for it to go quiet, measures,',
			'              writes, undrains — always, even if the measurement fails. Needs',
			'              --due; refuses --report/--scan/--from/--max/a named node/--write',
			'              (it always writes what it measures).',
			'',
			'  --due never selects the BACKSTOP: it is not ranked for routing, so its',
			'  benchmark is never due. Exempt machines are reported in `skippedByRole`',
			'  rather than dropped. Naming one positionally still measures it.',
			'',
			'It loads each box on purpose — thermals and throttling are only',
			'observable under load — so it skips nodes running CI unless forced.',
			'',
			'The cadence runs nightly in the quiet hour (operator, 2026-10-04, reversing',
			'the 2026-09-15 "no cron measures"): one node a night, so a batch measured',
			'together never ages out together. A node still inside the lead window but',
			'not picked this run is an ADVISORY; past the grace it is a FINDING. Catch up',
			'on everything else by hand, on the mgmt-api host:',
			'  {BY_HAND_FOR_30}',
		].join('\n'),
		booleans: ['--quick', '--force', '--write', '--json', '--scan', '--cadence', '--report'],
		valued: ['--from', '--due', '--max'],
		positionals: true,
	},

	'enroll-node.mjs': {
		usage: [
			'fleet enroll <node> [--write|--update] [--json]',
			'fleet enroll --file <capture> [--json]',
			'fleet enroll --stdin [--json]',
			'',
			'  <node>      ssh target. Reads the record from its newest bootstrap log and',
			'              RE-MEASURES the box over the same connection.',
			'  --write     commit a NEW node to the manifest. Without it, nothing is written',
			'              and the exit status is 1 — declaration is a human act.',
			'  --update    refresh only the MEASURED fields of a node already declared.',
			'              Never touches labels, capacity, excludeRepos or any $why.',
			'  --hardware-changed memTotalKb|cores --reason "<why>"',
			'              with --update: accept a KNOWN hardware change in that field',
			'              (a RAM upgrade) instead of refusing it; recorded in $measured.',
			'  --file      a saved capture. No re-probe is possible, and it says so.',
			'  --stdin     read the capture from stdin.',
			'  --json      machine-readable result.',
		].join('\n'),
		// `--machine <node>` names the node like every other subcommand does; the
		// positional `<node>` is the same thing. Neither is validated against the
		// manifest here: the node is not in it yet.
		booleans: ['--json', '--write', '--no-push', '--update', '--stdin'],
		valued: ['--address', '--hardware-changed', '--reason', '--file', '--machine'],
		positionals: true,
	},

	'reconcile-fleet-runners.mjs': {
		usage: [
			'fleet reconcile                                  # dry run — plan only, no side effects',
			'fleet reconcile --confirm                        # register what is missing',
			'fleet reconcile --confirm --remove-orphans',
			'fleet reconcile --confirm --remove-excluded',
			'fleet reconcile --repo WolffM/vibecheck',
			'fleet reconcile --json',
			'fleet reconcile --write-coverage                 # regenerate fleet-runner-coverage.json',
			'fleet reconcile --check-coverage [--json]        # is it still current (structural only)',
			'fleet reconcile --write-coverage --allow-shrink  # a DELIBERATE drop below half the roster',
			'',
			'  --confirm          register what is missing (default is a dry-run plan)',
			'  --remove-orphans   deregister a whole retired repo (archived/deleted/skip:true)',
			'  --remove-excluded  deregister one (node, repo) pair excludeRepos names',
			'  --repo <name>      scope to one repo',
			'  --json             machine-readable',
			'  --write-coverage   regenerate fleet-runner-coverage.json',
			'  --check-coverage   is the coverage file still current (structural drift only)',
			'  --allow-shrink     with --write-coverage: allow a drop below half the roster',
		].join('\n'),
		booleans: [
			'--confirm',
			'--remove-orphans',
			'--remove-excluded',
			'--json',
			'--write-coverage',
			'--check-coverage',
			'--allow-shrink',
		],
		valued: ['--repo'],
		positionals: false,
	},

	'collect-job-metrics.mjs': {
		usage: [
			'fleet job-metrics — what each job COST, joined to job history',
			'',
			'  --json            machine-readable',
			'  --machine <n>     one node only',
			'  --min-runs <n>    units with at least n runs (default 2)',
			'',
			'Reads ~/.hadoku/job-metrics.jsonl (and its one rotated .1) from every',
			// `{RETENTION_DAYS}` is filled in by the script, which already imports
			// the real constant for its own window — see the matching note on
			// job-rollups.mjs's own entry above.
			"node, ONLY the rows inside job-history's {RETENTION_DAYS}-day window — written by the",
			"ACTIONS_RUNNER_HOOK_JOB_COMPLETED hook from the kernel's memory.peak,",
			'cpu.stat, io.stat and memory.stat — and joins it to',
			'~/.hadoku-mgmt/job-history.jsonl for wall-clock.',
			'',
			'Every facet prints its SAMPLE COUNT beside its percentiles: io.stat is',
			'absent on some cgroup layouts and the tmpfs counters only exist on rows',
			'written by a newer hook, so a p95 over 4 of 500 rows must not read as the',
			'node\'s p95. A null percentile beside n=0 is "nobody measured it".',
			'',
			'If every node reports 0 rows, the hook is not installed: run',
			'  fleet throttle --confirm --machine <node>',
		].join('\n'),
		booleans: ['--json'],
		valued: ['--machine', '--min-runs'],
		positionals: false,
	},

	'backfill-failed-steps.mjs': {
		usage:
			'fleet backfill-failed-steps — fill failedStep/failedPhase on existing failed\n' +
			'job-history records, as far as GitHub still serves them.\n\n' +
			'Runs INSIDE mgmt-api (POST /api/fleet/job-history/backfill) because that\n' +
			'process is the only writer of job-history.jsonl and never re-reads it —\n' +
			'a patch applied to the file is silently overwritten by its next compaction.\n\n' +
			'  --max <n>          cap the gh calls this pass makes (default 2000)\n' +
			'  --concurrency <n>  parallel job fetches, capped at 10 (default 5)\n' +
			'  --base <url>       mgmt-api base (default http://127.0.0.1:4000)\n',
		booleans: [],
		valued: ['--max', '--concurrency', '--base'],
		positionals: false,
	},

	'retire-node.mjs': {
		usage: [
			'fleet retire <node> [--confirm] [--reason "why"] [--no-push] [--json]',
			'',
			'  (no --confirm)    DRY RUN: the plan only. Nothing is drained, deregistered,',
			'                    edited or moved.',
			'  --confirm         drain it (if nothing has yet), deregister every runner it',
			'                    holds, remove it from the manifest, add its name to the',
			'                    retired-name ledger, and archive its measured facets.',
			'  --reason          the drain reason, when this run is the one that drains it',
			'                    (default: "retiring — see docs/runbooks/retire-node.md").',
			'  --no-push         land the manifest edit locally; never push (tests only).',
			'',
			'A node must be QUIET first: no job running, and no live warm/JIT registration',
			'GitHub could still assign to directly. If it is not, --confirm drains it and',
			'then refuses to go further THIS run — a drain is a soft close.',
			'',
			'Node names are immutable: retiring claw-N never frees claw-N for reuse. Tailnet',
			'removal and the hardware inventory stay operator-only steps; this prints them.',
		].join('\n'),
		booleans: ['--confirm', '--no-push', '--json'],
		valued: ['--reason'],
		positionals: true,
	},
};
