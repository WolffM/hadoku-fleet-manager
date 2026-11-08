/**
 * reconcile-fleet-runners.mjs's human-readable plan report — everything the
 * CLI printed under `if (!JSON_OUT)` before the apply step, moved here
 * verbatim as one function (wave 5q lane B, pure move off the 800-line
 * ceiling). It only ever logs; the `--json` summary itself is still built
 * and emitted by the CLI, which is what `scripts/lib/json-contract.mjs`
 * scans for.
 *
 * `ctx.expectedDownNotes` (a `Map<claw, note>`) is passed in pre-built rather
 * than computed here with `deferralFor`/`deferralNote` — the CLI builds it
 * with a literal call to both, which is what keeps
 * `expected-down-guard.test.mjs`'s pinned list of #71/#74's seven gates
 * seeing that call in `reconcile-fleet-runners.mjs` itself.
 */

/**
 * @param {object} ctx
 * @param {object} ctx.summary the same object the CLI hands to `emitter.emit`
 * @param {Array} ctx.overCapacity
 * @param {Array} ctx.capDrift
 * @param {Array} ctx.missing
 * @param {Array} ctx.offline
 * @param {Array} ctx.orphans
 * @param {Array} ctx.excluded
 * @param {Array} ctx.unmanaged
 * @param {Array} ctx.unreadable
 * @param {Array} ctx.departed
 * @param {Array} ctx.ignored
 * @param {{ok: boolean, findings: {repo: string, reason: string}[], error?: string}} ctx.runnerVar
 * @param {Map<string, string>} ctx.expectedDownNotes
 * @param {boolean} ctx.CONFIRM
 * @param {boolean} ctx.REMOVE_ORPHANS
 * @param {boolean} ctx.REMOVE_EXCLUDED
 * @param {(msg: string) => void} ctx.log
 */
export function printReport(ctx) {
	const {
		summary,
		overCapacity,
		capDrift,
		missing,
		offline,
		orphans,
		excluded,
		unmanaged,
		unreadable,
		departed,
		ignored,
		runnerVar,
		expectedDownNotes,
		CONFIRM,
		REMOVE_ORPHANS,
		REMOVE_EXCLUDED,
		log,
	} = ctx;

	log(`Desired: ${summary.desiredRepos} repos × claws = ${summary.desiredPairs} pairs`);
	log(
		`Capacity: ${Object.entries(summary.capacity)
			.map(([m, c]) => `${m} ${c.used}/${c.max}`)
			.join('  ')}\n`
	);

	if (overCapacity.length) {
		log(`OVER CAPACITY (${overCapacity.length}) — refusing to plan:`);
		for (const o of overCapacity) {
			log(
				`  ${o.machine}: ${o.want} placements against maxRegistrations ${o.cap} (${o.cores} cores)`
			);
		}
		log("  Raise the node's maxRegistrations, or add an excludeRepos entry, in the manifest.\n");
	}

	if (capDrift.length) {
		const byCap = new Map();
		for (const c of capDrift) {
			const k = `${c.claw}: +${c.add.join(',')}`;
			byCap.set(k, (byCap.get(k) ?? 0) + 1);
		}
		log(`CAPABILITY DRIFT (${capDrift.length} runner(s)):`);
		for (const [k, n] of byCap) log(`  ${k}  on ${n} runner(s)`);
		log(CONFIRM ? '' : '  (--confirm applies these)\n');
	}

	if (missing.length) {
		log(`MISSING COVERAGE (${missing.length}):`);
		const byRepo = new Map();
		for (const m of missing) byRepo.set(m.repo, [...(byRepo.get(m.repo) ?? []), m.claw]);
		for (const [repo, claws] of byRepo) log(`  ${repo}  →  ${claws.join(', ')}`);
		log('');
	} else {
		log('MISSING COVERAGE: none — every desired pair has a registered runner.\n');
	}

	if (offline.length) {
		const clawsOffline = offline.filter((o) => !o.expectedDown);
		const expectedDownOffline = offline.filter((o) => o.expectedDown);
		if (clawsOffline.length) {
			log(
				`OFFLINE (${clawsOffline.length}) — reported, never auto-reinstalled; this is an incident:`
			);
			for (const o of clawsOffline) log(`  ${o.repo}  ${o.runner}`);
			log('');
		}
		if (expectedDownOffline.length) {
			// A node a human powered off is EXPECTED down. Its registrations are
			// still REPORTED — deferral removes the page, not the evidence — and
			// never count toward the exit code below. See lib/expected-down.mjs.
			const byClaw = new Map();
			for (const o of expectedDownOffline) byClaw.set(o.claw, true);
			log(`OFFLINE, EXPECTED DOWN (${expectedDownOffline.length}):`);
			for (const [claw] of byClaw) log(`  · ${expectedDownNotes.get(claw)}`);
			for (const o of expectedDownOffline) log(`  ${o.repo}  ${o.runner}  (${o.claw})`);
			log('');
		}
	}
	if (orphans.length) {
		log(`ORPHANS (${orphans.length}) — retired repos still holding runners:`);
		for (const o of orphans) log(`  ${o.repo}  ${o.runner}  (${o.why})`);
		log(REMOVE_ORPHANS ? '' : '  (pass --remove-orphans to tear these down)\n');
	}
	if (excluded.length) {
		log(
			`EXCLUDED (${excluded.length}) — the manifest no longer wants this pair, ` +
				`but the runner is still registered and still taking jobs:`
		);
		for (const e of excluded) log(`  ${e.repo}  ${e.runner}  (${e.claw}, ${e.status})`);
		log(REMOVE_EXCLUDED ? '' : '  (pass --remove-excluded to deregister these)\n');
	}
	if (unmanaged.length) {
		log(`UNMANAGED (${unmanaged.length}) — not on a managed claw, left untouched:`);
		for (const u of unmanaged) log(`  ${u.repo}  ${u.runner}  ${u.status}`);
		log('');
	}
	if (unreadable.length) {
		log(`UNREADABLE (${unreadable.length}) — could not list runners:`);
		for (const u of unreadable) log(`  ${u.repo}  ${u.error}`);
		log('');
	}
	if (departed.length) {
		// Loud, and phrased as a question the operator has to answer. A
		// departure is not drift to be applied — `--confirm` cannot fix it,
		// because there is nothing to register. It is the roster deciding on
		// its own that something is no longer the fleet's problem.
		log(
			`LEFT THE ROSTER (${departed.length}) — in fleet-runner-coverage.json, no longer eligible:`
		);
		for (const d of departed) log(`  ${d.repo}  ${d.why}`);
		log('');
		log('  A repo does not stop needing CI by aging out of a heuristic. Decide, do not');
		log('  regenerate on reflex — `--write-coverage` makes this disappear WITHOUT');
		log('  closing it, which is how a missing-coverage page self-resolves overnight.');
		log('    keep it   -> add an entry under `repos` in fleet-runner-manifest.json');
		log('    drop it   -> `skip: true` (should have no runners) or `ignore: true`');
		log('                 (has runners nobody intends to remove), with a $why');
		log('    then      -> fleet reconcile --write-coverage');
		log('');
	}
	// One line, not a section: an ignored repo is a decision already made, so
	// it should be visible without ever reading as something to act on.
	if (ignored.length) {
		log(`Ignored by manifest: ${ignored.map((i) => i.repo).join(', ')}\n`);
	}

	// ci:runner-var's unique catch, merged in (wave gates2 lane F1b): a repo
	// whose shipped workflows read the bare `fromJSON(vars.CI_RUNNER)` form
	// while the variable is unset or unreadable.
	if (runnerVar?.error) {
		log(`CI_RUNNER CHECK: could not look — ${runnerVar.error}\n`);
	} else if (runnerVar?.findings?.length) {
		log(
			`CI_RUNNER CHECK (${runnerVar.findings.length}) — vars.CI_RUNNER unreliable for these repos:`
		);
		for (const f of runnerVar.findings) log(`  ${f.repo}  ${f.reason}`);
		log('');
	} else if (runnerVar) {
		log('CI_RUNNER CHECK: every repo that asks for vars.CI_RUNNER can rely on it.\n');
	}
}
