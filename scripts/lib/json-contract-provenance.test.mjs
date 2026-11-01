/**
 * Split out of `json-contract.test.mjs` (wave 5s lane B) to bring that file
 * under the 1,000-line test ceiling — a whole-block move, every test body
 * below unchanged from where it lived there. `json-contract-declaration.test.mjs`
 * holds everything checked by reading source text alone; this is the one
 * check that runs the real, built CLI rather than reading it. See the doc
 * comment on the test below for the rule itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { JSON_CONTRACT } from './json-contract.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BUILT_CLI = join(ROOT, 'dist', 'cli.js');

/**
 * THE PROVENANCE BANNER MUST NOT REACH STDOUT.
 *
 * Issue #4 put a `site=… manifests=… fleet-manager=…` line on every subcommand,
 * and the trap it walks past is this contract: each consumer below reads stdout
 * and checks it starts with `{` BEFORE it looks at the exit code, so one extra
 * line on fd 1 turns every real finding into "the checker broke" — nightly, in
 * ten jobs, until somebody reads a log.
 *
 * PROVEN BY RUNNING THE REAL CLI, not by reading it. The rules above are
 * structural because behaviour was out of reach — `reconcile` needs a token,
 * `toolchain` needs ssh, `header-audit` needs 25 checkouts. This one is not:
 * the banner is written by the PARENT before it spawns anything, so pointing
 * every path at a directory that does not exist makes each subcommand fail in
 * under 100ms and still exercises the exact code that emits the banner. The
 * failures are the point — a broken environment is when a gate is most tempted
 * to write something extra to stdout.
 *
 * It also asserts the positive half. A banner that silently stopped being
 * printed would satisfy "stdout is clean" perfectly and lose the whole feature.
 */
const POISONED = {
	...process.env,
	// Every path resolver THROWS on a directory that is not there, which is what
	// makes these fail fast and offline. See src/lib/fleet-paths.ts.
	FLEET_MANIFEST_DIR: '/nonexistent-fleet-manifests',
	REPOS_DIR: '/nonexistent-fleet-repos',
	HADOKU_STATE_DIR: '/nonexistent-fleet-state',
	GH_TOKEN: '',
	GITHUB_TOKEN: '',
};
delete POISONED.HADOKU_SITE_ROOT;

void test('no contract subcommand writes the provenance banner to stdout', () => {
	assert.ok(
		existsSync(BUILT_CLI),
		`dist/cli.js is missing — run \`pnpm run build\` first. This test runs the CLI for ` +
			`real; skipping it because the build is absent would be "I could not look" rendering ` +
			`as "nothing is wrong".`
	);

	for (const entry of JSON_CONTRACT) {
		const r = spawnSync(process.execPath, [BUILT_CLI, entry.sub, ...entry.argv], {
			env: POISONED,
			encoding: 'utf8',
			timeout: 30_000,
			maxBuffer: 8 * 1024 * 1024,
		});
		const stdout = r.stdout ?? '';
		const stderr = r.stderr ?? '';

		for (const token of ['site=', 'manifests=', 'fleet-manager=']) {
			assert.ok(
				!stdout.includes(token),
				`\`fleet ${entry.sub} ${entry.argv.join(' ')}\` put "${token}" on STDOUT. ` +
					`${entry.job} (${entry.consumer}) requires stdout to be the subcommand's JSON and ` +
					`nothing else — it tests \`startsWith('{')\` before the exit code, so this turns ` +
					`every finding into a broken checker. Send the banner to stderr.`
			);
		}
		assert.match(
			stderr,
			/\bfleet-manager=/,
			`\`fleet ${entry.sub}\` printed no provenance banner on stderr at all. It is what ` +
				`says WHICH tree and WHICH install answered — the thing missing on 2026-09-04 when ` +
				`an operator chased G7 while the alert named G3.`
		);
		// Whatever DID reach stdout is still the contract shape. These runs all
		// fail (nothing resolves), and a failing gate writing prose to stdout is
		// the same breakage by another route.
		if (stdout.trim()) {
			assert.ok(
				stdout.trim().startsWith('{'),
				`\`fleet ${entry.sub} ${entry.argv.join(' ')}\` wrote non-JSON to stdout under ` +
					`--json: ${JSON.stringify(stdout.slice(0, 200))}`
			);
		}
	}
});

void test('FLEET_NO_BANNER=1 silences it, for a caller that compares fd 2 byte for byte', () => {
	const r = spawnSync(process.execPath, [BUILT_CLI, 'queue-health', '--json'], {
		env: { ...POISONED, FLEET_NO_BANNER: '1' },
		encoding: 'utf8',
		timeout: 30_000,
	});
	assert.ok(
		!(r.stderr ?? '').includes('fleet-manager='),
		'FLEET_NO_BANNER=1 did not suppress the banner'
	);
});
