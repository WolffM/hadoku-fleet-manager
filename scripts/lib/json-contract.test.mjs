/**
 * The `--json` contract, made checkable.
 *
 * CLAUDE.md called `--json` a contract and README.md said every subcommand a
 * cron consumes must keep it, and neither named one — so the rule could be
 * broken by anyone who did not happen to know which of the twenty-three
 * subcommands the five mgmt-api crons parse. `json-contract.mjs` names them;
 * this fails the build when the naming stops matching the code.
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
import { spawn, spawnSync } from 'node:child_process';
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

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
const BUILT_CLI = join(ROOT, 'dist', 'cli.js');

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
 */
const HOST_BOUND_SUBS = ['egress-slices', 'reap-trend', 'srv-drift'].sort();

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
 * THE PROVENANCE BANNER MUST NOT REACH STDOUT.
 *
 * Issue #4 put a `site=… manifests=… fleet-manager=…` line on every subcommand,
 * and the trap it walks past is this contract: each consumer below reads stdout
 * and checks it starts with `{` BEFORE it looks at the exit code, so one extra
 * line on fd 1 turns every real finding into "the checker broke" — nightly, in
 * ten jobs, until somebody reads a log.
 *
 * PROVEN BY RUNNING THE REAL CLI, not by reading it. The rules above are
 * structural because behaviour was out of reach — `reconcile` needs a token,
 * `toolchain` needs ssh, `header-audit` needs 25 checkouts. This one is not:
 * the banner is written by the PARENT before it spawns anything, so pointing
 * every path at a directory that does not exist makes each subcommand fail in
 * under 100ms and still exercises the exact code that emits the banner. The
 * failures are the point — a broken environment is when a gate is most tempted
 * to write something extra to stdout.
 *
 * It also asserts the positive half. A banner that silently stopped being
 * printed would satisfy "stdout is clean" perfectly and lose the whole feature.
 */
const POISONED = {
	...process.env,
	// Every path resolver THROWS on a directory that is not there, which is what
	// makes these fail fast and offline. See src/lib/fleet-paths.ts.
	FLEET_MANIFEST_DIR: '/nonexistent-fleet-manifests',
	REPOS_DIR: '/nonexistent-fleet-repos',
	HADOKU_STATE_DIR: '/nonexistent-fleet-state',
	GH_TOKEN: '',
	GITHUB_TOKEN: '',
};
delete POISONED.HADOKU_SITE_ROOT;

void test('no contract subcommand writes the provenance banner to stdout', () => {
	assert.ok(
		existsSync(BUILT_CLI),
		`dist/cli.js is missing — run \`pnpm run build\` first. This test runs the CLI for ` +
			`real; skipping it because the build is absent would be "I could not look" rendering ` +
			`as "nothing is wrong".`
	);

	for (const entry of JSON_CONTRACT) {
		const r = spawnSync(process.execPath, [BUILT_CLI, entry.sub, ...entry.argv], {
			env: POISONED,
			encoding: 'utf8',
			timeout: 30_000,
			maxBuffer: 8 * 1024 * 1024,
		});
		const stdout = r.stdout ?? '';
		const stderr = r.stderr ?? '';

		for (const token of ['site=', 'manifests=', 'fleet-manager=']) {
			assert.ok(
				!stdout.includes(token),
				`\`fleet ${entry.sub} ${entry.argv.join(' ')}\` put "${token}" on STDOUT. ` +
					`${entry.job} (${entry.consumer}) requires stdout to be the subcommand's JSON and ` +
					`nothing else — it tests \`startsWith('{')\` before the exit code, so this turns ` +
					`every finding into a broken checker. Send the banner to stderr.`
			);
		}
		assert.match(
			stderr,
			/\bfleet-manager=/,
			`\`fleet ${entry.sub}\` printed no provenance banner on stderr at all. It is what ` +
				`says WHICH tree and WHICH install answered — the thing missing on 2026-09-04 when ` +
				`an operator chased G7 while the alert named G3.`
		);
		// Whatever DID reach stdout is still the contract shape. These runs all
		// fail (nothing resolves), and a failing gate writing prose to stdout is
		// the same breakage by another route.
		if (stdout.trim()) {
			assert.ok(
				stdout.trim().startsWith('{'),
				`\`fleet ${entry.sub} ${entry.argv.join(' ')}\` wrote non-JSON to stdout under ` +
					`--json: ${JSON.stringify(stdout.slice(0, 200))}`
			);
		}
	}
});

void test('FLEET_NO_BANNER=1 silences it, for a caller that compares fd 2 byte for byte', () => {
	const r = spawnSync(process.execPath, [BUILT_CLI, 'queue-health', '--json'], {
		env: { ...POISONED, FLEET_NO_BANNER: '1' },
		encoding: 'utf8',
		timeout: 30_000,
	});
	assert.ok(
		!(r.stderr ?? '').includes('fleet-manager='),
		'FLEET_NO_BANNER=1 did not suppress the banner'
	);
});

/**
 * `ci:fleet-benchmark`'s argv, RUN — and proved to reach no machine.
 *
 * The other entries here are checked structurally because behaviour is out of
 * reach: `toolchain` needs ssh, `reconcile` needs a token. This one is the
 * opposite claim — that `--report` reaches NOTHING — and the whole point of the
 * 2026-09-15 change is that it can therefore be exercised for real, offline,
 * against a fixture history file.
 *
 * "No ssh" is not asserted from reading the code. `ssh`, `sudo` and `scp` are
 * shadowed on PATH by scripts that record having been called; if the report
 * path reached a box, the marker file would exist. The fixture manifest is a
 * temp directory, so nothing in `manifests/` or in hadoku_site is read, let
 * alone written, and every machine here is a row in a JSON file rather than a
 * host.
 *
 * FOUR MACHINES, AND THE LAST TWO ARE THE ROLE RULE:
 *
 *   fx-claw-old    claw,  40d  -> due at --due 30
 *   fx-claw-fresh  claw,   1d  -> due only at --due 0
 *   fx-guest       guest, 99d  -> NEVER due, and never a finding, at any
 *                                 threshold. A guest is a machine the fleet
 *                                 chain may not act on OR page about
 *                                 (operator, 2026-09-14), and a finding telling
 *                                 someone to go and measure it is paging about
 *                                 it. It must still be VISIBLE, in
 *                                 `skippedByRole` — "I did not need to look" is
 *                                 not "nothing is wrong".
 *   fx-unclassified  no role, 99d -> due. Absence reads as `claw`, the strict
 *                                 direction, so a guest that lost its role
 *                                 turns up loudly instead of vanishing.
 *
 * Names are deliberately fixture-shaped: this file must not teach anyone that
 * the rule is about one hostname. It is about the manifest's `role` key.
 */
function benchmarkFixture() {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-benchmark-report-'));
	const day = 86400000;
	writeFileSync(
		join(dir, 'fleet-runner-manifest.json'),
		JSON.stringify({
			machines: {
				'fx-claw-old': { role: 'claw' },
				'fx-claw-fresh': { role: 'claw' },
				'fx-guest': { role: 'guest' },
				'fx-unclassified': {},
			},
		})
	);
	// THE STATE FILE, not the manifest and not `fleet-benchmarks.json`: since
	// Wave 3h `$benchmark` is recorded in `<stateDir>/benchmark.json`
	// (`src/lib/measured.ts`), and that is where `--due` reads its `at` stamps.
	const stamp = (days) => ({
		at: new Date(Date.now() - days * day).toISOString(),
		by: 'fleet benchmark',
	});
	const state = join(dir, 'state');
	mkdirSync(state);
	writeFileSync(
		join(state, 'benchmark.json'),
		JSON.stringify({
			nodes: {
				'fx-guest': stamp(99),
				'fx-unclassified': stamp(99),
				'fx-claw-old': stamp(40),
				'fx-claw-fresh': stamp(1),
			},
		})
	);
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	const marker = join(dir, 'REACHED-A-MACHINE');
	for (const tool of ['ssh', 'sudo', 'scp']) {
		const p = join(bin, tool);
		writeFileSync(p, `#!/bin/sh\necho "${tool} $*" >> ${marker}\nexit 1\n`, { mode: 0o755 });
	}
	return { dir, bin, marker, state };
}

const runBenchmark = (fx, argv) =>
	spawnSync(process.execPath, [BUILT_CLI, 'benchmark', ...argv], {
		env: {
			...process.env,
			PATH: `${fx.bin}:${process.env.PATH ?? ''}`,
			FLEET_MANIFEST_DIR: fx.dir,
			// NEVER the operator's `~/.hadoku-mgmt`: on hokon that is the live state
			// dir, and `$benchmark` is read from it since Wave 3h.
			HADOKU_STATE_DIR: fx.state,
			// Blinded the way a CI runner is: no sibling checkouts on disk.
			HADOKU_SITE_ROOT: '/nonexistent-fleet-site',
			REPOS_DIR: '/nonexistent-fleet-repos',
		},
		encoding: 'utf8',
		timeout: 30_000,
	});

// `--report` is still a supported read-only mode for people, so it keeps its
// no-machine proof. It is no longer the cron's argv (#93): the contract entry
// declares `--cadence`, tested below.
const REPORT_ARGV = ['--due', '30', '--report', '--json'];

void test('--report answers from the state file and reaches no machine', () => {
	assert.ok(existsSync(BUILT_CLI), 'dist/cli.js is missing — run `pnpm run build` first');
	const fx = benchmarkFixture();
	try {
		const r = runBenchmark(fx, REPORT_ARGV);
		assert.equal(
			existsSync(fx.marker),
			false,
			`\`fleet benchmark ${REPORT_ARGV.join(' ')}\` invoked ssh/sudo/scp: ` +
				`${existsSync(fx.marker) ? readFileSync(fx.marker, 'utf8') : ''}`
		);
		assert.equal(r.status, 0, `exited ${r.status}: ${r.stderr}`);
		const out = JSON.parse(r.stdout);
		assert.equal(out.mode, 'report');
		// Oldest first. fx-unclassified (99d, no role -> claw) then fx-claw-old
		// (40d); fx-claw-fresh is 1d and fx-guest is exempt.
		assert.deepEqual(
			out.due.map((d) => d.node),
			['fx-unclassified', 'fx-claw-old']
		);
		assert.ok(out.due[0].measuredAt, 'a due node must carry the date its numbers were taken');
		assert.ok(
			out.due[1].ageDays >= 39 && out.due[1].ageDays <= 41,
			`ageDays ${out.due[1].ageDays}`
		);
		assert.deepEqual(out.results, {}, 'a report must measure nothing');
		assert.deepEqual(out.coverage.never, []);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

void test('a GUEST is never due and is never a finding — but it is never dropped either', () => {
	// hokon is a guest (operator, 2026-09-14): the fleet chain may not converge
	// it, repair it, or PAGE ABOUT IT. Its $benchmark stamp ages exactly like a
	// claw's — 12.3d on 2026-09-16, the same 2026-09-03 capture as five claws —
	// so without the role exclusion the nightly report would have crossed
	// --due 30 around 2026-10-03 and told a human to go and measure a guest.
	const fx = benchmarkFixture();
	try {
		const r = runBenchmark(fx, ['--due', '30', '--report', '--json']);
		assert.equal(existsSync(fx.marker), false, 'the report path invoked ssh/sudo/scp');
		assert.equal(r.status, 0, `exited ${r.status}: ${r.stderr}`);
		const out = JSON.parse(r.stdout);

		// 99 days old and NOT due.
		assert.ok(
			!out.due.some((d) => d.node === 'fx-guest'),
			`a guest reached the due list: ${JSON.stringify(out.due)}`
		);
		// Nor named anywhere a cron would turn into an alert. `findings` is what
		// the consumer pages on, so excluding it from `due` and then listing it
		// here would route the same page down the other pipe.
		assert.deepEqual(out.findings, [], 'a guest must not reach findings');
		assert.ok(
			!out.byHand.includes('fx-guest'),
			`the by-hand command told an operator to measure a guest: ${out.byHand}`
		);

		// VISIBLE, though. "I did not need to look" is not "nothing is wrong", and
		// a CLAW that wrongly gained role: guest would otherwise stop being
		// measured in total silence.
		assert.deepEqual(
			out.skippedByRole.map((d) => d.node),
			['fx-guest']
		);
		assert.equal(out.skippedByRole[0].role, 'guest');
		assert.ok(
			out.skippedByRole[0].measuredAt,
			'an exempt node still carries the date its numbers were taken'
		);
		assert.ok(out.skippedByRole[0].ageDays > 90, `ageDays ${out.skippedByRole[0].ageDays}`);

		// And the strict default holds: a machine with NO role reads as a claw, so
		// a guest that somehow lost its role turns up loudly rather than vanishing.
		assert.ok(
			out.due.some((d) => d.node === 'fx-unclassified'),
			'an unclassified machine must be treated as a claw, not silently exempted'
		);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

void test('--due 0 --report accounts for every machine across due + skippedByRole', () => {
	const fx = benchmarkFixture();
	try {
		const r = runBenchmark(fx, ['--due', '0', '--report', '--json']);
		assert.equal(existsSync(fx.marker), false, 'the report path invoked ssh/sudo/scp');
		assert.equal(r.status, 0, `exited ${r.status}: ${r.stderr}`);
		const out = JSON.parse(r.stdout);
		assert.deepEqual(out.due.map((d) => d.node).sort(), [
			'fx-claw-fresh',
			'fx-claw-old',
			'fx-unclassified',
		]);
		assert.deepEqual(
			out.skippedByRole.map((d) => d.node),
			['fx-guest']
		);
		// NO MACHINE MAY DISAPPEAR. At --due 0 every machine in the manifest has
		// aged out, so the two lists together must be the whole roster — an
		// exclusion that quietly shortened the total is the failure this asserts
		// against, not the exclusion itself.
		const machines = Object.keys(
			JSON.parse(readFileSync(join(fx.dir, 'fleet-runner-manifest.json'), 'utf8')).machines
		);
		assert.deepEqual(
			[...out.due.map((d) => d.node), ...out.skippedByRole.map((d) => d.node)].sort(),
			machines.sort()
		);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

void test('--report refuses --write and --max rather than quietly picking one', () => {
	const fx = benchmarkFixture();
	try {
		// A run that both measures and refuses to measure has no honest answer,
		// and silently letting one win is how a cron writes a manifest by
		// accident — the exact thing the operator ruled out.
		const w = runBenchmark(fx, ['--due', '30', '--report', '--write', '--json']);
		assert.equal(w.status, 2, `--report --write exited ${w.status}`);
		assert.match(w.stderr, /mutually exclusive/);
		// --max bounds how many boxes a run may LOAD. Honouring it on a report
		// that loads none would truncate the due list, so the further behind the
		// fleet fell the quieter this would get.
		const m = runBenchmark(fx, ['--due', '30', '--report', '--max', '1', '--json']);
		assert.equal(m.status, 2, `--report --max exited ${m.status}`);
		assert.match(m.stderr, /--max/);
		assert.equal(existsSync(fx.marker), false, 'a refused run still reached a machine');
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

/**
 * WHERE `$benchmark` IS READ FROM, AND WHAT ITS ABSENCE MEANS — Wave 3h.
 *
 * `measured-facets-home-2026-09-16.md` §6 made one behaviour a hard requirement
 * before the facet could leave the manifest: with the facet ABSENT, `--due 30
 * --report` must read every claw as DUE, never as fresh. Executed against the
 * pre-3h code over the live manifest with every `$benchmark` stripped, it FAILED:
 * `due: [], ok: true`, because `--due` read the run ledger
 * (`fleet-benchmarks.json`) and the ledger was still fresh. These pin the fix.
 *
 * Every machine here is a row in a temp file; `HADOKU_STATE_DIR` points into the
 * temp dir (never `~/.hadoku-mgmt`), and ssh/sudo/scp are shadowed as above.
 */
function stateFixture({ machines, state, ledgerFresh = false }) {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-benchmark-state-'));
	writeFileSync(join(dir, 'fleet-runner-manifest.json'), JSON.stringify({ machines }));
	if (ledgerFresh) {
		// The trap S §6 existed for: a run ledger that still reads fresh.
		const at = new Date().toISOString();
		writeFileSync(
			join(dir, 'fleet-benchmarks.json'),
			JSON.stringify({
				runs: [{ at, results: Object.fromEntries(Object.keys(machines).map((n) => [n, {}])) }],
			})
		);
	}
	const stateDir = join(dir, 'state');
	if (state !== undefined) {
		mkdirSync(stateDir);
		if (state !== null) {
			writeFileSync(
				join(stateDir, 'benchmark.json'),
				typeof state === 'string' ? state : JSON.stringify({ nodes: state })
			);
		}
	}
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	const marker = join(dir, 'REACHED-A-MACHINE');
	for (const tool of ['ssh', 'sudo', 'scp']) {
		writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> ${marker}\nexit 1\n`, {
			mode: 0o755,
		});
	}
	return { dir, bin, marker, state: stateDir };
}

const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

for (const [label, state] of [
	['the state dir does not exist', undefined],
	['the state dir exists and benchmark.json does not', null],
]) {
	void test(`S §6: NO benchmark record anywhere reads every claw as DUE, never fresh — ${label}`, () => {
		const fx = stateFixture({
			machines: { 'fx-a': { role: 'claw' }, 'fx-b': {}, 'fx-guest': { role: 'guest' } },
			state,
			ledgerFresh: true,
		});
		try {
			const r = runBenchmark(fx, ['--due', '30', '--report', '--json']);
			assert.equal(existsSync(fx.marker), false, 'the report path invoked ssh/sudo/scp');
			const out = JSON.parse(r.stdout);
			assert.deepEqual(
				out.due.map((d) => d.node).sort(),
				['fx-a', 'fx-b'],
				'a missing record must make every claw DUE — a fresh run ledger beside the ' +
					'manifest is not a record of anything a reader is served'
			);
			for (const d of out.due) assert.equal(d.measuredAt, null, `${d.node} got a date`);
			assert.equal(out.ok, false, '"I could not look" must never render as ok');
			// `coverage` is the raw fact and names the guest too; `findings` — what
			// the cron pages on — does not.
			assert.deepEqual(out.coverage.never.sort(), ['fx-a', 'fx-b', 'fx-guest']);
			assert.equal(out.findings.length, 2, JSON.stringify(out.findings));
			for (const f of out.findings) assert.match(f, /NEVER measured — no benchmark record/);
			// The guest is exempt from the page and still visible.
			assert.deepEqual(
				out.skippedByRole.map((d) => d.node),
				['fx-guest']
			);
			assert.equal(r.status, 1, 'a claw with no record exits 1');
		} finally {
			rmSync(fx.dir, { recursive: true, force: true });
		}
	});
}

void test('a MALFORMED state file is could-not-look — a fresh manifest copy does not paper over it', () => {
	const fx = stateFixture({
		machines: { 'fx-a': { role: 'claw', $benchmark: { at: daysAgo(1), by: 'fleet benchmark' } } },
		state: '{ this is not json',
	});
	try {
		const r = runBenchmark(fx, ['--due', '30', '--report', '--json']);
		const out = JSON.parse(r.stdout);
		assert.deepEqual(
			out.due.map((d) => d.node),
			['fx-a'],
			'an unreadable state file may hold a NEWER record than the manifest, so the ' +
				"manifest's copy must not answer"
		);
		assert.match(out.findings[0], /UNREADABLE \(malformed\)/);
		assert.equal(r.status, 1);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

void test('the MERGE: the state copy wins only when strictly newer; the manifest copy serves meanwhile', () => {
	// Each node is a different branch of `mergeFacet`, and the dates are chosen so
	// that reverting the merge to EITHER tree alone moves a node across --due 30:
	//
	//   fx-both-manifest-newer  manifest 2d, state 40d  -> manifest answers, fresh
	//   fx-both-state-newer     manifest 50d, state 1d  -> state answers, fresh
	//   fx-manifest-only        manifest 40d            -> manifest answers, due
	//   fx-state-only           state 45d               -> state answers, due
	const fx = stateFixture({
		machines: {
			'fx-both-manifest-newer': { $benchmark: { at: daysAgo(2), by: 'fleet benchmark' } },
			'fx-both-state-newer': { $benchmark: { at: daysAgo(50), by: 'fleet benchmark' } },
			'fx-manifest-only': { $benchmark: { at: daysAgo(40), by: 'fleet benchmark' } },
			'fx-state-only': {},
		},
		state: {
			'fx-both-manifest-newer': { at: daysAgo(40), by: 'fleet benchmark' },
			'fx-both-state-newer': { at: daysAgo(1), by: 'fleet benchmark' },
			'fx-state-only': { at: daysAgo(45), by: 'fleet benchmark' },
		},
	});
	try {
		const r = runBenchmark(fx, ['--due', '30', '--report', '--json']);
		assert.equal(r.status, 0, `exited ${r.status}: ${r.stderr}`);
		const out = JSON.parse(r.stdout);
		assert.deepEqual(
			out.due.map((d) => [d.node, Math.round(d.ageDays)]),
			[
				['fx-state-only', 45],
				['fx-manifest-only', 40],
			]
		);
		assert.deepEqual(out.findings, []);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
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
	const jsonConsumers = new Set(JSON_CONTRACT.map((e) => e.consumer));
	for (const entry of PROSE_CONTRACT) {
		assert.ok(
			entry.job && entry.consumer && entry.requires && entry.why,
			`${entry.job} is missing a field`
		);
		// A consumer in BOTH lists would mean one file is being judged by two
		// contracts with different rules, which is a declaration nobody can act on.
		assert.ok(
			!jsonConsumers.has(entry.consumer),
			`${entry.consumer} is declared as both a JSON and a prose consumer`
		);
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
 * A REAL CONTRACT SUBCOMMAND, A REAL PIPE, AND A DOCUMENT TOO BIG TO SLIP
 * THROUGH.
 *
 * Every other run in this file is deliberately TINY. The poisoned-environment
 * tests fail in under 100ms with a few hundred bytes, and the benchmark fixture
 * above holds four machines. That is what made them fast, offline and
 * trustworthy about what they check — and completely blind to issue #33: on a
 * pipe, `process.exit` discards whatever `process.stdout` still had queued, so
 * a gate whose answer grew past a few kilobytes started handing mgmt-api a
 * document cut off mid-string. `JSON.parse` fails, `startsWith('{')` still
 * passes, and the cron reports "the checker broke" in place of the fleet's
 * answer.
 *
 * TWO PROPERTIES HAVE TO HOLD AT ONCE, and dropping either one is how this
 * survived:
 *
 *   - the consumer reads through a PIPE. `spawn` with `stdio: 'pipe'` is what
 *     `execFile` is. A shell redirect makes fd 1 a FILE, Node writes files with
 *     `fs.writeSync`, nothing is queued, and the test passes against the broken
 *     emitter. The file half is measured here too — as the reference length,
 *     which is the only reason we can say the pipe lost something.
 *   - the document is BIG. 1,200 fixture machines put it past 140 KB. How much
 *     a broken emitter loses depends on how fast the reader drains — measured
 *     2026-09-16, 146,176 of 149,133 bytes with a reader attached and 8,192
 *     with none — so this asserts the whole length rather than a threshold.
 *
 * Still offline and still reaches no machine: same shadowed `ssh`/`sudo`/`scp`
 * as the fixture above, same temp manifest dir, and the marker file is asserted
 * absent.
 */
const BIG_FIXTURE_MACHINES = 1200;

function bigBenchmarkFixture() {
	const dir = mkdtempSync(join(tmpdir(), 'fleet-benchmark-big-'));
	const day = 86400000;
	const machines = {};
	const nodes = {};
	const at = new Date(Date.now() - 40 * day).toISOString();
	for (let i = 0; i < BIG_FIXTURE_MACHINES; i++) {
		const node = `fx-claw-${String(i).padStart(4, '0')}`;
		machines[node] = { role: 'claw' };
		nodes[node] = { at, by: 'fleet benchmark' };
	}
	writeFileSync(join(dir, 'fleet-runner-manifest.json'), JSON.stringify({ machines }));
	const state = join(dir, 'state');
	mkdirSync(state);
	writeFileSync(join(state, 'benchmark.json'), JSON.stringify({ nodes }));
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	const marker = join(dir, 'REACHED-A-MACHINE');
	for (const tool of ['ssh', 'sudo', 'scp']) {
		writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> ${marker}\nexit 1\n`, {
			mode: 0o755,
		});
	}
	return { dir, bin, marker, state };
}

void test('a contract subcommand delivers its WHOLE document through a real pipe', async () => {
	assert.ok(existsSync(BUILT_CLI), 'dist/cli.js is missing — run `pnpm run build` first');
	const fx = bigBenchmarkFixture();
	const env = {
		...process.env,
		PATH: `${fx.bin}:${process.env.PATH ?? ''}`,
		FLEET_MANIFEST_DIR: fx.dir,
		HADOKU_STATE_DIR: fx.state,
		HADOKU_SITE_ROOT: '/nonexistent-fleet-site',
		REPOS_DIR: '/nonexistent-fleet-repos',
	};
	const argv = [BUILT_CLI, 'benchmark', '--due', '0', '--report', '--json'];
	try {
		// The reference length: fd 1 as a FILE, which never truncated.
		const outFile = join(fx.dir, 'report.json');
		const fd = openSync(outFile, 'w');
		const viaFile = spawnSync(process.execPath, argv, {
			env,
			stdio: ['ignore', fd, 'pipe'],
			timeout: 120_000,
		});
		closeSync(fd);
		assert.equal(viaFile.status, 0, `into a file, exited ${viaFile.status}: ${viaFile.stderr}`);
		const fileBytes = statSync(outFile).size;
		assert.ok(
			fileBytes > 64 * 1024,
			`the fixture produced ${fileBytes} bytes; under 64 KB this test proves nothing. ` +
				'Raise BIG_FIXTURE_MACHINES.'
		);

		// The consumer's read: spawn, stdio 'pipe'. This is execFile.
		const chunks = [];
		const child = spawn(process.execPath, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
		child.stdout.on('data', (c) => chunks.push(c));
		const code = await new Promise((resolve, reject) => {
			child.on('error', reject);
			child.on('exit', resolve);
		});
		const piped = Buffer.concat(chunks);

		assert.equal(existsSync(fx.marker), false, 'the report path invoked ssh/sudo/scp');
		assert.equal(code, 0, `through a pipe, exited ${code}`);
		assert.equal(
			piped.length,
			fileBytes,
			`the pipe received ${piped.length} bytes of a ${fileBytes}-byte document. ` +
				'`process.exit` abandoned what stdout still had queued — see keepStdoutWhole() ' +
				'in lib/emit.mjs, issue #33.'
		);
		// The assertion every consumer in JSON_CONTRACT actually makes.
		const out = JSON.parse(piped.toString('utf8'));
		assert.equal(out.mode, 'report');
		assert.equal(out.due.length, BIG_FIXTURE_MACHINES);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

/**
 * #93: the DECLARED argv is the cadence, and it is a valid, bounded invocation.
 *
 * The cadence reaches a machine by design (it drains and measures one claw), so
 * it cannot share `--report`'s "reaches no machine" proof as-is. What the LIST
 * must guarantee is narrower: the argv mgmt-api runs is accepted, and with
 * nothing due it measures nothing and touches no box. The cadence's behaviour
 * with a node due (at most one, never a guest, busy or someone else's drain,
 * always undrained, including when the measurement throws) is proved against
 * injected fixtures in `scripts/benchmark-fleet.test.mjs`.
 */
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
].map(([sub, job, consumer]) => `${sub} -> ${job} -> ${consumer}`);

void test("the derived JSON_CONTRACT equals today's 22 entries exactly — name, sub and consumer", () => {
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

void test('the benchmark entry declares the cadence, and with nothing due it reaches no machine', () => {
	assert.ok(existsSync(BUILT_CLI), 'dist/cli.js is missing — run `pnpm run build` first');
	const entry = JSON_CONTRACT.find((e) => e.sub === 'benchmark');
	assert.ok(entry, 'the benchmark entry is gone from JSON_CONTRACT');
	assert.ok(
		entry.argv.includes('--cadence') && !entry.argv.includes('--report'),
		'ci:fleet-benchmark runs --cadence since 2026-10-04 (#87, #93); the list must declare what mgmt-api runs'
	);
	const fx = benchmarkFixture();
	try {
		// Every claw freshly measured: nothing inside any lead window.
		const fresh = { at: new Date().toISOString(), by: 'fleet benchmark' };
		writeFileSync(
			join(fx.state, 'benchmark.json'),
			JSON.stringify({
				nodes: {
					'fx-claw-old': fresh,
					'fx-claw-fresh': fresh,
					'fx-guest': fresh,
					'fx-unclassified': fresh,
				},
			})
		);
		const r = runBenchmark(fx, entry.argv);
		assert.equal(
			existsSync(fx.marker),
			false,
			`with nothing due the cadence invoked ssh/sudo/scp: ${existsSync(fx.marker) ? readFileSync(fx.marker, 'utf8') : ''}`
		);
		assert.equal(r.status, 0, `exited ${r.status}: ${r.stderr}`);
		const out = JSON.parse(r.stdout);
		assert.deepEqual(out.results ?? {}, {}, 'nothing due must measure nothing');
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});
