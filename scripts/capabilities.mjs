#!/usr/bin/env node
/**
 * fleet capabilities — THIN ALIAS (wave gates2 lane F1a). `check-capabilities.mjs`
 * is DELETED: operator-approved (docs/planning/wave-gates2-2026-11-08.md,
 * "DELETE check:capabilities") because everything it checked — every label a
 * node offers, EXECUTED — is already checked by `fleet bootcamp`'s probe
 * registry, which runs on its own nightly cadence an hour before this gate
 * used to, and REVOKES a label on failure (`src/capability-revocations.ts`)
 * rather than merely reporting it. Re-probing the same labels here one hour
 * later added nothing: a failure bootcamp had not yet revoked would simply
 * repeat the same `capability-drift` finding this subcommand always
 * produced, never catch anything bootcamp's own revocation missed.
 *
 * The ONE thing this subcommand checked that bootcamp does not is the
 * ephemeral dispatcher's `--jitconfig` dependency — not a per-node LABEL at
 * all, but a fleet-wide fact about the runner binary every node mints from.
 * That probe moved to `fleet boundary-contracts` (section 5 of
 * `check-boundary-contracts.mjs`), which already runs nightly under
 * `ci:audit-gates` and already asserts real boundary shapes against the
 * fleet, network included.
 *
 * TWO CALLERS, TWO SHAPES.
 * ------------------------
 * mgmt-api's `ci:audit-gates` (`check:capabilities` row, `audit-gates.ts`)
 * calls this FLEET-WIDE, with no `--machine`, and only needs a document it
 * can judge as a pass until the site lane (S1) removes that row — so with no
 * `--machine` this is a true no-op: no ssh, no probing, no capability state.
 *
 * `reboot-claws.mjs`'s re-prove step (`lib/reboot-cycle.mjs`'s `judgeReprove`)
 * calls this `--machine <node> --json` AFTER a reboot, BEFORE undraining, and
 * its contract is NOT a rubber stamp: `judgeReprove` requires `doc.results`
 * to carry the node and `doc.findings` to be empty, so a bare no-op here
 * would make EVERY reboot look like it broke the node (no `results` at all)
 * — the opposite failure from mgmt-api's case, but just as wrong, and a
 * reboot cycle that always fails its re-prove holds every claw drained
 * forever. So `--machine` is answered for REAL: this spawns
 * `fleet bootcamp --check-only --machine <node> --json` (probe-and-judge,
 * install and seed NOTHING — see bootcamp.mjs's own doc comment) and
 * reshapes its document into the old `{results, unreachable, findings}`
 * contract `judgeReprove` already reads.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEmitter } from './lib/emit.mjs';

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const out = createEmitter({ json: JSON_OUT });

const machineIdx = argv.indexOf('--machine');
const MACHINE = machineIdx === -1 ? null : (argv[machineIdx + 1] ?? null);

const NOTE =
	'check:capabilities retired — every label-execution probe it ran now lives in ' +
	"fleet bootcamp's probe registry (which also revokes on failure, unlike this gate); " +
	"its one unique check, the ephemeral dispatcher's --jitconfig dependency, moved to " +
	'fleet boundary-contracts. See docs/planning/wave-gates2-2026-11-08.md.';

if (!MACHINE) {
	// The mgmt-api fleet-wide case: a true no-op, nothing probed.
	if (JSON_OUT) {
		out.emit({
			ok: true,
			findings: [],
			unreadable: [],
			aliasOf: 'bootcamp (probe registry + revocation), boundary-contracts (--jitconfig)',
			note: NOTE,
		});
	} else {
		out.log(`✓ ${NOTE}`);
	}
	process.exit(0);
}

// `reboot-claws.mjs`'s re-prove case: a REAL re-probe of the one named node,
// via bootcamp's own probe registry, nothing installed or seeded.
// `FLEET_BOOTCAMP_SCRIPT_FOR_TEST` is a test-only seam (capabilities.test.mjs):
// bootcamp.mjs ssh's a real fleet, so a test stands in a canned script rather
// than spawning it for real.
const BOOTCAMP =
	process.env.FLEET_BOOTCAMP_SCRIPT_FOR_TEST ||
	join(dirname(fileURLToPath(import.meta.url)), 'bootcamp.mjs');
let bootcampDoc;
let bootcampError = null;
try {
	const stdout = execFileSync(
		process.execPath,
		[BOOTCAMP, '--check-only', '--machine', MACHINE, '--json'],
		{ encoding: 'utf8', timeout: 9 * 60_000, maxBuffer: 16 * 1024 * 1024 }
	);
	bootcampDoc = JSON.parse(stdout);
} catch (err) {
	// execFileSync throws on a non-zero exit too — bootcamp's OWN contract
	// (see its header) is to still emit one JSON document under `--json`
	// whatever the exit code, so its stdout is read off the error object the
	// same way every other `--json` consumer in this package does.
	const stdout = err && typeof err === 'object' ? err.stdout : null;
	try {
		bootcampDoc = JSON.parse(String(stdout ?? ''));
	} catch {
		bootcampError = err instanceof Error ? err.message : String(err);
	}
}

if (bootcampError || !bootcampDoc || typeof bootcampDoc !== 'object') {
	const reason = bootcampError ?? 'bootcamp --check-only produced no JSON';
	if (JSON_OUT) {
		out.emit({
			ok: false,
			findings: [`${MACHINE}: could not re-probe via bootcamp --check-only — ${reason}`],
			unreadable: [{ node: MACHINE, why: reason }],
			results: {},
			aliasOf: 'bootcamp --check-only (re-probe for reboot-claws.mjs)',
		});
	} else {
		out.log(`✗ ${MACHINE}: could not re-probe via bootcamp --check-only — ${reason}`);
	}
	process.exit(1);
}

// RESHAPED to the contract `judgeReprove` (lib/reboot-cycle.mjs) already
// reads: `results` keyed by node (bootcamp's own `report`, keyed the same
// way), `unreachable`, and a `findings` array that is non-empty exactly when
// bootcamp's own `ok` says the re-probe found something wrong.
const ok = bootcampDoc.ok !== false;
out.log(
	ok
		? `✓ ${MACHINE}: re-probed clean via bootcamp --check-only`
		: `✗ ${MACHINE}: bootcamp --check-only found drift on re-probe`
);
if (JSON_OUT) {
	out.emit({
		ok,
		findings: ok ? [] : [`${MACHINE}: bootcamp --check-only found drift on re-probe`],
		unreachable: bootcampDoc.unreachable ?? [],
		results: bootcampDoc.report ?? {},
		aliasOf: 'bootcamp --check-only (re-probe for reboot-claws.mjs)',
	});
}
process.exit(ok ? 0 : 1);
