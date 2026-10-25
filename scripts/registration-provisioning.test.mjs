/**
 * A STANDING RUNNER IS BORN PROVISIONED — fleet-manager#1.
 *
 * On 2026-10-22 `fleet reconcile --confirm` registered hadoku-fleet-manager's
 * standing runners on claw-4 and claw-6. `registerScript` ran
 * `systemctl --user enable --now` with no slice drop-in and a `.env` holding
 * only RUNNER_TOOL_CACHE, so both units started in app.slice (no group
 * ceiling) with no throttle hook (no concurrency limit) and no TMPDIR or
 * compile cache. `check:slice` and `check:throttle` were red for two nights and
 * the fix needed `slice --confirm --restart` — a restart that a runner born in
 * the slice never needs.
 *
 * WHAT THIS PROVES, AND HOW. The reconciler registers one missing pair on a
 * fake node (lib/fake-node.mjs) whose `ssh` runs every script for real: the
 * registration script, then the slice and throttle drivers' node halves. Then
 * the two CHECKS run, unmodified and read-only, against the same node. Nothing
 * runs in between. The checks are the readers the nightly gates use, so a pass
 * here is the claim the issue asks for, not a claim about script text.
 *
 * MUTATION-CHECKED: against the registration code before this change, the
 * slice check reports `SLICE-PLACEMENT-DRIFT ... effective=app.slice` and
 * in_slice=0, and the throttle check reports newly=1 — the 10-23 findings,
 * reproduced.
 *
 * NOTHING HERE SPAWNS git, and the environment strips GIT_* anyway.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFakeNode } from './lib/fake-node.mjs';
import { runFleetScript } from './lib/run-fleet-script.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLAW = 'fixture-claw';
const REPO = 'WolffM/fixture-alpha';
const UNIT = 'actions-runner-fixture-alpha.service';
const VERSION = '2.337.0';

/** Every `gh` call the reconcile makes: one repo, no runners yet. */
const GH_SHIM = `#!/usr/bin/env bash
case "$*" in
  "repo list"*)
    echo '[{"nameWithOwner":"${REPO}","isFork":false,"isArchived":false,"pushedAt":"'"$GH_PUSHED_AT"'"}]' ;;
  *"-X POST"*"registration-token"*) echo "fixture-token" ;;
  *"actions/runners"*) echo '{"total_count":0,"runners":[]}' ;;
  *"releases/latest"*) echo 'v${VERSION}' ;;
  *"/contents/.github/workflows") echo '[{"name":"ci.yml","path":".github/workflows/ci.yml"}]' ;;
  *"/contents/.github/workflows/"*)
    printf '{"content":"%s"}\\n' "$(printf 'jobs:\\n  check:\\n    runs-on: \${{ fromJSON(vars.CI_RUNNER) }}\\n' | base64 -w0)" ;;
  *"trees/HEAD"*) echo '{"tree":[]}' ;;
  *) echo '{}' ;;
esac
`;

function fixture() {
	const node = createFakeNode({ runnerVersion: VERSION });
	const manifests = join(node.root, 'manifests');
	mkdirSync(manifests);
	writeFileSync(
		join(manifests, 'fleet-runner-manifest.json'),
		JSON.stringify({
			machines: {
				[CLAW]: {
					labels: ['hadoku-builder'],
					cores: 4,
					ramGb: 8,
					maxConcurrent: 2,
					minFreeMb: 1024,
					slice: {},
				},
			},
		})
	);
	writeFileSync(join(manifests, 'fleet-runner-coverage.json'), JSON.stringify({ repos: [REPO] }));
	writeFileSync(join(node.callerBin, 'gh'), GH_SHIM);
	chmodSync(join(node.callerBin, 'gh'), 0o755);
	const env = {
		...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
		...node.env,
		PATH: `${node.callerBin}:${process.env.PATH}`,
		FLEET_MANIFEST_DIR: manifests,
		HADOKU_STATE_DIR: manifests,
		// Blind to any sibling checkout on this box (local gate vs CI).
		HADOKU_SITE_ROOT: '/nonexistent',
		FLEET_NO_BANNER: '1',
		GH_PUSHED_AT: new Date().toISOString(),
	};
	return { node, env };
}

const script = (name) => join(HERE, name);

/** The fake node's view, for any assertion message. */
function context(node, extra = '') {
	return `\n  starts: ${JSON.stringify(node.starts())}\n  units: ${node.units().join(', ')}\n${extra}`;
}

test('a freshly registered standing runner passes throttle --check and slice --check with no follow-up', async () => {
	const { node, env } = fixture();
	try {
		let reconcileOut = '';
		try {
			reconcileOut = execFileSync('node', [script('reconcile-fleet-runners.mjs'), '--confirm'], {
				env,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch (err) {
			assert.fail(`reconcile --confirm failed: ${err.stdout}\n${err.stderr}${context(node)}`);
		}
		assert.match(reconcileOut, /Done: 1 registered, 0 removed, 0 failed/, reconcileOut);
		assert.deepEqual(node.unhandled(), [], 'a systemctl call the fake does not model');

		// BORN IN THE SLICE: started exactly once, and that start was already in
		// runners.slice. A second start would be the `--restart` this exists to end.
		assert.deepEqual(
			node.starts().filter((l) => l.includes(UNIT)),
			[`START ${UNIT} slice=runners.slice`],
			context(node, reconcileOut)
		);

		const thr = await runFleetScript(
			script('deploy-ci-throttle.mjs'),
			['--machine', CLAW, '--check', '--json'],
			{ env }
		);
		assert.ok(thr.json, `throttle --check gave no JSON: ${thr.why}`);
		const t = thr.json.results.find((r) => r.machine === CLAW);
		assert.ok(t?.ok, `throttle --check could not read the node: ${JSON.stringify(t)}`);
		// `newly` is the "wrong env on disk" count, `stale` and `nolistener` the
		// two ways a correct env is not loaded: all zero, one runner wired.
		for (const [k, want] of Object.entries({
			wired: '1',
			newly: '0',
			stale: '0',
			stale_remaining: '0',
			nolistener: '0',
		})) {
			assert.match(t.summary, new RegExp(`\\b${k}=${want}\\b`), `${k}: ${t.summary}`);
		}

		const sl = await runFleetScript(
			script('deploy-runners-slice.mjs'),
			['--machine', CLAW, '--check', '--json'],
			{ env }
		);
		assert.ok(sl.json, `slice --check gave no JSON: ${sl.why}`);
		const s = sl.json.results.find((r) => r.machine === CLAW);
		assert.ok(s?.ok && s.summary, `slice --check could not read the node: ${JSON.stringify(s)}`);
		const unitNotes = s.notes.filter((n) => n.includes(UNIT));
		assert.deepEqual(
			unitNotes,
			[],
			`slice --check findings for the new unit:\n${s.notes.join('\n')}`
		);
		assert.equal(s.summary.user_units, '1', JSON.stringify(s.summary));
		assert.equal(s.summary.in_slice, '1', `in_slice: ${JSON.stringify(s.summary)}`);
		assert.equal(s.summary.capped_live, '1', `capped_live: ${JSON.stringify(s.summary)}`);
		assert.equal(s.summary.changed, '0', `changed: ${JSON.stringify(s.summary)}`);
		assert.equal(s.summary.supervised, '1', `supervised: ${JSON.stringify(s.summary)}`);
		// The two findings the 10-23 gates printed, by name.
		assert.ok(
			!s.problems.some((p) => /RUN outside it/.test(p)),
			`slice problems:\n${s.problems.join('\n')}`
		);

		// And the checks were read-only: the runner was still started only once.
		assert.equal(node.starts().filter((l) => l.includes(UNIT)).length, 1, context(node));
	} finally {
		node.cleanup();
	}
});

test('a node whose provisioning fails is registered but NOT started, and the run fails naming why', () => {
	const { node, env } = fixture();
	try {
		// No `slice` block: the slice driver has nothing to deploy to this node,
		// so the unit cannot be born in a slice. It must stay stopped.
		writeFileSync(
			join(env.FLEET_MANIFEST_DIR, 'fleet-runner-manifest.json'),
			JSON.stringify({
				machines: {
					[CLAW]: { labels: ['hadoku-builder'], maxConcurrent: 2, minFreeMb: 1024 },
				},
			})
		);
		let code = 0;
		let out = '';
		try {
			out = execFileSync('node', [script('reconcile-fleet-runners.mjs'), '--confirm'], {
				env,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch (err) {
			code = err.status;
			out = String(err.stdout);
		}
		assert.equal(code, 1, out);
		assert.match(out, /registered and enabled, NOT started: slice --confirm did not converge/, out);
		assert.match(out, /Done: 0 registered, 0 removed, 1 failed/, out);
		assert.deepEqual(node.starts(), [], 'an unprovisioned unit must never start');
	} finally {
		node.cleanup();
	}
});
