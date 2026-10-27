/**
 * Which standing-runner provisioning drift the converger may repair, and what
 * the repair achieved — judged from the drivers' own `--json` (fleet-manager#1).
 *
 * Until 2026-10-24 the only thing that ever noticed this drift was
 * hadoku_site's nightly check:throttle / check:slice, and hadoku_site does not
 * run fleet fixes, so every finding waited for a human. claw-4/claw-6 sat
 * unthrottled and outside runners.slice for two nights. The converger runs the
 * operator's own repair for the two facets that are safe to repair unattended
 * and then READS THE NODE AGAIN: a repair is judged by the check that follows
 * it, never by the repair's own report. The idempotency check reads observed
 * state too (AGENTS.md), and the drivers' --check already does.
 *
 * THE THREE FACETS, AND WHY ONLY THESE:
 *   throttle — a standing runner's `.env` is wrong (`newly > stale`) or right
 *     but not loaded (`stale`), or the node's own scripts lag this package
 *     (see scriptLag). `throttle --confirm` rewrites them and restarts only
 *     IDLE runners. A busy one keeps its job and stays stale.
 *     ALSO, since 2026-10-24: a LIVE JOB writes its temp to RAM
 *     (`jobtmpbad`, read from each Runner.Worker's own environ and the
 *     filesystem under it — see ci-throttle-install.sh), or `runner.env`, the
 *     file every JIT slot and warm listener is built from, is missing a key.
 *     The same `--confirm` rewrites runner.env and every standing .env. A job
 *     already running keeps the env it started with, so the re-check defers
 *     exactly the jobs that were already bad before the repair, and a NEW bad
 *     one after it is unconverged.
 *   slice — a standing unit runs outside its slice, above or below its cap, or
 *     below the CI OOM rank (SLICE-PLACEMENT-DRIFT / UNIT-CAP-DRIFT /
 *     OOM-RANK-DRIFT). `slice --confirm --restart` writes the drop-in, sets the
 *     cap and raises the rank live, and restarts only idle units. A busy one is
 *     reported BUSY and moved on a later pass; its rank needs no restart.
 *   apt-security — a claw whose unattended-upgrades would not install a
 *     pending Debian security update (2026-10-25: every claw's origin pattern
 *     matched nothing). `apt-security --confirm` writes two apt conf files and
 *     enables two timers. It restarts nothing, so it never waits for idle and
 *     is never deferred: the re-check, which RUNS the dry run, decides.
 * MINT-* drift is the minter's: a live JIT unit is never restarted from here.
 * Every other finding either check makes (io-delegation, unreachable nodes)
 * stays the nightly gates' to report.
 *
 * Pure: the I/O lives in `converge-provisioning.mjs`.
 */

const n = (v) => Number(v ?? 0) || 0;

/** `KEY=value` from a throttle SUMMARY string. */
function throttleKv(summary) {
	return Object.fromEntries(
		String(summary ?? '')
			.split(/\s+/)
			.filter((t) => t.includes('='))
			.map((t) => [t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)])
	);
}

/** The second word of every note with this prefix: a unit name or a runner dir. */
function subjects(notes, prefix) {
	return (notes ?? [])
		.filter((l) => l.startsWith(`${prefix} `))
		.map((l) => l.split(/\s+/)[1])
		.filter(Boolean);
}

/** `<dir> pid=<n>` of every JOBTMP-BAD note: one live job, never confused with the next job in that slot. */
function badJobs(notes) {
	return (notes ?? [])
		.filter((l) => l.startsWith('JOBTMP-BAD '))
		.map((l) => l.split(/\s+/).slice(1, 3).join(' '));
}

/**
 * Why a throttle SUMMARY needs the repair, beyond `newly`: live jobs whose temp
 * is on RAM, and a runner.env present but missing a key (every node, any role
 * — `runnerEnvDrift`'s rule). Empty when neither holds.
 */
function jobTmpWhy(kv) {
	const why = [];
	if (n(kv.jobtmpbad) > 0) why.push(`${n(kv.jobtmpbad)} live job(s) write temp to RAM`);
	if (kv.runnerenv === '1' && kv.runnerenvkeys === '0') why.push('runner.env is missing a key');
	return why;
}

const SLICE_DRIFT = ['SLICE-PLACEMENT-DRIFT', 'UNIT-CAP-DRIFT', 'OOM-RANK-DRIFT'];

/** The standing units a slice result names as misplaced, miscapped or under-ranked. */
export function sliceDriftUnits(result) {
	return [...new Set(SLICE_DRIFT.flatMap((p) => subjects(result?.notes, p)))].sort();
}

/**
 * The node-side files on this node that do not match the package running the
 * check: `scriptDrift` from the throttle driver, plus `standing.env` when it
 * is absent or stale. `throttle --confirm` redeploys all of them, atomically
 * (ci-throttle-install.sh's put_b64), so a running hook is never truncated.
 * This is how a fixed jit-provision.sh reaches the nodes without anyone running
 * the deploy by hand. The package the controller runs is the reference, as it
 * is for the nightly check; a node hand-deployed AHEAD of it is put back.
 */
function scriptLag(result) {
	const files = [...(result?.scriptDrift ?? [])];
	if (result?.standingEnv === 'absent' || result?.standingEnv === 'stale')
		files.push('standing.env');
	return files;
}

/** What an apt-security result says is wrong, from its DRIFT notes. */
export function aptDrift(result) {
	return (result?.notes ?? []).filter((l) => l.startsWith('DRIFT ')).map((l) => l.slice(6));
}

/** A per-machine result that answered: reached, and carrying a SUMMARY. */
function answered(result) {
	return Boolean(result?.ok && result.summary && !result.expectedDown);
}

/**
 * From one fleet-wide `--check` of each driver: the nodes to repair, and the
 * nodes the check could not read (reported, never repaired, never "clean").
 *
 * @returns {{ repair: { node: string, facet: 'throttle' | 'slice', before: string }[],
 *             unreadable: { node: string, facet: string, why: string }[] }}
 */
export function planRepairs(throttleDoc, sliceDoc, aptDoc = null) {
	const repair = [];
	const unreadable = [];
	for (const r of throttleDoc?.results ?? []) {
		if (r.expectedDown) continue;
		if (!answered(r)) {
			unreadable.push({ node: r.machine, facet: 'throttle', why: r.error ?? 'no SUMMARY' });
			continue;
		}
		const kv = throttleKv(r.summary);
		const lag = scriptLag(r);
		const extra = jobTmpWhy(kv);
		if (n(kv.newly) > 0 || lag.length || extra.length) {
			const wrong = n(kv.newly) - n(kv.stale);
			repair.push({
				node: r.machine,
				facet: 'throttle',
				before: [
					n(kv.newly) > 0
						? `${wrong} runner(s) with the wrong env, ${n(kv.stale)} written but not loaded`
						: '',
					lag.length ? `node-side files behind this package: ${lag.join(', ')}` : '',
					...extra,
				]
					.filter(Boolean)
					.join('; '),
			});
		}
	}
	for (const r of sliceDoc?.results ?? []) {
		if (r.expectedDown || r.advisory) continue;
		if (!answered(r)) {
			unreadable.push({ node: r.machine, facet: 'slice', why: r.error ?? 'no SUMMARY' });
			continue;
		}
		const units = sliceDriftUnits(r);
		if (units.length) repair.push({ node: r.machine, facet: 'slice', before: units.join(', ') });
	}
	for (const r of aptDoc?.results ?? []) {
		if (r.expectedDown) continue;
		if (!answered(r)) {
			unreadable.push({ node: r.machine, facet: 'apt-security', why: r.error ?? 'no SUMMARY' });
			continue;
		}
		const drift = aptDrift(r);
		if (drift.length)
			repair.push({ node: r.machine, facet: 'apt-security', before: drift.join('; ') });
	}
	return { repair, unreadable };
}

/**
 * One repaired (node, facet): what its confirm run(s) changed, and what the
 * re-check found afterwards. `confirms` is every confirm of this facet on this
 * node in order; changes are summed across them, and BUSY is read from the
 * last, which is the one that decided what was left alone.
 *
 *   converged   — the re-check is clean for this facet.
 *   deferred    — what is left is exactly what the last confirm left alone
 *                 because a job was running on it. Not a failure: the next
 *                 pass gets it.
 *   unconverged — anything else. The repair ran and the node still disagrees,
 *                 so a human is needed. This is the only outcome that pages.
 *
 * @returns {{ outcome: 'converged' | 'deferred' | 'unconverged', changed: string, why: string,
 *             busy: string[] }}
 */
export function classifyRepair(facet, confirms, recheck) {
	const runs = [confirms].flat();
	const broken = runs.find((c) => !answered(c));
	if (!runs.length || broken) {
		return {
			outcome: 'unconverged',
			changed: '',
			why: `the repair could not run: ${broken?.error ?? 'no SUMMARY'}`,
			busy: [],
		};
	}
	if (!answered(recheck)) {
		return {
			outcome: 'unconverged',
			changed: '',
			why: `the repair ran but the node could not be re-read: ${recheck?.error ?? 'no SUMMARY'}`,
			busy: [],
		};
	}
	const last = runs[runs.length - 1];
	const busy = subjects(last.notes, 'BUSY');
	const sum = (key, kv) => runs.reduce((t, c) => t + n(kv(c)[key]), 0);
	if (facet === 'throttle') {
		const kv = (c) => throttleKv(c.summary);
		const r = throttleKv(recheck.summary);
		const changed = `env written on ${sum('newly', kv) - sum('stale', kv)} runner(s), ${sum('restarted', kv)} restarted`;
		const wrong = n(r.newly) - n(r.stale);
		const lag = scriptLag(recheck);
		if (lag.length) {
			return {
				outcome: 'unconverged',
				changed,
				why: `after throttle --confirm, node-side files still differ from this package: ${lag.join(', ')}`,
				busy,
			};
		}
		// Live jobs on RAM after the repair: deferred only if every one was
		// ALREADY running, and already bad, when the last confirm ran — those
		// keep the env they started with. One that started after it means the
		// rewrite did not reach what new jobs are built from.
		const before = new Set(badJobs(last.notes));
		const jobsLeft = badJobs(recheck.notes);
		const newBad = jobsLeft.filter((j) => !before.has(j));
		const keysWrong = r.runnerenv === '1' && r.runnerenvkeys === '0';
		if (keysWrong || newBad.length) {
			return {
				outcome: 'unconverged',
				changed,
				why:
					`after throttle --confirm, ` +
					[
						keysWrong ? 'runner.env is still missing a key' : '',
						newBad.length
							? `${newBad.length} job(s) started since still write temp to RAM: ${newBad.join(', ')}`
							: '',
					]
						.filter(Boolean)
						.join('; '),
				busy,
			};
		}
		const jobsBusy = jobsLeft.map((j) => `${j} (temp on RAM, started before the repair)`);
		if (n(r.newly) === 0 && !jobsLeft.length)
			return { outcome: 'converged', changed, why: '', busy };
		if (n(r.newly) === 0) {
			return { outcome: 'deferred', changed, why: `busy: ${jobsBusy.join(', ')}`, busy: jobsLeft };
		}
		const stale = subjects(recheck.notes, 'STALE');
		if (wrong === 0 && stale.length && stale.every((d) => busy.includes(d))) {
			return {
				outcome: 'deferred',
				changed,
				why: `busy: ${[...stale, ...jobsBusy].join(', ')}`,
				busy: [...stale, ...jobsLeft],
			};
		}
		const failed = runs.flatMap((c) => subjects(c.notes, 'RESTART-FAILED'));
		return {
			outcome: 'unconverged',
			changed,
			why:
				`after throttle --confirm, ${wrong} runner(s) still have the wrong env and ` +
				`${n(r.stale)} are written but not loaded` +
				(failed.length ? `; restart failed: ${failed.join(', ')}` : ''),
			busy,
		};
	}
	if (facet === 'apt-security') {
		const changed = runs.some((c) => /\bchanged=1\b/.test(c.summary))
			? 'apt conf rewritten from the profile, timers enabled'
			: '';
		const left = aptDrift(recheck);
		if (!left.length) return { outcome: 'converged', changed, why: '', busy: [] };
		return {
			outcome: 'unconverged',
			changed,
			why: `after apt-security --confirm, the dry run still says: ${left.join('; ')}`,
			busy: [],
		};
	}
	const kv = (c) => c.summary;
	const changed = `${sum('changed', kv)} slice change(s) written, ${sum('restarted', kv)} restarted`;
	const left = sliceDriftUnits(recheck);
	if (!left.length) return { outcome: 'converged', changed, why: '', busy };
	if (left.every((u) => busy.includes(u))) {
		return { outcome: 'deferred', changed, why: `busy: ${left.join(', ')}`, busy: left };
	}
	const failed = runs.flatMap((c) =>
		(c.notes ?? []).filter((l) => /^(PLACE-FAILED|NEEDS-OPERATOR) /.test(l))
	);
	return {
		outcome: 'unconverged',
		changed,
		why:
			`after slice --confirm --restart, still outside the slice, off its cap or below the OOM rank: ${left.join(', ')}` +
			(failed.length ? ` (${failed.join('; ')})` : ''),
		busy,
	};
}
