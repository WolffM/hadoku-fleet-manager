/**
 * The promoter and the sync run from a SPARSE checkout of main, so a relative
 * import outside that set is a crash, not a build error: 2026-11-25 `ee7ac96`
 * (fleet-manager#160) made both import `../lib/is-main.mjs`, every test here
 * passed against the full tree, and the promoter could not start. Because it
 * runs main's copy, it could not promote its own fix either. This holds each
 * workflow's sparse set to the transitive relative imports of its script.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The non-cone patterns under `sparse-checkout: |`, as repo-relative paths. */
function sparseSet(workflow) {
	const lines = readFileSync(join(ROOT, '.github/workflows', workflow), 'utf8').split('\n');
	const at = lines.findIndex((l) => /^\s*sparse-checkout: \|\s*$/.test(l));
	assert.ok(at >= 0, `${workflow}: no block-form sparse-checkout`);
	const indent = lines[at + 1].match(/^\s*/)[0];
	const out = [];
	for (const l of lines.slice(at + 1)) {
		if (!l.startsWith(indent) || !l.trim()) break;
		out.push(l.trim().replace(/^\//, ''));
	}
	assert.ok(
		lines.some((l) => /^\s*sparse-checkout-cone-mode: false\s*$/.test(l)),
		`${workflow}: a file pattern needs sparse-checkout-cone-mode: false`
	);
	return out;
}

/** Every repo-relative file a script reaches through relative imports. */
function importGraph(entry, seen = new Set()) {
	if (seen.has(entry)) return seen;
	seen.add(entry);
	const src = readFileSync(join(ROOT, entry), 'utf8');
	for (const m of src.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+'(\.{1,2}\/[^']+)'/gms)) {
		importGraph(relative(ROOT, resolve(ROOT, dirname(entry), m[1])), seen);
	}
	return seen;
}

const covered = (file, set) => set.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));

for (const [workflow, script] of [
	['ppe-promote.yml', 'scripts/ppe/promote.mjs'],
	['ppe-sync.yml', 'scripts/ppe/sync.mjs'],
]) {
	void test(`${workflow}'s sparse checkout holds every file ${script} imports`, () => {
		const set = sparseSet(workflow);
		const files = [...importGraph(script)];
		assert.ok(files.includes('scripts/lib/is-main.mjs'), `walked only ${files.join(', ')}`);
		assert.deepEqual(
			files.filter((f) => !covered(f, set)),
			[],
			`add these to ${workflow}'s sparse-checkout`
		);
	});
}
