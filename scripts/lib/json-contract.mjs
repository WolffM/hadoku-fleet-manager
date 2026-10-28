/**
 * WHO READS THIS CLI'S OUTPUT, AND HOW. Two declarations, in one file on
 * purpose — a reader asking "what breaks if I change what the CLI prints?" must
 * find BOTH here, because splitting them is how the second one got missed.
 *
 * `JSON_CONTRACT` is the ten cron jobs that parse stdout as JSON.
 * `PROSE_CONTRACT`, at the bottom, is the one that reads stdout AND STDERR as
 * prose against a regex. On 2026-09-07 a provenance banner was added to every
 * subcommand's stderr with a test that covered the JSON half exactly, and the
 * prose consumer was invisible to it — not because the test was weak, but
 * because nothing had ever written the prose consumer down.
 *
 * WHICH SUBCOMMANDS OWE A `--json` CONTRACT, AND TO WHOM.
 *
 * CLAUDE.md has said "`--json` is a contract — four mgmt-api cron jobs parse
 * subcommand stdout and treat a non-zero exit as a FINDING, not a crash" since
 * the extraction, and README.md has said "every subcommand that a cron job
 * consumes must keep its `--json` contract". Neither named one. Twelve of the
 * twenty-three subcommands implement `--json` and nothing anywhere said which of
 * them are load-bearing, so the rule was unenforceable by anyone who did not
 * already have `services/mgmt-api/src/routes/jobs/` open in another window.
 *
 * Measured 2026-08-30 by grepping that directory: it was FIVE cron jobs, not
 * four. `ci:claw-cleanup` was the one nobody had counted. `ci:runner-var`,
 * `ci:queue-health` and `ci:egress-slices` have joined since. The LIST below is
 * the declaration; this prose has carried a stale count twice, so it no longer
 * carries one at all — count the entries.
 *
 * WHAT BREAKING IT COSTS
 * ----------------------
 * Every consumer below has the same shape: `execFile(node, [cli, sub, ...argv])`
 * and then `if (out.trim().startsWith('{'))` BEFORE it looks at the exit code.
 * That ordering is the whole contract, and it is deliberate — these gates exit
 * non-zero ON FINDINGS, so reading the exit code first turns every real finding
 * into "the checker broke". Three ways to break it, all silent from here:
 *
 *   1. rename a subcommand    -> `fleet: unknown subcommand`, exit 1, no JSON
 *   2. drop `--json` handling -> human output, exit 1, no JSON
 *   3. print before the JSON  -> stdout no longer starts with `{`
 *   4. lose the END of it     -> stdout starts with `{` and never closes
 *
 * In all four the cron reports its own failure rather than the fleet's, which
 * is the failure mode CLAUDE.md's "'I could not look' must never render as
 * 'nothing is wrong'" rule exists to prevent — one layer up.
 *
 * (4) IS THE ONE THIS FILE DID NOT KNOW ABOUT UNTIL 2026-09-16, and it is the
 * nastiest of the four precisely because it satisfies the consumer's own test:
 * `out.trim().startsWith('{')` passes on a document cut off mid-string. On a
 * PIPE — which `execFile` is — `process.exit` abandons whatever `stdout` still
 * had queued, and every script here writes its document and exits on the next
 * line. Measured: `fleet benchmark --due 0 --report --json` over a fixture,
 * 149,133 bytes into a file and 8,192 through a pipe. The fix is fd 1 rather
 * than the twenty-odd call sites — `keepStdoutWhole()` in `lib/emit.mjs`, which
 * every contract script already reaches through `createEmitter`. Issue #33; the
 * gate is in `json-contract.test.mjs` and runs a real subcommand, through a real
 * pipe, over a payload no poisoned-environment run could ever produce.
 *
 * WHAT THE GATE BESIDE THIS FILE CAN AND CANNOT PROVE
 * --------------------------------------------------
 * It proves (1) and (2) offline, against the source with comments blanked.
 *
 * IT DOES NOT PROVE (3), AND SINCE 2026-09-03 IT NO LONGER HAS TO. This file
 * used to say (3) was unprovable, because proving it looked like RUNNING each
 * subcommand — and among them `reconcile` needs a GitHub token, `toolchain`
 * and `cleanup` need ssh to the garage, and `header-audit` and `identity-model`
 * need 25 sibling checkouts on disk. None of that is available to
 * `pnpm run check`.
 *
 * That reasoning was sound about BEHAVIOUR and wrong about STRUCTURE. Every
 * contract script now writes stdout only through `lib/emit.mjs`, and
 * `lib/emit.test.mjs` gates exactly that: no `console.log`, no
 * `process.stdout.write`, one `emit()` that refuses to fire twice. So printing
 * before the JSON is not a thing these scripts can do — for every input,
 * including the ones a single run could never reach. A stronger claim than
 * observing one execution would have bought, and it costs no token and no ssh.
 *
 * This remains a check on the DECLARATION in the sense docs/VOCABULARY.md gives
 * that word; the cron is still the only observer of what the fleet actually
 * says back.
 */

/**
 * One entry per mgmt-api cron job that parses this CLI's stdout as JSON.
 *
 * `argv` is what the consumer ACTUALLY passes, copied from the call site, not
 * the minimum that would work — `--confirm` and `--fleet` are part of what the
 * job asks for and a reader chasing a bug needs the real command line.
 *
 * `hostBound` (#79 Lane 2/3, `docs/control-plane.md`): does this subcommand
 * read something that belongs to THIS box specifically — this host's own pm2
 * list or cgroups, its own mgmt-api log, its own `~/srv` deploy clone — rather
 * than the fleet (GitHub, the manifest, ssh to a node)? Another repo's source is
 * NOT host-bound: since fleet-manager#7 every gate reads it through
 * `lib/fleet-source.mjs`, which fetches the default branch itself, so five
 * entries that read sibling checkouts under `REPOS_DIR` flipped to `false`. A host-bound subcommand gives a DIFFERENT answer
 * on a passive replica than on the active controller, even reading the same
 * manifest, so it cannot be split across them the way the fleet-facing ones
 * can; the active/passive design (`docs/control-plane.md`) has to run every
 * `hostBound: true` entry from wherever its OWN inputs live, not merely from
 * wherever `controller: true` happens to be. Every entry below carries this
 * field — `true` or `false`, never absent — and the gate beside this file
 * requires it on every entry, present or future, so a new contracted
 * subcommand cannot land silently unclassified.
 */
export const JSON_CONTRACT = [
	{
		sub: 'drain-check',
		hostBound: false,
		argv: ['--json'],
		job: 'ci:drain-enforced',
		consumer: 'services/mgmt-api/src/routes/jobs/drain-enforced-check.ts',
		why:
			'Is a drained node actually idle. `fleet drain --status` reads the drain ' +
			'FILE and reports what it says, so when the file is wrong the check is ' +
			'wrong with it -- claw-5 spent days believed drained, by three documents, ' +
			'while serving 61 jobs. `--check` reads JOB HISTORY instead: a drained ' +
			'node that STARTED work after its drain is a drain not being enforced, ' +
			'whichever of the two enforcement paths failed. On fleet-pulse at */10 ' +
			'rather than repo-sync because a drain is a safety fact about a physical ' +
			'machine and it costs two local file reads -- no ssh, no token.',
	},
	{
		sub: 'benchmark',
		hostBound: false,
		argv: ['--due', '30', '--cadence', '--json'],
		job: 'ci:fleet-benchmark',
		consumer: 'services/mgmt-api/src/routes/jobs/fleet-benchmark-check.ts',
		why:
			'Is the hardware still what the manifest says. Every capacity decision ' +
			'is COMPARATIVE, so the fleet has to keep measuring or the comparison ' +
			'silently ages out. AUTOMATED since 2026-10-04 (operator: "i would prefer ' +
			'if that was automated", reversing the 2026-09-15 report-only decision, ' +
			'#87): `--cadence` measures at most ONE claw per run, never a guest, a busy ' +
			'node or one someone else drained, drains it around the measurement the ' +
			'way ci:toolchain-refresh does, writes `<stateDir>/benchmark.json`, and ' +
			'always undrains. A node due inside the lead window but not measured this ' +
			'run is an ADVISORY; a finding comes only past a grace, or for a node that ' +
			'could not be reached. `--report` remains a supported read-only mode for ' +
			'people; it is no longer what the cron runs (#93).',
	},
	{
		sub: 'reconcile',
		hostBound: false,
		argv: ['--json'],
		job: 'ci:fleet-coverage',
		consumer: 'services/mgmt-api/src/routes/jobs/fleet-coverage-check.ts',
		why:
			'Does every covered repo have a runner. Also invoked a second time as ' +
			'`--json --confirm` to apply, so both paths must emit the same shape. ' +
			'Distinct from `--check-coverage` (is the roster itself current), which ' +
			"ci:audit-gates runs and reads as prose, not JSON — see that job's own note.",
	},
	{
		sub: 'toolchain',
		hostBound: false,
		argv: ['--json'],
		job: 'ci:fleet-toolchain',
		consumer: 'services/mgmt-api/src/routes/jobs/fleet-toolchain-check.ts',
		why:
			'Can each node build what its neighbours can. Detection only — it ' +
			'never passes --confirm, because converging means apt-get on shared CI ' +
			'hosts. An unreachable node is a finding, so a non-zero exit here is ' +
			'the NORMAL case the JSON has to survive.',
	},
	{
		sub: 'converge-toolchain',
		hostBound: false,
		argv: ['--refresh', '--json'],
		job: 'ci:toolchain-refresh',
		consumer: 'services/mgmt-api/src/routes/jobs/toolchain-refresh.ts',
		why:
			'The CADENCE (#69): detect every node, then one node at a time drain -> ' +
			'wait DRAINED -> update -> re-probe -> undrain. A non-zero exit is a ' +
			'FINDING, not a crash, and parseable stdout wins: a node that failed its ' +
			're-probe STAYS DRAINED and arrives as `findings[].kind === "reprobe-failed"`, ' +
			'and `nodes[].status === "deferred"` (queue under pressure, or a hold that ' +
			'is not ours) is reported but is not a failure. `tunnels[]` (additive) is each ' +
			"service host's own Cloudflare tunnel; its findings are `tunnel-*` kinds. `peers[]` (additive) is each hot standby's peer port, closed to all but its pair-mate; its findings are `peer-port-*` kinds. Plain `converge-toolchain " +
			'--json` (no --refresh) is not under contract.',
	},
	{
		sub: 'header-audit',
		hostBound: false,
		argv: ['--json'],
		job: 'ci:header-fleet',
		consumer: 'services/mgmt-api/src/routes/jobs/header-fleet-check.ts',
		why:
			'The @wolffm consumer contract across every checkout. It reports ' +
			'`registry.blind` so the job can tell "clean" from "could not read the ' +
			'registry" — a distinction that exists ONLY in the JSON shape; the human ' +
			'output collapses both into a tidy summary line.',
	},
	{
		sub: 'identity-model',
		hostBound: false,
		argv: ['--fleet', '--json'],
		job: 'ci:identity-model',
		consumer: 'services/mgmt-api/src/routes/jobs/identity-model-check.ts',
		why:
			'The child half of the identity model. `--fleet` is not optional here: ' +
			'without it the run covers hadoku_site alone, which lint.yml already ' +
			'does. The JSON carries `scanned` and `missingCheckouts`, which is how ' +
			'the job fails a run that looked at nothing.',
	},
	{
		sub: 'cleanup',
		hostBound: false,
		argv: ['--json', '--confirm'],
		job: 'ci:claw-cleanup',
		consumer: 'services/mgmt-api/src/routes/jobs/claw-cleanup.ts',
		why:
			'Reclaims what runner self-update strands. The fifth consumer, and the ' +
			'one CLAUDE.md\'s "four cron jobs" had never counted. It is the only ' +
			'contract entry that MUTATES the fleet, so a broken parse here means an ' +
			'apply whose result nobody reads.',
	},
	{
		sub: 'check-runner-var',
		hostBound: false,
		argv: ['--json'],
		job: 'ci:runner-var',
		consumer: 'services/mgmt-api/src/routes/jobs/runner-var-check.ts',
		why:
			'Does every repo that ASKS for vars.CI_RUNNER actually have it. The fleet ' +
			'uses the bare `fromJSON(vars.CI_RUNNER)` form, so an unset variable is not ' +
			'a queue — runs-on resolves to nothing and every workflow in that repo ' +
			'fails to start. ci-runner-fallback.ts named this guard as covering that ' +
			'case for a year before it existed. Deliberately WIDER than the coverage ' +
			'roster: a repo that leaves the roster keeps its workflows and loses its ' +
			'writer, which is the case it is most for.',
	},
	{
		sub: 'check-site-token',
		hostBound: false,
		argv: ['--json'],
		job: 'ci:site-token',
		consumer: 'services/mgmt-api/src/routes/jobs/site-token-check.ts',
		why:
			'Is HADOKU_SITE_TOKEN, the account-wide repo+workflow PAT, held only by the ' +
			'hub and the declared siteTokenHolders. Child repos stopped holding it on ' +
			'2026-10-23 (mgmt-api does their two writes with their own service key), and ' +
			'a copy that comes back fails nothing on its own. Reads Actions secrets from ' +
			'the GitHub API and workflows/.devvault.json from each default branch on origin.',
	},
	{
		sub: 'egress-slices',
		hostBound: true,
		argv: ['--json'],
		job: 'ci:egress-slices',
		consumer: 'services/mgmt-api/src/routes/jobs/egress-slices-check.ts',
		why:
			"fleet-manager's half of the cgroup split tunnel agreed with local-hawk on " +
			'2026-09-05: we declare which cgroups carry fleet work and must egress direct, ' +
			'local-hawk owns the routing policy that acts on it. The reason it needs a cron ' +
			'rather than a subcommand is the same property that makes the policy drift-' +
			'resistant — it is a PREFIX match, so a PM2 app added tomorrow is covered with no ' +
			'rule edit, and therefore inherits FLEET EGRESS with nobody deciding that it ' +
			'should. Its JSON separates `findings` from `deferred` and `acceptedLeaks`, and ' +
			'that separation exists ONLY in the JSON shape: an app restarting during a rolling ' +
			'deploy must not read as a policy breach, and a leak already on record must not ' +
			'read as clean. The only entry here that is HOST-LOCAL — it reads this box, not ' +
			'the fleet, because the claws carry no VPN and have no split tunnel to audit.',
	},
	{
		sub: 'queue-health',
		hostBound: false,
		argv: ['--json'],
		job: 'ci:queue-health',
		consumer: 'services/mgmt-api/src/routes/jobs/queue-health-check.ts',
		why:
			'Is the fleet actually SERVING work. The only entry here that reads an ' +
			'OUTCOME rather than a declaration or a mechanism, and it exists because on ' +
			'2026-09-01 every other one was green while 13 jobs sat queued 11-19 minutes ' +
			'across nine repos. Runs */10 in its own fleet-pulse profile rather than ' +
			'daily, because a stall resolves or escalates inside the hour. Its JSON ' +
			'carries `error` separately from `findings` so the job can tell "the roster ' +
			'could not be read" from "nothing is queued" - a distinction that exists ONLY ' +
			'in the JSON shape, since both render as a calm fleet otherwise.',
	},
	{
		sub: 'reap-trend',
		hostBound: true,
		argv: ['--json'],
		job: 'ci:reap-timeout-trend',
		consumer: 'services/mgmt-api/src/routes/jobs/reap-timeout-trend-check.ts',
		why:
			"Is the reap's GET-runners timeout rate CLIMBING, not just what it reads today. " +
			'`api-budget-outage-2026-09-07.md`: timeouts on this path went 460/hr at the peak to ' +
			'~35/hr after the cadence fix, and nothing would notice if the trend resumed. Reads ' +
			"mgmt-api's OWN pm2 log for the exact line the outage was diagnosed from — " +
			'`[runner-health] GET /actions/runners?per_page=100 failed: ...` — so it must run on ' +
			'the box mgmt-api runs on, which every consumer of this contract already does. Its ' +
			'JSON separates a trend FINDING from an `error` (log too short to compare two ' +
			'windows, or unreadable) — a distinction that exists ONLY in the JSON shape, since a ' +
			'gate that could not read enough log must never report the quiet it produced as a ' +
			'clean fleet.',
	},
	{
		sub: 'preflight',
		hostBound: false,
		argv: ['--json'],
		job: 'ci:fleet-preflight',
		consumer: 'services/mgmt-api/src/routes/jobs/fleet-preflight-check.ts',
		why:
			'The nightly slow-motion sweep: Tailscale node-key expiry, HADOKU_SITE_TOKEN expiry, ' +
			'runner-version drift on the standing claw-4/claw-6/hokon registrations and on each ' +
			"node's JIT payload (every mint is copied from it), pending " +
			'reboots. Every one of the first three has already caused a silent outage on this ' +
			'fleet once (claw-1/claw-2 node keys lapsing 2026-08-31, HADOKU_SITE_TOKEN expiring ' +
			'unregistered 2026-08-13) or is the same shape of risk (runner version, reboots). ' +
			'Its JSON separates a `could-not-look` finding — one of the four signals could not be ' +
			'read at all — from an ordinary finding on a signal it DID read, so a partial outage ' +
			'in the checker itself cannot be reported as "the other three are clean".',
	},
	{
		sub: 'srv-drift',
		hostBound: true,
		argv: ['--json'],
		job: 'ci:srv-drift',
		consumer: 'services/mgmt-api/src/routes/jobs/srv-drift-check.ts',
		why:
			'Is the manifest the fleet is RUNNING the manifest main holds. The DEPLOYED site ' +
			'checkout under `~/srv` is not a deploy artifact — it is a git checkout, and every ' +
			'redeploy of mgmt-api runs `git reset ' +
			'--hard origin/main` on it — so the four `--write` commands that resolve ' +
			'FLEET_MANIFEST_DIR there succeed, read back true, and are erased at the next publish ' +
			'anywhere in the ecosystem. That happened on 2026-09-14 and the loss was silent. ' +
			'`lib/manifest-target.mjs` now refuses that target for those four; this is the half ' +
			'that sees writes they did not make — a hand edit, an older deployed fleet-manager, ' +
			'anything run from `~/srv` because that is where the CLI is. Its JSON separates ' +
			'`unlanded-write` from `undeployed`, and both from `deferred` and `error`: the two ' +
			'findings have OPPOSITE fixes (recover the numbers, versus fix redeploy-mgmt-api.yml), ' +
			'an in-flight redeploy must not page, and `facetsCompared: 0` must not read as a ' +
			'matching deploy — distinctions that exist ONLY in the JSON shape, since all four ' +
			'render as a calm fleet otherwise.',
	},
	{
		sub: 'inventory',
		hostBound: false,
		argv: ['--check', '--json'],
		job: 'ci:fleet-inventory',
		consumer: 'services/mgmt-api/src/routes/jobs/fleet-inventory-check.ts',
		why:
			'Is the blast-radius doc still the fleet. #38 built `fleet inventory --check` in wave ' +
			'3j and NOTHING ran it, so when claw-9 joined and claw-7 left, the generated region of ' +
			"hadoku_site's SELF_HOSTED_RUNNERS.md kept naming a fleet that had stopped existing — " +
			'measured 2026-09-22, 113 committed rows against 115 real workflows, stale:true, exit ' +
			'1, and nobody knew. The lane that wired this consumer was named for the rule itself: ' +
			'a manual subcommand is not a guard until a cron runs it. Detection only, and the ' +
			'consumer never passes --write — regenerating the region is a hadoku_site COMMIT from ' +
			'a development checkout, because ~/srv is hard-reset at every publish and a write ' +
			'there is erased silently. The consumer points HADOKU_SITE_ROOT at the ~/repos ' +
			'checkout, which repos:main-sync fast-forwards earlier in the same profile, so the ' +
			"doc under judgment is MAIN's committed copy rather than the deploy tree's lag. Its " +
			'JSON carries `stale` separately from `problems` and `ok`, and the zero-scan case ' +
			'emits `ok:false` with `error` — a run that read nothing must not render as a doc ' +
			'that matches nothing.',
	},
	{
		sub: 'doctor',
		hostBound: false,
		argv: ['--cadence', '--write', '--json'],
		job: 'ci:health-refresh',
		consumer: 'services/mgmt-api/src/routes/jobs/health-refresh.ts',
		why:
			'The WRITER of `$health`, which ci:health-freshness below only judges. Until ' +
			'2026-10-11 nothing scheduled it: one hand run on 2026-09-26 wrote all nine records ' +
			'and ci:health-freshness went red 15.3 days later on every node at once. ' +
			'`--cadence` is the run a cron can own — a node busy with CI is DEFERRED (advisory, ' +
			'record kept) rather than a BLOCKING no-load-reading that would page on busyness, and ' +
			'a guest is probed but never loaded. An unreachable node and every real thermal, ' +
			'SMART or disk finding still exit 1, so a non-zero exit with parseable stdout is the ' +
			'FINDING path. `deferred` and `unreachable` name the nodes this run did not rewrite.',
	},
	{
		sub: 'health-freshness',
		hostBound: false,
		argv: ['--json'],
		job: 'ci:health-freshness',
		consumer: 'services/mgmt-api/src/routes/jobs/health-freshness-check.ts',
		why:
			'How old is the `$health` record every placement rule reads. The second entry here ' +
			'whose subject is a FACET RATHER THAN A FLEET, and the one that shows why the rule ' +
			'needs a cron to mean anything: `fleet doctor` is the only thing that reads `$health` ' +
			'and it REWRITES it on every run, so the record is fresh whenever anyone looks and ' +
			'invisible when nobody does. Measured 2026-09-26 — SIX of NINE nodes carried one ' +
			'15.7-day-old reading, across a window that decommissioned claw-7, admitted claw-8 ' +
			'and claw-9 and rewrote the `cpu-thermal` rule, while filter 5 of resident placement ' +
			'read it to decide who may host. Nothing was red. The gate (wave 3o, #64) answered ' +
			'correctly from the day it landed and NOTHING RAN IT for two waves, which is the ' +
			'same shape as ci:fleet-inventory above and the reason "a manual subcommand is not a ' +
			'guard" is a standing rule rather than an observation. Probes nothing, writes ' +
			"nothing, calls no API and ssh's no box: two local file reads, which is why it sits " +
			'in repo-sync with the other daily audits and needs no retry. Its JSON separates ' +
			'`blocking` from `advisory` and carries `facetFileOk` beside `ok` — a GUEST node is ' +
			'not a placement candidate, so its ageing record must be SAID without failing the ' +
			'run (the role comes from the manifest, never a name here), and a `$health` file ' +
			'that could not be parsed at all must not arrive as zero findings. Both distinctions ' +
			'exist ONLY in the JSON shape: the human output collapses each into one summary line.',
	},
	{
		sub: 'node-users',
		hostBound: false,
		argv: ['--json'],
		job: 'ci:node-users',
		consumer: 'services/mgmt-api/src/routes/jobs/node-users-check.ts',
		why:
			'Who runs CI on each claw, read from the node (node users, 2026-10-27). Built in ' +
			'0.34.100 and run by nothing until 2026-10-28 — the same shape as ci:fleet-inventory ' +
			'and ci:health-freshness above. A node still running CI as admin is `state: ' +
			'"not-cut-over"`: the state the cutover plan is moving AWAY from, reported with an ' +
			'advisory and never a failure, so the consumer carries the count as data. `ok` is ' +
			'false only for a node that did not answer (and is not expected down) or a cut-over ' +
			'node that drifted. The consumer ALSO fails on any `class: "blocking"` finding on an ' +
			'answered node, which today adds exactly one case `ok` does not cover: ' +
			'`runner-secret-in-argv` on a node not yet cut over. Those distinctions exist ONLY in ' +
			'the JSON shape; the human output is one line per node.',
	},
	{
		sub: 'runner-units',
		hostBound: false,
		argv: ['--json'],
		job: 'ci:runner-units',
		consumer: 'services/mgmt-api/src/routes/jobs/runner-units-check.ts',
		why:
			'Does every standing runner install on a node name a live, on-roster, unarchived repo. ' +
			"Reads the BOX, not GitHub: a runner whose registration died appears in no repo's " +
			'runner list, which is how claw-1 and claw-2 carried six crash-looping installs ' +
			'(11,126 and 8,422 restarts) while `reconcile` reported clean on 2026-09-03. Nothing ran ' +
			'it until 2026-10-28. Its JSON separates `findings` from `unreachable`, ' +
			'`rosterUnresolved` and `lookupFailed` (each with a reason), and a run that could not ' +
			'start — no manifest, zero nodes selected — still emits a document with `error`, so ' +
			'"GitHub could not be asked" never arrives as GONE and "probed nothing" never as clean.',
	},
	{
		sub: 'fleet-kills',
		hostBound: false,
		argv: ['--days', '2', '--json'],
		job: 'ci:fleet-kills',
		consumer: 'services/mgmt-api/src/routes/jobs/fleet-kills-check.ts',
		why:
			'Did the FLEET stop a job at a unit TTL, rather than the job failing (#22). Reads only ' +
			'job history — completed jobs, after the fact — so it is nightly in repo-sync, not ' +
			"fleet-pulse: the evidence exists only once a job has already died, and today's TTL " +
			"(23,400 s) sits above GitHub's own 6 h job ceiling, so a new match means a TTL " +
			'regression shipped by a release. `--days 2` and not the default 14: history is ' +
			'immutable, so a 14-day window would hold one kill red for a fortnight; 48 h still ' +
			'reads every record at least once on a daily cadence (a job is written when it ends, ' +
			'at most 6.5 h after it started). `kills` and `nearTtl` are separate, and the three ' +
			'refusals (`bad-days`, `no-history`, `no-records-in-window`) arrive as `ok: false` ' +
			'with `why` — zero records scanned is not a clean window.',
	},
];

/**
 * The `COMMANDS` table in `src/cli.ts`, as `subcommand -> script`.
 *
 * Parsed from source rather than imported: `src/cli.ts` is the CLI entry point
 * and runs `process.argv` at module scope, so importing it would execute it.
 * `tsconfig.json` has no `allowJs` either, which is the same reason
 * `node-identity-guard.test.mjs` lives in this directory.
 *
 * Comments must be blanked before calling this. A commented-out table entry is
 * not a subcommand, and this repo has been bitten three times by a grep that
 * read a COMMENT as evidence.
 */
export function parseCliCommands(blankedSource) {
	const start = blankedSource.indexOf('const COMMANDS');
	if (start === -1) return new Map();
	const end = blankedSource.indexOf('\n};', start);
	if (end === -1) return new Map();
	const table = blankedSource.slice(start, end);

	const out = new Map();
	// A table entry: one tab of indent, an optionally-quoted key, then the
	// `script:` field somewhere inside its braces.
	const ENTRY = /\n\t(?:'([a-z0-9-]+)'|([a-z0-9-]+)):\s*\{[\s\S]*?script:\s*'([^']+)'/g;
	for (const m of table.matchAll(ENTRY)) out.set(m[1] ?? m[2], m[3]);
	return out;
}

/**
 * Does this source BIND a flag from `--json`, rather than merely mention it?
 *
 * Every implementer follows one convention — `const JSON_OUT = <argv test>` —
 * so the rule can require the binding rather than the substring. Pass blanked
 * source: five of these scripts document `--json` in their own header prose,
 * and one of them (`check-capability-schema.mjs`) writes the sentence
 * "`--json` is a contract: cron jobs parse this stdout" directly above the line
 * that implements it.
 *
 * A SECOND SPELLING, arrived at honestly rather than by design: `inventory`
 * hands the WHOLE decision to the shared emitter — a bare `createEmitter()`,
 * no options — so the binding lives in lib/emit.mjs (`opts.json ??
 * argv.includes('--json')`) rather than in the script. That is not a hole in
 * the rule but a different place the rule's question is answered, and the
 * guarantee is held beside it: `emit.test.mjs` already fails any contract
 * script that writes stdout outside `emit()` or never references
 * `createEmitter`. Only the BARE call is accepted — `createEmitter({ json: ... })`
 * with arguments says nothing about where the flag came from, so a script
 * using that form still has to bind `JSON_OUT` itself to pass.
 *
 * A THIRD SPELLING, for the same reason and with the same test:
 * `createEmitter({ argv: process.argv })`. It is the bare call with the argv
 * named rather than defaulted — `lib/emit.mjs` still answers the flag question
 * (`opts.json ?? argv.includes('--json')`), and the argument says WHICH argv, so
 * the flag provably comes from this process's command line. `health-freshness`
 * uses it and holds `out.json` as its only record of the mode, so there is no
 * `JSON_OUT` for the first rule to find.
 *
 * THE ARGUMENT IS MATCHED, NOT JUST THE KEY. `process.argv` exactly — a fixture
 * array (`createEmitter({ argv: ['--json'] })`, which several tests pass) says
 * nothing about the real command line, and `{ json: ... }` still says nothing
 * about where the flag came from. Both are rejected, so accepting this spelling
 * widens the rule by one provable form rather than by a family of them.
 */
export function bindsJsonFlag(blankedSource) {
	return (
		/const\s+JSON_OUT\s*=\s*[^;\n]*--json/.test(blankedSource) ||
		/\bcreateEmitter\s*\(\s*\)/.test(blankedSource) ||
		/\bcreateEmitter\s*\(\s*\{\s*argv:\s*process\.argv\s*,?\s*\}\s*\)/.test(blankedSource)
	);
}

/**
 * Does it branch on that flag and emit a JSON document?
 *
 * TWO SPELLINGS OF "EMIT", because there are two. `JSON.stringify` was the only
 * one until the shared emitter landed; a contract script now hands its payload
 * to `emit()` (lib/emit.mjs) and never serialises it itself, which is the whole
 * point — the emitter is the only code that can write stdout, so "print before
 * the JSON" stops being reachable rather than merely being absent.
 *
 * Both are accepted rather than the new one alone: `check-capability-schema`
 * and the other non-contract implementers still stringify directly, and this
 * predicate is exported and used against them too. A migration that made this
 * gate reject the OLD shape would fail scripts that are perfectly correct.
 *
 * And TWO SPELLINGS OF "BRANCH", for the same reason `bindsJsonFlag` has two: a
 * self-binding script branches on its own `JSON_OUT`, a delegating one on the
 * emitter's own flag (`if (emitter.json)`). Same requirement either way — the
 * JSON branch must exist and must be the thing that emits.
 */
export function emitsJson(blankedSource) {
	const branchesOnTheFlag =
		/if\s*\(\s*JSON_OUT\s*\)/.test(blankedSource) || /if\s*\(\s*\w+\.json\s*\)/.test(blankedSource);
	return (
		branchesOnTheFlag &&
		(/JSON\.stringify/.test(blankedSource) || /\bemit\s*\(/.test(blankedSource))
	);
}

/**
 * THE PROSE CONSUMER. One entry, and it is the one this file existed without.
 *
 * `ci:audit-gates` runs THIRTEEN subcommands through this CLI and judges each by
 * a regex over `stdout + stderr` — `audit-gates.ts` merges the two
 * UNCONDITIONALLY, on the success path, into a value two rules then read. It is
 * not a JSON consumer, so `JSON_CONTRACT` never named it and the producer-side
 * test could not see it. Anything this CLI writes on EITHER stream therefore
 * becomes part of thirteen gates' verdicts.
 *
 * WHAT WENT WRONG, MEASURED. The provenance banner (issue #4) landed on stderr
 * for every subcommand, and:
 *
 *   1. `spawnError: out.trim() ? undefined : e.message` became unreachable for
 *      all thirteen — the banner is never empty — so "it never started (missing
 *      script, broken interpreter)" stopped being distinguishable from an
 *      ordinary failure. It still FAILS, so this is a lost diagnosis rather than
 *      a false pass, but it is CLAUDE.md's "say WHY" rule losing a distinction
 *      that was deliberately built.
 *
 *   2. The banner carries OPERATOR-CONTROLLED PATHS, and a path can satisfy a
 *      gate's `evidence` on its own. Measured against the deployed table: with
 *      `HADOKU_SITE_ROOT=~/repos/hadoku_site`, the substring `repos` satisfies
 *      `check:ci-watch` (`/target|repo|watch/i`), so a gate that exited 0 having
 *      printed NOTHING reported `ok: true` where it used to report `exited 0 but
 *      printed nothing showing it looked`. The cron's `REPOS_DIR` defaults to
 *      `~/srv`, so the scheduled job was clean — a coincidence of one default,
 *      not a property. And it is not one unlucky regex: a checkout under
 *      `~/tools` would satisfy `check:tool-inventory` (`/tool|workflow|invoke/i`)
 *      the same way. CLAUDE.md: "no gate may get EASIER to pass the worse the
 *      failure gets."
 *
 * THE FIX IS SUPPRESSION, NOT STRIPPING. `audit-gates.ts` passes
 * `FLEET_NO_BANNER=1` and reports provenance once for the whole job instead of
 * thirteen times inside thirteen gate verdicts. A consumer-side regex that
 * stripped the banner would be a string-shape contract between two repos with
 * nothing holding it: change the banner's format and the strip silently stops
 * working, which is a hand-kept marker wearing a different hat. An env var is a
 * CAPABILITY contract — it is implemented here, tested here, and cannot go stale
 * without failing.
 *
 * `check-contract-consumers.mjs` verifies both halves against the real
 * hadoku_site checkout, so this is a gate rather than a note.
 */
export const PROSE_CONTRACT = [
	{
		job: 'ci:audit-gates',
		consumer: 'services/mgmt-api/src/routes/jobs/audit-gates.ts',
		/** The env var the consumer must set. The mechanism, named so it is checkable. */
		requires: 'FLEET_NO_BANNER',
		why:
			"Runs every `script: 'fleet'` gate in its GATES table through this CLI and " +
			'judges each by a regex over stdout+stderr merged — count the entries, do ' +
			'not trust a number written here; this sentence carried 13 and went stale ' +
			'the day `check:warm-canary` was added. Anything the CLI WRAPPER writes — ' +
			'as opposed to the subcommand — becomes part of every one of those ' +
			'verdicts and can both satisfy `evidence` and mask `spawnError`. It reads ' +
			'output as PROSE, so no --json contract covers it and the producer-side ' +
			'test cannot see it.',
	},
];

/**
 * A TENANT reads these, not a cron job: hadoku-cardtable's coordinator (lane D,
 * placement and failover, `apps/server/src/play/remote/`), declared by it on
 * 2026-10-27. It drains matches off a node before a hosting end or a reboot
 * from `notices`, and places by `ok`, `hosting.state` and `ciUser.state`.
 *
 * Each `fields` entry is a dotted path into the document, `[]` marking an
 * array. Renaming or dropping one breaks a live game's failover, so the
 * contract is: TELL CARDTABLE FIRST. `json-contract.test.mjs` pins every
 * path against the producing source and, for the hosting judgement, against
 * the function's output.
 */
export const TENANT_CONTRACT = [
	{
		sub: 'node-status',
		argv: ['--json'],
		consumer: 'hadoku-cardtable apps/server/src/play/remote/ (lane D)',
		fields: [
			// Added 2026-10-28 (fleet-manager#16), agreed with cardtable: the
			// version it pins, when the document was observed, and whether it is
			// a `--max-age` copy.
			'contract',
			'generatedAt',
			'cached',
			'nodes[].node',
			'nodes[].reachable',
			'nodes[].ok',
			'nodes[].findings[].class',
			'nodes[].findings[].category',
			'nodes[].notices[].event',
			'nodes[].notices[].at',
			'nodes[].notices[].kind',
			'nodes[].ciUser.state',
			'nodes[].hosting.state',
			'nodes[].hosting.declared.memoryMb',
			'nodes[].hosting.declared.cores',
			'nodes[].hosting.declared.port',
			'nodes[].hosting.observed.agent',
			'nodes[].hosting.observed.portReach',
			'nodes[].hosting.observed.memoryInUseMb',
			'nodes[].hosting.until',
		],
	},
	{
		sub: 'hosting',
		argv: ['--check', '--json'],
		consumer: 'hadoku-cardtable apps/server/src/play/remote/ (lane D)',
		fields: ['ok', 'nodes[].node', 'nodes[].state', 'nodes[].findings', 'nodes[].declared'],
	},
	{
		sub: 'hosting-demand',
		argv: ['cardtable', '--slices', '1', '--json'],
		consumer:
			'hadoku-cardtable: restates its slice count every poll once placement.auto is approved (fleet-manager#16)',
		fields: [
			'contract',
			'ok',
			'at',
			'demand',
			'declared[].node',
			'ending[].node',
			'ending[].until',
			'lastPass.live',
			'lastPass.actions[].op',
			'lastPass.actions[].node',
			'lastPass.blocked[].why',
		],
	},
	{
		sub: 'hosting-plan',
		argv: ['WolffM/hadoku-cardtable', '--json'],
		consumer:
			'hadoku-cardtable lane D: names the next slice in its Capacity alert (never declares one)',
		fields: [
			'plan.ranked[].node',
			'plan.ranked[].ciJobs.before',
			'plan.ranked[].ciJobs.after',
			'plan.ranked[].memoryLeftMb',
			'plan.ranked[].cutOver',
			'plan.ranked[].risk',
			'plan.refused[].node',
			'plan.refused[].reasons',
		],
	},
];

/**
 * The `GATES` table in hadoku_site's `audit-gates.ts`, as
 * `[{ id, script, sub, evidence }]`.
 *
 * Parsed from source for the same reason `parseCliCommands` is: it is another
 * repo's module and importing it would run its imports. Pass BLANKED source —
 * every gate carries a `why` paragraph, and several of those quote regex
 * fragments and the word `evidence` in prose.
 *
 * `script: 'fleet'` is the discriminator that matters. Only those gates spawn
 * this CLI, so only those can ever see anything this CLI writes; the other six
 * run `scripts/admin/*.mjs` and are not ours to reason about.
 */
export function parseAuditGates(blankedSource) {
	const start = blankedSource.indexOf('const GATES');
	if (start === -1) return [];
	const end = blankedSource.indexOf('\n];', start);
	if (end === -1) return [];

	const out = [];
	// Entries are one tab in. Splitting on the brace that opens each is what
	// keeps a `why` paragraph from bleeding one entry's fields into the next.
	for (const entry of blankedSource
		.slice(start, end)
		.split(/\n\t\{\n/)
		.slice(1)) {
		const id = /\bid: '([^']+)'/.exec(entry)?.[1];
		const script = /\bscript: '([^']+)'/.exec(entry)?.[1];
		const sub = /\bsub: '([^']+)'/.exec(entry)?.[1] ?? null;
		const evidence = /\bevidence: (\/(?:\\.|\[[^\]]*\]|[^/\\\n])+\/[a-z]*)/.exec(entry)?.[1];
		if (id && script && evidence) out.push({ id, script, sub, evidence });
	}
	return out;
}

/**
 * Does this consumer actually SUPPRESS the banner, rather than merely mention it?
 *
 * The assignment, not the substring. The name appears in that file's own prose
 * explaining why it is set, and this repo has read a comment as evidence three
 * times — so blank comments first and require the `FLEET_NO_BANNER: '1'`
 * property form that puts it in a child's environment.
 */
export function suppressesBanner(blankedSource) {
	return /FLEET_NO_BANNER\s*:\s*['"]1['"]/.test(blankedSource);
}

/** A `/body/flags` string from {@link parseAuditGates}, as a real RegExp. */
export function evidenceRegExp(literal) {
	const cut = literal.lastIndexOf('/');
	return new RegExp(literal.slice(1, cut), literal.slice(cut + 1));
}
