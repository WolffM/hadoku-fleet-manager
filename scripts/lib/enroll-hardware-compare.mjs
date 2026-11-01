/**
 * `fleet enroll`'s declared-vs-observed hardware comparison — split out of
 * scripts/enroll-node.mjs (wave 5p lane D) so the CLI stays under the
 * 800-line ceiling. Takes the CLI's flags and helpers (`log`/`warn`/`die`)
 * through `ctx`; never imports the CLI.
 */
const FATAL = ['cores', 'hostname'];
/**
 * memTotalKb is fixed hardware, but NOT a fixed NUMBER.
 *
 * Measured on claw-6, 2026-09-02: the record said 8038384 and the re-probe said
 * 8038388 — four kilobytes, one page. The kernel reserves slightly different
 * amounts from boot to boot depending on what is loaded, so an exact comparison
 * refuses a perfectly good node and tells its operator the capture came from a
 * different machine. That is a false accusation, and the kind that trains people
 * to pass --force.
 *
 * A tolerance still catches what this check is for. The failure it exists to
 * prevent is a spliced capture or the wrong ssh target, and those differ by
 * gigabytes: 8GB against 16GB is 100% out, not 0.00005%.
 */
const MEM_TOLERANCE = 0.01;
const ADVISORY = ['kernel'];

/**
 * Compares `declared` (from the enrollment record) against `probed` (the
 * control host's own ssh measurement, or `null` for a capture with no
 * re-probe), mutating `declared` in place for any field this run accepts as
 * a KNOWN hardware change (`--hardware-changed`). Returns `{ conflicts,
 * notes, hardwareChanges }`; dies on an unaccepted conflict, exactly as the
 * CLI did inline.
 */
export function compareHardware(ctx, declared, probed) {
	const { HARDWARE_CHANGED, HARDWARE_REASON, NODE, log, warn, die } = ctx;
	const conflicts = [];
	const notes = [];
	const hardwareChanges = [];

	if (probed) {
		log('[enroll] re-probing over ssh (declared vs observed)');
		for (const key of [...FATAL, 'memTotalKb', ...ADVISORY, 'diskFreeGb']) {
			const d = declared[key];
			const o = probed[key] === '' || probed[key] === undefined ? null : probed[key];
			let same = d === null || o === null ? null : String(d) === String(o);
			if (same === false && key === 'memTotalKb') {
				const drift = Math.abs(Number(d) - Number(o)) / Math.max(Number(d), Number(o));
				if (Number.isFinite(drift) && drift <= MEM_TOLERANCE) same = true;
			}
			const verdict =
				o === null ? 'not probed' : same === null ? 'unmeasured' : same ? 'ok' : 'DIFFERS';
			log(
				`  ${key.padEnd(14)} ${String(d ?? '—').padEnd(12)} ${String(o ?? '—').padEnd(12)} ${verdict}`
			);
			if (same === false && HARDWARE_CHANGED.includes(key)) {
				// The box as it is NOW is the measurement: every derived field
				// (memTotalMb, ramGb) is built from `declared`, so it takes the probe.
				const now = Number.isFinite(Number(o)) ? Number(o) : o;
				declared[key] = now;
				hardwareChanges.push({
					field: key,
					from: d,
					to: now,
					reason: HARDWARE_REASON,
					at: new Date().toISOString(),
				});
				warn(
					`${key} changed: ${d} -> ${o}, accepted as a known hardware change (${HARDWARE_REASON})`
				);
			} else if (same === false) {
				if (FATAL.includes(key) || key === 'memTotalKb')
					conflicts.push({ key, declared: d, observed: o });
				// diskFreeGb is EXPECTED to differ — it is silently refreshed below.
				// Warning on it every single run is how a warning stops being read,
				// which would cost the kernel advisory beside it its only reader.
				else if (ADVISORY.includes(key)) notes.push({ key, declared: d, observed: o });
			}
		}
		if (conflicts.length) {
			die(
				`the record and this host disagree on ${conflicts.map((c) => c.key).join(', ')}.\n` +
					conflicts
						.map((c) => `    ${c.key}: record says ${c.declared}, ${NODE} reports ${c.observed}`)
						.join('\n') +
					`\n  These cannot change between bootstrap and enroll. Either the capture came ` +
					`from a different machine, or ${NODE} is not the box that was bootstrapped. ` +
					`Enrolling would declare the wrong hardware under this name.`,
				{ conflicts }
			);
		}
		for (const n of notes) {
			warn(`${n.key} changed since bootstrap: ${n.declared} -> ${n.observed} (advisory)`);
		}
	}

	return { conflicts, notes, hardwareChanges };
}
