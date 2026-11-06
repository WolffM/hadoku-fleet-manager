/**
 * The shared rig for the egress-slices suites: run the REAL gate against a
 * stubbed `pm2` on PATH, plus the fixture apps and taxonomies the cases build
 * on. Split out of `egress-slices-guard.test.mjs` so the on-demand cases
 * (fleet-manager#64) could live in their own file. See that file's header for
 * why the gate is spawned rather than imported.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CHECK = join(ROOT, 'scripts', 'check-egress-slices.mjs');
export const MANIFEST = join(ROOT, 'manifests', 'egress-slices.json');
export const spec = JSON.parse(readFileSync(MANIFEST, 'utf8'));

/**
 * Run the real script with a stubbed `pm2` on PATH.
 *
 * `samples` is what successive `pm2 jlist` calls answer; the last one repeats,
 * so a two-element list means "first sample, then this forever". The stub counts
 * its calls, which is how the tests below prove that a crash loop is rejected
 * WITHOUT paying the settle wait — a cheap bound firing late is a slow gate, and
 * a cheap bound not firing at all is a wrong one, and the call count is the only
 * thing that tells those apart from outside.
 */
export function runGate(samples, opts = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'egress-slices-'));
	try {
		// A STATE DIR PER RUN, ALWAYS — even for the tests that say nothing about
		// deploy markers. Without it every case below would read the DEV BOX's
		// `~/.hadoku-mgmt/deploys-in-flight.json`, so the suite's answer would
		// depend on whether mgmt-api happened to be deploying while it ran. An
		// empty directory is the `absent` case, which is what those tests mean.
		const state = join(dir, 'state');
		mkdirSync(state, { recursive: true });
		if (opts.marker !== undefined) {
			writeFileSync(
				join(state, 'deploys-in-flight.json'),
				typeof opts.marker === 'string' ? opts.marker : JSON.stringify(opts.marker)
			);
		}
		// A FIXTURE TAXONOMY WHEN THE CASE IS ABOUT THE TAXONOMY (issue #68).
		//
		// The cases above are about PM2 STATE and read the repo's real manifest on
		// purpose — `anchor` is a genuine entry in it. The class-exemption cases are
		// about the MANIFEST, and pinning them to operator config would make the
		// suite's answer depend on which apps somebody has classified this week:
		// the `platform`-is-not-exempt case needs an entry the real file may not
		// keep, and the "an ecosystem service named hokon-local is still ecosystem"
		// case needs one the real file must never have. So those write their own,
		// through the same `FLEET_MANIFEST_DIR` production resolves.
		let manifestDir = join(ROOT, 'manifests');
		if (opts.spec) {
			manifestDir = join(dir, 'manifests');
			mkdirSync(manifestDir, { recursive: true });
			writeFileSync(join(manifestDir, 'egress-slices.json'), JSON.stringify(opts.spec));
		}
		samples.forEach((s, i) => writeFileSync(join(dir, `sample-${i}.json`), JSON.stringify(s)));
		const last = samples.length - 1;
		const stub = join(dir, 'pm2');
		writeFileSync(
			stub,
			'#!/usr/bin/env bash\n' +
				`n=$(cat "${dir}/calls" 2>/dev/null || echo 0)\n` +
				`echo $((n + 1)) > "${dir}/calls"\n` +
				`i=$n\n` +
				`if [ "$i" -gt ${last} ]; then i=${last}; fi\n` +
				`cat "${dir}/sample-$i.json"\n`
		);
		chmodSync(stub, 0o755);

		let stdout = '';
		let code = 0;
		try {
			stdout = execFileSync(process.execPath, [CHECK, '--json'], {
				encoding: 'utf8',
				cwd: ROOT,
				stdio: ['ignore', 'pipe', 'pipe'],
				env: {
					...process.env,
					PATH: `${dir}:${process.env.PATH ?? ''}`,
					FLEET_MANIFEST_DIR: manifestDir,
					// The same variable mgmt-api's `deployMarkerPath()` honours.
					HADOKU_STATE_DIR: state,
					// Milliseconds instead of seconds. The bound under test is "does it
					// come back within the window", not the window's width.
					FLEET_EGRESS_SETTLE_MS: '5',
				},
			});
		} catch (err) {
			stdout = typeof err.stdout === 'string' ? err.stdout : '';
			code = typeof err.status === 'number' ? err.status : -1;
			if (!stdout.trim().startsWith('{')) {
				throw new Error(`the gate produced no JSON (exit ${code}): ${err.stderr ?? err.message}`);
			}
		}
		const calls = Number(readFileSync(join(dir, 'calls'), 'utf8').trim());
		return { report: JSON.parse(stdout), code, calls };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * An app with a pid the kernel will never have, so its cgroup cannot be read and
 * the only thing under test is the PM2-status path. `observedCgroup` treats a
 * pid of 0 as unreadable, which is also what PM2 reports for a stopped app.
 */
export function app(name, pm2_env) {
	return {
		name,
		pid: 0,
		pm2_env: {
			status: 'online',
			pm_cwd: `/home/hadoku/srv/hadoku_site/apps/${name}`,
			unstable_restarts: 0,
			restart_time: 6,
			pm_uptime: Date.parse('2026-09-12T13:07:00Z'),
			...pm2_env,
		},
	};
}

/**
 * ONE APP THAT PASSES CLEANLY, in every fixture below.
 *
 * Without it every app in the fixture defers and the run trips the
 * `nothing-observed` bound — which is that bound working, but it would mask the
 * per-app answer each test is actually about. `pm2-logrotate` is a real
 * hokonLocal entry, and giving it this process's pid means its cgroup reads for
 * real, so it is classified rather than deferred wherever the suite runs.
 */
export const anchor = {
	name: 'pm2-logrotate',
	pid: process.pid,
	pm2_env: {
		status: 'online',
		pm_cwd: '/home/hadoku/.pm2/modules/pm2-logrotate',
		unstable_restarts: 0,
		restart_time: 0,
	},
};

/** Findings ABOUT AN APP. Slice-level findings depend on which box runs the suite. */
export const appFindings = (report) => (report.findings ?? []).filter((f) => f.name);

/**
 * A fixture taxonomy: the real direct-egress prefixes and ecosystem root, with a
 * `hokonLocal` register the case under test controls.
 *
 * The prefixes and the root come from the repo manifest because those are the
 * parts every case here wants to be REAL — the exemption's whole safety argument
 * is that `declaredOf` resolves the ecosystem PREFIX before it ever looks at the
 * register, and a made-up root would not test that. Only the register varies.
 */
export function specWith(hokonLocal) {
	return {
		directEgress: spec.directEgress,
		ecosystemRoot: spec.ecosystemRoot,
		hokonLocal: [FIXTURE_ANCHOR_ENTRY, ...hokonLocal],
	};
}

/**
 * ONE ONLINE APP THAT CLASSIFIES CLEANLY under a fixture taxonomy, so the run
 * never trips `nothing-observed` and each case's own claim is what is under
 * test. Its pid is this process's, so its cgroup reads for real wherever the
 * suite runs. The `pm2-logrotate` anchor above cannot serve here: these cases
 * need the register's `platform` entry to be a controlled variable.
 */
export const FIXTURE_ANCHOR_ENTRY = {
	app: 'fixture-anchor',
	class: 'hokon-local',
	why: 'the fixture anchor — an online hokon-local app, so the run observes at least one cgroup.',
};
export const fixtureAnchor = {
	name: 'fixture-anchor',
	pid: process.pid,
	pm2_env: {
		status: 'online',
		pm_cwd: '/home/hadoku/fixture-anchor',
		unstable_restarts: 0,
		restart_time: 0,
	},
};

/** A non-ecosystem app, as `valheim` actually is on hokon: pid 0, its own root. */
export function local(name, pm2_env) {
	return {
		name,
		pid: 0,
		pm2_env: {
			status: 'online',
			pm_cwd: '/mnt/games/valheim-server',
			unstable_restarts: 0,
			restart_time: 0,
			...pm2_env,
		},
	};
}
