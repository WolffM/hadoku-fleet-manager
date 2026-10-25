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
 * THE TWO FACETS, AND WHY ONLY THESE:
 *   throttle — a standing runner's `.env` is wrong (`newly > stale`) or right
 *     but not loaded (`stale`), or the node's own scripts lag this package
 *     (see scriptLag). `throttle --confirm` rewrites them and restarts only
 *     IDLE runners. A busy one keeps its job and stays stale.
 *   slice — a standing unit runs outside its slice or above or below its cap
 *     (SLICE-PLACEMENT-DRIFT / UNIT-CAP-DRIFT). `slice --confirm --restart`
 *     writes the drop-in, sets the cap live, and restarts only idle units. A
 *     busy one is reported BUSY and moved on a later pass.
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

const SLICE_DRIFT = ['SLICE-PLACEMENT-DRIFT', 'UNIT-CAP-DRIFT'];

/** The standing units a slice result names as misplaced or miscapped. */
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
export function planRepairs(throttleDoc, sliceDoc) {
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
		if (n(kv.newly) > 0 || lag.length) {
			const wrong = n(kv.newly) - n(kv.stale);
			repair.push({
				node: r.machine,
				facet: 'throttle',
				before: [
					n(kv.newly) > 0
						? `${wrong} runner(s) with the wrong env, ${n(kv.stale)} written but not loaded`
						: '',
					lag.length ? `node-side files behind this package: ${lag.join(', ')}` : '',
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
		if (n(r.newly) === 0) return { outcome: 'converged', changed, why: '', busy };
		const stale = subjects(recheck.notes, 'STALE');
		if (wrong === 0 && stale.length && stale.every((d) => busy.includes(d))) {
			return { outcome: 'deferred', changed, why: `busy: ${stale.join(', ')}`, busy: stale };
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
			`after slice --confirm --restart, still outside the slice or off its cap: ${left.join(', ')}` +
			(failed.length ? ` (${failed.join('; ')})` : ''),
		busy,
	};
}
