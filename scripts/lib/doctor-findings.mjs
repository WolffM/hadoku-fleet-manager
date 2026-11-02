/**
 * doctor — the `$health` facet of the supply record, and the findings it implies.
 *
 * THE GAP THIS FILLS
 * ------------------
 * `supply-ledger-2026-09-07.md` converged four producers onto ONE per-node
 * object in the fleet manifest, each an independently provenanced `{at, by, …}`
 * sibling: `$measured` (`fleet enroll`), `$benchmark` (`fleet benchmark`),
 * `$capabilities` (`fleet bootcamp`). It named the fourth row and said it had no
 * producer: health. `claw-floor-design-2026-09-07.md` §1.1 says the same thing
 * from the consumer side — "a `$health` facet (thermals, SMART, I/O — P1's
 * fourth row) has no producer yet … claw-3's thermal demotion and claw-1's 98 °C
 * stay a manifest `$why` and a manual demotion". `fleet doctor` printed all of
 * it to a terminal and recorded none of it, so every health fact the fleet has
 * ever acted on lives in prose a human typed after reading a scrollback.
 *
 * WHERE THE RECORD LIVES (Wave 3h): not in the manifest any more.
 * `fleet doctor --write` records `<stateDir>/health.json` through
 * `src/lib/measured.ts`, keyed `nodes[<node>]`, the same `{at, by, …}` block
 * without the `$`, plus one line per node in `health.log`. A re-measure is not
 * an editorial act and no longer costs a hadoku_site commit.
 *
 * This file is the judging half. EVERY FUNCTION HERE IS PURE: the probe is a
 * string, the I/O lives in `doctor-run.mjs`, and the reasoning is tested against
 * captured node output rather than against an intention. Same split
 * `preflight.mjs` / `check-fleet-preflight.mjs` already use, and the same split
 * `node-interfaces.mjs` states in its own header ("it parses here, not over
 * there").
 *
 * THE READER FOR A FACET MAY NOT READ WHAT THE WRITER WROTE (CLAUDE.md)
 * --------------------------------------------------------------------
 * Every number here comes from the kernel or from the drive's own firmware:
 * temperatures from `/sys/class/thermal` and `/sys/class/hwmon`, throttling from
 * `core_throttle_count`, disk free from `df`, SMART from `smartctl` talking to
 * the device, the wifi manager from `/run/network/ifstate` cross-checked against
 * NetworkManager's own device list. Nothing is read from a manifest declaration,
 * a `.env`, or a previous `$health` record. The ONE exception is the bootcamp
 * verdict, and it is deliberately a POINTER rather than evidence: `$health`
 * carries `$capabilities`' `at`/verdict so the inventory page can show both ages
 * side by side, and it is labelled `from: '$capabilities'` so nobody mistakes it
 * for something doctor measured. It is attached in memory and re-derived on
 * every read, never stored — see {@link bootcampPointer}. A verifier that read its own writer's artifact
 * could not fail; this one does not verify that artifact at all.
 *
 * "I COULD NOT LOOK" IS NEVER "NOTHING IS WRONG", AND IT SAYS WHY
 * --------------------------------------------------------------
 * Each fact is either a value or an `unknown` carrying the REASON — `smartctl is
 * not installed`, `root is required and sudo -n was refused`, `no SMART data
 * (USB bridge or unsupported)`, `CI was building here`. Those are four different
 * jobs, which is the whole argument `check-queue-health` lost in 2026-09-07 by
 * naming a repo and nothing else. An unknown for a fact this facet exists to
 * carry is a BLOCKING finding, never a silent skip and never a `catch {}`.
 *
 * WHY THE MAXIMUM ACROSS EVERY THERMAL ZONE IS NOT THE CPU TEMPERATURE
 * -------------------------------------------------------------------
 * `claw-doctor.sh` has carried this warning since 2026-08-17 — "a temperature
 * guard aimed at an ambient sensor" cost most of a day — and it is still live:
 * measured on claw-1 while writing this, `thermal_zone2` (type `acpitz`) read
 * **96 °C** in one sample with `x86_pkg_temp` at 76 °C, and 61 °C against 61 °C
 * four minutes later. A reader taking the max of all zones would therefore
 * report claw-1 as pinned at 96 °C at idle, which is very probably the
 * provenance of the "claw-1 98 °C" that has been quoted in prose since
 * `tier-assignment-2026-09-03.md`. So {@link cpuSensor} picks ONE designated
 * die sensor in a fixed order and every other sensor is reported BESIDE it,
 * never folded into it — and a zone running hot while the die is cool gets its
 * own advisory finding naming the zone, because a lying sensor is a real problem
 * (it is what the watchdog may be aimed at) and not the same problem as a hot CPU.
 */

import { BLOCKING } from './preflight.mjs';

import { f } from './doctor-findings-record.mjs';
import { thermalFindings } from './doctor-findings-thermal.mjs';
import { watchdogFindings } from './doctor-findings-watchdog.mjs';
import { storageFindings } from './doctor-findings-storage.mjs';
import { networkFindings } from './doctor-findings-network.mjs';
import { opsFindings } from './doctor-findings-ops.mjs';

/**
 * The BACKSTOP's findings are advisory, and the rule lives in `preflight.mjs` so
 * `check-fleet-preflight` and `fleet doctor` cannot classify the same box two
 * different ways. Re-exported rather than reimplemented for the reason this
 * file already imports `rebootFinding`: one judgement, one implementation.
 *
 * Every finding `doctorFindings` produces is node-keyed, so this reaches all of
 * them — except `unreachable`, which {@link BACKSTOP_BLOCKING_CATEGORIES} keeps
 * blocking: a backstop nothing can reach is no use in an emergency.
 */

/**
 * THRESHOLDS — SAFETY CONTROLS, NOT TUNING. Moved to
 * `doctor-findings-thresholds.mjs` (wave 5s lane B, pure move) to bring this
 * file under the 800-line source ceiling; re-exported here so every existing
 * importer (this file's own `doctorFindings` below, and every test that reads
 * `THERMAL_BLOCKING_C` etc. straight off `doctor-findings.mjs`) compiles
 * unchanged. See that file for the doc comment on each number.
 */

// ═══════════════════════════════════════════════════════════════════════════
// FINDINGS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Every finding one node's `$health` implies, each with a class.
 *
 * SAME THREE PROPERTIES `preflight.mjs` holds, and for the same reasons:
 * BLOCKING is what anything unrecognised resolves to (`blockingFindings` asks
 * whether a finding is explicitly advisory, never whether it is explicitly
 * blocking); only a CLEAN READ may be advisory, so every `why`-carrying unknown
 * below is blocking; and nothing gets looser as the reading gets worse.
 *
 * THE ORCHESTRATOR, not a judge itself (wave shrink-1 lane D): each facet's
 * judgement moved to its own `doctor-findings-*.mjs` module, named for the
 * ONE facet it reads — thermal, watchdog, storage (disk + SMART), network,
 * and ops (reboot/units/pm2/bootcamp). This stays the single place that
 * decides the UNREACHABLE short-circuit and the order findings are reported
 * in; every judge is pure and reads only `health`, so concatenating their
 * output in this order reproduces exactly what the one function used to do
 * inline.
 *
 * @param {ReturnType<healthFacet>} health
 * @param {{nowMs?: number}} [opts]
 */
export function doctorFindings(health, { nowMs = Date.now() } = {}) {
	if (!health || health.reachable === false) {
		return [
			f(
				health ?? { node: null },
				'unreachable',
				BLOCKING,
				'unreachable',
				health?.why ?? 'the node produced no health record at all'
			),
		];
	}

	return [
		...thermalFindings(health),
		...watchdogFindings(health),
		...storageFindings(health),
		...networkFindings(health),
		...opsFindings(health, { nowMs }),
	];
}
