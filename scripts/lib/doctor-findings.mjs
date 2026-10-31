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

import { ADVISORY, BLOCKING, rebootFinding } from './preflight.mjs';
import { BOOTCAMP_STALE_DAYS } from '../../dist/lib/workload-gate.js';
import { independentCpuSensors } from './doctor-parse.mjs';

export { ADVISORY, BLOCKING };
export { advisoryFindings, blockingFindings } from './preflight.mjs';
/**
 * A GUEST's findings are advisory, and the rule lives in `preflight.mjs` so
 * `check-fleet-preflight` and `fleet doctor` cannot classify the same box two
 * different ways. Re-exported rather than reimplemented for the reason this
 * file already imports `rebootFinding`: one judgement, one implementation.
 *
 * Every finding `doctorFindings` produces is node-keyed, so this reaches all of
 * them — except `unreachable`, which {@link GUEST_BLOCKING_CATEGORIES} keeps
 * blocking: a box nothing can reach cannot answer the one question a guest IS
 * in scope for.
 */
export { guestAdvisory, GUEST_BLOCKING_CATEGORIES } from './preflight.mjs';

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

// ═══════════════════════════════════════════════════════════════════════════
// FINDINGS
// ═══════════════════════════════════════════════════════════════════════════

const f = (health, category, cls, status, why, extra = {}) => ({
	node: health.node,
	category,
	class: cls,
	status,
	why,
	...extra,
});

/**
 * Every finding one node's `$health` implies, each with a class.
 *
 * SAME THREE PROPERTIES `preflight.mjs` holds, and for the same reasons:
 * BLOCKING is what anything unrecognised resolves to (`blockingFindings` asks
 * whether a finding is explicitly advisory, never whether it is explicitly
 * blocking); only a CLEAN READ may be advisory, so every `why`-carrying unknown
 * below is blocking; and nothing gets looser as the reading gets worse.
 *
 * @param {ReturnType<healthFacet>} health
 * @param {{nowMs?: number}} [opts]
 */
export function doctorFindings(health, { nowMs = Date.now() } = {}) {
	const out = [];
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

	// ── thermals ──────────────────────────────────────────────────────────────
	const t = health.thermal ?? {};
	if (t.sensor === null) {
		out.push(
			f(
				health,
				'thermal-sensor',
				BLOCKING,
				'no-die-sensor',
				`no CPU die sensor could be identified on this node: ${t.why}. Nothing here can say ` +
					'whether it runs hot, and a node whose temperature cannot be read is not a node ' +
					'known to be cool.'
			)
		);
	} else if (t.loadC === null) {
		out.push(
			f(
				health,
				'cpu-thermal',
				BLOCKING,
				'no-load-reading',
				`${t.sensor} read ${t.idleC} °C before the load phase and no under-load reading was ` +
					`taken: ${(t.loadWhy ?? 'the load phase produced no peak for this sensor').replace(/\.\s*$/, '')}. A baseline temperature says nothing ` +
					'says nothing about a cooler that cannot shed heat — claw-8 idled at 58 °C and hit ' +
					'100 °C in under five seconds of load.',
				{ sensor: t.sensor, idleC: t.idleC }
			)
		);
	} else if (t.loadC >= THERMAL_BLOCKING_C) {
		out.push(
			f(
				health,
				'cpu-thermal',
				BLOCKING,
				'pinned',
				`${t.sensor} reached ${t.loadC} °C under ${t.loadSeconds}s of all-core load (idle ` +
					`${t.idleC} °C, rise ${t.riseC} °C). At or above ${THERMAL_BLOCKING_C} °C there is no ` +
					"thermal headroom left: the watchdog trip point and the CPU's own PROCHOT are both " +
					'here, so the next sustained job throttles or reboots the box.',
				{ sensor: t.sensor, idleC: t.idleC, loadC: t.loadC, riseC: t.riseC }
			)
		);
	} else if (t.riseC !== null && t.riseC < IMPLAUSIBLE_RISE_C && t.loadC < THERMAL_ADVISORY_C) {
		// BOTH CLAUSES, not just the rise — hokon rose 9 °C because it started at
		// 88 and finished at 97, and a part already at its ceiling cannot rise. The
		// `loadC` clause is written out rather than left to the else-if order below
		// it, because the order is a property of this chain and the rule is a
		// property of the finding.
		//
		// THE SENSOR IS ASKED TO TRACK, NOT TO RISE (2026-09-22, lane T). This
		// branch used to block on the rise number alone, calibrated on small boxes
		// that move 29–47 °C — until claw-9 (an i7-5930K locked at 3.0 GHz, turbo
		// off, under a tower cooler) rose +7 °C while its six per-core sensors
		// independently rose +6…+14 °C, and the rule called the sensor broken for
		// measuring a cool die. The question is now RELATIONAL: did the die reading
		// move WITH the independent readings beside it? A cool die is not a broken
		// sensor; a die reading that does not follow the package's own heat is not
		// a temperature. And the rule does not get easier as the failure gets
		// worse: a stuck die beside moving cores blocks (it ignored real heat),
		// and a die where NOTHING moved blocks (the whole suite is frozen or the
		// load never loaded — either way there is no reading here at all).
		const beside = independentCpuSensors(t.sensor, Object.keys(t.idleSensors ?? {})).filter(
			(k) => (t.loadSensors ?? {})[k] !== undefined
		);
		const besideRises = beside
			.map((k) => t.loadSensors[k] - t.idleSensors[k])
			.filter((r) => Number.isFinite(r))
			.sort((a, b) => a - b);
		// The MEDIAN, not the mean or the max: one stuck core sensor must neither
		// halve the reference (mean) nor cap it (max would ignore it, but one very
		// hot core would raise the bar a working package sensor cannot meet).
		const besideRiseC = besideRises.length
			? besideRises.length % 2
				? besideRises[(besideRises.length - 1) / 2]
				: (besideRises[besideRises.length / 2 - 1] + besideRises[besideRises.length / 2]) / 2
			: null;
		const neededC =
			besideRiseC === null
				? null
				: Math.max(SENSOR_MOVED_C, Math.ceil(besideRiseC / SENSOR_TRACKS_DIVISOR));
		if (besideRiseC === null) {
			// ONE SENSOR, NO WITNESS. Tracking cannot be judged on a single
			// reading — claw-5's FX-8350 exposes exactly one k10temp channel — so
			// this node is NOT called healthy on the strength of it. The rise is
			// still quoted: +5 °C against a fleet that moved 29–47 °C on the same
			// load is its own evidence that the number is not a die temperature.
			out.push(
				f(
					health,
					'cpu-thermal',
					BLOCKING,
					'tracking-unjudgeable',
					`${t.sensor} is the only CPU sensor this node emitted — no per-core or sibling ` +
						`reading exists to say whether it tracks the die — and it rose ${t.riseC} °C ` +
						`(${t.idleC} → ${t.loadC} °C) under ${t.loadSeconds}s of load on ${t.loadWorkers} ` +
						`cores, under the ${IMPLAUSIBLE_RISE_C} °C line and against a fleet that moved ` +
						'29–47 °C on the same load. Tracking cannot be judged on one reading, and a node ' +
						'whose temperature nothing vouches for is not a node known to be cool — this ' +
						'finding says JUDGE ME, not "the sensor is fine".',
					{ sensor: t.sensor, idleC: t.idleC, loadC: t.loadC, riseC: t.riseC }
				)
			);
		} else if (t.riseC < neededC && besideRiseC >= SENSOR_MOVED_C) {
			out.push(
				f(
					health,
					'cpu-thermal',
					BLOCKING,
					'sensor-did-not-move',
					`${t.sensor} rose ${t.riseC} °C (${t.idleC} → ${t.loadC} °C) under ${t.loadSeconds}s ` +
						`of load on ${t.loadWorkers} cores, while the ${beside.length} CPU sensor(s) ` +
						`beside it on the same package rose a median of ${besideRiseC} °C. The die ` +
						'demonstrably warmed and this reading did not move with it, so it is not ' +
						"tracking the die — whatever it is reporting, the package's own sensors say " +
						'it is not the temperature of anything a thermal guard could rely on.',
					{
						sensor: t.sensor,
						idleC: t.idleC,
						loadC: t.loadC,
						riseC: t.riseC,
						besideRiseC,
						besideSensors: beside.length,
					}
				)
			);
		} else if (t.riseC < neededC) {
			out.push(
				f(
					health,
					'cpu-thermal',
					BLOCKING,
					'nothing-moved-under-load',
					`neither ${t.sensor} nor any of the ${beside.length} CPU sensor(s) beside it rose ` +
						`as much as ${SENSOR_MOVED_C} °C under ${t.loadSeconds}s of load on ` +
						`${t.loadWorkers} cores (die ${t.idleC} → ${t.loadC} °C, median beside it ` +
						`${besideRiseC} °C). A die holding every core busy for a minute warms more than ` +
						'that on every box this fleet has measured — so either the whole sensor suite ' +
						'is frozen or the load never loaded, and either way this record carries no ' +
						'temperature. That is "I could not look", and it is not "nothing is wrong".',
					{
						sensor: t.sensor,
						idleC: t.idleC,
						loadC: t.loadC,
						riseC: t.riseC,
						besideRiseC,
						besideSensors: beside.length,
					}
				)
			);
		}
		// else: the die reading rose with the sensors beside it. It is tracking
		// the die, and a die that stays cool under load is a fact about the
		// cooler, not a finding about the sensor — nothing is pushed.
	} else if (t.loadC >= THERMAL_ADVISORY_C) {
		out.push(
			f(
				health,
				'cpu-thermal',
				ADVISORY,
				'hot',
				`${t.sensor} reached ${t.loadC} °C under ${t.loadSeconds}s of all-core load (idle ` +
					`${t.idleC} °C). Above ${THERMAL_ADVISORY_C} °C and below ${THERMAL_BLOCKING_C} °C is ` +
					'the band where a modern part boosts to its own limit by design — real, worth ' +
					'ranking on, and not an outage.',
				{ sensor: t.sensor, idleC: t.idleC, loadC: t.loadC, riseC: t.riseC }
			)
		);
	}

	// A SENSOR THAT DISAGREES WITH THE DIE IS ITS OWN FINDING. Not folded into
	// the temperature above, because the hazard is different: this is the sensor
	// `/etc/watchdog.conf` may be aimed at, and a guard reading a lying sensor
	// cannot protect the box it is guarding.
	//
	// SCOPED TO `thermal_zone` SENSORS, for a reason measured rather than
	// assumed: `/etc/watchdog.conf`'s `temperature-sensor=` on this fleet points
	// at a thermal-zone path (claw-1: `/sys/class/thermal/thermal_zone3/temp`),
	// so a zone is the only sensor that can actually BE the guard's input. A
	// hwmon sensor on another device is a different die with its own legitimate
	// temperature — claw-5's `nouveau` GPU idles 20 °C above its FX-8350's
	// k10temp reading, and flagging that said nothing true about either part.
	if (t.sensor && t.idleC !== null) {
		for (const [k, c] of Object.entries(t.idleSensors ?? {})) {
			if (k === t.sensor) continue;
			if (!k.startsWith('zone.')) continue;
			if (c - t.idleC < SENSOR_DISAGREE_C) continue;
			out.push(
				f(
					health,
					'thermal-sensor',
					ADVISORY,
					'disagrees',
					`sensor ${k} read ${c} °C while the die sensor ${t.sensor} read ${t.idleC} °C — ` +
						`${c - t.idleC} °C apart at idle. It is measuring something else or it is wrong, ` +
						'and either way it must not be what a thermal guard watches: aiming ' +
						'watchdog.conf at an ambient sensor is what cost a day on 2026-08-17.',
					{ sensor: k, sensorC: c, dieC: t.idleC }
				)
			);
		}
	}

	// ── the watchdog, and whether it can protect this box ─────────────────────
	const w = health.watchdog ?? {};
	// `enabled: not-found` MEANS THE UNIT DOES NOT EXIST, which is a different
	// fact from a unit that exists and is stopped. hokon has no `watchdog`
	// package at all — it is a claw safety control, configured by the node
	// profile — so judging it by the claws' rule reported the production host as
	// BLOCKING for not running software nobody ever installed there. The fact is
	// still recorded in `$health.watchdog`; it is just not a finding.
	const watchdogInstalled = w.enabled !== null && w.enabled !== 'not-found';
	if (watchdogInstalled && w.active && w.active !== 'active') {
		out.push(
			f(
				health,
				'watchdog',
				BLOCKING,
				'not-running',
				`the watchdog daemon is "${w.active}" (enabled: ${w.enabled}), wd_keepalive is ` +
					`"${w.keepalive}". Recover with: systemctl stop wd_keepalive && systemctl start watchdog`
			)
		);
	}
	// A LOAD TRIGGER REBOOTS A BUSY NODE, NOT A WEDGED ONE. The profile writes
	// none; a line here is a hand edit or a node bootstrapped before 2026-10-30.
	// Even `max-load-1` alone is a 15-minute ceiling of half its value, because
	// the daemon derives max-load-5/15 when they are unset: that is how claw-8
	// was rebooted at 52/48/34 with two heavy jobs beside its hosting slice.
	if (watchdogInstalled && w.loadTrigger && w.loadTrigger !== 'none') {
		out.push(
			f(
				health,
				'watchdog',
				ADVISORY,
				'load-trigger',
				`watchdog.conf reboots this node on load (${w.loadTrigger}). Load is not a wedge ` +
					'signal on a CI node, and an unset max-load-15 is half of max-load-1. Remove ' +
					'every max-load-* line from /etc/watchdog.conf and restart watchdog.',
				{ loadTrigger: w.loadTrigger }
			)
		);
	}
	if (w.sensorPath && t.sensor && w.sensorC !== null && t.idleC !== null) {
		const mismatch = Math.abs(w.sensorC - t.idleC) >= SENSOR_DISAGREE_C;
		if (mismatch) {
			out.push(
				f(
					health,
					'watchdog',
					BLOCKING,
					'wrong-sensor',
					`watchdog.conf watches ${w.sensorPath}, which reads ${w.sensorC} °C while the die ` +
						`reads ${t.idleC} °C. It cannot protect this box from a thermal fault it is not ` +
						'looking at.',
					{ sensorPath: w.sensorPath, sensorC: w.sensorC, dieC: t.idleC }
				)
			);
		}
	}

	// ── root disk ─────────────────────────────────────────────────────────────
	const d = health.disk ?? {};
	if (d.freePct === null) {
		out.push(
			f(
				health,
				'disk-free',
				BLOCKING,
				'unreadable',
				`free space on / could not be computed: ${d.why ?? 'df produced no usable total or available figure'}.`
			)
		);
	} else if (d.freePct < DISK_BLOCKING_FREE_PCT) {
		out.push(
			f(
				health,
				'disk-free',
				BLOCKING,
				'full',
				`/ is ${d.freePct}% free (${d.availKb} of ${d.totalKb} KiB) — under ` +
					`${DISK_BLOCKING_FREE_PCT}%. A runner that cannot write its workspace fails every ` +
					'job assigned to it, and a full root takes the node out without any gate going red.',
				{ freePct: d.freePct }
			)
		);
	} else if (d.freePct < DISK_ADVISORY_FREE_PCT) {
		out.push(
			f(
				health,
				'disk-free',
				ADVISORY,
				'tight',
				`/ is ${d.freePct}% free — under ${DISK_ADVISORY_FREE_PCT}%. Not an outage; a node ` +
					'that wants `fleet clean` before it is given anything resident.',
				{ freePct: d.freePct }
			)
		);
	}

	// ── `_work`, when it is a genuinely different filesystem from `/` ─────────
	//
	// Wave 4c §F. Reuses the SAME percentage lines as root (`DISK_BLOCKING_FREE_PCT`
	// / `DISK_ADVISORY_FREE_PCT`) rather than inventing a second rule: this is an
	// extension of the existing root-disk judgement onto a second disk, not a new
	// kind of finding. `disk-watch.ts`'s absolute-GB lines are the SEPARATE,
	// earlier-warning mechanism this wave adds elsewhere (`runner-health.ts`); the
	// two are not meant to agree, because one answers "is this disk nearly full"
	// and the other answers "is there still runway before admission refuses a
	// mint" — different questions, deliberately different units.
	const w2 = health.disk?.work;
	if (w2) {
		if (w2.freePct === null) {
			out.push(
				f(
					health,
					'disk-work-free',
					BLOCKING,
					'unreadable',
					`free space on _work could not be computed: ${w2.why ?? 'df produced no usable total or available figure'}.`
				)
			);
		} else if (w2.freePct < DISK_BLOCKING_FREE_PCT) {
			out.push(
				f(
					health,
					'disk-work-free',
					BLOCKING,
					'full',
					`_work (${w2.fs ?? 'unknown fs'}) is ${w2.freePct}% free — under ${DISK_BLOCKING_FREE_PCT}%. ` +
						'This is the filesystem holding the JIT payload cache and every job workspace.',
					{ freePct: w2.freePct }
				)
			);
		} else if (w2.freePct < DISK_ADVISORY_FREE_PCT) {
			out.push(
				f(
					health,
					'disk-work-free',
					ADVISORY,
					'tight',
					`_work (${w2.fs ?? 'unknown fs'}) is ${w2.freePct}% free — under ${DISK_ADVISORY_FREE_PCT}%.`,
					{ freePct: w2.freePct }
				)
			);
		}
	}

	// ── the drive ─────────────────────────────────────────────────────────────
	const s = health.smart ?? {};
	if (s.health === null) {
		out.push(
			f(
				health,
				'smart-health',
				BLOCKING,
				'unreadable',
				`SMART could not be read on ${health.node}: ${s.why ?? 'no reason was recorded'}. ` +
					'A drive whose health was not read is not a drive known to be healthy.'
			)
		);
	} else if (s.health !== 'PASSED' && s.health !== 'OK') {
		out.push(
			f(
				health,
				'smart-health',
				BLOCKING,
				'failing',
				`${s.device} reports SMART overall-health "${s.health}" — the drive's own firmware ` +
					'says it is failing.',
				{ device: s.device, health: s.health }
			)
		);
	}
	if (s.powerOnHours === null && s.health !== null) {
		out.push(
			f(
				health,
				'smart-hours',
				BLOCKING,
				'unreadable',
				`${s.device} answered SMART but reported no power-on hours, so its age is unknown. ` +
					'An unaged drive cannot be planned around.',
				{ device: s.device }
			)
		);
	} else if (s.powerOnHours !== null && s.powerOnHours >= SMART_HOURS_BLOCKING) {
		out.push(
			f(
				health,
				'smart-hours',
				BLOCKING,
				'beyond-service-life',
				`${s.device} reports ${s.powerOnHours.toLocaleString('en-US')} power-on hours ` +
					`(${(s.powerOnHours / 8766).toFixed(1)} years) — past ${SMART_HOURS_BLOCKING}h, any ` +
					`service life this class of drive is specified for. It still reports ` +
					`"${s.health}"${s.lifetimeRemainingPct === null ? '' : ` with ${s.lifetimeRemainingPct}% lifetime remaining`}, ` +
					'and that is not a reason to plan around it: replace the drive, or give this node ' +
					'nothing it cannot lose.',
				{ device: s.device, powerOnHours: s.powerOnHours }
			)
		);
	} else if (s.powerOnHours !== null && s.powerOnHours >= SMART_HOURS_ADVISORY) {
		out.push(
			f(
				health,
				'smart-hours',
				ADVISORY,
				'aging',
				`${s.device} reports ${s.powerOnHours.toLocaleString('en-US')} power-on hours ` +
					`(${(s.powerOnHours / 8766).toFixed(1)} years) — past ${SMART_HOURS_ADVISORY}h. ` +
					'Nothing is wrong with it; plan a replacement before this node hosts anything ' +
					'resident.',
				{ device: s.device, powerOnHours: s.powerOnHours }
			)
		);
	}

	// ── the radio ─────────────────────────────────────────────────────────────
	// `none` is a FACT about a wired-only box (claw-4/5/6) and not a finding, and
	// `node-interfaces.mjs` says so in its own six-answer list. `unknown` is the
	// "I could not look" answer and never collapses into `none`.
	const n = health.network ?? {};
	if (n.wifiManager === 'unknown') {
		out.push(
			f(
				health,
				'wifi-manager',
				BLOCKING,
				'unknown',
				`which stack owns this node's radio could not be determined: ${n.wifiReason}.`
			)
		);
	} else if (n.wifiManager === 'split') {
		out.push(
			f(
				health,
				'wifi-manager',
				BLOCKING,
				'split',
				`two managers on one box: ${n.wifiReason}. A stale ifupdown default route outlives ` +
					'the carrier it was learned on, which is the exact way a pulled cable blackholes a node.'
			)
		);
	} else if (n.wifiManager === 'unmanaged') {
		out.push(
			f(
				health,
				'wifi-manager',
				ADVISORY,
				'unmanaged',
				`${n.wifiReason}. The node is reachable on its other link today; the radio is the one ` +
					'that survives a cable pull, so leaving it unconfigured means a wired-only failure mode.'
			)
		);
	}
	// TWO DIFFERENT FAULTS, AND ONLY ONE OF THEM IS AN OUTAGE.
	//
	// `connected` from NetworkManager with a kernel operstate that is not `up` is
	// the two writers CONTRADICTING each other, and one of them is lying about
	// the link the fleet falls back on when a cable comes out — blocking.
	// `disconnected`/`unavailable` with a down link is the two writers AGREEING
	// that nothing has configured this radio, which is a real gap (hokon's
	// wlp13s0 is exactly this: NM holds it, nothing connects it, and the box is
	// wired-only in practice) but not a contradiction and not an outage today.
	if (n.radio && n.operstate && n.operstate !== 'up' && n.wifiManager === 'networkmanager') {
		const contradicts = n.nmState === 'connected' || n.nmState === 'connecting';
		out.push(
			f(
				health,
				'wifi-link',
				contradicts ? BLOCKING : ADVISORY,
				contradicts ? 'contradicts' : 'not-connected',
				contradicts
					? `NetworkManager reports ${n.radio} "${n.nmState}" while the kernel reports ` +
							`operstate "${n.operstate}" (carrier ${n.carrier}). The two writers disagree about ` +
							'the link the fleet falls back on when a cable comes out, so one of them is wrong.'
					: `${n.radio} is held by NetworkManager as "${n.nmState}" and its kernel operstate is ` +
							`"${n.operstate}" — both agree nothing has connected it. The radio is the link that ` +
							'survives a cable pull; until it is configured this box is wired-only in practice.',
				{ radio: n.radio, operstate: n.operstate, nmState: n.nmState }
			)
		);
	}

	// ── a staged reboot. preflight.mjs already owns this judgement. ───────────
	const reboot = rebootFinding(
		{
			node: health.node,
			ok: true,
			rebootRequired: health.reboot?.required ?? false,
			packages: health.reboot?.packages ?? [],
			stagedAtMs: health.reboot?.stagedAt ? Date.parse(health.reboot.stagedAt) : null,
		},
		{ nowMs }
	);
	// WHAT THE REBOOT CYCLE DECIDED (fleet reboot-claws, hourly), attached by
	// doctor-run from the cycle's own state. The staged flag says a reboot is
	// owed; this says whether one is coming, and if not, what is stopping it.
	const cycle = health.reboot?.cycle ?? null;
	const cycleNote = cycle
		? ` The reboot cycle last looked at ${cycle.at}: ${cycle.status}${cycle.why ? ` — ${cycle.why}` : ''}.`
		: '';
	if (reboot) out.push({ ...reboot, node: health.node, why: `${reboot.why}${cycleNote}` });
	if (cycle?.status === 'held') {
		out.push(
			f(
				health,
				'reboot-held',
				BLOCKING,
				'held',
				`${health.node} was rebooted by the reboot cycle and FAILED verification, so it is held ` +
					`out of service and no other claw reboots until a human lifts it:${cycleNote} ` +
					`Check it, then \`fleet drain ${health.node} --undo\`.`
			)
		);
	}

	// ── failed CI units ───────────────────────────────────────────────────────
	if ((health.runners?.failed ?? 0) > 0) {
		out.push(
			f(
				health,
				'runner-units',
				BLOCKING,
				'failed',
				`${health.runners.failed} actions.runner unit(s) are in the failed state on this node.`,
				{ failed: health.runners.failed }
			)
		);
	}

	// ── every other failed unit ───────────────────────────────────────────────
	// ADVISORY, both ways. The first three this found (claw-5/6 networkd, claw-3's
	// cktest-runner retired 07-30, claw-1's modules-load from a boot before DKMS
	// rebuilt nvidia) were leftovers, not outages, and none is a reason to refuse
	// a node work. Being unable to list units is advisory for the same reason: it
	// may not render as clean, and it is no worse than finding one. `actions.runner.*`
	// is left to the BLOCKING `runner-units` finding above. A record written before
	// this probe existed has no `failedUnits` and draws nothing — it never asked.
	const fu = health.failedUnits;
	if (fu && fu.units === null) {
		out.push(
			f(
				health,
				'failed-units',
				ADVISORY,
				'unknown',
				`whether any systemd unit has failed on this node could not be read: ${fu.why}.`
			)
		);
	} else if (fu) {
		const units = fu.units.filter((u) => !u.unit.startsWith('actions.runner.'));
		if (units.length > 0) {
			out.push(
				f(
					health,
					'failed-units',
					ADVISORY,
					'failed',
					`${units.length} systemd unit(s) failed: ` +
						units.map((u) => `${u.unit} (since ${u.since ?? 'an unreported time'})`).join(', ') +
						'. `systemctl status <unit>` on the node says why; `systemctl reset-failed` clears a ' +
						'stale one only once its cause is gone.',
					{ units }
				)
			);
		}
	}

	// ── pm2 managers nothing claims ───────────────────────────────────────────
	// `pm2Claims` is ATTACHED by doctor-run from the tenant registry, the hosting
	// declarations and the app layer's host list (lib/hosting-claims.mjs), like
	// the bootcamp pointer: never stored, so a reader without those records
	// draws nothing rather than a stale verdict. An unclaimed manager is memory
	// no budget counts and keeps `not-beside-unbounded` tenants off the node, so
	// it BLOCKS; a declared host with no apps and no ceiling is hadoku_site's
	// call and is advisory.
	if (health.pm2Units?.units === null) {
		out.push(
			f(
				health,
				'pm2-claims',
				ADVISORY,
				'unknown',
				`which pm2 managers run on this node could not be read: ${health.pm2Units.why}.`
			)
		);
	}
	for (const c of health.pm2Claims ?? []) {
		if (c.severity === 'ok') continue;
		out.push(
			f(
				health,
				'pm2-claims',
				c.severity === 'advisory' ? ADVISORY : BLOCKING,
				c.claim,
				`${c.unit}: ${c.why}.`,
				{
					unit: c.unit,
					by: c.by,
				}
			)
		);
	}

	// ── the bootcamp pointer, aged ────────────────────────────────────────────
	const b = health.bootcamp ?? {};
	if (!b.at) {
		out.push(
			f(
				health,
				'bootcamp-record',
				ADVISORY,
				'missing',
				b.why ?? 'this node carries no $capabilities record, so nothing has proved what it can do.'
			)
		);
	} else {
		const ageDays = (nowMs - Date.parse(b.at)) / 86_400_000;
		if (!Number.isFinite(ageDays) || ageDays > BOOTCAMP_STALE_DAYS) {
			out.push(
				f(
					health,
					'bootcamp-record',
					ADVISORY,
					'stale',
					`$capabilities was last written ${Number.isFinite(ageDays) ? `${Math.round(ageDays)}d` : 'at an unparseable time'} ` +
						`ago (${b.at}) — past ${BOOTCAMP_STALE_DAYS}d. What this node can do is being read ` +
						'off a record older than the toolchain on it.',
					{ capabilitiesAt: b.at }
				)
			);
		}
	}

	return out;
}
