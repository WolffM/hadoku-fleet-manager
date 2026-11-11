/**
 * The human-readable report of `fleet egress-slices` (scripts/check-egress-slices.mjs).
 *
 * Moved out of the gate unchanged (fleet-manager#85) so the gate fits its
 * file-size ceiling; the gate still decides everything, this only prints what
 * it decided. `--json` never reaches here.
 */

/**
 * Print the run. `r` is what the gate gathered: `examined`, `population`
 * (cgroup -> process count or null), `findings`, `deferred`, `leaks`,
 * `dormant`, `deploying`, `pending` (tunnel-only apps not moved yet) and the
 * deploy `markers` reader.
 */
export function printEgressReport(log, r) {
	const { examined, population, findings, deferred, leaks, dormant, deploying, pending, markers } =
		r;
	log(`Examined ${examined} PM2 app(s) against manifests/egress-slices.json.\n`);
	for (const [prefix, count] of population)
		log(`  ${(count === null ? 'n/a' : String(count)).padStart(3)} proc(s) in ${prefix}`);
	log('');
	for (const f of findings)
		// `nothing-observed` is about the RUN and names neither an app nor a
		// cgroup, so this line printed the word `undefined` where its subject
		// belongs — on the one finding that means the whole scan is worthless.
		log(
			`  ${f.status.toUpperCase().padEnd(24)} ${f.name ?? f.cgroup ?? '(this run)'}\n    ${f.why}`
		);
	if (deferred.length) {
		log(
			`\n  ${deferred.length} app(s) DEFERRED — not cross-checked on this run, which is NOT a pass:`
		);
		// SAY WHY, per app. A deferral is the one thing here that is reported and
		// not failed, so the reason it was tolerated has to be legible or the
		// operator cannot tell a deploy from a gate that stopped looking.
		for (const d of deferred)
			log(`    [${d.deferral ?? 'unspecified'}] ${d.name} (${d.class}) — ${d.why}`);
	}
	if (leaks.length) {
		log(`\n  ${leaks.length} accepted leak(s) — hokon-local apps receiving fleet egress:`);
		for (const l of leaks) log(`    ${l.name} (${l.class}) — ${l.why}`);
	}
	if (pending.length) {
		log(`\n  ${pending.length} named tunnel-only but not moved there yet (not a finding):`);
		for (const p of pending) log(`    ${p.name} -> ${p.tunnelOnly} — runs in ${p.observed ?? '?'}`);
	}
	// PRINTED ON EVERY RUN THAT HAS ONE, and next to the leaks rather than with
	// the deferrals, because this IS the other half of the accepted-leak
	// register: the line above says what is leaking now, this one says what is
	// still on the register and currently not. Silence here is the register
	// quietly shrinking.
	if (dormant.length) {
		log(`\n  ${dormant.length} dormant — not running, and not this gate's subject while down:`);
		for (const d of dormant)
			log(
				`    ${d.name} (${d.onDemand ? 'on-demand ' : ''}${d.class}) — PM2 reports ` +
					`"${d.pm2Status}". ${d.registeredWhy ?? ''}`
			);
	}
	// Only once something asked. A box with nothing moving never opens the file,
	// and printing "unread" on every clean run would be noise that trains the
	// operator to skip the line that matters during a deploy.
	if (markers.consulted()) {
		const m = markers.report();
		log(
			`\n  deploy markers: ${m.path} — ${m.status}` +
				`${m.reason ? ` (${m.reason})` : ''}` +
				`${m.status === 'ok' ? `, ${m.entries} entr(ies), honoured for up to ${Math.round(m.staleAfterMs / 60_000)} min` : ''}`
		);
	}
	// THE GREEN LINE MUST NOT COVER A PARTIAL SCAN. "No findings" and "every app
	// was checked" were the same sentence until issue #31 gave the gate a second
	// way to skip an app — and a deferral that reads as green is a deferral that
	// has quietly become a pass.
	if (!findings.length)
		log(
			deferred.length
				? `\nNo findings — but ${deferred.length} of ${examined} app(s) were DEFERRED` +
						`${deploying.length ? ` (${deploying.length} mid-deploy)` : ''}` +
						`${dormant.length ? ` and ${dormant.length} dormant` : ''} and not ` +
						'cross-checked. That is a partial scan, not a clean box; the next tick re-reads them.'
				: dormant.length
					? // A DORMANT APP IS NOT A PARTIAL SCAN, and must not borrow that
						// sentence: nothing is pending and the next tick re-reads nothing.
						// Every app WAS classified — the claim the green line makes — and
						// what is missing is an egress observation for apps that have no
						// egress. Said plainly rather than either hidden or dressed up as
						// a deferral.
						`\nEvery PM2 app is classified, and every direct-egress cgroup is populated. ` +
						`${dormant.length} app(s) are dormant: hokon-local or on-demand, not ` +
						'running, and cross-checked again whenever the operator starts them.'
					: '\nEvery PM2 app is classified, and every direct-egress cgroup is populated.'
		);
}
