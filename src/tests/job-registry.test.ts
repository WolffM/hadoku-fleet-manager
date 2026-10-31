import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
	JOB_REGISTRY,
	MANUAL,
	cadencePeriodMs,
	parseDurationMs,
	registeredSubs,
	validateRegistry,
	type JobEntry,
} from '../lib/job-registry.js';

void test('every entry has a unique name, a why, an args array and a parseable cadence+budget', () => {
	const seen = new Set<string>();
	for (const e of JOB_REGISTRY) {
		assert.ok(!seen.has(e.name), `${e.name} declared twice`);
		seen.add(e.name);
		assert.ok(e.why && e.why.length > 0, `${e.name} has no why`);
		assert.ok(Array.isArray(e.args), `${e.name}.args is not an array`);
		// Throws loudly on anything this registry does not understand yet —
		// that is the point: every real entry must parse today.
		assert.ok(cadencePeriodMs(e.cadence) > 0, `${e.name}.cadence did not yield a positive period`);
		assert.ok(parseDurationMs(e.detectionBudget) > 0, `${e.name}.detectionBudget did not parse`);
		for (const c of e.coversSubs ?? []) {
			assert.ok(c.why && c.why.length > 0, `${e.name}:${c.sub} has no why`);
			assert.ok(
				parseDurationMs(c.detectionBudget) > 0,
				`${e.name}:${c.sub}.detectionBudget did not parse`
			);
		}
	}
});

void test('parseDurationMs: the three suffixes this registry actually uses', () => {
	assert.equal(parseDurationMs('20m'), 20 * 60_000);
	assert.equal(parseDurationMs('1h'), 3_600_000);
	assert.equal(parseDurationMs('48h'), 48 * 3_600_000);
	assert.equal(parseDurationMs('14d'), 14 * 86_400_000);
});

void test('parseDurationMs: throws rather than silently matching nothing', () => {
	for (const bad of ['', '10', '10x', '10 m', 'ten minutes', '-5m']) {
		assert.throws(() => parseDurationMs(bad), `expected "${bad}" to throw`);
	}
});

void test('cadencePeriodMs: the two cron shapes profiles.json actually uses, plus clockMs', () => {
	assert.equal(cadencePeriodMs({ cron: '*/10 * * * *' }), 10 * 60_000);
	assert.equal(cadencePeriodMs({ cron: '0 13 * * *' }), 86_400_000);
	assert.equal(cadencePeriodMs({ cron: '0 12 * * *' }), 86_400_000);
	assert.equal(cadencePeriodMs({ clockMs: 300_000 }), 300_000);
});

void test('cadencePeriodMs: an unsupported cron shape throws rather than guessing a period', () => {
	assert.throws(() => cadencePeriodMs({ cron: '0 0 * * SUN' }));
	assert.throws(() => cadencePeriodMs({ cron: 'not a cron' }));
});

void test('registeredSubs covers every direct sub and every covered sub', () => {
	const subs = registeredSubs();
	assert.ok(subs.has('queue-health'));
	assert.ok(subs.has('drain-check'));
	// Discharged only through ci:audit-gates's coversSubs, not its own row.
	assert.ok(subs.has('warm-canary'));
	assert.ok(subs.has('label-floor'));
	assert.ok(subs.has('tier-fleet'));
	assert.ok(subs.has('boundary-contracts'));
	// Never registered anywhere, never manual either — must NOT be present.
	assert.ok(!subs.has('this-sub-does-not-exist'));
});

void test('MANUAL names exactly the subcommands that are automated but carry no clock of their own', () => {
	const expected = [
		'apt-security',
		'toolpack',
		'bootcamp',
		'hosting-request',
		'capability-schema',
		'hosting-demand',
	];
	assert.deepEqual(Object.keys(MANUAL).sort(), expected.sort());
	for (const [sub, why] of Object.entries(MANUAL)) {
		assert.ok(why && why.length > 10, `MANUAL['${sub}'] has no real reason`);
		// A sub cannot be BOTH registered and manual — that would mean this file
		// disagrees with itself about whether something has a clock.
		assert.ok(!registeredSubs().has(sub), `'${sub}' is both registered and manual`);
	}
});

/**
 * THE KNOWN, NAMED FINDING — pinned, not fixed. Plan §6.1 calls out
 * warm-canary and label-floor by name as liveness checks sitting on a daily
 * cron; `validateRegistry` is required to say so rather than pass quietly.
 * This is RED on purpose, and pinning the EXACT two entries is what makes
 * this a test of the gate rather than a test that happens to pass today —
 * a THIRD cadence-budget violation appearing here, undetected, would be
 * exactly the silent regression the rest of this file guards against.
 */
void test('validateRegistry (no COMMANDS cross-check): exactly the two known cadence/budget gaps, nothing else', () => {
	const result = validateRegistry();
	const budgetIssues = result.issues.filter((i) => i.kind === 'cadence-budget');
	assert.deepEqual(budgetIssues.map((i) => i.entry).sort(), [
		'ci:audit-gates:label-floor',
		'ci:audit-gates:warm-canary',
	]);
	// And nothing else: no duplicate names, no malformed entries, no gate
	// carrying a mutating flag, anywhere in the real registry.
	const other = result.issues.filter((i) => i.kind !== 'cadence-budget');
	assert.deepEqual(other, [], `unexpected validation issues: ${JSON.stringify(other)}`);
});

void test('validateRegistry: a duplicate name is caught', () => {
	const dup: JobEntry[] = [JOB_REGISTRY[0], { ...JOB_REGISTRY[0] }];
	const result = validateRegistry(dup);
	assert.ok(result.issues.some((i) => i.kind === 'duplicate-name'));
});

void test('validateRegistry: a gate with a mutating flag in its own args is caught', () => {
	const fixture: JobEntry = {
		name: 'fx:fake-gate',
		sub: 'fx-fake-gate',
		args: ['--json', '--confirm'],
		kind: 'gate',
		detectionBudget: '48h',
		cadence: { cron: '0 13 * * *' },
		contract: 'json',
		why: 'fixture',
	};
	const result = validateRegistry([fixture]);
	const hit = result.issues.find((i) => i.kind === 'gate-mutates');
	assert.ok(hit, 'a gate with --confirm in its args must be flagged');
	assert.match(hit!.message, /--confirm/);
});

void test('validateRegistry: a gate with a mutating flag in a covered sub is caught too', () => {
	const fixture: JobEntry = {
		name: 'fx:fake-umbrella',
		args: [],
		kind: 'gate',
		detectionBudget: '48h',
		cadence: { cron: '0 13 * * *' },
		contract: 'prose',
		why: 'fixture',
		coversSubs: [{ sub: 'fx-inner', args: ['--write'], detectionBudget: '48h', why: 'fixture' }],
	};
	const result = validateRegistry([fixture]);
	assert.ok(
		result.issues.some((i) => i.kind === 'gate-mutates' && i.entry === 'fx:fake-umbrella:fx-inner')
	);
});

void test('validateRegistry: a cadence the parser cannot meet its own stated budget is caught', () => {
	const fixture: JobEntry = {
		name: 'fx:too-slow',
		sub: 'fx-too-slow',
		args: [],
		kind: 'gate',
		detectionBudget: '1h',
		cadence: { cron: '0 13 * * *' }, // daily — cannot meet a 1h budget
		contract: 'json',
		why: 'fixture',
	};
	const result = validateRegistry([fixture]);
	assert.ok(result.issues.some((i) => i.kind === 'cadence-budget' && i.entry === 'fx:too-slow'));
});

void test('validateRegistry: a cadence that CAN meet its budget passes clean', () => {
	const fixture: JobEntry = {
		name: 'fx:fine',
		sub: 'fx-fine',
		args: [],
		kind: 'gate',
		detectionBudget: '20m',
		cadence: { cron: '*/10 * * * *' },
		contract: 'json',
		why: 'fixture',
	};
	const result = validateRegistry([fixture]);
	assert.deepEqual(result.issues, []);
	assert.equal(result.ok, true);
});

void test('validateRegistry: kind cross-check against COMMANDS is skipped without commandsKind', () => {
	// benchmark's kindDrift explains a real documented disagreement; without a
	// commandsKind map there is nothing to cross-check against, so this must
	// stay silent either way (no false positive, no false negative).
	const entry = JOB_REGISTRY.find((e) => e.name === 'ci:fleet-benchmark')!;
	const result = validateRegistry([entry]);
	assert.deepEqual(
		result.issues.filter((i) => i.kind === 'kind-mismatch'),
		[]
	);
});

void test('validateRegistry: an UNDOCUMENTED kind mismatch against commandsKind is caught', () => {
	const fixture: JobEntry = {
		name: 'fx:undrifted',
		sub: 'fx-undrifted',
		args: [],
		kind: 'gate',
		detectionBudget: '48h',
		cadence: { cron: '0 13 * * *' },
		contract: 'json',
		why: 'fixture',
	};
	const commandsKind = new Map([['fx-undrifted', 'converger']]);
	const result = validateRegistry([fixture], { commandsKind });
	assert.ok(result.issues.some((i) => i.kind === 'kind-mismatch' && i.entry === 'fx:undrifted'));
});

void test('validateRegistry: a DOCUMENTED kind mismatch (kindDrift) is not flagged', () => {
	const fixture: JobEntry = {
		name: 'fx:drifted',
		sub: 'fx-drifted',
		args: [],
		kind: 'gate',
		detectionBudget: '48h',
		cadence: { cron: '0 13 * * *' },
		contract: 'json',
		why: 'fixture',
		kindDrift: 'documented on purpose, for this fixture',
	};
	const commandsKind = new Map([['fx-drifted', 'converger']]);
	const result = validateRegistry([fixture], { commandsKind });
	assert.deepEqual(result.issues, []);
});

void test('validateRegistry: a COMMANDS kind outside gate/converger/recorder is never cross-checked', () => {
	// throttle/slice are kind:'mutator' in COMMANDS, used read-only (--check)
	// inside ci:audit-gates. They must not demand a kindDrift just because the
	// umbrella's own kind ('gate') differs from 'mutator' — that comparison is
	// out of scope by design (see the module header).
	const audit = JOB_REGISTRY.find((e) => e.name === 'ci:audit-gates')!;
	const commandsKind = new Map([
		['throttle', 'mutator'],
		['slice', 'mutator'],
	]);
	const result = validateRegistry([audit], { commandsKind });
	assert.deepEqual(
		result.issues.filter((i) => i.kind === 'kind-mismatch'),
		[]
	);
});
