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
 *
 * SINCE WAVE 5E (plan §6.2 item 4): the list below is DERIVED from
 * `src/lib/job-registry.ts`'s `JOB_REGISTRY`, not hand-written. That file is
 * the one place cadence and detection budget live; this one stays the
 * declaration of WHO READS IT, in the exact shape every consumer below
 * already depends on (`sub`, `hostBound`, `argv`, `job`, `consumer`, `why`).
 * `json-contract.test.mjs` pins the derived list against today's 22 entries
 * BY NAME, so a registry change that silently drops or renames one still
 * fails the build the same way an edit to a hand list used to.
 */
import { JOB_REGISTRY } from '../../dist/lib/job-registry.js';

/**
 * `JOB_REGISTRY` entries with `contract: 'json'`, reshaped into the exact
 * fields every consumer of `JSON_CONTRACT` already reads. `hostBound`
 * defaults to `false` rather than being required in the registry's own
 * shape, because every in-process entry (not under this contract at all)
 * would otherwise need to carry a field that means nothing for it.
 *
 * SINCE WAVE 5F LANE B: also folds in every `coversSubs` row that carries its
 * OWN `contract: 'json'` — a gate migrated off the prose umbrella one at a
 * time (plan §6.2). Its `job`/`consumer` are the UMBRELLA's (`ci:audit-gates`
 * / `audit-gates.ts`): there is no second cron and no second mgmt-api route,
 * only the same invocation now passing `--json` for this one sub. See
 * `CoveredSub`'s own doc comment in `job-registry.ts`.
 */
function deriveJsonContract(registry) {
	const direct = registry
		.filter((e) => e.contract === 'json')
		.map((e) => ({
			sub: e.sub,
			hostBound: e.hostBound ?? false,
			argv: e.args,
			job: e.name,
			consumer: e.mgmtApiFile,
			why: e.why,
		}));
	const migrated = registry.flatMap((e) =>
		(e.coversSubs ?? [])
			.filter((c) => c.contract === 'json')
			.map((c) => ({
				sub: c.sub,
				hostBound: c.hostBound ?? false,
				argv: c.args,
				job: e.name,
				consumer: e.mgmtApiFile,
				why: c.why,
			}))
	);
	return [...direct, ...migrated];
}

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
export const JSON_CONTRACT = deriveJsonContract(JOB_REGISTRY);

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
 * The same `COMMANDS` table, read for its `kind` field instead of `script`
 * (wave 5e lane A, `job-registry-guard.test.mjs`): does every automated
 * subcommand (`gate` | `converger` | `recorder`) have a clock in
 * `src/lib/job-registry.ts`, or an explicit `manual: '<why>'` there?
 *
 * Non-greedy to the first `kind:` after each entry's opening brace, same
 * reasoning as `parseCliCommands`'s stop at the first `script:` — every real
 * entry carries exactly one `kind` field, so the nearest one is always this
 * entry's own, never a later entry's. Pass BLANKED source for the same reason
 * as every other parser here: a commented-out `kind:` must not be read as one.
 */
export function parseCliCommandKinds(blankedSource) {
	const start = blankedSource.indexOf('const COMMANDS');
	if (start === -1) return new Map();
	const end = blankedSource.indexOf('\n};', start);
	if (end === -1) return new Map();
	const table = blankedSource.slice(start, end);

	const out = new Map();
	const ENTRY = /\n\t(?:'([a-z0-9-]+)'|([a-z0-9-]+)):\s*\{[\s\S]*?kind:\s*'([a-z-]+)'/g;
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
 *
 * THE "THIRTEEN" ABOVE IS THE 2026-09-07 MEASUREMENT, not a live count — wave
 * 5f lane B starts moving them to `JSON_CONTRACT` instead, one at a time (a
 * migrated sub's `--json` output is still merged into `out` the same way by
 * `audit-gates.ts`'s `runGate`, harmlessly, because that file judges a
 * migrated gate by its parsed `GateDoc` before it ever looks at `evidence`).
 * `PROSE_CONTRACT.length` stays `1` regardless — see the module header on
 * `coversSubs`: the row IS the umbrella, not a per-sub count.
 *
 * SINCE WAVE 5E: derived from `JOB_REGISTRY`'s one `contract: 'prose'` entry
 * (`ci:audit-gates`), same reasoning as `JSON_CONTRACT` above. `requires` is
 * hardcoded here rather than carried on the registry entry — it is a fact
 * about THIS contract's own mechanism (the env var a prose consumer must set
 * to stop reading the banner as evidence), not a property every job in the
 * registry needs a field for.
 */
function deriveProseContract(registry) {
	return registry
		.filter((e) => e.contract === 'prose')
		.map((e) => ({
			job: e.name,
			consumer: e.mgmtApiFile,
			requires: 'FLEET_NO_BANNER',
			why: e.why,
		}));
}

export const PROSE_CONTRACT = deriveProseContract(JOB_REGISTRY);

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
