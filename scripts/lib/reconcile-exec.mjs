/**
 * reconcile-fleet-runners.mjs's `--confirm` apply step — registering what is
 * missing, relabelling capability drift, and removing orphaned/excluded
 * registrations — split off the 800-line ceiling (wave 5q lane B, ctx
 * restructure).
 *
 * `ctx.ssh` is the CLI's own `ssh()` (which calls `runOn`); it is passed in
 * rather than imported, for the same reason `reconcile-coverage.mjs` takes
 * `ctx.readJobReserves` — `ssh()` must stay DEFINED in the top-level CLI file
 * for `expected-down-guard.test.mjs` to keep scanning it (see that file's
 * header, and the 5g-C split that first called this out). This lib never
 * imports anything out of `reconcile-fleet-runners.mjs`.
 */
import {
	offeredLabels,
	ghWrite,
	currentRunnerVersion,
	provisionBeforeStart,
	mintToken,
} from './reconcile-apply.mjs';
import { repoSuffix, registerScript, startScript, removeScript } from './reconcile-scripts.mjs';
import { maySudo, rootAdvisory } from './operator-sudo.mjs';

/**
 * Register every missing (repo, claw) pair, then apply any capability-label
 * drift. Mutates `ctx.results` in place (`registered`, `failed`, `labelled`)
 * — the same object the CLI builds and later reports from.
 */
export async function applyRegistrations(ctx) {
	const { CONFIRM, overCapacity, missing, capDrift, manifest, log, ssh, results } = ctx;

	// A capacity breach REFUSES the apply, it does not merely colour the report.
	// A gate that reports and then proceeds anyway is the "dead guard" shape:
	// it reads as protection while protecting nothing.
	if (CONFIRM && overCapacity.length) {
		log("REFUSING to apply: the plan exceeds a node's maxRegistrations (see above).");
		log('Nothing was registered. Resolve the capacity breach in the manifest first.\n');
	}

	if (CONFIRM && !overCapacity.length && missing.length) {
		const version = currentRunnerVersion();
		log(`Registering ${missing.length} runner(s) at release v${version}...\n`);

		// Serialize per claw — config.sh and the shared tarball cache race on
		// one host — and run the claws concurrently, which is the real win.
		const byClaw = new Map();
		for (const m of missing) byClaw.set(m.claw, [...(byClaw.get(m.claw) ?? []), m]);

		await Promise.all(
			[...byClaw.entries()].map(async ([claw, pairs]) => {
				const unstarted = [];
				for (const { repo } of pairs) {
					const token = mintToken(repo, 'register');
					// A runner's labels are the NODE's declared capabilities, projected
					// onto it. Until now `machines[].labels` was read in exactly one
					// place — the `needs` matcher, which decides PLACEMENT — and never
					// applied to anything. So the manifest could say hokon has
					// `pm2-host` while no hokon runner carried it, and the capability
					// half of the model was only ever half wired.
					//
					// DERIVED from the capability registry rather than assembled here,
					// and NEVER eligible: the fast loop grants `hadoku-builder` once the
					// node is judged safe. See `registrationLabels`.
					const labels = offeredLabels(manifest, claw);
					// config.sh needs a non-empty --labels; `self-hosted` is implicit
					// anyway, so it is the harmless identity value.
					const labelArg = labels.length ? labels.join(',') : 'self-hosted';
					const res = await ssh(
						claw,
						registerScript({ repo, claw, version, token, labels: labelArg })
					);
					// A claw's script ends in exactly one of two ways when it exits 0:
					// UNIT-WRITTEN (enabled, waiting to be provisioned) or SKIP (a
					// system unit already supervises this directory). Anything else is
					// a script that succeeded without saying what it did.
					const wrote = /^UNIT-WRITTEN /m.test(res.stdout);
					const skipped = /^SKIP: /m.test(res.stderr);
					if (res.ok && wrote) {
						unstarted.push(repo);
					} else if (res.ok && skipped) {
						results.registered.push({ repo, claw });
						log(`  ✓ ${claw}  ${repo}`);
					} else if (res.ok) {
						const error = 'registration exited 0 but wrote no unit and gave no SKIP reason';
						results.failed.push({ repo, claw, error });
						log(`  ✗ ${claw}  ${repo}\n      ${error}`);
					} else {
						results.failed.push({ repo, claw, error: res.stderr.trim().slice(0, 400) });
						log(
							`  ✗ ${claw}  ${repo}\n      ${res.stderr.trim().split('\n').slice(-3).join('\n      ')}`
						);
					}
				}
				if (!unstarted.length) return;

				// BORN PROVISIONED (#1). Each unit is registered and enabled but has
				// never run; its slice drop-in and throttle env go on disk now, so its
				// first start is in the slice with the hook loaded and nothing ever
				// needs `--restart`. A unit whose provisioning failed is NOT started:
				// an offline runner fails the next reconcile loudly, an unthrottled
				// one outside the slice ran unnoticed for two nights.
				const prov = await provisionBeforeStart(claw);
				for (const repo of unstarted) {
					const unit = `actions-runner-${repoSuffix(repo)}.service`;
					if (!prov.ok) {
						results.failed.push({ repo, claw, error: `registered, NOT started: ${prov.why}` });
						log(
							`  ✗ ${claw}  ${repo} — registered and enabled, NOT started: ${prov.why}\n` +
								`      fix: fleet slice --machine ${claw} --confirm && ` +
								`fleet throttle --machine ${claw} --confirm --no-restart, ` +
								`then: ssh ${claw} systemctl --user start ${unit}`
						);
						continue;
					}
					const started = await ssh(claw, startScript({ repo, sliceName: prov.sliceName }));
					if (started.ok) {
						results.registered.push({ repo, claw });
						log(`  ✓ ${claw}  ${repo}  (started in ${prov.sliceName}, throttle env loaded)`);
					} else {
						results.failed.push({ repo, claw, error: started.stderr.trim().slice(0, 400) });
						log(
							`  ✗ ${claw}  ${repo} — provisioned, but its first start failed:\n      ` +
								started.stderr.trim().split('\n').slice(-2).join('\n      ')
						);
					}
				}
			})
		);
		log('');
	}

	// Applied even when nothing needs registering: a capability the manifest
	// declares is not optional just because coverage happens to be complete.
	if (CONFIRM && capDrift.length) {
		log(`Applying ${capDrift.length} capability label(s)...\n`);
		for (const c of capDrift) {
			const res = ghWrite('POST', `/repos/${c.repo}/actions/runners/${c.id}/labels`, {
				labels: c.add,
			});
			if (res.ok) {
				results.labelled = (results.labelled ?? 0) + 1;
			} else {
				results.failed.push({ repo: c.repo, claw: c.claw, error: `label: ${res.error}` });
				log(`  ✗ ${c.claw}  ${c.repo}  +${c.add.join(',')}  ${res.error}`);
			}
		}
		log(`  ✓ ${results.labelled ?? 0} runner(s) relabelled\n`);
	}
}

/**
 * Remove one (repo, node) registration and report how it went. One function
 * for the orphan and excluded paths, which carried two copies of this.
 *
 * The BY-ID FALLBACK (#123): when config.sh remove fails on an install that
 * WAS found, the controller deletes the registration through the REST API by
 * its id and then has the node remove the install with deregistration
 * skipped. A renamed repo is the case: the install's .runner names the old
 * URL, the runner API does not follow the rename, and config.sh remove 404s
 * (hadoku-printTool -> hadoku-craft, hokon, 2026-10-19), while
 * DELETE repos/<current>/actions/runners/<id> works. The install is still
 * removed only after the registration is gone — the ordering removeScript's
 * header exists for.
 */
async function removeRegistration({ repo, claw, id }, { manifest, log, ssh, results }) {
	const runnerId = Number.isInteger(id) ? id : null;
	const token = mintToken(repo, 'remove');
	// No sudo on the backstop: a SYSTEM install there stops at NEEDS_ROOT
	// without trying, and is the operator's (lib/operator-sudo.mjs).
	const sudo = maySudo(manifest.machines?.[claw]);
	let res = await ssh(claw, removeScript({ repo, token, sudo, runnerId }));
	let byId = false;
	if (!res.ok && /DEREGISTER_FAILED/.test(res.stderr) && runnerId !== null) {
		const del = ghWrite('DELETE', `/repos/${repo}/actions/runners/${runnerId}`, {});
		if (del.ok) {
			byId = true;
			res = await ssh(claw, removeScript({ repo, token, sudo, runnerId, deregistered: true }));
		} else {
			log(`  ! ${claw}  ${repo} — config.sh remove failed and so did DELETE by id: ${del.error}`);
		}
	}
	const dir =
		/DIR=(\S+?)\)/.exec(res.stderr)?.[1] ?? `~/runners/actions-runner-${repoSuffix(repo)}`;
	if (res.ok) {
		results.removed.push({ repo, claw });
		log(
			`  ✓ ${claw}  ${repo}` +
				(byId
					? ` (deregistered by id ${runnerId}: config.sh remove refused — a renamed repo?)`
					: '')
		);
	} else if (/NOT_OURS/.test(res.stderr)) {
		// No install of this registration on the node, looked for under the
		// current name AND by agentId. Never a root command: there is no
		// directory to run svc.sh in, which is what this hint used to send
		// the operator after.
		log(
			`  ! ${claw}  ${repo} — no install of this registration on ${claw}. NOTHING was changed.\n` +
				(runnerId !== null
					? `      If no other user on ${claw} runs it, the registration is stale:\n` +
						`      gh api -X DELETE repos/${repo}/actions/runners/${runnerId}`
					: `      (no runner id was known, so only the current name was searched)`)
		);
		results.failed.push({ repo, claw, error: 'no install found for this registration' });
	} else if (/NEEDS_ROOT/.test(res.stderr) && !sudo) {
		const a = rootAdvisory(
			claw,
			`removing the system-service runner for ${repo}`,
			`fleet reconcile --confirm --remove-orphans`
		);
		results.advisories.push(a);
		log(`  ! ${claw}  ${repo} — ${a.message}. NOTHING was changed:\n      ${a.fix}`);
	} else if (/NEEDS_ROOT/.test(res.stderr)) {
		// The runner is a SYSTEM install and this node would not give it up
		// unattended. Nothing was changed — say so, because the whole reason
		// this branch exists is that a silent failure here used to end with a
		// deleted directory.
		log(
			`  ! ${claw}  ${repo} — system service, root required. NOTHING was changed:\n` +
				`      ssh ${claw} 'cd ${dir} && sudo ./svc.sh stop && sudo ./svc.sh uninstall'`
		);
		results.failed.push({ repo, claw, error: 'system service; root required' });
	} else if (/DEREGISTER_FAILED/.test(res.stderr)) {
		// Distinct from every other failure because the remedy is distinct: the
		// directory was deliberately LEFT, so re-running is the fix. It used to
		// be deleted here, which is what made claw-1's 21 failures on
		// 2026-09-01 unrecoverable without the REST API.
		log(
			`  ! ${claw}  ${repo} — still registered; the local install was left intact. Re-run to retry.`
		);
		results.failed.push({ repo, claw, error: 'deregister failed; install left intact' });
	} else {
		results.failed.push({ repo, claw, error: res.stderr.trim().slice(0, 400) });
		// The reason, not just the mark. A bare ✗ is how 21 identical failures
		// on claw-1 read as 21 unrelated ones.
		log(`  ✗ ${claw}  ${repo}\n      ${res.stderr.trim().split('\n').slice(-2).join('\n      ')}`);
	}
}

/**
 * Remove orphaned (retired-repo) and excluded (manifest no longer wants it
 * here) registrations, under `--remove-orphans`/`--remove-excluded`. Mutates
 * `ctx.results` in place, same as {@link applyRegistrations}.
 */
export async function applyRemovals(ctx) {
	const {
		CONFIRM,
		REMOVE_ORPHANS,
		REMOVE_EXCLUDED,
		orphans,
		excluded,
		manifest,
		log,
		ssh,
		results,
	} = ctx;
	const dep = { manifest, log, ssh, results };

	if (CONFIRM && REMOVE_ORPHANS && orphans.length) {
		log(`Removing ${orphans.length} orphaned runner(s)...\n`);
		const byClaw = new Map();
		for (const o of orphans) byClaw.set(o.claw, [...(byClaw.get(o.claw) ?? []), o]);

		await Promise.all(
			[...byClaw.entries()].map(async ([claw, items]) => {
				for (const { repo, id } of items) await removeRegistration({ repo, claw, id }, dep);
			})
		);
		log('');
	}

	// Excluded pairs are removed one (repo, node) at a time, and NEVER while
	// the runner is busy. An orphan belongs to a repo that has retired, so losing
	// its in-flight job costs nothing; an excluded pair belongs to a repo that is
	// very much alive and simply should not run HERE, so tearing down mid-job
	// would fail a real build to save an idle listener. The API's `busy` flag
	// lags reality, which is why this only ever SKIPS on it — a stale `false`
	// still leaves removeScript's own checks in front of the uninstall, while a
	// stale `true` costs one deferred removal.
	if (CONFIRM && REMOVE_EXCLUDED && excluded.length) {
		const removable = excluded.filter((e) => !e.busy);
		const busyCount = excluded.length - removable.length;
		log(`Deregistering ${removable.length} excluded pair(s)...\n`);
		if (busyCount) log(`  (${busyCount} busy, deferred to the next run)`);
		for (const { repo, claw, id } of removable) await removeRegistration({ repo, claw, id }, dep);
		log('');
	}
}
