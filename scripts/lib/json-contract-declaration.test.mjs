/**
 * The `--json` contract's own shape: the CLI table, the host-bound set, the
 * `bindsJsonFlag`/`emitsJson`/`suppressesBanner` spelling rules, the prose
 * contract's parser and its README sync, the registry-derived pins, and
 * `parseCliCommandKinds`. Everything here is checked by reading SOURCE TEXT
 * — `src/cli.ts`, `json-contract.mjs`'s own tables, README.md — and never by
 * spawning the built CLI; `json-contract-provenance.test.mjs` and
 * `json-contract-benchmark.test.mjs` are the halves that do.
 *
 * Split out of `json-contract.test.mjs` (wave 5s lane B) to bring that file
 * under the 1,000-line test ceiling — a whole-block move, every test body
 * below unchanged from where it lived there.
 *
 * It lives in the scripts half for the same two reasons as
 * `node-identity-guard.test.mjs`: it imports `blankComments` (which
 * `tsconfig.json` cannot, with no `allowJs`) and it reads the SOURCE tree, so a
 * test compiled into `dist/tests/` would be looking at the wrong files.
 *
 * COMMENTS ARE BLANKED FIRST, including in this file's own subject matter.
 * Several of these scripts print their own `--json` usage in a header comment,
 * and one writes the words "`--json` is a contract" immediately above the line
 * that implements it. Prose must neither trip this rule nor satisfy it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments } from './blank-comments.mjs';
import {
	JSON_CONTRACT,
	PROSE_CONTRACT,
	parseCliCommands,
	parseCliCommandKinds,
	parseAuditGates,
	bindsJsonFlag,
	emitsJson,
	evidenceRegExp,
	suppressesBanner,
} from './json-contract.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CLI = join(ROOT, 'src', 'cli.ts');

/**
 * A floor, not the count. Measured 2026-08-30: `COMMANDS` held 23 entries. The
 * number moves — subcommands are being added on another branch as this lands —
 * but a parse that yields a handful means the regex stopped matching the table,
 * and every assertion below would then pass over nothing. Zero repos scanned is
 * a failure; so is zero subcommands parsed.
 */
const MIN_COMMANDS = 15;

const commands = parseCliCommands(blankComments(readFileSync(CLI, 'utf8')));

void test('the CLI table is readable at all — a parse of nothing is not a pass', () => {
	assert.ok(
		commands.size >= MIN_COMMANDS,
		`parsed ${commands.size} subcommand(s) from src/cli.ts, expected at least ${MIN_COMMANDS}. ` +
			'The COMMANDS table moved or changed shape, so every --json contract check below ' +
			'is looking at an empty map and asserting nothing.'
	);
});

void test('the contract names no subcommand and no script that has been removed', () => {
	// This is the failure that is completely silent from inside this repo:
	// mgmt-api spawns `node <cli> <sub> --json`, so a renamed subcommand exits 1
	// with `fleet: unknown subcommand` and the cron reports ITS OWN breakage
	// instead of the fleet's, nightly, until someone reads a log.
	for (const entry of JSON_CONTRACT) {
		const script = commands.get(entry.sub);
		assert.ok(
			script,
			`${entry.job} runs \`fleet ${entry.sub} ${entry.argv.join(' ')}\`, and "${entry.sub}" is ` +
				`no longer in the COMMANDS table in src/cli.ts. Renaming a subcommand is a ` +
				`cross-repo change: fix ${entry.consumer} in hadoku_site in the same pass, or ` +
				`that cron fails every night with an unknown-subcommand error.`
		);
		assert.ok(
			existsSync(join(ROOT, 'scripts', script)),
			`fleet ${entry.sub} maps to scripts/${script}, which does not exist`
		);
	}
});

void test('every subcommand under contract actually implements --json', () => {
	for (const entry of JSON_CONTRACT) {
		const script = commands.get(entry.sub);
		if (!script) continue; // already reported above
		const src = blankComments(readFileSync(join(ROOT, 'scripts', script), 'utf8'));
		assert.ok(
			bindsJsonFlag(src),
			`scripts/${script} (fleet ${entry.sub}) no longer binds --json to a flag. ` +
				`${entry.job} parses its stdout as JSON and checks that BEFORE the exit code, ` +
				`so human output here reads to the cron as a broken checker rather than a finding.`
		);
		assert.ok(
			emitsJson(src),
			`scripts/${script} (fleet ${entry.sub}) binds --json but has no \`if (JSON_OUT)\` ` +
				`branch emitting a JSON document.`
		);
	}
});

void test('the contract itself is well-formed', () => {
	const seen = new Set();
	for (const entry of JSON_CONTRACT) {
		assert.ok(!seen.has(entry.sub), `${entry.sub} is declared twice`);
		seen.add(entry.sub);
		assert.ok(
			entry.argv.includes('--json'),
			`${entry.job} is declared as a JSON consumer but its argv does not pass --json`
		);
		// `why` is not decoration. Every one of these costs a cross-repo change to
		// remove, and an entry nobody can justify is an entry nobody dares delete.
		assert.ok(entry.why && entry.job && entry.consumer, `${entry.sub} is missing a field`);
		// #79 Lane 2/3: every entry must say HOST-BOUND or not, not merely have
		// the key present with some truthy-ish value — `typeof ... === 'boolean'`
		// fails on `undefined` (missing), `'true'` (string), `1` (number) and
		// every other near-miss a copy-paste could introduce. A subcommand added
		// to JSON_CONTRACT without this field is a subcommand nobody has decided
		// can run on a passive replica's OWN inputs or must run on the
		// controller's — see docs/control-plane.md.
		assert.equal(
			typeof entry.hostBound,
			'boolean',
			`${entry.sub} must declare hostBound: true or false (#79 Lane 2/3) — got ${JSON.stringify(entry.hostBound)}`
		);
	}
});

/**
 * THE THREE HOST-BOUND ENTRIES, PINNED.
 *
 * `hostBound: true` means the subcommand reads something that belongs to THIS
 * box specifically rather than the fleet — see the field's own doc comment in
 * json-contract.mjs. This is a REGRESSION test, not a structural one: it does
 * not re-derive which entries are host-bound from the source (that would just
 * be the declaration checking itself), it pins them by hand, so that flipping
 * one — or adding a fourth without updating this list — fails loudly instead
 * of silently changing what an active/passive split is allowed to assume.
 *
 * There were eight. header-audit, identity-model, inventory, check-runner-var
 * and check-site-token read sibling checkouts under REPOS_DIR, and since
 * fleet-manager#7 read each repo's default branch through lib/fleet-source.mjs
 * instead, which any host can do.
 *
 * TWO MORE JOINED WAVE 5F LANE B's MIGRATION, deliberately: `history-coverage`
 * reads `job-history.jsonl` under `HADOKU_STATE_DIR` — THIS process's own
 * recorded ingest (docs/control-plane.md §2: "safe to hand from one
 * controller to the next" but a different answer on a passive replica than
 * the active one), and `contract-consumers` reads a real `hadoku_site`
 * checkout off local disk (`siteRoot()`/`reposDir()`) rather than through
 * `lib/fleet-source.mjs` — the pre-#7 class every other migrated entry here
 * already left behind. `warm-canary`, migrated the same wave, is NOT
 * host-bound: it ssh's the CANDIDATE nodes, the same class as node-users and
 * runner-units.
 *
 * ONE MORE JOINED WAVE 5I LANE B's MIGRATION: `label-floor` reads BOTH
 * `job-history.jsonl` (the observed-demand half) AND `demand-ledger.jsonl`
 * under `HADOKU_STATE_DIR` — the same file and the same reasoning as
 * `history-coverage` above. `throttle`, migrated the same wave, is NOT
 * host-bound: it ssh's the CANDIDATE nodes, the same class as warm-canary
 * and capabilities (its one locally-resolved value, RESERVE_FILE, is never
 * read back as a fact about the fleet — see `src/lib/job-registry.ts`'s
 * entry for the detail).
 */
const HOST_BOUND_SUBS = [
	'contract-consumers',
	'egress-slices',
	'history-coverage',
	'hosting-placement',
	'label-floor',
	'reap-trend',
	'srv-drift',
].sort();

void test('the host-bound declaration matches the evidenced three, exactly', () => {
	const actual = JSON_CONTRACT.filter((e) => e.hostBound === true)
		.map((e) => e.sub)
		.sort();
	assert.deepEqual(
		actual,
		HOST_BOUND_SUBS,
		'hostBound: true has drifted from the #79-evidenced set. If a subcommand genuinely ' +
			'changed what it reads (no longer this host-s pm2/cgroups/log, or no longer a ' +
			'sibling checkout), update HOST_BOUND_SUBS here AND docs/control-plane.md in the ' +
			'same pass — this list is the thing the doc cites, not a copy of it.'
	);
	// Every one of them must still be an entry at all — a rename that
	// slipped the sub through the OTHER tests (e.g. renamed on both sides at
	// once) would otherwise make this list compare against nothing.
	const subs = new Set(JSON_CONTRACT.map((e) => e.sub));
	for (const sub of HOST_BOUND_SUBS) {
		assert.ok(subs.has(sub), `${sub} is pinned host-bound here but is no longer in JSON_CONTRACT`);
	}
});

void test('prose about --json can neither satisfy nor trip the rule', () => {
	// The negative control. Without it this whole gate degrades into a grep for
	// a string that five of these files print in their own documentation — which
	// is the exact mistake that cleared a security rule in reconcile-repo-policy,
	// credited an unschedulable gate in check-gate-coverage, and planned nine
	// runner registrations off a workflow comment saying the repo was NOT on the
	// fleet. Three times, three different files.
	const proseOnly = [
		'/**',
		" * Usage: fleet foo --json    (const JSON_OUT = process.argv.includes('--json'))",
		' * if (JSON_OUT) { console.log(JSON.stringify(report)); }',
		' */',
		"console.log('hello');",
	].join('\n');
	assert.equal(bindsJsonFlag(blankComments(proseOnly)), false, 'a comment satisfied the rule');
	assert.equal(emitsJson(blankComments(proseOnly)), false, 'a comment satisfied the rule');

	const real = ["const JSON_OUT = process.argv.includes('--json');", 'if (JSON_OUT) {'].join('\n');
	assert.equal(bindsJsonFlag(blankComments(real)), true, 'real code failed the rule');
	assert.equal(
		emitsJson(blankComments(`${real}\nJSON.stringify({});`)),
		true,
		'real code failed the rule'
	);
	// The emitter spelling, held to the same standard as the old one. A contract
	// script now hands its payload to `emit()` and never stringifies it, so this
	// branch carries seven of the seven jobs; a comment must not satisfy it.
	assert.equal(
		emitsJson(blankComments(`${real}\nemitter.emit({ ok: true });`)),
		true,
		'the emitter spelling failed the rule'
	);
	assert.equal(
		emitsJson(blankComments(['/**', ' * if (JSON_OUT) emitter.emit({});', ' */'].join('\n'))),
		false,
		'a comment describing emit() satisfied the rule'
	);
	// The DELEGATED spelling, added for `inventory`: a script that hands the
	// whole flag decision to the shared emitter binds `--json` in lib/emit.mjs
	// and branches on the emitter's own flag. Real code passes; prose describing
	// it must not; and an emitter constructed with ARGUMENTS is NOT the bare
	// call — `createEmitter({ json: false })` could hardcode human mode, so a
	// script using that form still has to bind JSON_OUT itself to pass.
	const delegated = [
		'const emitter = createEmitter();',
		'if (emitter.json) emitter.emit({});',
	].join('\n');
	assert.equal(bindsJsonFlag(blankComments(delegated)), true, 'real code failed the rule');
	assert.equal(emitsJson(blankComments(delegated)), true, 'real code failed the rule');
	assert.equal(
		bindsJsonFlag(blankComments(['/**', ' * const emitter = createEmitter();', ' */'].join('\n'))),
		false,
		'a comment describing the delegation satisfied the rule'
	);
	assert.equal(
		emitsJson(blankComments(['/**', ' * if (emitter.json) emitter.emit({});', ' */'].join('\n'))),
		false,
		'a comment describing the delegated branch satisfied the rule'
	);
	assert.equal(
		bindsJsonFlag(blankComments('const e = createEmitter({ json: false });')),
		false,
		'an emitter with arguments is not the bare call — the script must bind the flag itself'
	);
	assert.equal(
		bindsJsonFlag(blankComments('const e = createEmitter({ json: JSON_OUT });')),
		false,
		'the { json: JSON_OUT } form is only sound when JSON_OUT is bound where the rule can see it'
	);
	// The THIRD spelling, added for `health-freshness`: the bare call with the
	// argv NAMED rather than defaulted. `lib/emit.mjs` still reads `--json` out
	// of it, and naming `process.argv` is what says the flag came from this
	// process's command line.
	const named = [
		'const out = createEmitter({ argv: process.argv });',
		'if (out.json) out.emit({});',
	].join('\n');
	assert.equal(bindsJsonFlag(blankComments(named)), true, 'real code failed the rule');
	assert.equal(emitsJson(blankComments(named)), true, 'real code failed the rule');
	assert.equal(
		bindsJsonFlag(
			blankComments(['/**', ' * createEmitter({ argv: process.argv });', ' */'].join('\n'))
		),
		false,
		'a comment describing the named-argv form satisfied the rule'
	);
	// A FIXTURE ARRAY IS NOT THE COMMAND LINE. Several tests in this package
	// construct an emitter over a literal argv to exercise both modes, and that
	// argument says nothing about what the process was actually invoked with —
	// so the rule matches `process.argv` and not merely the `argv:` key.
	assert.equal(
		bindsJsonFlag(blankComments("const e = createEmitter({ argv: ['--json'] });")),
		false,
		'a fixture argv satisfied the rule — only process.argv proves the real command line'
	);
});

/**
 * THE PROSE CONTRACT'S PARSER, offline.
 *
 * `check-contract-consumers` reads hadoku_site's `audit-gates.ts` and judges it,
 * which needs a sibling checkout and therefore cannot run in `pnpm run check`.
 * What CAN run here is the reading itself — and a parser that silently returns
 * nothing would make that gate report a clean sweep of a file it failed to
 * understand, which is the exact shape of every failure this file guards.
 */
const AUDIT_GATES_FIXTURE = [
	'export const GATES: Gate[] = [',
	'\t{',
	"\t\tid: 'check:site-install',",
	"\t\tscript: 'check-site-install.mjs',",
	'\t\targs: [],',
	'\t\tevidence: /@wolffm|site install/i,',
	"\t\twhy: 'A why paragraph that says evidence and script: and id: in prose.',",
	'\t},',
	'\t{',
	"\t\tid: 'check:ci-watch',",
	"\t\tscript: 'fleet',",
	"\t\tsub: 'ci-watch',",
	'\t\targs: [],',
	'\t\tevidence: /target|repo|watch/i,',
	"\t\twhy: 'Another one.',",
	'\t},',
	'];',
].join('\n');

void test('parseAuditGates reads id, script, sub and evidence, and does not bleed across entries', () => {
	const gates = parseAuditGates(blankComments(AUDIT_GATES_FIXTURE));
	assert.equal(gates.length, 2);
	assert.deepEqual(gates[0], {
		id: 'check:site-install',
		script: 'check-site-install.mjs',
		sub: null,
		evidence: '/@wolffm|site install/i',
	});
	// The `why` paragraph above writes `script:` and `id:` in prose. An entry
	// splitter that missed the boundary would take the NEXT entry's fields, or
	// this one's prose, and report a gate that does not exist.
	assert.deepEqual(gates[1], {
		id: 'check:ci-watch',
		script: 'fleet',
		sub: 'ci-watch',
		evidence: '/target|repo|watch/i',
	});
});

void test('a table it cannot find yields nothing — and the gate treats that as a failure', () => {
	// Not a pass. `check-contract-consumers` holds a floor on the fleet-gate
	// count for exactly this: a rename of GATES must fail loudly rather than
	// clear every rule by having nothing to check.
	assert.deepEqual(parseAuditGates('const SOMETHING_ELSE = [];'), []);
});

void test('evidenceRegExp rebuilds a working regex, flags included', () => {
	const re = evidenceRegExp('/target|repo|watch/i');
	assert.equal(re.test('/home/hadoku/REPOS/hadoku_site'), true, 'the i flag was dropped');
	assert.equal(re.test('site=/home/hadoku/srv/hadoku_site'), false);
	// The measured case, stated as a fact rather than a story: this is why the
	// banner had to be suppressed rather than reasoned about.
	assert.equal(re.test('site=/home/hadoku/repos/hadoku_site fleet-manager=0.22.25'), true);
});

void test('suppressesBanner requires the assignment, not the word', () => {
	// The negative control this file insists on everywhere else. `audit-gates.ts`
	// explains FLEET_NO_BANNER at length in its own header, and a substring grep
	// would score that prose as the fix being in place — the mistake that cleared
	// a security rule in reconcile-repo-policy and credited an unschedulable gate
	// in check-gate-coverage.
	const prose = ['/**', " * Sets FLEET_NO_BANNER: '1' on the gate environment.", ' */'].join('\n');
	assert.equal(suppressesBanner(blankComments(prose)), false, 'a comment satisfied the rule');
	assert.equal(suppressesBanner(blankComments("FLEET_NO_BANNER: '1',")), true);
	assert.equal(suppressesBanner(blankComments('FLEET_NO_BANNER: "1",')), true);
	// Mentioning it without setting it is the state this rule exists to catch.
	assert.equal(suppressesBanner(blankComments('delete env.FLEET_NO_BANNER;')), false);
});

void test('the prose contract is well-formed and names a distinct consumer', () => {
	assert.ok(PROSE_CONTRACT.length, 'PROSE_CONTRACT is empty — the prose half checks nothing');
	// Wave 5f lane B: a consumer in BOTH lists is no longer automatically a
	// bug. `ci:audit-gates` migrates its own covered subs off prose ONE AT A
	// TIME, so its own consumer (`audit-gates.ts`) legitimately shows up in
	// JSON_CONTRACT (for the migrated subs) AND in PROSE_CONTRACT (the
	// umbrella row, for the rest) at once — same job, same file, by design.
	// What the original rule actually guarded against survives: a DIFFERENT
	// job sharing a prose consumer's file with some JSON entry would still be
	// one file judged by two contracts with different rules and nothing
	// holding them apart.
	const jsonJobByConsumer = new Map(JSON_CONTRACT.map((e) => [e.consumer, e.job]));
	for (const entry of PROSE_CONTRACT) {
		assert.ok(
			entry.job && entry.consumer && entry.requires && entry.why,
			`${entry.job} is missing a field`
		);
		const jsonJob = jsonJobByConsumer.get(entry.consumer);
		if (jsonJob !== undefined) {
			assert.equal(
				jsonJob,
				entry.job,
				`${entry.consumer} is a JSON consumer for "${jsonJob}" AND a prose consumer for ` +
					`"${entry.job}" — two DIFFERENT jobs sharing one consumer file under two contracts`
			);
		}
	}
});

/**
 * The README's `--json` table must BE the declaration, not a copy of it.
 *
 * CLAUDE.md's rule is "the LIST is the declaration", written after this file
 * carried a bare count and was wrong twice. The README then repeated the
 * mistake in the other direction: it rendered the list properly, and by
 * 2026-09-07 it showed six of the ten actually under contract — `drain-check`,
 * `benchmark`, `egress-slices` and `queue-health` were all missing. Nothing
 * caught it, because nothing read that table.
 *
 * This reads it. Both directions matter: a row for a subcommand that is NOT
 * under contract is as wrong as a missing one, because someone will avoid
 * renaming a command the crons do not actually parse.
 */
void test('the README --json table matches JSON_CONTRACT exactly', () => {
	const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
	const rows = [];
	for (const line of readme.split('\n')) {
		// A table row is `| `fleet <cmd> …` | `ci:<job>` |`. The separator row and
		// the header carry no backticked cells, so they fall out on their own.
		const m = /^\|\s*`fleet ([^`]+)`\s*\|\s*`(ci:[^`]+)`\s*\|/.exec(line);
		if (m) rows.push({ invocation: m[1].trim(), job: m[2].trim() });
	}
	assert.ok(
		rows.length > 0,
		'found no `--json` contract rows in README.md at all. Either the table was ' +
			'deleted or its shape changed — this test is worthless if it silently matches ' +
			'nothing, which is exactly the "I could not look" failure it exists to prevent.'
	);

	const declared = JSON_CONTRACT.map((e) => ({
		invocation: [e.sub, ...e.argv].join(' '),
		job: e.job,
	}));
	const key = (r) => `${r.invocation}  ->  ${r.job}`;
	const inReadme = new Set(rows.map(key));
	const inCode = new Set(declared.map(key));

	const missing = declared.filter((d) => !inReadme.has(key(d))).map(key);
	const extra = rows.filter((r) => !inCode.has(key(r))).map(key);

	assert.deepEqual(
		{ missing, extra },
		{ missing: [], extra: [] },
		`README.md's --json table has drifted from JSON_CONTRACT.\n` +
			`  missing from the README: ${missing.join(', ') || '(none)'}\n` +
			`  in the README but not under contract: ${extra.join(', ') || '(none)'}\n` +
			`Fix the README table; json-contract.mjs is the declaration.`
	);
});

/**
 * THE PROOF REQUIRED BEFORE THE HAND LIST COULD BE DELETED (wave 5e lane A,
 * plan §6.2 item 4 / blast-radius row 1): `JSON_CONTRACT` and
 * `PROSE_CONTRACT` are now DERIVED from `src/lib/job-registry.ts`'s
 * `JOB_REGISTRY`, not hand-written. This pins the derived list against
 * today's truth — the same 22 JSON jobs and 1 prose job that were here
 * before the derivation landed, by name, subcommand and consumer file — so a
 * registry edit that silently drops, renames or re-points one of them still
 * fails the build exactly the way an edit to the old hand list used to.
 */
const TODAYS_JSON_CONTRACT = [
	['drain-check', 'ci:drain-enforced', 'services/mgmt-api/src/routes/jobs/drain-enforced-check.ts'],
	['benchmark', 'ci:fleet-benchmark', 'services/mgmt-api/src/routes/jobs/fleet-benchmark-check.ts'],
	['reconcile', 'ci:fleet-coverage', 'services/mgmt-api/src/routes/jobs/fleet-coverage-check.ts'],
	['toolchain', 'ci:fleet-toolchain', 'services/mgmt-api/src/routes/jobs/fleet-toolchain-check.ts'],
	[
		'converge-toolchain',
		'ci:toolchain-refresh',
		'services/mgmt-api/src/routes/jobs/toolchain-refresh.ts',
	],
	['bootcamp', 'ci:bootcamp', 'services/mgmt-api/src/routes/jobs/bootcamp.ts'],
	['header-audit', 'ci:header-fleet', 'services/mgmt-api/src/routes/jobs/header-fleet-check.ts'],
	[
		'identity-model',
		'ci:identity-model',
		'services/mgmt-api/src/routes/jobs/identity-model-check.ts',
	],
	['cleanup', 'ci:claw-cleanup', 'services/mgmt-api/src/routes/jobs/claw-cleanup.ts'],
	['check-runner-var', 'ci:runner-var', 'services/mgmt-api/src/routes/jobs/runner-var-check.ts'],
	['check-site-token', 'ci:site-token', 'services/mgmt-api/src/routes/jobs/site-token-check.ts'],
	['egress-slices', 'ci:egress-slices', 'services/mgmt-api/src/routes/jobs/egress-slices-check.ts'],
	['queue-health', 'ci:queue-health', 'services/mgmt-api/src/routes/jobs/queue-health-check.ts'],
	[
		'reap-trend',
		'ci:reap-timeout-trend',
		'services/mgmt-api/src/routes/jobs/reap-timeout-trend-check.ts',
	],
	['preflight', 'ci:fleet-preflight', 'services/mgmt-api/src/routes/jobs/fleet-preflight-check.ts'],
	['srv-drift', 'ci:srv-drift', 'services/mgmt-api/src/routes/jobs/srv-drift-check.ts'],
	[
		'hosting-placement',
		'ci:fleet-placement',
		'services/mgmt-api/src/routes/jobs/fleet-placement-check.ts',
	],
	['inventory', 'ci:fleet-inventory', 'services/mgmt-api/src/routes/jobs/fleet-inventory-check.ts'],
	[
		'service-inventory',
		'ci:slice-inventory',
		'services/mgmt-api/src/routes/jobs/slice-inventory.ts',
	],
	['doctor', 'ci:health-refresh', 'services/mgmt-api/src/routes/jobs/health-refresh.ts'],
	[
		'health-freshness',
		'ci:health-freshness',
		'services/mgmt-api/src/routes/jobs/health-freshness-check.ts',
	],
	['node-users', 'ci:node-users', 'services/mgmt-api/src/routes/jobs/node-users-check.ts'],
	['runner-units', 'ci:runner-units', 'services/mgmt-api/src/routes/jobs/runner-units-check.ts'],
	['fleet-kills', 'ci:fleet-kills', 'services/mgmt-api/src/routes/jobs/fleet-kills-check.ts'],
	// Added 2026-10-31 (wave 5e lane D): the schedule drift gate.
	['check-schedule', 'ci:schedule', 'services/mgmt-api/src/routes/jobs/schedule-check.ts'],
	// Added wave 5f lane B: three `ci:audit-gates` covered subs migrated off
	// PROSE_CONTRACT onto their own `contract: 'json'` — same umbrella job,
	// same consumer file, no second cron.
	['history-coverage', 'ci:audit-gates', 'services/mgmt-api/src/routes/jobs/audit-gates.ts'],
	['contract-consumers', 'ci:audit-gates', 'services/mgmt-api/src/routes/jobs/audit-gates.ts'],
	// Added wave 5h lane B: three more `ci:audit-gates` covered subs migrated
	// off PROSE_CONTRACT the same way — same umbrella job, same consumer
	// file, no second cron.
	['tier-fleet', 'ci:audit-gates', 'services/mgmt-api/src/routes/jobs/audit-gates.ts'],
	['capabilities', 'ci:audit-gates', 'services/mgmt-api/src/routes/jobs/audit-gates.ts'],
	['boundary-contracts', 'ci:audit-gates', 'services/mgmt-api/src/routes/jobs/audit-gates.ts'],
	// Added wave 5i lane B: two more `ci:audit-gates` covered subs migrated off
	// PROSE_CONTRACT the same way — same umbrella job, same consumer file, no
	// second cron.
	['throttle', 'ci:audit-gates', 'services/mgmt-api/src/routes/jobs/audit-gates.ts'],
	// Added wave 5j lane B: the last two NON-d3 `ci:audit-gates` covered subs
	// migrated off PROSE_CONTRACT the same way — same umbrella job, same
	// consumer file, no second cron. Only `slice`/`tool-inventory` (d3's lane)
	// and `ci-watch` stay prose.
	['mf-externals', 'ci:audit-gates', 'services/mgmt-api/src/routes/jobs/audit-gates.ts'],
	['identity', 'ci:audit-gates', 'services/mgmt-api/src/routes/jobs/audit-gates.ts'],
	// fleet-manager#38: warm-canary and label-floor (migrated in 5f/5i above)
	// left the umbrella for rows of their own, so a 30-minute cron can meet
	// their 1h liveness budget without running every audit gate that often.
	['warm-canary', 'ci:warm-canary', 'services/mgmt-api/src/routes/jobs/warm-canary-check.ts'],
	['label-floor', 'ci:label-floor', 'services/mgmt-api/src/routes/jobs/label-floor-check.ts'],
].map(([sub, job, consumer]) => `${sub} -> ${job} -> ${consumer}`);

void test("the derived JSON_CONTRACT equals today's 35 entries exactly — name, sub and consumer", () => {
	const derived = JSON_CONTRACT.map((e) => `${e.sub} -> ${e.job} -> ${e.consumer}`);
	assert.deepEqual(derived.slice().sort(), TODAYS_JSON_CONTRACT.slice().sort());
});

void test("the derived PROSE_CONTRACT equals today's one entry exactly", () => {
	assert.equal(PROSE_CONTRACT.length, 1);
	assert.equal(PROSE_CONTRACT[0].job, 'ci:audit-gates');
	assert.equal(PROSE_CONTRACT[0].consumer, 'services/mgmt-api/src/routes/jobs/audit-gates.ts');
	assert.equal(PROSE_CONTRACT[0].requires, 'FLEET_NO_BANNER');
});

/**
 * `parseCliCommandKinds` — the same table, read for `kind` instead of
 * `script`. `job-registry-guard.test.mjs` is the real consumer; this proves
 * the parser itself against both a fixture (so a shape it cannot read fails
 * loudly rather than silently) and the real table (floor, not a count, same
 * reasoning as `parseCliCommands` above).
 */
void test('parseCliCommandKinds reads a fixture table without bleeding across entries', () => {
	const fixture = [
		'const COMMANDS: Record<string, Command> = {',
		'\treconcile: {',
		"\t\tscript: 'reconcile-fleet-runners.mjs',",
		"\t\tkind: 'converger',",
		"\t\tsummary: 'converge runner coverage',",
		'\t},',
		"\t'drain-check': {",
		"\t\tscript: 'check-drain-enforced.mjs',",
		"\t\tkind: 'gate',",
		"\t\tsummary: 'is every drain actually being enforced',",
		'\t},',
		'};',
	].join('\n');
	const kinds = parseCliCommandKinds(blankComments(fixture));
	assert.equal(kinds.get('reconcile'), 'converger');
	assert.equal(kinds.get('drain-check'), 'gate');
	assert.equal(kinds.size, 2);
});

void test('parseCliCommandKinds: a table it cannot find yields an empty map, not a crash', () => {
	assert.equal(parseCliCommandKinds('const SOMETHING_ELSE = {};').size, 0);
});

void test('parseCliCommandKinds against the real src/cli.ts: every JOB_REGISTRY sub resolves to a real kind', () => {
	const kinds = parseCliCommandKinds(blankComments(readFileSync(CLI, 'utf8')));
	assert.ok(
		kinds.size >= MIN_COMMANDS,
		`parsed ${kinds.size} kind(s), expected at least ${MIN_COMMANDS}`
	);
	for (const entry of JSON_CONTRACT) {
		assert.ok(kinds.has(entry.sub), `src/cli.ts has no COMMANDS['${entry.sub}'].kind`);
	}
});
