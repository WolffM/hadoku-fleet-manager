/**
 * `fleet traffic` explains a routing decision, so its failure modes are the
 * ones where it would explain a decision the fleet is not actually making.
 *
 * The dangerous direction is optimism: a tool that says "claw-4 is eligible"
 * when it is drained, or "everything is fine" when nothing can take the job,
 * is worse than no tool — it is a second source of truth that disagrees with
 * the first and looks more convenient.
 */
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'traffic-status.mjs');
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

function site({ drain = {}, labels = {} } = {}) {
	const d = mkdtempSync(join(tmpdir(), 'fleet-traffic-'));
	made.push(d);
	writeFileSync(
		join(d, 'fleet-runner-manifest.json'),
		JSON.stringify({
			machines: {
				'claw-2': { labels: labels['claw-2'] ?? ['hadoku-builder'] },
				'claw-6': { labels: labels['claw-6'] ?? ['hadoku-builder'] },
				'claw-3': { labels: labels['claw-3'] ?? ['hadoku-builder'], ephemeral: true },
			},
		})
	);
	writeFileSync(join(d, 'fleet-drain.json'), JSON.stringify({ nodes: drain }));
	return d;
}

/**
 * BOTH DIRECTORIES ARE PINNED, and the second one is not optional.
 *
 * `traffic-status.mjs` resolves the drain from the STATE dir first and falls
 * back to the manifest dir — deliberately, matching `src/runners/drain.ts`, so a
 * report names the same drain the dispatcher enforces. Pinning only
 * FLEET_MANIFEST_DIR therefore leaves the state dir pointing at
 * `~/.hadoku-mgmt`, where a real operator drain lives, and the fixture's drain
 * is never read at all.
 *
 * MEASURED 2026-09-03: claw-5 was drained for a BIOS fix, the two drain tests
 * below started failing on this machine, and they had nothing to do with the
 * change being made. On a clean box they pass — while testing nothing, because
 * the drain they assert on is the one the script ignored.
 *
 * That is the same fault as the tickFleet suite SSHing the garage and
 * `summarise` reading the live job history: a test whose result moves with what
 * the fleet happens to be doing. The state dir is now a temp dir per fixture,
 * so the only drain in scope is the one the test wrote.
 */
const run = (dir, argv = []) =>
	spawnSync(process.execPath, [SCRIPT, ...argv, '--json'], {
		encoding: 'utf8',
		env: { ...process.env, FLEET_MANIFEST_DIR: dir, HADOKU_STATE_DIR: dir },
	});

test('it orders every declared node — equal and unmeasured, so by name', () => {
	const r = run(site());
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(JSON.parse(r.stdout).order, ['claw-2', 'claw-3', 'claw-6']);
});

test('a DRAINED node is never in the order, and says why', () => {
	const r = run(
		site({ drain: { 'claw-2': { since: 'x', kind: 'training', reason: 'bootcamp' } } })
	);
	const out = JSON.parse(r.stdout);
	assert.ok(!out.order.includes('claw-2'), 'a drained node was offered work');
	const row = out.nodes.find((n) => n.name === 'claw-2');
	assert.equal(row.verdict, 'drained');
	assert.match(row.why, /training: bootcamp/);
});

test('a node lacking a required label is excluded, and NAMES the label', () => {
	// The bootcamp case. "not eligible" without the missing label sends someone
	// to read four files.
	const r = run(site(), ['--labels', 'hadoku-builder,python-toolcache']);
	const out = JSON.parse(r.stdout);
	assert.deepEqual(out.order, []);
	for (const n of out.nodes) {
		assert.equal(n.verdict, 'no-label');
		assert.match(n.why, /python-toolcache/);
	}
});

test('self-hosted is not treated as an earnable label', () => {
	// Every runner has it implicitly; requiring it as a capability would exclude
	// the entire fleet from every job.
	const r = run(site(), ['--labels', 'self-hosted,hadoku-builder']);
	assert.deepEqual(JSON.parse(r.stdout).order, ['claw-2', 'claw-3', 'claw-6']);
});

test('an empty order is stated as such, not shown as success', () => {
	const r = run(
		site({
			drain: {
				'claw-2': { since: 'x', reason: 'a' },
				'claw-6': { since: 'x', reason: 'b' },
				'claw-3': { since: 'x', reason: 'c' },
			},
		})
	);
	assert.deepEqual(JSON.parse(r.stdout).order, []);
});

test('an unreadable manifest REFUSES rather than reporting an empty fleet', () => {
	const d = site();
	writeFileSync(join(d, 'fleet-runner-manifest.json'), '{ not json');
	const r = run(d);
	assert.notEqual(r.status, 0, 'a corrupt manifest was reported as a fleet with no nodes');
	assert.match(r.stderr, /unreadable|Refusing/);
});
