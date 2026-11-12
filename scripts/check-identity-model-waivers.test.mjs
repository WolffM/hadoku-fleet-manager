/**
 * Inline waivers in the identity-model gate (fleet-manager#82): a repo exempts
 * its own code next to the code, the central list keeps `nonWaivable`, and
 * `--print-waivers` moves central rows into the repos they name.
 *
 * The marker is assembled at runtime (`MARK`) so this file holds no literal
 * waiver for the fleet's own scans of this repo to read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { jsonDoc, runFiles, withRemotes } from './lib/identity-model-fixtures.mjs';

const MARK = ['identity-model', 'disable-next-line'].join('-');
/** One G4 finding, on line 2 of the file. */
const G4_LINE = "export const f = { ownerId: 'hadoku' };\n";
const waived = (head) => `${head}\n${G4_LINE}`;
const SIB = { repos: ['WolffM/hadoku-sib'], facets: {} };

test('a waiver with a reason absorbs the finding on the next line', () => {
	const r = runFiles(
		{ 'src/f.ts': waived(`// ${MARK} G4: a fixture of the old value`) },
		{ extra: ['--json'] }
	);
	assert.equal(r.code, 0, r.out);
	assert.equal(jsonDoc(r).waived, 1);
});

test('the waiver skips blank and comment-only lines, so a reason can run long', () => {
	const head = `// ${MARK} G4: a fixture of the old value,\n// continued on a second line\n`;
	const r = runFiles({ 'src/f.ts': waived(head) });
	assert.equal(r.code, 0, r.out);
});

test('a waiver with no reason absorbs nothing and is itself a finding', () => {
	const r = runFiles({ 'src/f.ts': waived(`// ${MARK} G4`) }, { extra: ['--json'] });
	assert.equal(r.code, 1, r.out);
	const checks = jsonDoc(r).violations.map((v) => `${v.check}:${v.line}`);
	assert.deepEqual(checks.sort(), ['G4:2', 'waiver:1']);
});

test('a waiver on a line with no finding is unused, and fails', () => {
	const src = `// ${MARK} G4: was a fixture\nexport const f = 1;\n`;
	const r = runFiles({ 'src/f.ts': src }, { extra: ['--json'] });
	assert.equal(r.code, 1, r.out);
	assert.match(jsonDoc(r).violations[0].message, /no G4 finding: remove it/);
});

test('a waiver naming the wrong check does not absorb the finding', () => {
	const r = runFiles({ 'src/f.ts': waived(`// ${MARK} G5: wrong check`) }, { extra: ['--json'] });
	assert.equal(r.code, 1, r.out);
	const checks = jsonDoc(r).violations.map((v) => v.check);
	assert.deepEqual(checks.sort(), ['G4', 'waiver'], 'G4 live, the G5 waiver unused');
});

test('a token that is not a check is not a waiver: the finding stays live', () => {
	const r = runFiles(
		{ 'src/f.ts': waived(`// ${MARK} <check>: prose about the syntax`) },
		{
			extra: ['--json'],
		}
	);
	assert.deepEqual(
		jsonDoc(r).violations.map((v) => v.check),
		['G4']
	);
});

test('a NON-WAIVABLE check: the waiver absorbs nothing and is a finding', () => {
	const r = runFiles(
		{ 'src/f.ts': waived(`// ${MARK} G4: please`) },
		{ extra: ['--json'], nonWaivable: ['G4'] }
	);
	assert.equal(r.code, 1, r.out);
	const doc = jsonDoc(r);
	assert.deepEqual(doc.violations.map((v) => v.check).sort(), ['G4', 'waiver']);
	assert.match(doc.violations.find((v) => v.check === 'waiver').message, /non-waivable/);
});

test('nonWaivable must name real checks', () => {
	const r = runFiles({ 'src/f.ts': 'export const ok = 1;\n' }, { nonWaivable: ['G99'] });
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /"nonWaivable" must list check ids/);
});

test('a SQL migration takes a `--` waiver', () => {
	const sql = `-- ${MARK} G2: legacy column, read by nothing\nCREATE TABLE t (user_key TEXT);\n`;
	const r = runFiles({ 'workers/x-api/migrations/0001.sql': sql }, { extra: ['--json'] });
	assert.equal(r.code, 0, r.out);
	assert.equal(jsonDoc(r).waived, 1);
});

test('a sibling waiving inline SUPERSEDES its central row: reported, never stale', () => {
	withRemotes((repos, remotes) => {
		remotes.push('WolffM/hadoku-sib', { 'src/f.ts': waived(`// ${MARK} G4: old value`) });
		const r = runFiles(
			{},
			{
				extra: ['--fleet', '--json'],
				coverage: SIB,
				REPOS_DIR: repos,
				allow: [{ check: 'G4', file: 'hadoku-sib:src/f.ts', why: 'old value' }],
			}
		);
		assert.equal(r.code, 0, r.out);
		const doc = jsonDoc(r);
		assert.deepEqual(doc.staleExemptions, []);
		assert.deepEqual(doc.supersededExemptions, ['G4 hadoku-sib:src/f.ts']);
	});
});

test('--print-waivers moves a sibling row into the sibling, and the result is clean', () => {
	withRemotes((repos, remotes) => {
		const body = `export const a = 1;\n${G4_LINE}export const b = 2;\n${G4_LINE}`;
		remotes.push('WolffM/hadoku-sib', { 'src/f.ts': body });
		const opts = {
			coverage: SIB,
			REPOS_DIR: repos,
			allow: [
				{ check: 'G4', file: 'hadoku-sib:src/f.ts', why: 'two fixtures of the old value' },
				{ check: 'G4', file: 'src/site.ts', why: 'the site keeps its own' },
			],
		};
		const site = { 'src/site.ts': G4_LINE };
		const r = runFiles(site, { ...opts, extra: ['--fleet', '--print-waivers', '--json'] });
		assert.equal(r.code, 0, r.out);
		const doc = jsonDoc(r);
		assert.equal(doc.complete, true);
		assert.deepEqual(
			doc.waivers.map((w) => [w.repo, w.file, w.line]),
			[
				['hadoku-sib', 'src/f.ts', 4],
				['hadoku-sib', 'src/f.ts', 2],
			],
			'bottom-up, and the site row is not moved'
		);
		assert.match(doc.waivers[1].insert[0], /two fixtures of the old value/, 'full reason on top');

		// Apply them as printed, bottom-up, and the sibling is clean on its own.
		const lines = body.split('\n');
		for (const w of doc.waivers) lines.splice(w.line - 1, 0, ...w.insert);
		remotes.push('WolffM/hadoku-sib', { 'src/f.ts': lines.join('\n') });
		const after = runFiles(site, {
			...opts,
			allow: [opts.allow[1]],
			extra: ['--fleet', '--json'],
		});
		assert.equal(after.code, 0, after.out);
		assert.equal(jsonDoc(after).waived, 2);
	});
});
