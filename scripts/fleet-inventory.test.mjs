/**
 * `fleet inventory --write` — F3 characterization (wave clean-1 lane A). The
 * generated-region splice moved off a hand-rolled `writeFileSync` onto the
 * shared `writeFileAtomic`. No test exercised this CLI's `--write` path
 * before (only `scripts/lib/fleet-inventory.test.mjs`'s pure-function half);
 * `fleet-inventory.mjs` runs `main()` unconditionally at import, so it is
 * run as a real subprocess here, never imported — see AGENTS.md.
 *
 * Mirrors `ci-watch.test.mjs`'s fixture shape: a throwaway manifest dir
 * (`fleet-runner-coverage.json` roster, `runner-inventory-notes.json`), a
 * fixture site root with the doc already fenced, and real fixture git
 * remotes read through `fleet-source.mjs` (never a sibling checkout).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixtureRemotes } from './lib/fleet-source-fixture.mjs';
import { BEGIN_MARKER, END_MARKER } from './lib/fleet-inventory.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'fleet-inventory.mjs');

const NO_GIT_ENV = Object.fromEntries(
	Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
);

function fixture(repos = ['WolffM/app']) {
	const remotes = fixtureRemotes('fleet-inventory-gate-');
	const root = remotes.root;
	const manifestDir = join(root, 'manifest');
	const siteRoot = join(root, 'site');
	mkdirSync(manifestDir, { recursive: true });
	mkdirSync(join(siteRoot, 'docs', 'operations'), { recursive: true });

	writeFileSync(
		join(manifestDir, 'fleet-runner-coverage.json'),
		JSON.stringify({ repos, facets: {} })
	);
	writeFileSync(join(manifestDir, 'runner-inventory-notes.json'), JSON.stringify({ notes: {} }));

	const doc = join(siteRoot, 'docs', 'operations', 'SELF_HOSTED_RUNNERS.md');
	writeFileSync(doc, `# Self-hosted runners\n\n${BEGIN_MARKER}\n${END_MARKER}\n`);

	return { root, remotes, manifestDir, siteRoot, doc };
}

function run(fx, argv) {
	try {
		const out = execFileSync('node', [SCRIPT, ...argv], {
			env: {
				...NO_GIT_ENV,
				...fx.remotes.env,
				FLEET_MANIFEST_DIR: fx.manifestDir,
				HADOKU_SITE_ROOT: fx.siteRoot,
			},
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { code: 0, out };
	} catch (e) {
		return { code: e.status ?? -1, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
	}
}

function cleanup(fx) {
	rmSync(fx.root, { recursive: true, force: true });
}

test('fleet inventory --write splices the generated region into the doc through the shared atomic writer', () => {
	const fx = fixture();
	try {
		fx.remotes.push('WolffM/app', {
			'.github/workflows/ci.yml': 'jobs:\n  check:\n    runs-on: ${{ fromJSON(vars.CI_RUNNER) }}\n',
		});
		const r = run(fx, ['--write']);
		assert.equal(r.code, 0, r.out);

		const text = readFileSync(fx.doc, 'utf8');
		assert.match(text, /# Self-hosted runners/, 'prose outside the fences survives the splice');
		assert.match(text, new RegExp(BEGIN_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
		assert.match(text, /`ci\.yml`/);
		assert.match(text, /`app`/);

		// No leftover `.tmp` sibling next to the doc — the atomic write cleaned
		// up after itself.
		assert.deepEqual(
			readdirSync(dirname(fx.doc)).filter((f) => f.startsWith('SELF_HOSTED_RUNNERS.md')),
			['SELF_HOSTED_RUNNERS.md']
		);
	} finally {
		cleanup(fx);
	}
});

test('fleet inventory --write refuses (and never writes) when a roster repo is unreadable', () => {
	const fx = fixture(['WolffM/app', 'WolffM/unreadable']);
	try {
		// 'WolffM/app' ships a workflow (rows.length > 0, so the scan is not
		// ZERO); 'WolffM/unreadable' has no pushed remote at all, so fleet-source
		// reports it unreadable — the write must be refused, and the fenced doc
		// left untouched.
		fx.remotes.push('WolffM/app', {
			'.github/workflows/ci.yml': 'jobs:\n  check:\n    runs-on: ${{ fromJSON(vars.CI_RUNNER) }}\n',
		});
		const before = readFileSync(fx.doc, 'utf8');
		const r = run(fx, ['--write']);
		assert.notEqual(r.code, 0, r.out);
		assert.match(r.out, /REFUSING to write/);
		assert.equal(
			readFileSync(fx.doc, 'utf8'),
			before,
			'the doc is byte-identical to before the run'
		);
	} finally {
		cleanup(fx);
	}
});
