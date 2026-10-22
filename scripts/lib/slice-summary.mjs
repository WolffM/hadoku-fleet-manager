// scripts/lib/slice-summary.mjs — #98: the per-node SUMMARY rules
// `fleet slice --check` applies to the slice CEILINGS, the `changed` count and
// the minted units' kernel caps, pulled out of deploy-runners-slice.mjs so they
// can be unit-tested without executing the driver (which reaches real nodes
// over ssh and has no hermetic path) — the same reason runner-env-drift.mjs
// exists for the throttle.
//
// EVERY RULE REQUIRES THE GOOD VALUE. The mutation pass found three that passed
// on a missing token: `Number(undefined) > 0` is false, so a SUMMARY with no
// `changed` read as nothing to change; `user_max=-` beside `user_load=loaded`
// skipped the ceiling check outright; and a SUMMARY with no `user_load` at all
// skipped both. "I could not look" must never render as "nothing is wrong".

/**
 * One slice ceiling's verdict, or null when it holds.
 *
 * `live` is the KERNEL's value (the node half's slicemax(): bytes, `max`,
 * `inactive` or `unreadable`); `cfg` is what systemd's loaded config says. The
 * config is consulted for exactly one case: `inactive`, a slice holding nothing
 * and therefore owning no cgroup, where there is no kernel value to read and
 * nothing running for one to bound. What systemd applies when the slice next
 * activates is then the only fact there is, so it must be the right one.
 */
function ceilingProblem(label, live, cfg, want) {
	const w = String(want);
	if (live === undefined)
		return `could not read the ${label} — the SUMMARY carried no token for it, so it was never checked`;
	if (live === w) return null;
	if (live === 'inactive') {
		if (cfg === w) return null;
		return (
			`${label} has no cgroup (the slice holds nothing) and its config would apply ` +
			`${cfg ?? '(no token)'} when it next activates, want ${w}`
		);
	}
	if (live === 'unreadable' || live === '-' || live === '')
		return `could not read the ${label} from the kernel (memory file unreadable) — not a pass`;
	return `${label} is ${live}, want ${w}${cfg !== undefined && cfg !== live ? ` (config says ${cfg})` : ''}`;
}

/**
 * @param {{
 *   kv: Record<string, string>,
 *   notes: string[],
 *   sliceName: string,
 *   wantMax: number,
 *   wantSwap: number,
 * }} args `kv` is the node's parsed SUMMARY; `notes` its prefixed lines.
 * @returns {string[]} zero or more problems for this node.
 */
export function sliceSummaryProblems({ kv, notes, sliceName, wantMax, wantSwap }) {
	const problems = [];
	if (!/^\d+$/.test(kv.changed ?? ''))
		problems.push(
			`could not read how many units are off the declared slice/cap (changed=${kv.changed ?? '(no token)'})`
		);
	else if (Number(kv.changed) > 0)
		problems.push(`${kv.changed} unit(s) not on the declared slice/cap`);

	for (const p of [
		ceilingProblem('slice MemoryMax', kv.live_max, kv.cfg_max, wantMax),
		ceilingProblem('slice MemorySwapMax', kv.live_swap, kv.cfg_swap, wantSwap),
	])
		if (p) problems.push(p);

	// THE CEILING THAT ACTUALLY BOUNDS A MINTED RUNNER. Every `jit-*`/`warm-*`
	// unit is `systemd-run --user`, so the USER manager's copy is the one that
	// governs an all-JIT claw. LoadState, not ActiveState: a slice holding
	// nothing is INACTIVE and still loaded — see the installer.
	if (kv.user_load !== 'loaded') {
		problems.push(
			kv.user_load === undefined
				? `could not read whether the USER manager has ${sliceName} — no user_load token, so ` +
						'nothing about the ceiling every minted runner sits under was checked'
				: `the USER manager has no ${sliceName} (LoadState=${kv.user_load}) — every minted runner ` +
						'is a --user unit, so nothing would bound their sum there'
		);
	} else {
		for (const p of [
			ceilingProblem(`user-manager ${sliceName} MemoryMax`, kv.user_max, kv.user_cfg_max, wantMax),
			ceilingProblem(
				`user-manager ${sliceName} MemorySwapMax`,
				kv.user_swap,
				kv.user_cfg_swap,
				wantSwap
			),
		])
			if (p) problems.push(p);
	}

	// A MINTED UNIT ABOVE THE PER-UNIT CEILING, or with none. The installer reads
	// each one's kernel memory.max; the fix is the minter, never a restart.
	const mintCap = notes.filter((n) => n.startsWith('MINT-CAP-DRIFT')).length;
	if (mintCap)
		problems.push(
			`${mintCap} minted unit(s) (jit-*/warm-*) carry a kernel memory.max above the per-unit ` +
				'ceiling, or none at all — nothing bounds them below the whole slice; the minter fixes ' +
				'this on the next mint, never a restart'
		);
	return problems;
}
