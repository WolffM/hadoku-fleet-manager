/**
 * `runs-on-demand.mjs` — every `runs-on` shape the fleet writes, and the ones
 * the old three-regex reader went blind on (#98).
 *
 * The live strings below are copied from the checkouts on 2026-10-10, not
 * paraphrased: hadoku-cardtable's `forge.yml` and brave-quartet's `ci.yml` are
 * where `jdk21` and `cargo-bevy` were invisible to the label floor.
 *
 * Pure — nothing here touches disk.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	isHostedLabel,
	jobRunsOn,
	observedDemand,
	resolveRunsOn,
	workflowDemand,
} from './runs-on-demand.mjs';

const FLEET = '["self-hosted","hadoku-builder"]';
const ctx = { fleetValue: FLEET };
const labelsOf = (raw, jobText) => resolveRunsOn(raw, { ...ctx, jobText }).labels.sort();

test('the cardtable forge shape: the fromJSON literal default is demand (jdk21)', () => {
	const raw =
		"${{ inputs.runs_on != '' && fromJSON(inputs.runs_on) || " +
		'fromJSON(\'["self-hosted","hadoku-builder","jdk21"]\') }}';
	assert.deepEqual(labelsOf(raw), ['hadoku-builder', 'jdk21', 'self-hosted']);
});

test('the brave-quartet format() shape: cargo-bevy, the fleet set, no {0} placeholder', () => {
	const raw =
		'${{ fromJSON(format(\'["{0}","cargo-bevy"]\', join(fromJSON(vars.CI_RUNNER), \'","\'))) }}';
	assert.deepEqual(labelsOf(raw), ['cargo-bevy', 'hadoku-builder', 'self-hosted']);
});

test('the fork guard: the fleet set and the hosted hatch, never the author associations', () => {
	const raw =
		'${{ fromJSON((github.event_name == \'pull_request\' && !contains(fromJSON(\'["OWNER","MEMBER",' +
		'"COLLABORATOR"]\'), github.event.pull_request.author_association) && \'["ubuntu-latest"]\') || ' +
		'vars.CI_RUNNER) }}';
	assert.deepEqual(labelsOf(raw), ['hadoku-builder', 'self-hosted', 'ubuntu-latest']);
});

test('a bare flow sequence, a scalar, a block list and a group/labels mapping', () => {
	assert.deepEqual(labelsOf('[self-hosted, pm2-host]'), ['pm2-host', 'self-hosted']);
	assert.deepEqual(labelsOf('ubuntu-24.04'), ['ubuntu-24.04']);
	const job = '    runs-on:\n      - self-hosted\n      - "av1-nvenc"\n    steps: []\n';
	assert.deepEqual(labelsOf(jobRunsOn(job)), ['av1-nvenc', 'self-hosted']);
	const grp = '    runs-on:\n      group: fleet\n      labels: [self-hosted, taskauto]\n';
	assert.deepEqual(labelsOf(jobRunsOn(grp)), ['self-hosted', 'taskauto']);
	const grpBlock = '    runs-on:\n      group: fleet\n      labels:\n        - jdk21\n';
	assert.deepEqual(labelsOf(jobRunsOn(grpBlock)), ['jdk21']);
	assert.deepEqual(labelsOf('{ group: fleet, labels: [self-hosted, jdk21] }'), [
		'jdk21',
		'self-hosted',
	]);
});

test('a matrix reference resolves to the job’s own matrix values', () => {
	const job =
		'    strategy:\n      matrix:\n        os: [self-hosted, ubuntu-latest]\n' +
		'        include:\n          - os: cargo-bevy\n    runs-on: ${{ matrix.os }}\n';
	assert.deepEqual(labelsOf(jobRunsOn(job), job), ['cargo-bevy', 'self-hosted', 'ubuntu-latest']);
});

test('a runs-on that resolves to NOTHING is unresolved, never zero labels', () => {
	const r = resolveRunsOn('${{ inputs.runner }}', ctx);
	assert.deepEqual(r.labels, []);
	assert.match(r.unresolved, /resolves to no label/);
	const dyn =
		'    strategy:\n      matrix: ${{ fromJSON(needs.plan.outputs.m) }}\n    runs-on: ${{ matrix.os }}\n';
	assert.match(resolveRunsOn(jobRunsOn(dyn), { ...ctx, jobText: dyn }).unresolved, /no label/);
	const grpOnly = '    runs-on:\n      group: fleet\n';
	assert.ok(resolveRunsOn(jobRunsOn(grpOnly), ctx).unresolved);
});

test('workflowDemand: per job, comments are not demand, a reusable call is not a finding', () => {
	const body = [
		'on: push',
		'# runs-on: [self-hosted, taskauto]   <- prose, not a runs-on',
		'jobs:',
		'  build:',
		'    # runs-on: [self-hosted, av1-nvenc]',
		'    runs-on: ${{ fromJSON(vars.CI_RUNNER) }}',
		'  call:',
		'    uses: ./.github/workflows/x.yml',
		'  broken:',
		'    steps: []',
		'',
	].join('\n');
	const d = workflowDemand(body, ctx);
	assert.deepEqual(d.jobs, [{ id: 'build', labels: ['self-hosted', 'hadoku-builder'] }]);
	assert.deepEqual(d.unresolved, ['broken: no `runs-on` and no `uses`']);
	assert.deepEqual(workflowDemand('name: x\n', ctx).unresolved.length, 1);
});

test('workflowDemand: a CRLF workflow reads the same as an LF one (fleet-manager#5)', () => {
	// secretProject's working tree was CRLF, and every job header kept a
	// trailing \r, so the label floor reported the file as having no jobs.
	const lines = [
		'on: push',
		'jobs:',
		'  daily:',
		'    runs-on: ${{ fromJSON(vars.CI_RUNNER) }}',
		'  pinned:',
		'    runs-on: [self-hosted, pm2-host] # where the deploy lives',
		'',
	];
	const want = [
		{ id: 'daily', labels: ['self-hosted', 'hadoku-builder'] },
		{ id: 'pinned', labels: ['self-hosted', 'pm2-host'] },
	];
	assert.deepEqual(workflowDemand(lines.join('\n'), ctx), { jobs: want, unresolved: [] });
	assert.deepEqual(workflowDemand(lines.join('\r\n'), ctx), { jobs: want, unresolved: [] });
	// A lone \r is the old Mac line ending; no fleet file has one, but it is the
	// same failure and the same one-line fix.
	assert.deepEqual(workflowDemand(lines.join('\r'), ctx), { jobs: want, unresolved: [] });
});

test('hosted images are not capabilities — ubuntu-24.04 included', () => {
	for (const l of [
		'ubuntu-latest',
		'ubuntu-24.04',
		'ubuntu-22.04-arm',
		'macos-14',
		'windows-latest',
	]) {
		assert.ok(isHostedLabel(l), l);
	}
	for (const l of ['jdk21', 'hadoku-builder', 'cargo-bevy']) assert.ok(!isHostedLabel(l), l);
});

test('observedDemand: the window, proof runs and malformed lines', () => {
	const now = Date.now();
	const iso = (h) => new Date(now - h * 3_600_000).toISOString();
	const rows = [
		{ runner: 'claw-1', labels: ['self-hosted', 'jdk21'], startedAt: iso(1) },
		{ runner: 'claw-1', labels: ['self-hosted', 'old-label'], startedAt: iso(24 * 20) },
		{ runner: 'jit-claw-4-proof-x-j0-r0-1', labels: ['proof-abc'], startedAt: iso(1) },
	];
	const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n{"partial';
	const o = observedDemand(text, {
		sinceIso: iso(24 * 14),
		isProof: (r) => r.includes('-proof-'),
	});
	assert.equal(o.rows, 1);
	assert.equal(o.malformed, 1);
	assert.deepEqual([...o.labels.keys()].sort(), ['jdk21', 'self-hosted']);
});

test('observedDemand: when each label was last asked for is its latest job, in any order', () => {
	const now = Date.now();
	const iso = (h) => new Date(now - h * 3_600_000).toISOString();
	const rows = [
		{ runner: 'claw-1', labels: ['jdk21'], startedAt: iso(48) },
		{ runner: 'claw-2', labels: ['jdk21'], startedAt: iso(2) },
		{ runner: 'claw-3', labels: ['jdk21'], startedAt: iso(72) },
	];
	const o = observedDemand(rows.map((r) => JSON.stringify(r)).join('\n'), {
		sinceIso: iso(24 * 14),
		isProof: () => false,
	});
	assert.equal(o.last.get('jdk21'), iso(2));
});
