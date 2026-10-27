/**
 * runners.slice on a node whose CI has its own user: two halves, two roles.
 *
 * `runners-slice-install.sh` manages two copies of the slice. The SYSTEM copy
 * is written with sudo, so it is admin's. The USER-MANAGER copy bounds every
 * minted `jit-*`/`warm-*` unit, and it lives in the manager of whoever runs
 * CI. Before a node is cut over to a ci user (src/lib/node-users.ts) those are
 * the same login and one run does both. After, the deployer runs the payload
 * as admin AND as ci, and judges each half from the run that can see it. As
 * ci the installer behaves as it always has on hokon: no sudo, the system half
 * reported rather than attempted.
 *
 * {@link mergeSplitSummary} is that judgement: one SUMMARY made of the system
 * fields from admin's run and the user-manager fields from ci's, with the
 * counters summed.
 */

/** SUMMARY fields that describe the CI user's manager: taken from the ci run. */
export const USER_HALF = [
	'user_max',
	'user_swap',
	'user_cfg_max',
	'user_cfg_swap',
	'user_load',
	'user_units',
	'unit_mb',
	'capped_live',
	'in_slice',
	'supervised',
	'sup_total',
	'mint_total',
	'mint_in_slice',
	'io_subtree',
	'bad_slices',
	'bad_slice_names',
];

/** Counters: each run counts its own half, so the node's total is the sum. */
const SUMMED = ['changed', 'restarted', 'busy', 'failed'];

/** One SUMMARY from the admin run's (system half) and the ci run's (user half). */
export function mergeSplitSummary(adminKv, ciKv) {
	const out = { ...adminKv };
	for (const k of USER_HALF) if (k in ciKv) out[k] = ciKv[k];
	for (const k of SUMMED) {
		const a = Number(adminKv[k] ?? 0);
		const c = Number(ciKv[k] ?? 0);
		out[k] = String((Number.isFinite(a) ? a : 0) + (Number.isFinite(c) ? c : 0));
	}
	return out;
}

/**
 * The ci run's lines that belong in the report. Its NEEDS-OPERATOR is the
 * system half it cannot write without sudo, which admin's run owns and has
 * already reported, so it is dropped; everything else it says is about its own
 * manager and is kept.
 */
export const ciNotes = (lines) => lines.filter((l) => !/^NEEDS-OPERATOR /.test(l));
