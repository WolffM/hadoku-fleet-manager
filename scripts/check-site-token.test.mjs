/**
 * check-site-token, run whole: the owner's repo list from a `gh` shim, every
 * repo's shipped files from fixture REMOTES through fleet-source
 * (lib/fleet-source-fixture.mjs). The rules themselves are in
 * lib/site-token.test.mjs; this file is about WHAT the gate reads.
 *
 * Every git child here runs with GIT_* stripped — lib/hook-safe-tests.test.mjs.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { fixtureRemotes, poisonedClone } from './lib/fleet-source-fixture.mjs';

const GATE = new URL('./check-site-token.mjs', import.meta.url).pathname;
const NO_GIT_ENV = Object.fromEntries(
	Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
);

/** `repo list` from `repos`; the secrets listing from `secrets` (repo -> names). */
const GH_SHIM = `const fx = JSON.parse(require('fs').readFileSync(process.env.GH_FIXTURE, 'utf8'));
const argv = process.argv.slice(2).join(' ');
if (argv.startsWith('repo list')) {
	const listing = JSON.stringify(fx.repos.map((nameWithOwner) => ({ nameWithOwner })));
	process.stdout.write(listing);
	process.exit(0);
}
const m = argv.match(new RegExp('repos/([^ ]+)/actions/secrets'));
if (m) {
	process.stdout.write((fx.secrets[m[1]] ?? []).join('\\n') + '\\n');
	process.exit(0);
}
process.stderr.write('gh: unexpected call ' + argv + '\\n');
process.exit(1);
`;

const USES_TOKEN =
	'jobs:\n  bump:\n    runs-on: x\n    steps:\n      - run: echo ${{ secrets.HADOKU_SITE_TOKEN }}\n';
const CLEAN = 'jobs:\n  check:\n    runs-on: x\n';

function fleet({ repos, secrets = {}, remotes: files = {} }) {
	const remotes = fixtureRemotes('site-token-');
	const { root } = remotes;
	for (const [repo, f] of Object.entries(files)) remotes.push(repo, f);
	const manifests = join(root, 'manifests');
	const reposDir = join(root, 'repos');
	const bin = join(root, 'bin');
	for (const d of [manifests, reposDir, bin]) mkdirSync(d, { recursive: true });
	writeFileSync(
		join(manifests, 'repo-policy-manifest.json'),
		JSON.stringify({ siteTokenHolders: {} })
	);
	writeFileSync(join(root, 'gh.json'), JSON.stringify({ repos, secrets }));
	// A .cjs beside a bash wrapper: an extensionless node script would load as ESM
	// under any ancestor package.json with "type": "module".
	writeFileSync(join(bin, 'gh.cjs'), GH_SHIM);
	writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash\nexec node "$0.cjs" "$@"\n`);
	chmodSync(join(bin, 'gh'), 0o755);
	const env = {
		...process.env,
		...remotes.env,
		PATH: `${bin}:${process.env.PATH}`,
		GH_FIXTURE: join(root, 'gh.json'),
		REPOS_DIR: reposDir,
		FLEET_MANIFEST_DIR: manifests,
	};
	return { remotes, reposDir, env, cleanup: remotes.cleanup };
}

function run(env) {
	const r = spawnSync(process.execPath, [GATE, '--json'], { encoding: 'utf8', env });
	return { ...r, out: r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : null };
}

const HUB = 'WolffM/hadoku_site';

test('a clean account passes, and every listed repo is read', () => {
	const fx = fleet({
		repos: [HUB, 'WolffM/child'],
		secrets: { [HUB]: ['HADOKU_SITE_TOKEN'] },
		remotes: {
			[HUB]: { '.github/workflows/deploy.yml': USES_TOKEN },
			'WolffM/child': { '.github/workflows/ci.yml': CLEAN },
		},
	});
	try {
		const r = run(fx.env);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.deepEqual(r.out.examined, { repos: 2, checkouts: 2 });
		assert.deepEqual(r.out.findings, []);
	} finally {
		fx.cleanup();
	}
});

test('a repo with NO clone on this host is still read — its workflow and .devvault.json', () => {
	// Before fleet-manager#7 a repo without a checkout under REPOS_DIR had its
	// files silently not read; a cron host holds no checkouts at all.
	const fx = fleet({
		repos: [HUB, 'WolffM/leaky'],
		remotes: {
			[HUB]: { '.github/workflows/ci.yml': CLEAN },
			'WolffM/leaky': {
				'.github/workflows/bump.yml': USES_TOKEN,
				'.devvault.json': JSON.stringify({ GH_PAT: 'HADOKU_SITE_TOKEN' }),
			},
		},
	});
	try {
		const r = run(fx.env);
		assert.equal(r.status, 1);
		assert.deepEqual(
			r.out.findings.map((f) => [f.repo, f.kind]),
			[
				['WolffM/leaky', 'workflow'],
				['WolffM/leaky', 'devvault'],
			]
		);
	} finally {
		fx.cleanup();
	}
});

test('a listed repo whose default branch cannot be read is an unreadable finding', () => {
	const fx = fleet({
		repos: [HUB, 'WolffM/never-pushed'],
		remotes: { [HUB]: { '.github/workflows/ci.yml': CLEAN } },
	});
	try {
		const r = run(fx.env);
		assert.equal(r.status, 1);
		const f = r.out.findings.find((x) => x.repo === 'WolffM/never-pushed');
		assert.equal(f.kind, 'unreadable');
		assert.match(f.detail, /fetch from .* failed/);
		assert.deepEqual(r.out.examined, { repos: 2, checkouts: 1 });
	} finally {
		fx.cleanup();
	}
});

/**
 * fleet-manager#7: A LOCAL CLONE CANNOT CHANGE THE VERDICT. The baseline clones
 * match the shipped branches and carry an origin the old reader could fetch, so
 * a gate reading clones passes the baseline too. Then one clone is GONE (a cron
 * host with no ~/repos), and the other is CRLF, carries a workflow the remote
 * deleted, and an uncommitted workflow and .devvault.json asking for the token.
 * The verdict must not move. Revert the gate and the missing clone's leak goes
 * unread.
 */
test('#7: a missing, CRLF, stale, dirty clone under REPOS_DIR does not change the verdict', () => {
	const leaky = { '.github/workflows/bump.yml': USES_TOKEN };
	const clean = { '.github/workflows/ci.yml': CLEAN };
	const fx = fleet({
		repos: [HUB, 'WolffM/leaky', 'WolffM/clean'],
		remotes: { [HUB]: clean, 'WolffM/leaky': leaky, 'WolffM/clean': clean },
	});
	const clone = (repo, files, poison) => {
		const dir = poisonedClone(fx.reposDir, repo, files, poison);
		execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', fx.remotes.remote(repo)], {
			env: NO_GIT_ENV,
			stdio: 'ignore',
		});
		return dir;
	};
	try {
		clone(HUB, clean);
		clone('WolffM/leaky', leaky);
		clone('WolffM/clean', clean);
		const baseline = run(fx.env);
		assert.equal(baseline.status, 1, baseline.stdout + baseline.stderr);
		assert.deepEqual(
			baseline.out.findings.map((f) => [f.repo, f.kind]),
			[['WolffM/leaky', 'workflow']],
			'the baseline must have read the leak'
		);

		rmSync(join(fx.reposDir, 'leaky'), { recursive: true, force: true });
		rmSync(join(fx.reposDir, 'clean'), { recursive: true, force: true });
		clone(
			'WolffM/clean',
			{ ...clean, '.github/workflows/deleted-upstream.yml': USES_TOKEN },
			{
				crlf: true,
				edit: {
					'.github/workflows/wip.yml': USES_TOKEN,
					'.devvault.json': JSON.stringify({ X: 'HADOKU_SITE_TOKEN' }),
				},
			}
		);
		const poisoned = run(fx.env);
		assert.equal(poisoned.status, baseline.status, poisoned.stdout);
		assert.deepEqual(poisoned.out.findings, baseline.out.findings);
		assert.deepEqual(poisoned.out.examined, baseline.out.examined);
	} finally {
		fx.cleanup();
	}
});
