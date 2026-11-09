/**
 * toolchain-refresh-backstop — the one place `fleet converge-toolchain
 * --refresh` turns a doctor run into the backstop readiness record its own
 * JSON document promises (hadoku_site#527).
 *
 * `fleet toolchain --json` has always carried `machines[].backstop` — the
 * advisory readiness block `lib/toolchain-backstop.mjs` builds for whichever
 * node the manifest declares the backstop (`lib/toolchain-doctor.mjs`).
 * mgmt-api's ci-digest reads it to render hokon's readiness. `--refresh`
 * already calls the SAME doctor (`runDoctor`) for its own tool-cache-drift
 * findings (wave gates2 lane F1a, `converge-toolchain.mjs`), and threw the
 * backstop block away afterwards — harmless while `ci:fleet-toolchain`'s own
 * cron still ran `fleet toolchain --json` an hour later and gave ci-digest a
 * second source for it, but that cron is retired this wave (lane S1), so
 * without this the block has no reader left at all. This module is purely
 * additive: it answers "could the backstop take load", never "is the fleet
 * healthy", and must never add a finding or move the refresh report's `ok` —
 * see `toolchain-backstop.mjs`'s own doc for why the block itself carries
 * that rule, and `converge-toolchain.mjs`'s call site for why `ok` is
 * recomputed only from `findings` immediately after these are set.
 */
import { isBackstopNode } from '../../dist/lib/node-role.js';

/**
 * `doctorReport` is `runDoctor(...).report` — one entry per probed machine.
 * Every entry that carries `m.backstop` (the block itself, unchanged in
 * shape — never re-derived here) is copied in, keyed by `m.machine`.
 *
 * A machine the manifest declares `role: 'backstop'` but whose probe came
 * back `unreachable` (so `runDoctor` never reached the point of building the
 * block at all) still gets an entry — `{ error }` — rather than silently
 * dropping out of the record: "I could not look" must never render as
 * "nothing to report" here either (CLAUDE.md).
 *
 * Any OTHER machine (an ordinary claw, which never carries `m.backstop`) is
 * left out entirely: the field is "every backstop this fleet declares", not
 * "every machine, most of them null".
 */
export function refreshBackstopRecord(doctorReport, manifest) {
	const out = {};
	for (const m of doctorReport) {
		if (m.backstop) {
			out[m.machine] = m.backstop;
			continue;
		}
		if (isBackstopNode(manifest.machines?.[m.machine])) {
			out[m.machine] = {
				error: m.error ?? 'the backstop probe produced no readiness block',
			};
		}
	}
	return out;
}

/**
 * The whole-doctor-run failure case: `runDoctor` itself threw before any
 * machine was probed at all (`converge-toolchain.mjs`'s own `catch` already
 * turns this into a `tool-cache-probe-failed` finding; this is the matching
 * shape for the `backstop` field). `_doctor` is not a real node name — it is
 * the one key a consumer can check for "the doctor never ran" without
 * mistaking it for a machine that happens to be named that.
 */
export function refreshBackstopDoctorFailed(err) {
	return { _doctor: { error: err instanceof Error ? err.message : String(err) } };
}
