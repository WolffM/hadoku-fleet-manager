/**
 * reconcile-runner-identity.mjs's human-readable report — everything the CLI
 * printed under `if (!JSON_OUT)`, moved here verbatim as one function (wave
 * 5q lane B, pure move off the 800-line ceiling). It only ever logs; the
 * `--json` GateDoc itself is still built and emitted by the CLI, which is
 * what `scripts/lib/json-contract.mjs` scans for.
 */
import { READ_ATTEMPTS } from './queue-health.mjs';

/**
 * @param {object} ctx
 * @param {(msg: string) => void} ctx.log
 */
export function printIdentityReport(ctx) {
	const {
		ghosts,
		jitOrphans,
		unreaped,
		young,
		warmOrphans,
		warmRechecked,
		noInstall,
		expectedDown,
		drainUnreadable,
		clobbered,
		unconfigured,
		unreachable,
		unreadableRepos,
		unexpectedlyDark,
		expectedDark,
		FLEET_WIDE,
		ONLY,
		CONFIRM,
		UNREAPED_AFTER_MS,
		GRACE_MS,
		log,
	} = ctx;

	if (ghosts.length) {
		log(`BLACK HOLES (${ghosts.length}) — GitHub says online, NO listener anywhere:`);
		for (const g of ghosts)
			log(`  ${g.repo}  ${g.name}${g.busy ? '  BUSY — a job is stuck on it' : ''}`);
		log('  These are never auto-deleted: a persistent registration is a node identity,');
		log("  and GitHub's status field lags. Investigate before removing.\n");
	}
	if (jitOrphans.length) {
		log(`JIT ORPHANS (${jitOrphans.length}) — ephemeral registration, no live unit:`);
		for (const o of jitOrphans)
			log(
				`  ${o.repo}  ${o.name}  status=${o.status}  age=${o.ageMs === Infinity ? 'unknown (no epoch in name)' : Math.round(o.ageMs / 1000) + 's'}`
			);
		log(CONFIRM ? '' : '  (pass --confirm to reap these)\n');
	}
	if (unreaped.length) {
		log(
			`UNREAPED BLACK HOLES (${unreaped.length}) — ONLINE JIT orphans older than ` +
				`${Math.round(UNREAPED_AFTER_MS / 60_000)}m, past the dispatcher's reap grace plus two sweeps:`
		);
		for (const u of unreaped)
			log(
				`  ${u.repo}  ${u.name}  age=${u.ageMs === Infinity ? 'unknown (no epoch in name)' : Math.round(u.ageMs / 1000) + 's'}`
			);
		log('  This FAILS. GitHub schedules onto an online registration and nothing answers;');
		log("  the dispatcher's sweep should have deleted these and has not. Check that it is");
		log('  running (mgmt-api up, token budget not spent) — --confirm reaps them here.\n');
	}
	if (young.length) {
		// Named so a skipped reap is never silent — an orphan that is always
		// "too young" is a dispatcher that is minting and failing to spawn.
		log(`TOO YOUNG TO JUDGE (${young.length}) — inside the ${GRACE_MS / 1000}s mint grace:`);
		for (const y of young) log(`  ${y.repo}  ${y.name}  age=${Math.round(y.ageMs / 1000)}s`);
		log('');
	}
	if (warmOrphans.length) {
		log(`WARM ORPHANS (${warmOrphans.length}) — warm registration, no live unit on its node:`);
		for (const w of warmOrphans) log(`  ${w.repo}  ${w.name}  status=${w.status} — ${w.why}`);
		log("  This FAILS. The warm reap only reaches a name its node's marker still holds, so");
		log('  nothing is guaranteed to clear these (#61). Delete the registration by id.\n');
	}
	if (warmRechecked.length) {
		log(`WARM, RESOLVED ON A SECOND LOOK (${warmRechecked.length}) — the cache rotated mid-sweep:`);
		for (const w of warmRechecked) log(`  ${w.repo}  ${w.name} — ${w.outcome}`);
		log('');
	}
	if (noInstall.length) {
		log(`REGISTERED, NO INSTALL (${noInstall.length}) — no node is configured for this repo:`);
		for (const d of noInstall)
			log(
				`  ${d.repo}  runner "${d.name}" status=${d.status}` +
					(d.carriers.length ? `  (that name lives on: ${d.carriers.join(', ')})` : '')
			);
		log('');
	}
	if (expectedDown.length) {
		// LISTED, never dropped. A deferral the report does not print is
		// indistinguishable from a clean fleet, which is the failure this whole
		// mechanism is one step away from.
		const byNode = new Map();
		for (const e of expectedDown) {
			if (!byNode.has(e.node)) byNode.set(e.node, []);
			byNode.get(e.node).push(e);
		}
		log(
			`EXPECTED DOWN (${expectedDown.length}) — registered, no install, DEFERRED because the node is drained:`
		);
		for (const [node, rows] of byNode) {
			log(`  ${rows[0].why}`);
			log(`    ${rows.length} offline registration(s) still held by ${node}:`);
			for (const r of rows) log(`      ${r.repo}`);
		}
		log('  Lift the drain, or let it expire, and every line above fails this gate again.\n');
	}
	if (drainUnreadable) {
		log(`! DRAIN RECORD UNREADABLE — ${drainUnreadable}`);
		log('  NOTHING was deferred on this run. A gate that cannot read the drain record');
		log('  cannot tell a deliberate power-off from a dead node, so any registration');
		log('  finding above may be either. Fix the file and re-run before acting on them.\n');
	}
	if (clobbered.length) {
		log(`STOLEN IDENTITIES (${clobbered.length}) — a JIT probe overwrote a persistent install:`);
		for (const c of clobbered) log(`  ${c.machine}  ${c.dir}  now claims "${c.name}" (${c.repo})`);
		log('  Repair: ./config.sh remove --local, then re-register with --replace.\n');
	}
	if (unconfigured.length) {
		log(`UNCONFIGURED LISTENERS (${unconfigured.length}) — running with no readable .runner:`);
		for (const u of unconfigured) log(`  ${u.machine}  ${u.dir}`);
		log('');
	}
	if (!FLEET_WIDE) {
		log(
			ONLY
				? `Scoped to ${ONLY}: registration-side checks (black holes, registered-no-install) SKIPPED —\n  they need every node's installs to be meaningful.\n`
				: `${unreachable.length} node(s) unreachable: registration-side checks SKIPPED —\n  a partial fleet view turns every unseen install into a false finding.\n`
		);
	}
	if (unexpectedlyDark.length) {
		log(
			`COULD NOT LOOK — ${unexpectedlyDark.length} node(s) unreachable, after ${READ_ATTEMPTS} attempts:`
		);
		for (const u of unexpectedlyDark) log(`  ${u.machine}: ${u.error}  [${u.why}]`);
		log("  This FAILS. A node that did not answer has installs nobody saw, and this gate's");
		log('  registration half is skipped while one is dark — so a pass here would be a');
		log("  statement about the boxes that answered, wearing the fleet's name.\n");
	}
	if (expectedDark.length) {
		log(
			`EXPECTED DOWN (${expectedDark.length}) — unreachable, DEFERRED because the node is drained:`
		);
		for (const u of expectedDark) log(`  ${u.why}\n    probe said: ${u.error}`);
		log('  Lift the drain, or let it expire, and every line above fails this gate again.\n');
	}
	if (unreadableRepos.length) {
		log(
			`COULD NOT LOOK — ${unreadableRepos.length} repo(s) whose runner listing failed every one of ${READ_ATTEMPTS} attempts:`
		);
		for (const r of unreadableRepos) log(`  ${r.repo} — ${r.reason}`);
		log('  This FAILS. An unread listing and a repo with no registrations are the same');
		log('  bytes to everything downstream, and telling those apart is what this gate is.\n');
	}
	if (
		!ghosts.length &&
		!jitOrphans.length &&
		!unreaped.length &&
		!warmOrphans.length &&
		!noInstall.length &&
		!unconfigured.length &&
		!clobbered.length &&
		!drainUnreadable &&
		!unreachable.length &&
		!unreadableRepos.length
	)
		// THE ✓ IS A CLAIM ABOUT THE FLEET, so it may only be made when the fleet
		// was seen. Under `--machine` the registration half never ran, and the old
		// line said "every registration has a live listener" anyway — a sentence
		// about 27 repos printed by a run that read none of them.
		log(
			(FLEET_WIDE
				? '✓ every registration has a live listener, and every listener knows who it is.'
				: `✓ nothing wrong with the listeners on ${ONLY} — but the registration half was SKIPPED, so this says nothing about the fleet.`) +
				(expectedDown.length ? ` (${expectedDown.length} deferred — listed above)` : '')
		);
}
