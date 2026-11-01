/**
 * doctor's thresholds — pulled out of `doctor-findings.mjs` (wave 5s lane B)
 * purely to bring that file under the 800-line source ceiling. SAFETY
 * CONTROLS, NOT TUNING: every number and every doc comment below is
 * unchanged from where it lived until now, directly above the
 * `doctorFindings` export it still feeds — see that file's own header for
 * the record this facet fills and why "the reader may not read what the
 * writer wrote" applies to every one of these.
 *
 * `doctorFindings` stays ONE function (see `git show 7d4a010`'s note, carried
 * forward in `doctor-findings.mjs`): its watchdog check reads the thermal
 * reading computed earlier in the same body, so cutting it into
 * per-category functions would be a rewrite, not a move. This file is the
 * other half of that same constraint — a move that COULD be made cleanly,
 * because a threshold constant closes over nothing.
 */

import { BOOTCAMP_STALE_DAYS } from '../../dist/lib/workload-gate.js';

// ═══════════════════════════════════════════════════════════════════════════
// THRESHOLDS — SAFETY CONTROLS, NOT TUNING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Die temperature at which a node is reported BLOCKING.
 *
 * 100 °C is not a round number picked for comfort: it is the `max-load`/trip
 * point `/etc/watchdog.conf` is configured against on this fleet, and the
 * temperature at which the CPU's own PROCHOT pulls the clock down. claw-3 was
 * demoted on 96 °C against exactly that 100 °C trip with 1018 throttle events
 * in 51 minutes (`stress-node.sh`), and claw-8 went from 58 °C to 100 °C in
 * under five seconds of load with a cooler that does not transfer heat. A die
 * that reaches this under a one-minute load has no thermal headroom left at all.
 */
export const THERMAL_BLOCKING_C = 100;

/**
 * Die temperature at which a node is reported ADVISORY.
 *
 * STATED PLAINLY BECAUSE IT IS LOAD-BEARING, the way `preflight.mjs` states
 * hokon's staged kernel: hokon is a Ryzen and boosts to its own Tjmax by
 * design — measured 93.9 °C (`k10temp` `Tctl`) while merely idle-ish — so
 * hokon sits in this band permanently and that is the correct reading, not a
 * number chosen to make it pass. An advisory prints, rides in `--json` and does
 * not fail the run; the band exists so claw-3's 96 °C and hokon's 94 °C are
 * distinguishable from claw-4's 50 °C without either of them paging anyone.
 */
export const THERMAL_ADVISORY_C = 90;

/**
 * A non-CPU sensor this far above the die is reported as a SUSPECT sensor.
 *
 * Not a temperature finding — a provenance finding. See the file header: a
 * `acpitz` zone 20 °C hotter than the die is either lying or measuring
 * something else, and on this fleet `/etc/watchdog.conf`'s
 * `temperature-sensor=` has been aimed at one of those before.
 */
export const SENSOR_DISAGREE_C = 20;

/** Free space on `/` below which a node is BLOCKING. §H names this one. */
export const DISK_BLOCKING_FREE_PCT = 10;

/** Free space on `/` below which a node is ADVISORY. */
export const DISK_ADVISORY_FREE_PCT = 20;

/**
 * Drive power-on hours at which the drive becomes an ADVISORY finding.
 *
 * 43 800 h is five years of continuous power-on. Nothing is wrong with the
 * drive at this point; it is the age at which "plan its replacement" is a real
 * item rather than a worry, which is exactly what `workstreams.md` already says
 * about claw-7 in prose.
 */
export const SMART_HOURS_ADVISORY = 43_800;

/**
 * Drive power-on hours at which the drive becomes a BLOCKING finding.
 *
 * 87 600 h is ten years of continuous power-on — past any service life a
 * consumer SSD or laptop HDD is specified for. STATED PLAINLY, as above:
 * **claw-7 measures 91 529 h and is therefore BLOCKING from the day this
 * lands**, with the drive still reporting `PASSED` and 67 % lifetime remaining.
 * That is the design and not an accident. `workstreams.md` already carries the
 * operator item ("plan its replacement before it hosts anything resident"), and
 * a finding that goes green when the drive is replaced is how that item stops
 * living in a planning doc. Two further properties make this honest rather than
 * merely loud:
 *
 *   - `fleet doctor` is NOT in `scripts/lib/json-contract.mjs`, so no mgmt-api
 *     cron parses it and nothing pages `@here` on this. It is an operator
 *     command and a record writer. A later lane that puts it under contract
 *     owes this threshold a second look FIRST.
 *   - The direction is monotone, per CLAUDE.md's "no gate may get EASIER to
 *     pass the worse the failure gets": more hours is stricter, never looser,
 *     and a drive whose SMART cannot be read at all is blocking too.
 */
export const SMART_HOURS_BLOCKING = 87_600;

/**
 * The rise below which the die reading is ASKED TO PROVE IT TRACKS — not, on
 * its own, a verdict. See the `sensor-did-not-move` branch of
 * {@link doctorFindings} for the question this now triggers.
 *
 * MEASURED ACROSS THE WHOLE FLEET 2026-09-10, one run, `--seconds 60`: claw-1
 * +36 °C, claw-2 +30, claw-3 +47, claw-4 +43, claw-6 +29, claw-7 +32, hokon +9.
 * claw-5 moved **+5 °C, from 19 °C to 24 °C** — physically impossible for an
 * FX-8350 holding eight cores busy for a minute, and the giveaway that its
 * `k10temp` (family 15h, unlabelled `temp1_input`) is not reporting an absolute
 * die temperature at all.
 *
 * WHY THE NUMBER STOPPED BEING THE VERDICT (2026-09-22, lane T): the threshold
 * was calibrated on a fleet of small boxes, and claw-9 is not one — an i7-5930K
 * locked at 3.0 GHz with turbo off since a BIOS reset, under a desktop tower
 * cooler. On 2026-09-21 its package rose 42 → 49 °C under the 60 s load, under
 * this line, while its six per-core sensors independently rose +6…+14 °C. Every
 * sensor on the die moved, together: the sensor was tracking a die that stays
 * cool, and the rule recorded a BLOCKING anyway — a false "broken sensor" in
 * the one record meant to say whether a box is safe, on every desktop-class
 * node the fleet will ever onboard. A rise under this line is now the TRIGGER
 * for the tracking question, never the answer to it.
 *
 * STILL GUARDED BY THE SAME SECOND CLAUSE: a part already at its ceiling
 * cannot rise (hokon went 88 → 97 °C and only rose 9 °C), so a load reading at
 * {@link THERMAL_ADVISORY_C} or above is hot, not suspect, and never reaches
 * the tracking question.
 */
export const IMPLAUSIBLE_RISE_C = 8;

/**
 * The smallest rise that counts as a sensor MOVING, rather than sitting still.
 *
 * The die sensors read in whole degrees, minutes apart, so an honest sensor
 * that did not move still prints ±1–2 °C of rounding and ambient drift. 3 °C
 * is above that and below the smallest REAL rise this fleet has produced:
 * claw-9's package, the coolest reading any box here has answered with, moved
 * +7 °C under the 60 s all-core load (2026-09-21). A floor under 3 calls noise
 * movement; a floor above 7 calls claw-9's working package sensor stuck —
 * which is the exact false positive this rule was rewritten to stop making.
 */
export const SENSOR_MOVED_C = 3;

/**
 * How far the die reading may lag the independent readings beside it and still
 * be said to TRACK them: it must rise at least the median independent rise
 * divided by this.
 *
 * A package sensor legitimately trails its own cores — it integrates the whole
 * heat spreader while a core sensor sits on the hotspot — measured at 0.58–1.03
 * of the median per-core rise across this fleet (claw-9 is the 0.58: package
 * +7 °C while its cores moved +6–14 °C on the same load). One third keeps that
 * margin and still refuses a reading that rose a third of what the die
 * demonstrably did: a sensor responding to something other than the die.
 */
export const SENSOR_TRACKS_DIVISOR = 3;

/** How stale `$capabilities` may be before `$health` flags it — one number
 *  with `GET /fleet`'s `vocabulary.bootcampStaleDays`, owned by capabilities.ts. */
export { BOOTCAMP_STALE_DAYS };
