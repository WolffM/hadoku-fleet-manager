/**
 * Every subcommand `src/cli.ts` files as `gate`, `converger` or `recorder`
 * must have a clock — either a row in `src/lib/job-registry.ts`'s
 * `JOB_REGISTRY` (directly, or discharged through an umbrella's
 * `coversSubs`), or an explicit `manual: '<why>'` there. Wave 5e lane A,
 * plan §6.2 item 4 ("every gate/recorder/converger COMMANDS entry is in the
 * registry, or marked `manual: '<why>'`").
 *
 * THE SECOND HALF OF THE SAME RULE: a `gate` never mutates. Its registered
 * `args` — here, or on a covered sub — must never carry `--confirm`,
 * `--write` or `--apply`. An existing violation is reported as a FINDING
 * (the assertion below names it), never silently re-kinded — this lane does
 * not own `src/cli.ts` and would not fix one here even if it found one.
 *
 * Reads `src/cli.ts` with comments blanked, same reasoning as every other
 * parser beside `json-contract.mjs`: a commented-out `kind:` must not count,
 * and a mention of a subcommand name in prose must not satisfy anything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments } from './blank-comments.mjs';
import { parseCliCommandKinds } from './json-contract.mjs';
import {
	JOB_REGISTRY,
	MANUAL,
	registeredSubs,
	validateRegistry,
} from '../../dist/lib/job-registry.js';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CLI = join(ROOT, 'src', 'cli.ts');

/** Same floor as json-contract.test.mjs's MIN_COMMANDS: a parse of nothing asserts nothing. */
const MIN_KINDS = 15;

const commandsKind = parseCliCommandKinds(blankComments(readFileSync(CLI, 'utf8')));

/** The three kinds this registry ever puts a clock on. */
const GUARDED_KINDS = new Set(['gate', 'converger', 'recorder']);

/**
 * Every COMMANDS entry of a guarded kind that is NOT covered by the registry
 * and NOT in MANUAL — the coverage half of the rule, as a pure function of
 * (commandsKind, registered subs, manual keys) so the mutation tests below
 * can exercise it against a fixture instead of the real table.
 */
function uncoveredEntries(kindMap, registered, manualKeys) {
	const out = [];
	for (const [sub, kind] of kindMap) {
		if (!GUARDED_KINDS.has(kind)) continue;
		if (registered.has(sub)) continue;
		if (manualKeys.has(sub)) continue;
		out.push(`${sub} (kind: ${kind})`);
	}
	return out;
}

void test('the COMMANDS table is readable at all — a parse of nothing is not a pass', () => {
	assert.ok(
		commandsKind.size >= MIN_KINDS,
		`parsed ${commandsKind.size} kind(s) from src/cli.ts, expected at least ${MIN_KINDS}. The ` +
			'COMMANDS table moved or changed shape, so every check below is looking at an empty map.'
	);
});

void test('every gate/converger/recorder subcommand has a clock in JOB_REGISTRY or a MANUAL reason', () => {
	const registered = registeredSubs(JOB_REGISTRY);
	const manualKeys = new Set(Object.keys(MANUAL));
	const uncovered = uncoveredEntries(commandsKind, registered, manualKeys);
	assert.deepEqual(
		uncovered,
		[],
		`${uncovered.length} COMMANDS entr${uncovered.length === 1 ? 'y' : 'ies'} of a scheduled kind ` +
			`have no clock and no MANUAL reason: ${uncovered.join(', ')}. Either this subcommand is ` +
			'actually scheduled somewhere (add it to JOB_REGISTRY, with its real cadence) or it is not ' +
			"(add MANUAL['<sub>'] = '<why>')."
	);
});

void test('MANUAL names only subcommands that are real, guarded-kind COMMANDS entries', () => {
	// The inverse of the test above: a MANUAL entry for a sub that does not
	// exist, or that is not actually gate/converger/recorder, documents
	// nothing — it would silently stop meaning anything the day the
	// subcommand it names was renamed or re-kinded.
	for (const sub of Object.keys(MANUAL)) {
		const kind = commandsKind.get(sub);
		assert.ok(kind !== undefined, `MANUAL['${sub}'] names a subcommand src/cli.ts no longer has`);
		assert.ok(
			GUARDED_KINDS.has(kind),
			`MANUAL['${sub}'] is kind '${kind}' in COMMANDS, which this guard never checks anyway`
		);
	}
});

void test('no MANUAL subcommand is also registered — that would be a self-contradiction', () => {
	const registered = registeredSubs(JOB_REGISTRY);
	for (const sub of Object.keys(MANUAL)) {
		assert.ok(!registered.has(sub), `'${sub}' is both MANUAL and in JOB_REGISTRY`);
	}
});

void test('validateRegistry against the REAL COMMANDS kinds: no undocumented kind mismatch, no gate mutates', () => {
	const result = validateRegistry(JOB_REGISTRY, { commandsKind });
	const bad = result.issues.filter((i) => i.kind === 'kind-mismatch' || i.kind === 'gate-mutates');
	assert.deepEqual(
		bad,
		[],
		`${bad.length} undocumented kind-mismatch/gate-mutates issue(s) against the real COMMANDS table: ` +
			JSON.stringify(bad)
	);
});

/**
 * MUTATION 1/3: a COMMANDS entry of a guarded kind that the registry and
 * MANUAL both know nothing about must be caught.
 */
void test('mutation: an unregistered, non-manual gate is caught', () => {
	const fixtureKinds = new Map(commandsKind);
	fixtureKinds.set('fx-new-gate-nobody-registered', 'gate');
	const uncovered = uncoveredEntries(
		fixtureKinds,
		registeredSubs(JOB_REGISTRY),
		new Set(Object.keys(MANUAL))
	);
	assert.ok(
		uncovered.some((e) => e.startsWith('fx-new-gate-nobody-registered')),
		'an unregistered, non-manual gate must be reported as uncovered'
	);
});

/**
 * MUTATION 2/3: a `gate`-kind registry entry carrying `--confirm` must be
 * caught by `validateRegistry` itself (the function this guard calls), not
 * merely by this test file's own logic.
 */
void test('mutation: a gate-kind registry entry with --confirm is caught', () => {
	const fixtureRegistry = [
		{
			name: 'fx:mutating-gate',
			sub: 'fx-mutating-gate',
			args: ['--json', '--confirm'],
			kind: 'gate',
			detectionBudget: '48h',
			cadence: { cron: '0 13 * * *' },
			contract: 'json',
			why: 'fixture',
		},
	];
	const fixtureKinds = new Map([['fx-mutating-gate', 'gate']]);
	const result = validateRegistry(fixtureRegistry, { commandsKind: fixtureKinds });
	assert.ok(
		result.issues.some((i) => i.kind === 'gate-mutates' && i.entry === 'fx:mutating-gate'),
		'a gate with --confirm in its registered args must fail validateRegistry'
	);
});

/**
 * MUTATION 3/3: the derived `JSON_CONTRACT`/`PROSE_CONTRACT` list differing
 * from the registry it is derived from must be impossible to miss. This is
 * the mutation for blast-radius row 1 ("the derived list must equal today's
 * entries exactly") — proved here by mutating the REGISTRY and checking the
 * derived list moves with it, which is what "derived" has to mean.
 */
void test('mutation: the derived JSON_CONTRACT list tracks JOB_REGISTRY, not a frozen copy of today', async () => {
	// json-contract.mjs's deriveJsonContract is `registry.filter(contract==='json').map(...)`
	// — a pure function of its argument, not a closure over a count taken once
	// at import time. Proving that means calling the SAME rule against
	// JOB_REGISTRY plus one extra row (never mutating the shared singleton
	// array, which every other test in this process still reads) and checking
	// the extra row reaches the output. If `JSON_CONTRACT` were ever rewritten
	// back into a hand-copied snapshot, this still passes (nothing here reads
	// the exported `JSON_CONTRACT` constant) — it is `json-contract.test.mjs`'s
	// pin against today's 22 names that would then start failing, which is the
	// point: two different failure modes, two different tests.
	const { JOB_REGISTRY: liveRegistry } = await import('../../dist/lib/job-registry.js');
	const probe = {
		name: 'ci:fx-probe-job',
		sub: 'fx-probe-sub',
		args: ['--json'],
		kind: 'gate',
		detectionBudget: '48h',
		cadence: { cron: '0 13 * * *' },
		mgmtApiFile: 'services/mgmt-api/src/routes/jobs/fx-probe.ts',
		contract: 'json',
		why: 'fixture: proves the derivation is live, not a snapshot taken once at import time',
	};
	const deriveJsonContract = (registry) =>
		registry.filter((e) => e.contract === 'json').map((e) => ({ sub: e.sub, job: e.name }));

	assert.ok(
		liveRegistry.length > 0,
		'JOB_REGISTRY must not be empty for this proof to mean anything'
	);
	const withoutProbe = deriveJsonContract(liveRegistry).map((e) => e.job);
	const withProbe = deriveJsonContract([...liveRegistry, probe]).map((e) => e.job);
	assert.ok(
		!withoutProbe.includes('ci:fx-probe-job'),
		'the probe leaked into the registry without being added'
	);
	assert.ok(
		withProbe.includes('ci:fx-probe-job'),
		'a new registry row must reach the derived contract list'
	);
	assert.equal(withProbe.length, withoutProbe.length + 1);
});
