/**
 * The fields a TENANT reads (`TENANT_CONTRACT` in json-contract.mjs) must keep
 * existing. Two layers, because running node-status end to end would reach
 * this box's real /proc and cgroups (a fixture HOME is not isolation):
 *
 *   - the hosting judgement is a pure function, so its `observed` fields are
 *     checked on its OUTPUT;
 *   - every other path's last key must still be built somewhere in the
 *     producing source, comments blanked so prose cannot satisfy it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments } from './blank-comments.mjs';
import { parseCliCommands, TENANT_CONTRACT } from './json-contract.mjs';
import { judgeHosting, parseObserved } from './hosting.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
/** Source with comments AND quoted strings blanked: a help line saying "reachable," builds nothing. */
const read = (rel) =>
	blankComments(readFileSync(join(ROOT, rel), 'utf8')).replace(
		/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g,
		"''"
	);

/** Where each subcommand's document is assembled. */
const PRODUCERS = {
	'node-status': [
		'scripts/node-status.mjs',
		'scripts/lib/hosting.mjs',
		'scripts/lib/node-users-facet.mjs',
		'src/runners/drain.ts',
	],
	hosting: ['scripts/hosting.mjs', 'scripts/lib/hosting.mjs'],
};

const keyOf = (path) => path.split('.').at(-1).replace('[]', '');
/** A property `key:`, or the shorthand `{ key,` / `, key }`. */
const builds = (src, key) => new RegExp(`\\b${key}\\s*:|[{,]\\s*${key}\\s*[,}]`).test(src);

void test('every tenant-read subcommand is still in the CLI', () => {
	const commands = parseCliCommands(blankComments(readFileSync(join(ROOT, 'src/cli.ts'), 'utf8')));
	for (const c of TENANT_CONTRACT) assert.ok(commands.has(c.sub), `${c.sub} left the CLI`);
});

void test('every field a tenant reads is still built by its producer', () => {
	const missing = [];
	for (const c of TENANT_CONTRACT) {
		const src = PRODUCERS[c.sub].map(read).join('\n');
		for (const f of c.fields) if (!builds(src, keyOf(f))) missing.push(`${c.sub}: ${f}`);
	}
	assert.deepEqual(missing, [], 'tell cardtable before any of these change');
});

void test("the hosting judgement's observed fields come out of the function itself", () => {
	const declared = { tenant: 'cardtable', memoryMb: 4096, cores: 4, port: 7621 };
	const obs = parseObserved('OBSERVE-BEGIN\nmemoryCurrent=1048576\nOBSERVE-END');
	const reach = { addrs: {}, controller: { lan: 'open' }, peer: null };
	const { observed } = judgeHosting(declared, obs, 'shared', reach);
	const fields = TENANT_CONTRACT.find((c) => c.sub === 'node-status').fields;
	for (const f of fields.filter((p) => p.startsWith('nodes[].hosting.observed.')))
		assert.ok(keyOf(f) in observed, `judgeHosting no longer reports ${keyOf(f)}`);
	assert.equal(observed.memoryInUseMb, 1);
});

void test('the guard sees a key that is gone', () => {
	assert.equal(builds('{ reachable: true }', 'reachable'), true);
	assert.equal(builds('{ reachableNow: true }', 'reachable'), false);
	assert.equal(builds('return { node, ok }', 'node'), true);
	assert.equal(
		builds("log('per node: reachable, health')".replace(/'[^']*'/g, "''"), 'reachable'),
		false
	);
});
