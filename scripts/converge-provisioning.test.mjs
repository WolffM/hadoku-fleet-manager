/**
 * The converger, end to end, on the 2026-10-23 shape — fleet-manager#1.
 *
 * A fake node (lib/fake-node.mjs) is put into exactly the state claw-4 and
 * claw-6 were in. A standing runner's unit was started with no slice drop-in,
 * so it runs in app.slice, and its `.env` holds RUNNER_TOOL_CACHE and nothing
 * the throttle writes. The converger runs, then the two real checks run
 * read-only against the same node.
 *
 * Covered here: both facets drifting at once, repaired with ONE restart.
 * The deferral and failure verdicts are covered against driver-shaped JSON in
 * lib/provisioning-converge.test.mjs. Throttle's own restart path reads
 * /proc/<pid>/cgroup, which a fake node cannot supply.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFakeNode } from './lib/fake-node.mjs';
import { runFleetScript } from './lib/run-fleet-script.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLAW = 'fixture-claw';
const UNIT = 'actions-runner-hadoku-fleet-manager.service';

/** claw-4 at 2026-10-22 18:35Z: registered, started, never provisioned. */
const DRIFTED_1023 = `
set -e
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
D="$HOME/runners/actions-runner-hadoku-fleet-manager"
mkdir -p "$D/bin" "$HOME/.config/systemd/user"
echo '{"agentId":7}' > "$D/.runner"
printf 'LANG=C.UTF-8\\nRUNNER_TOOL_CACHE=/opt/hostedtoolcache\\n' > "$D/.env"
printf '[Unit]\\nDescription=x\\n[Service]\\nExecStart=%%h/runners/actions-runner-hadoku-fleet-manager/run.sh\\nWorkingDirectory=%%h/runners/actions-runner-hadoku-fleet-manager\\nRestart=always\\nKillMode=mixed\\n[Install]\\nWantedBy=default.target\\n' > "$HOME/.config/systemd/user/${UNIT}"
systemctl --user daemon-reload
systemctl --user enable --now ${UNIT}
`;

function fixture() {
	const node = createFakeNode({ runnerVersion: '2.337.0' });
	const manifests = join(node.root, 'manifests');
	mkdirSync(manifests);
	writeFileSync(
		join(manifests, 'fleet-runner-manifest.json'),
		JSON.stringify({
			machines: {
				[CLAW]: { cores: 4, ramGb: 8, maxConcurrent: 2, minFreeMb: 1024, slice: {} },
			},
		})
	);
	const env = {
		...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
		...node.env,
		PATH: `${node.callerBin}:${process.env.PATH}`,
		FLEET_MANIFEST_DIR: manifests,
		HADOKU_STATE_DIR: manifests,
		HADOKU_SITE_ROOT: '/nonexistent',
		FLEET_NO_BANNER: '1',
	};
	execFileSync('ssh', [CLAW], { env, input: DRIFTED_1023 });
	return { node, env };
}

const check = async (script, env) => {
	const r = await runFleetScript(join(HERE, script), ['--machine', CLAW, '--check', '--json'], {
		env,
	});
	assert.ok(r.json, `${script} --check gave no JSON: ${r.why}`);
	return r.json.results.find((x) => x.machine === CLAW);
};

test('the 10-23 drift is converged on both facets with one restart, and both checks then pass', async () => {
	const { node, env } = fixture();
	try {
		// Not vacuous: the checks see what the nightly gates saw.
		const t0 = await check('deploy-ci-throttle.mjs', env);
		assert.match(t0.summary, /\bnewly=1\b/, t0.summary);
		const s0 = await check('deploy-runners-slice.mjs', env);
		assert.ok(
			s0.notes.some((n) => n.startsWith(`SLICE-PLACEMENT-DRIFT ${UNIT} effective=app.slice`)),
			s0.notes.join('\n')
		);

		const run = await runFleetScript(join(HERE, 'converge-provisioning.mjs'), ['--json'], { env });
		assert.ok(run.json, `converge gave no JSON: ${run.why}`);
		const doc = run.json;
		assert.equal(run.code, 0, JSON.stringify(doc, null, 2));
		assert.deepEqual(
			doc.converged.map((r) => `${r.node}/${r.facet}`),
			[`${CLAW}/throttle`, `${CLAW}/slice`],
			JSON.stringify(doc, null, 2)
		);
		assert.deepEqual([doc.unconverged, doc.deferred, doc.unreadable], [[], [], []]);
		const [thrChanged, sliceChanged] = doc.changed.map((c) => c.changed);
		assert.equal(thrChanged, 'env written on 1 runner(s), 0 restarted');
		assert.match(sliceChanged, /, 1 restarted$/);

		// Born in app.slice, restarted ONCE into runners.slice.
		assert.deepEqual(
			node.starts().filter((l) => l.includes(UNIT)),
			[`START ${UNIT} slice=app.slice`, `START ${UNIT} slice=runners.slice`]
		);

		const t1 = await check('deploy-ci-throttle.mjs', env);
		for (const kv of ['wired=1', 'newly=0', 'stale=0', 'stale_remaining=0']) {
			assert.match(t1.summary, new RegExp(`\\b${kv}\\b`), t1.summary);
		}
		const s1 = await check('deploy-runners-slice.mjs', env);
		assert.deepEqual(
			s1.notes.filter((n) => n.includes(UNIT)),
			[]
		);
		assert.equal(s1.summary.in_slice, '1');

		// And a second pass finds nothing to do.
		const again = await runFleetScript(join(HERE, 'converge-provisioning.mjs'), ['--json'], {
			env,
		});
		assert.deepEqual(again.json?.planned, [], JSON.stringify(again.json));
		assert.equal(node.starts().filter((l) => l.includes(UNIT)).length, 2);
		assert.deepEqual(node.unhandled(), []);
	} finally {
		node.cleanup();
	}
});
