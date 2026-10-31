/**
 * check-contract-consumers, run for real against a fixture hadoku_site
 * checkout — the GateDoc half (wave 5f lane B) alongside the pre-existing
 * `findings`/`verifiedEntries` shape.
 *
 * No test file existed for this script before this wave; `json-contract.test.mjs`
 * only proves the PARSERS this script calls (`parseAuditGates`, `evidenceRegExp`,
 * `suppressesBanner`) in isolation. This proves the SCRIPT, through a real
 * `HADOKU_SITE_ROOT`, in the three shapes GateDoc exists to tell apart:
 * could-not-look (no checkout), a real finding (a missing/drifted consumer),
 * and a clean sweep.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tempDir, cleanupTempDirs } from './lib/test-tmpdir.mjs';
import { JSON_CONTRACT, PROSE_CONTRACT } from './lib/json-contract.mjs';

afterEach(cleanupTempDirs);

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-contract-consumers.mjs');

/** A `script: 'fleet'` GATES entry whose evidence can never match anything real. */
const SAFE_GATE = (id) =>
	`\t{\n\t\tid: '${id}',\n\t\tscript: 'fleet',\n\t\tsub: '${id}',\n\t\targs: [],\n\t\tevidence: /zzz-${id}-never-matches-zzz/,\n\t\twhy: 'fixture',\n\t},\n`;

/**
 * A fixture `hadoku_site` checkout. `complete: true` writes every declared
 * consumer, each mentioning its job name, plus a `FLEET_NO_BANNER` assignment
 * and >= 8 safe `script: 'fleet'` GATES entries in the prose consumer — a
 * clean sweep. `complete: false` writes every consumer EXCEPT the first
 * JSON_CONTRACT entry's, to produce exactly one MISSING finding.
 */
function siteFixture({ complete }) {
	const dir = tempDir('contract-consumers-site-');
	const skip = complete ? null : JSON_CONTRACT[0].consumer;
	for (const entry of JSON_CONTRACT) {
		if (entry.consumer === skip) continue;
		const abs = join(dir, entry.consumer);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, `// consumer of ${entry.job}\n`);
	}
	for (const entry of PROSE_CONTRACT) {
		const abs = join(dir, entry.consumer);
		mkdirSync(dirname(abs), { recursive: true });
		const gates = Array.from({ length: 8 }, (_, i) => SAFE_GATE(`fx-safe-${i}`)).join('');
		writeFileSync(
			abs,
			`// consumer of ${entry.job}\n` +
				`const env = { FLEET_NO_BANNER: '1' };\n` +
				`const GATES = [\n${gates}];\n`
		);
	}
	return dir;
}

function run(siteRoot, extraArgv = ['--json']) {
	const dir = tempDir('contract-consumers-run-');
	const r = spawnSync(process.execPath, [SCRIPT, ...extraArgv], {
		encoding: 'utf8',
		env: { ...process.env, HADOKU_SITE_ROOT: siteRoot, REPOS_DIR: dir, HADOKU_STATE_DIR: dir },
	});
	return r;
}

void test('no checkout at all: GateDoc reports could-not-look, never a finding', () => {
	const r = run('/nonexistent-fixture-site-root');
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.ok, false);
	assert.equal(r.status, 1);
	assert.deepEqual(doc.findings, []);
	assert.equal(doc.unreadable.length, 1);
	assert.equal(doc.unreadable[0].node, null);
	assert.match(doc.unreadable[0].why, /cannot resolve/);
	assert.ok(doc.why, 'a failing GateDoc must carry why');
});

void test('a missing consumer: GateDoc reports it as a finding, not unreadable', () => {
	const site = siteFixture({ complete: false });
	const r = run(site);
	const doc = JSON.parse(r.stdout);
	assert.equal(doc.ok, false);
	assert.equal(r.status, 1);
	assert.deepEqual(doc.unreadable, []);
	assert.ok(doc.findings.length >= 1);
	const missing = doc.findings.find((f) => f.kind === 'MISSING');
	assert.ok(missing, JSON.stringify(doc.findings));
	assert.equal(missing.node, null);
	assert.match(missing.reason, /does not exist/);
	assert.equal(missing.job, JSON_CONTRACT[0].job);
});

void test('a clean sweep: GateDoc is ok, no findings, nothing unreadable', () => {
	const site = siteFixture({ complete: true });
	const r = run(site);
	const doc = JSON.parse(r.stdout);
	assert.equal(r.status, 0, JSON.stringify(doc));
	assert.equal(doc.ok, true);
	assert.deepEqual(doc.findings, []);
	assert.deepEqual(doc.unreadable, []);
	assert.ok(!('why' in doc), 'a clean GateDoc must not carry why');
	// The pre-existing shape travels too, under its migration-era name.
	assert.equal(doc.entries, JSON_CONTRACT.length + PROSE_CONTRACT.length);
	assert.equal(doc.verifiedEntries.length, doc.entries);
});

void test('human output is unaffected by the migration — same prose, same exit code', () => {
	const site = siteFixture({ complete: true });
	const human = run(site, []);
	const json = run(site, ['--json']);
	assert.equal(human.status, json.status, 'exit code must match between the two modes');
	assert.match(human.stdout, /every contract entry names a consumer that exists/);
	assert.ok(!human.stdout.trim().startsWith('{'), 'human mode must not print JSON');
});
