// check-consumer-imports (fleet-manager#67): what a consumer imports, and
// whether a candidate build still provides it. The typecheck half runs real
// tsc against a fixture package; nothing here reads a consumer's repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildProbe, surfaceFromUrl, typecheckProbe } from './check-consumer-imports.mjs';
import { collectUses, extractImports } from './lib/consumer-imports.mjs';

const P = '@wolffm/fleet-manager';
const names = (src, opts) => extractImports(src, opts).map((u) => `${u.kind}:${u.name}@${u.spec}`);

test('every import shape the site uses, and none from prose', () => {
	const src = `
// import { Ghost } from '${P}';   <- a comment is not an import
/* export { Phantom } from '${P}'; */
import type {
	FleetVocabulary,
	// BackstopReason was dropped in 0.34.324
	ClawState,
} from '${P}';
import { createFleetManager, type FleetHost, isLocalNode as isLocal } from '${P}';
import * as source from '${P}/fleet-source';
import tiers from '${P}/tier-detectors';
export { shipped } from '${P}/fleet-source';
export type { Gate } from '${P}';
const { nodeExec, runOn: run } = await import('${P}/fleet-exec');
await import('${P}/yaml-comments');
import '${P}/sibling-repos';
import { other } from '@wolffm/fleet-manager-extra';
`;
	assert.deepEqual(names(src).sort(), [
		`default:default@${P}/tier-detectors`,
		`module:null@${P}/fleet-exec`,
		`module:null@${P}/sibling-repos`,
		`module:null@${P}/yaml-comments`,
		`namespace:null@${P}/fleet-source`,
		`type:ClawState@${P}`,
		`type:FleetHost@${P}`,
		`type:FleetVocabulary@${P}`,
		`type:Gate@${P}`,
		`value:createFleetManager@${P}`,
		`value:isLocalNode@${P}`,
		`value:nodeExec@${P}/fleet-exec`,
		`value:runOn@${P}/fleet-exec`,
		`value:shipped@${P}/fleet-source`,
	]);
});

test('a JS consumer has no types: every named import is a value', () => {
	assert.deepEqual(names(`import { type X } from '${P}';`, { js: true }), [`value:X@${P}`]);
});

test('collectUses keeps one binding per name and every file that uses it', () => {
	const uses = collectUses(
		new Map([
			['a.ts', `import { x } from '${P}';`],
			['b.ts', `import { x, y } from '${P}';`],
			['c.ts', 'no import here'],
			['d.ts', null],
		])
	);
	assert.deepEqual(
		[...uses.values()].map((u) => [u.name, u.usedBy]),
		[
			['x', ['a.ts', 'b.ts']],
			['y', ['b.ts']],
		]
	);
});

/** A package shaped like this one: typed root, untyped .mjs subpath. */
function fixturePackage() {
	const dir = mkdtempSync(join(tmpdir(), 'consumer-pkg-'));
	writeFileSync(
		join(dir, 'package.json'),
		JSON.stringify({
			name: P,
			type: 'module',
			exports: {
				'.': { types: './index.d.ts', default: './index.js' },
				'./fleet-source': './fleet-source.mjs',
			},
		})
	);
	writeFileSync(
		join(dir, 'index.d.ts'),
		'export type ClawState = "up";\nexport declare const createFleetManager: () => void;\n'
	);
	writeFileSync(join(dir, 'index.js'), 'export const createFleetManager = () => {};\n');
	writeFileSync(join(dir, 'fleet-source.mjs'), 'export function shipped() {}\n');
	mkdirSync(join(dir, 'node_modules'));
	return dir;
}

test('the candidate is judged by real tsc: a removed type, value, JS export or subpath is named with its users', () => {
	const pkg = fixturePackage();
	try {
		const uses = collectUses(
			new Map([
				[
					'src/types.ts',
					`import type { ClawState, BackstopReason } from '${P}';\nimport { createFleetManager, gone } from '${P}';`,
				],
				['scripts/a.mjs', `import { shipped, unshipped } from '${P}/fleet-source';`],
				['scripts/b.mjs', `import x from '${P}/no-such-subpath';`],
			])
		);
		const { findings, other } = typecheckProbe(buildProbe(uses), { pkgRoot: pkg });
		assert.deepEqual(other, []);
		assert.deepEqual(findings.map((f) => [f.name, f.spec, f.usedBy.join(','), f.code]).sort(), [
			['BackstopReason', P, 'src/types.ts', 'TS2305'],
			['default', `${P}/no-such-subpath`, 'scripts/b.mjs', 'TS2307'],
			['gone', P, 'src/types.ts', 'TS2305'],
			['unshipped', `${P}/fleet-source`, 'scripts/a.mjs', 'TS2724'],
		]);
	} finally {
		rmSync(pkg, { recursive: true, force: true });
	}
});

test('an intact surface type-checks clean (non-vacuous: the same uses minus the removed names)', () => {
	const pkg = fixturePackage();
	try {
		const uses = collectUses(
			new Map([
				[
					'src/types.ts',
					`import type { ClawState } from '${P}';\nimport { createFleetManager } from '${P}';`,
				],
				['scripts/a.mjs', `import { shipped } from '${P}/fleet-source';`],
			])
		);
		assert.equal(uses.size, 3);
		assert.deepEqual(typecheckProbe(buildProbe(uses), { pkgRoot: pkg }), {
			findings: [],
			other: [],
		});
	} finally {
		rmSync(pkg, { recursive: true, force: true });
	}
});

test('the mgmt-api surface: its bindings come back keyed like a local read; anything else is could-not-look', async () => {
	const body = {
		success: true,
		package: P,
		consumers: [
			{
				repo: 'WolffM/hadoku_site',
				sha: 'a0be270',
				bindings: [{ spec: P, name: 'ClawState', kind: 'type', usedBy: ['src/types.ts'] }],
			},
		],
	};
	const seen = [];
	const fake = (status, payload) => async (url, init) => {
		seen.push(init.headers['X-User-Key']);
		return {
			ok: status === 200,
			status,
			text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
		};
	};
	const [c] = await surfaceFromUrl('https://x/api/repo/consumer-imports', 'k1', fake(200, body));
	assert.equal(seen[0], 'k1', 'the service key is the credential, and the only one');
	assert.deepEqual(
		[c.repo, c.sha, [...c.uses.values()][0].usedBy],
		['WolffM/hadoku_site', 'a0be270', ['src/types.ts']]
	);

	await assert.rejects(
		surfaceFromUrl('u', 'k', fake(403, { success: false, error: 'access denied' })),
		/HTTP 403 access denied/
	);
	await assert.rejects(surfaceFromUrl('u', 'k', fake(502, '<html>bad gateway')), /not JSON/);
	await assert.rejects(surfaceFromUrl('u', 'k', fake(200, { success: true })), /HTTP 200/);
});
