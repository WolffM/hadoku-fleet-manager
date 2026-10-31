/**
 * The drain file's one script-side writer is a locked MERGE, not a replace.
 * claw-9's drain vanished on 2026-10-31 when four `fleet drain` calls and
 * mgmt-api's own drain/hosting writers overlapped: each wrote back the whole
 * doc it had read, so the last writer erased the others' records.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './test-tmpdir.mjs';
import { mergeDrainDoc } from './expected-down.mjs';

const SINCE = new Date(Date.now() - 60_000).toISOString();
const rec = (reason) => ({
	since: SINCE,
	kind: 'maintenance',
	reason,
	by: 't',
});

test('merge: a record the caller did not touch survives a concurrent writer', () => {
	const base = { nodes: {}, planned: [] };
	const current = { nodes: { 'claw-9': rec('other writer') }, planned: [] };
	const next = { nodes: { 'claw-4': rec('mine') }, planned: [] };
	assert.deepEqual(Object.keys(mergeDrainDoc(current, base, next).nodes).sort(), [
		'claw-4',
		'claw-9',
	]);
});

test('merge: an undo deletes only its own node', () => {
	const base = { nodes: { 'claw-1': rec('a') }, planned: [] };
	const current = { nodes: { 'claw-1': rec('a'), 'claw-2': rec('b') }, planned: [] };
	const next = { nodes: {}, planned: [] };
	assert.deepEqual(Object.keys(mergeDrainDoc(current, base, next).nodes), ['claw-2']);
});

test('merge: planned entries are added and removed by value, others kept', () => {
	const p = (node) => ({
		node,
		from: new Date(Date.now() + 86_400_000).toISOString(),
		...rec(node),
	});
	const base = { nodes: {}, planned: [p('claw-1')] };
	const current = { nodes: {}, planned: [p('claw-1'), p('claw-2')] };
	const next = { nodes: {}, planned: [p('claw-3')] };
	assert.deepEqual(
		mergeDrainDoc(current, base, next).planned.map((x) => x.node),
		['claw-2', 'claw-3']
	);
});

/** REAL PROCESSES racing on one file. MUTATION: write `next` without the merge or the lock. */
test('twelve concurrent writers each draining a different node: every record lands', async () => {
	const dir = tempDir('drain-race-');
	const lib = join(import.meta.dirname, 'expected-down.mjs');
	const script = `
		const m = await import(${JSON.stringify(lib)});
		const doc = m.readDrainDoc();
		await new Promise((r) => setTimeout(r, 30));
		const node = process.argv[1];
		m.writeDrainDoc({ nodes: { ...doc.nodes, [node]: ${JSON.stringify(rec('race'))} }, planned: doc.planned }, doc);
	`;
	const nodes = Array.from({ length: 12 }, (_, i) => `n${i}`);
	await Promise.all(
		nodes.map(
			(n) =>
				new Promise((resolve, reject) => {
					const c = spawn(process.execPath, ['--input-type=module', '-e', script, n], {
						env: { ...process.env, HADOKU_STATE_DIR: dir, FLEET_MANIFEST_DIR: dir },
						stdio: ['ignore', 'ignore', 'pipe'],
					});
					let err = '';
					c.stderr.on('data', (d) => (err += d));
					c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err))));
				})
		)
	);
	const doc = JSON.parse(readFileSync(join(dir, 'fleet-drain.json'), 'utf8'));
	assert.deepEqual(Object.keys(doc.nodes).sort(), [...nodes].sort());
});
