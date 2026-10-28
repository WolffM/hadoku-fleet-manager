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
import { BOOTCAMP_STALE_DAYS } from '../../dist/capabilities.js';
import { WIFI_MANAGER_PROBE, parseWifiManager } from './node-interfaces.mjs';

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

/** Seconds of all-core load the thermal reading is taken under. Fixed, by §H. */
export const LOAD_SECONDS = 60;

/**
 * A `~`-relative path this file will embed, UNQUOTED user data, into a remote
 * shell command (`doctorProbe`'s `seedCachePaths`). Deliberately strict: only
 * `~/`, then letters, digits, `.`, `_`, `/` and `-`. No spaces, no quotes, no
 * `$`, no `;` — nothing a shell would treat as anything other than a literal
 * path segment. A manifest value that does not match this is DROPPED, never
 * "best-effort" embedded; see `doctorProbe`'s own `seedCachePaths` doc.
 */
export const SAFE_CACHE_PATH = /^~\/[A-Za-z0-9._/-]+$/;

/**
 * Seed cache paths out of a manifest's `$seeds` (wave 4c §E), defensively.
 *
 * TWO SHAPES ARE ACCEPTED, because the two lanes that settle this disagree in
 * their own prose and neither had landed when this was written: the wave brief
 * asks doctor to read `$seeds[*][*].cache` (two wildcards — one capability,
 * several named seeds under it), while lane E's own write-up describes
 * `$seeds` as "keyed by capability. Each entry names a repo, a script path …"
 * — one object per capability, no second level. Rather than guess which shape
 * lane E actually shipped and silently report zero seed caches if wrong, this
 * reads BOTH: a capability entry with its own string `cache` field (shape A),
 * and a capability entry that is itself a map of named sub-entries each
 * carrying `cache` (shape B). Neither shape present is read as "no seed caches
 * declared" — same rule as an absent `$seeds` key entirely, never an error.
 *
 * Every returned `cache` matches {@link SAFE_CACHE_PATH}; anything else
 * (not a string, empty, or shaped wrong) is DROPPED rather than guessed at —
 * `check-capability-schema` (lane E) is where a malformed manifest value
 * belongs as a finding, not here.
 *
 * @param {unknown} manifest
 * @returns {{capability: string, seed: string|null, cache: string}[]}
 */
export function seedCachePathsFromManifest(manifest) {
	const seeds =
		manifest && typeof manifest === 'object' ? /** @type {any} */ (manifest).$seeds : null;
	if (!seeds || typeof seeds !== 'object') return [];
	const out = [];
	for (const [capability, entry] of Object.entries(seeds)) {
		if (!entry || typeof entry !== 'object') continue;
		if (typeof entry.cache === 'string' && SAFE_CACHE_PATH.test(entry.cache)) {
			out.push({ capability, seed: null, cache: entry.cache });
			continue;
		}
		for (const [seedName, sub] of Object.entries(entry)) {
			if (
				sub &&
				typeof sub === 'object' &&
				typeof sub.cache === 'string' &&
				SAFE_CACHE_PATH.test(sub.cache)
			) {
				out.push({ capability, seed: seedName, cache: sub.cache });
			}
		}
	}
	return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE NODE-HALF PROBE
// ═══════════════════════════════════════════════════════════════════════════

/** Why an operator's `--no-load` run carries no under-load reading. */
export const NO_LOAD_WHY =
	'the load phase was disabled with --no-load, so no under-load temperature was taken';

/**
 * Why a `--cadence` run carries no under-load reading for a guest.
 *
 * hokon is the production host, and the operator keeps routine automation off
 * it (2026-10-09). Probing it is in scope, but a nightly 60s all-core load on
 * the box serving production is not. Its findings are advisory anyway, so the
 * missing reading costs no verdict. A hand-run `fleet doctor` still loads it.
 */
export const GUEST_CADENCE_NO_LOAD_WHY =
	'a scheduled (--cadence) run never loads a guest node; run fleet doctor by hand for its under-load temperature';

/**
 * The shell the node runs. Emits a line protocol and decides nothing.
 *
 *   `DOCTOR-BEGIN v1` … `DOCTOR-END <host>`   sentinels
 *   `D <key> <value>`                          a fact
 *   `U <key> <reason>`                         I could not look, and why
 *   `S <line>`                                 one raw line of smartctl output
 *   `WMGR …`                                   {@link WIFI_MANAGER_PROBE}'s own
 *
 * A run without `DOCTOR-END` is SILENCE, not an empty result — same rule
 * `bootcamp.mjs` applies to `PROBE-END` and `parseSummary` applies to its
 * `SUMMARY` line. A node that died halfway through prints plenty and finishes
 * nothing, and reading that as "nothing to report" is how an audit goes green
 * on a box it never finished talking to.
 *
 * SENSOR KEYS ARE EMITTED ONCE AND REUSED. `sensors()` is defined in the shell
 * and called for the idle reading and for every sample during the load, so
 * `idle.<key>` and `peak.<key>` are guaranteed to be the SAME physical sensor.
 * Picking the die sensor on the control side (see {@link cpuSensor}) would be
 * worthless if the two halves could disagree about which sensor that was.
 *
 * @param {{loadSeconds?: number, force?: boolean, seedCachePaths?: string[], noLoadWhy?: string}} [opts]
 *   `loadSeconds: 0` disables the load phase and says so as an `unknown`.
 *   `force` loads the box even while CI is building on it.
 *   `seedCachePaths`: `~`-relative paths (wave 4c §E's manifest `$seeds[*].cache`
 *     / `$seeds[*][*].cache`) to size alongside the other known consumers. A
 *     path that does not match {@link SAFE_CACHE_PATH} is silently dropped
 *     here — never embedded into the remote shell unvalidated. See
 *     {@link seedCachePathsFromManifest}, which already filters to this same
 *     pattern; this is defense in depth for a caller that did not.
 */
export function doctorProbe({
	loadSeconds = LOAD_SECONDS,
	force = false,
	seedCachePaths = [],
	noLoadWhy = NO_LOAD_WHY,
} = {}) {
	const secs = Number.isFinite(loadSeconds) && loadSeconds > 0 ? Math.floor(loadSeconds) : 0;
	// Embedded in a remote shell line inside double quotes, so nothing that
	// shell would expand may reach it.
	if (!/^[\w\s.,;:()'-]+$/.test(noLoadWhy))
		throw new Error(`doctorProbe: unsafe noLoadWhy ${noLoadWhy}`);
	return [
		'set -u',
		// A value may be empty (a grep that matched nothing); `say` refuses it so
		// an empty string can never masquerade as a measurement.
		'say() { if [ -n "${2:-}" ]; then printf "D %s %s\\n" "$1" "$2"; else printf "U %s %s\\n" "$1" "the node produced no value for this"; fi; }',
		'unk() { printf "U %s %s\\n" "$1" "$2"; }',
		'if [ "$(id -u)" = 0 ]; then SUDO=""; else SUDO="sudo -n"; fi',
		'if $SUDO true 2>/dev/null; then ROOTOK=yes; else ROOTOK=no; fi',
		'echo "DOCTOR-BEGIN v1"',
		'say schema 1',
		'say hostname "$(cat /proc/sys/kernel/hostname 2>/dev/null)"',
		'say product "$(cat /sys/class/dmi/id/product_name 2>/dev/null)"',
		'say kernel "$(uname -r)"',
		'say startedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
		'say uptimeSec "$(cut -d" " -f1 /proc/uptime | cut -d. -f1)"',
		'say cores "$(grep -c ^processor /proc/cpuinfo)"',
		'say load1 "$(cut -d" " -f1 /proc/loadavg)"',
		'say rootElevation "$ROOTOK"',
		// ── every temperature sensor, named, emitted by ONE function ──────────
		'sensors() {',
		'  i=0',
		'  for z in /sys/class/thermal/thermal_zone*/; do',
		'    [ -r "$z/temp" ] || continue',
		'    printf "zone.%s.%s %s\\n" "$i" "$(cat "$z/type" 2>/dev/null)" "$(cat "$z/temp" 2>/dev/null)"',
		'    i=$((i+1))',
		'  done',
		'  i=0',
		// ITERATE `temp*_input`, NOT `temp*_label`. A label is optional and the
		// sensor that matters most here does not have one: claw-5 is an FX-8350
		// whose `k10temp` exposes `temp1_input` with NO `temp1_label`, so a
		// label-driven loop found zero sensors on it and `fleet doctor` reported
		// "no readable sensor under /sys/class/thermal or /sys/class/hwmon" on a
		// box whose die temperature was sitting there in sysfs. The reading is the
		// thing that exists; the label is how it is spelled.
		'  for h in /sys/class/hwmon/hwmon*; do',
		'    n=$(cat "$h/name" 2>/dev/null || echo unnamed)',
		'    for f in "$h"/temp*_input; do',
		'      [ -r "$f" ] || continue',
		'      v=$(cat "$f" 2>/dev/null) || continue',
		'      [ -n "$v" ] || continue',
		'      b=$(basename "$f" _input)',
		'      if [ -r "${f%_input}_label" ]; then l=$(tr " " "_" < "${f%_input}_label"); else l="$b"; fi',
		'      printf "hwmon.%s.%s.%s %s\\n" "$i" "$n" "${l:-$b}" "$v"',
		'    done',
		'    i=$((i+1))',
		'  done',
		'}',
		'throttles() { t=0; for c in /sys/devices/system/cpu/cpu*/thermal_throttle/core_throttle_count; do [ -r "$c" ] || continue; t=$((t + $(cat "$c" 2>/dev/null || echo 0))); done; echo "$t"; }',
		'SENSED=0',
		'while read -r k v; do printf "D idle.%s %s\\n" "$k" "$v"; SENSED=$((SENSED+1)); done < <(sensors)',
		'[ "$SENSED" -gt 0 ] || unk idle.sensors "no readable sensor under /sys/class/thermal or /sys/class/hwmon"',
		'say idle.throttleCount "$(throttles)"',
		// ── watchdog: what it will do about load, and what sensor it watches ──
		'say watchdog.active "$(systemctl is-active watchdog 2>/dev/null)"',
		'say watchdog.enabled "$(systemctl is-enabled watchdog 2>/dev/null)"',
		'say watchdog.keepalive "$(systemctl is-active wd_keepalive 2>/dev/null)"',
		'if [ -r /etc/watchdog.conf ]; then',
		'  WDL=$(grep -E "^[[:space:]]*max-load-1" /etc/watchdog.conf | tr -d " " | cut -d= -f2)',
		'  if [ -n "$WDL" ]; then say watchdog.maxLoad1 "$WDL"; else unk watchdog.maxLoad1 "watchdog.conf names no max-load-1 threshold, so nothing bounds the load it will reboot this box for"; fi',
		'  WDS=$(grep -E "^[[:space:]]*temperature-sensor" /etc/watchdog.conf | tr -d " " | cut -d= -f2)',
		'  if [ -n "$WDS" ]; then say watchdog.sensorPath "$WDS"; say watchdog.sensorMilliC "$(cat "$WDS" 2>/dev/null)"; else unk watchdog.sensorPath "watchdog.conf names no temperature-sensor"; fi',
		'else unk watchdog.conf "/etc/watchdog.conf is not readable"; fi',
		'say crashes "$(last -x reboot 2>/dev/null | grep -c crash)"',
		// ── root filesystem and the physical device behind it ─────────────────
		'say disk.root.fs "$(findmnt -no FSTYPE --target / 2>/dev/null)"',
		'say disk.root.totalKb "$(df -P / | awk "NR==2{print \\$2}")"',
		'say disk.root.availKb "$(df -P / | awk "NR==2{print \\$4}")"',
		'say disk.root.usePct "$(df -P / | awk "NR==2{gsub(/%/,\\"\\",\\$5);print \\$5}")"',
		'say mem.totalKb "$(awk "/^MemTotal:/{print \\$2}" /proc/meminfo)"',
		'say mem.availKb "$(awk "/^MemAvailable:/{print \\$2}" /proc/meminfo)"',
		'RSRC=$(findmnt -no SOURCE --target / 2>/dev/null | sed "s/\\[.*\\]//")',
		'RDEV=$(lsblk -rnso NAME,TYPE "$RSRC" 2>/dev/null | awk "\\$2==\\"disk\\"{print \\$1}" | tail -1)',
		'if [ -n "$RDEV" ]; then say disk.root.device "$RDEV"; else unk disk.root.device "could not resolve a physical device behind ${RSRC:-an unreadable root source}"; fi',
		// ── the `_work` filesystem — wave 4c §F, the operator's disk ask ──────
		//
		// The SAME directory `ephemeral-tick.ts`'s own space probe targets
		// (`~/.hadoku/jit`, falling back to `~/.hadoku` then `$HOME` — a node that
		// has never minted has no `jit` directory yet, and that absence is not
		// "unreadable"). Reported here as DATA, never a gate — `disk-watch.ts`
		// owns the early-warning judgement on this same filesystem, on its own
		// absolute-GB lines; doctor still judges `/` on the existing percentage
		// rule and, below, judges `_work` the same way ONLY when it is a
		// genuinely DIFFERENT filesystem from `/` — on most of this fleet today
		// it is the same device, and double-reporting one full disk as two
		// findings would be noise, not signal.
		// ONE spelling of the node's fleet directory in this probe — same move,
		// same reason, as `ci-throttle-install.sh`'s and `clean-runner-debris.sh`'s
		// own `NODE_DIR` (ecosystem-literals.test.mjs's WAVE 4B LANE C entry): a
		// script running ON a node must name it once and cannot resolve it from
		// the controller's environment, because there is no controller
		// environment to read at the point this probe runs.
		'NODE_DIR="$HOME/.hadoku"',
		'WORKDIR="$NODE_DIR/jit"',
		'[ -d "$WORKDIR" ] || WORKDIR="$NODE_DIR"',
		'[ -d "$WORKDIR" ] || WORKDIR="$HOME"',
		'say disk.work.fs "$(findmnt -no FSTYPE --target "$WORKDIR" 2>/dev/null)"',
		'say disk.work.totalKb "$(df -P "$WORKDIR" | awk "NR==2{print \\$2}")"',
		'say disk.work.availKb "$(df -P "$WORKDIR" | awk "NR==2{print \\$4}")"',
		// THREE-STATE, not yes/no: `$RSRC`/`$WSRC` unreadable must read as
		// "unknown", never collapse into "different" — that would draw a second
		// disk-free finding for a disk doctor never actually distinguished from
		// root.
		'WSRC=$(findmnt -no SOURCE --target "$WORKDIR" 2>/dev/null)',
		'if [ -z "$WSRC" ] || [ -z "$RSRC" ]; then say disk.work.sameAsRoot unknown',
		'elif [ "$WSRC" = "$RSRC" ]; then say disk.work.sameAsRoot yes',
		'else say disk.work.sameAsRoot no; fi',
		// ── where the space went: the known large consumers, read-only `du -sk`
		//
		// `sizeKb` reports 0 for a directory that does not exist — a node that
		// never earned a capability, never minted, or never built a pnpm package
		// has no cache for it, and that is a fact about the node, not a read
		// failure. It only emits `U` (via `say`'s own empty-string rule) if `du`
		// itself produced nothing for a directory that DOES exist, which is the
		// actual "could not look" case.
		'sizeKb() { if [ -d "$1" ]; then command du -sk "$1" 2>/dev/null | tail -1 | cut -f1; else echo 0; fi; }',
		'say consumer.jitKb "$(sizeKb "$NODE_DIR/jit")"',
		'say consumer.warmKb "$(sizeKb "$NODE_DIR/warm")"',
		'say consumer.cacheKb "$(sizeKb "$HOME/.cache")"',
		// NEVER TRUST `pnpm store path` ALONE — `pnpm-store-doctor.sh` already
		// measured it reporting `.../store/v10` while `v11` is the store actually
		// in use on this fleet. Same resolution that script uses: look for what
		// EXISTS beside the reported path, newest version first.
		'PSTORE_REPORTED=$(pnpm store path 2>/dev/null | tail -1)',
		'PSTORE=""',
		'if [ -n "$PSTORE_REPORTED" ] && [ -d "$PSTORE_REPORTED" ]; then',
		'  PSTORE="$PSTORE_REPORTED"',
		'elif [ -n "$PSTORE_REPORTED" ]; then',
		'  PROOT="${PSTORE_REPORTED%/*}"',
		'  for cand in $(ls -d "$PROOT"/v* 2>/dev/null | sort -V -r); do [ -d "$cand/files" ] && PSTORE="$cand" && break; done',
		'fi',
		'if [ -n "$PSTORE" ]; then say consumer.pnpmStoreKb "$(sizeKb "$PSTORE")"; else unk consumer.pnpmStoreKb "pnpm store path produced nothing this run could resolve to an existing directory"; fi',
		// Seed caches (wave 4c §E): one `D`/`U` line per DECLARED cache path, keyed
		// by the path itself so a reader never has to re-derive which capability it
		// belonged to from an index. Absent `seedCachePaths` emits nothing — no
		// `$seeds` in the manifest is "no seed caches", never an error.
		...seedCachePaths
			.filter((p) => SAFE_CACHE_PATH.test(p))
			.map((p) => `say 'consumer.seed|${p}' "$(sizeKb "$HOME/${p.slice(2)}")"`),
		// ── SMART, from the drive's firmware, with the reason when it cannot ──
		// Scoped to the ROOT device on purpose. claw-4 carries four empty USB
		// card-reader slots (sdc..sdf) that answer "Unknown USB bridge" forever;
		// a per-/sys/block sweep would emit four permanent unreadable findings
		// per run on a node whose actual disks are both fine, which is how a
		// findings list stops being read.
		'if [ -z "$RDEV" ]; then unk smart "the root block device could not be resolved, so no drive was queried"',
		'elif [ ! -x /usr/sbin/smartctl ]; then unk smart "smartctl is not installed on this node (/usr/sbin/smartctl absent); it is in both node profiles toolchain.packages"',
		'elif [ "$ROOTOK" != yes ]; then unk smart "reading SMART needs root and sudo -n was refused on this node"',
		'else',
		'  say smart.device "$RDEV"',
		'  SOUT=$($SUDO /usr/sbin/smartctl -H -A "/dev/$RDEV" 2>&1)',
		'  if [ -n "$SOUT" ]; then printf "%s\\n" "$SOUT" | sed "s/^/S /"; else unk smart "smartctl produced no output at all for /dev/$RDEV"; fi',
		'fi',
		// ── staged reboot. Same file and shape `preflight.mjs` already judges. ─
		'if [ -f /var/run/reboot-required ]; then',
		'  say reboot.required yes',
		'  say reboot.stagedAtEpoch "$(stat -c %Y /var/run/reboot-required 2>/dev/null)"',
		'  if [ -f /var/run/reboot-required.pkgs ]; then say reboot.packages "$(tr "\\n" "," < /var/run/reboot-required.pkgs | sed "s/,$//")"; fi',
		'else say reboot.required no; fi',
		// ── CI registrations, and whether this box is working right now ───────
		'say runners.registered "$(systemctl list-units "actions.runner.*" --no-pager --plain 2>/dev/null | grep -c running)"',
		'say runners.failed "$(systemctl list-units "actions.runner.*" --state=failed --no-pager --plain 2>/dev/null | grep -c failed)"',
		'BUSY=$(pgrep -c -f "[R]unner\\.Worker" 2>/dev/null | head -1)',
		'BUSY=${BUSY:-0}',
		'say runners.busy "$BUSY"',
		// ── every failed system unit, and since when ──────────────────────────
		//
		// Not just `actions.runner.*`. claw-5 and claw-6 failed
		// systemd-networkd-wait-online on EVERY boot from their 2026-08-31/09-01
		// install until 10-27 — a preseed-era networkd config for a radio neither
		// box has, costing each boot two minutes — and `fleet benchmark` printed
		// `failed units: 1` for claw-6 on 10-04 without anything turning it into
		// a finding. The timestamp is what tells a leftover from something new.
		// A COUNTED zero is emitted as 0; a systemctl that cannot list is `U`.
		'if FU=$(systemctl list-units --state=failed --no-legend --no-pager --plain 2>/dev/null); then',
		'  say failedUnits.count "$(printf "%s\\n" "$FU" | grep -c .)"',
		'  for u in $(printf "%s\\n" "$FU" | awk "NF{print \\$1}"); do',
		'    say "failedUnit.$u" "$(systemctl show -P StateChangeTimestamp --timestamp=unix "$u" 2>/dev/null | tr -d @)"',
		'  done',
		'else unk failedUnits "systemctl could not list this node\'s units"; fi',
		// ── every pm2 manager, its ceiling and how many apps it runs ─────────────
		//
		// Claimed against the tenant registry and the app layer's host list by
		// doctor-run (lib/hosting-claims.mjs); the node only measures. The app
		// count is the daemon's direct children, from the kernel: pm2's own list
		// also carries stopped apps, and an "idle" manager is one RUNNING none.
		"if PU=$(systemctl list-units --no-legend --plain 'pm2-*.service' 2>/dev/null); then",
		'  say pm2Units.count "$(printf "%s\\n" "$PU" | grep -c .)"',
		'  for u in $(printf "%s\\n" "$PU" | awk "NF{print \\$1}"); do',
		'    cg=$(systemctl show -P ControlGroup "$u" 2>/dev/null); m=$(systemctl show -P MainPID "$u" 2>/dev/null)',
		'    if [ "${m:-0}" -gt 0 ] 2>/dev/null; then a=$(ps --ppid "$m" --no-headers 2>/dev/null | wc -l); else a=U; fi',
		'    say "pm2Unit.$u" "$(cat "/sys/fs/cgroup$cg/memory.max" 2>/dev/null || echo U) $a"',
		'  done',
		'else unk pm2Units "systemctl could not list this node\'s pm2 units"; fi',
		'if E=$(journalctl -b 0 -p err --no-pager 2>/dev/null); then say errorsThisBoot "$(printf "%s\\n" "$E" | grep -vcE "ACPI|Bluetooth")"; else unk errorsThisBoot "the journal could not be read by this user"; fi',
		// ── which stack owns the radio. node-interfaces.mjs owns the question. ─
		//
		// IN A SUBSHELL, and that is not style. `WIFI_MANAGER_PROBE` is one
		// `;`-joined string ending in `exit 0` — correct when it is the whole
		// remote command, fatal when it is a stanza of a longer one. Inlined bare,
		// it ended the probe: every node reported its wifi and then nothing, no
		// `DOCTOR-END`, and the run read as UNREACHABLE on a box that had just
		// answered 60 lines. Caught by executing it, not by reading it.
		`( ${WIFI_MANAGER_PROBE} )`,
		'RADIO=',
		'for d in /sys/class/net/*/wireless; do [ -e "$d" ] || continue; RADIO=$(basename "$(dirname "$d")"); break; done',
		'if [ -n "$RADIO" ]; then',
		'  say wifi.iface "$RADIO"',
		'  say wifi.operstate "$(cat "/sys/class/net/$RADIO/operstate" 2>/dev/null)"',
		'  say wifi.carrier "$(cat "/sys/class/net/$RADIO/carrier" 2>/dev/null)"',
		'  if [ -x /sbin/iw ]; then',
		'    L=$(/sbin/iw dev "$RADIO" link 2>/dev/null)',
		'    say wifi.ssid "$(printf "%s\\n" "$L" | awk -F"SSID: " "/SSID: /{print \\$2; exit}")"',
		'    say wifi.signalDbm "$(printf "%s\\n" "$L" | awk "/signal:/{print \\$2; exit}")"',
		'    say wifi.freqMhz "$(printf "%s\\n" "$L" | awk "/freq:/{print \\$2; exit}")"',
		'  else unk wifi.link "iw is not installed on this node, so the radio cannot be asked for its SSID or signal"; fi',
		'fi',
		// ── the load phase: a FIXED 60s, all cores, and the peak of every sensor
		secs > 0
			? [
					`LOADSECS=${secs}`,
					`FORCE=${force ? 1 : 0}`,
					'if [ "$BUSY" -gt 0 ] && [ "$FORCE" != 1 ]; then',
					'  unk load "CI was building here ($BUSY worker(s)) — loading the box would slow a consumer\'s job and skew the reading. Re-run with --force, or when the node is idle."',
					'else',
					'  say load.seconds "$LOADSECS"',
					'  NPROC=$(grep -c ^processor /proc/cpuinfo)',
					'  say load.workers "$NPROC"',
					'  say load.throttleBefore "$(throttles)"',
					'  i=0; while [ "$i" -lt "$NPROC" ]; do (timeout "$LOADSECS" sha512sum /dev/zero >/dev/null 2>&1) & i=$((i+1)); done',
					'  declare -A PEAK',
					'  sample() { while read -r k v; do cur=${PEAK[$k]:-0}; if [ "$v" -gt "$cur" ] 2>/dev/null; then PEAK[$k]=$v; fi; done < <(sensors); }',
					'  END=$(( $(date +%s) + LOADSECS ))',
					'  while [ "$(date +%s)" -lt "$END" ]; do sample; sleep 3; done',
					'  wait 2>/dev/null',
					'  sample',
					'  for k in "${!PEAK[@]}"; do printf "D peak.%s %s\\n" "$k" "${PEAK[$k]}"; done',
					'  say load.throttleAfter "$(throttles)"',
					'  say load.finishedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
					'fi',
				].join('\n')
			: `unk load ${JSON.stringify(noLoadWhy)}`,
		'echo "DOCTOR-END $(cat /proc/sys/kernel/hostname 2>/dev/null)"',
	].join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// PARSING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Split {@link doctorProbe}'s stdout into facts, unknowns and smartctl lines.
 *
 * @param {string} out
 * @returns {{complete: boolean, facts: Record<string,string>,
 *            unknown: Record<string,string>, smart: string[], wifiRaw: string}}
 */
export function parseDoctor(out) {
	const text = String(out ?? '');
	const facts = {};
	const unknown = {};
	const smart = [];
	for (const line of text.split('\n')) {
		const m = /^([DUS]) (.*)$/.exec(line.replace(/\r$/, ''));
		if (!m) continue;
		if (m[1] === 'S') {
			smart.push(m[2]);
			continue;
		}
		const kv = /^(\S+) ?(.*)$/.exec(m[2]);
		if (!kv) continue;
		(m[1] === 'D' ? facts : unknown)[kv[1]] = kv[2].trim();
	}
	return {
		complete: /^DOCTOR-END /m.test(text),
		facts,
		unknown,
		smart,
		wifiRaw: text,
	};
}

/** Keys that name a temperature sensor, in the order a die reading is preferred. */
const DIE_SENSORS = [
	/^hwmon\.\d+\.coretemp\.Package_id_0$/,
	/^zone\.\d+\.x86_pkg_temp$/,
	/^hwmon\.\d+\.k10temp\.Tccd1$/,
	/^hwmon\.\d+\.k10temp\.Tctl$/,
	// An UNLABELLED k10temp. Family 15h (claw-5's FX-8350) exposes one
	// `temp1_input` and no label at all, so the only name it can be given is the
	// sysfs node's own. Last of the k10temp entries because a labelled Tccd1 is a
	// better answer wherever one exists.
	/^hwmon\.\d+\.k10temp\.temp\d+$/,
	/^hwmon\.\d+\.coretemp\.Core_0$/,
];

/**
 * Which sensor key IS this node's CPU die, or null.
 *
 * A FIXED PREFERENCE ORDER OVER THE KEYS THE NODE EMITTED — never the maximum,
 * and never a guess from the hottest reading. See the file header for the
 * measurement that makes this load-bearing. Intel boxes answer on
 * `coretemp`/`x86_pkg_temp` (every claw); AMD answers on `k10temp`, where
 * `Tccd1` is the die and `Tctl` is a control value that may carry a vendor
 * offset, so the die is preferred when both exist (hokon emits both).
 *
 * @param {string[]} sensorKeys keys WITHOUT the `idle.`/`peak.` prefix
 */
export function cpuSensor(sensorKeys) {
	for (const re of DIE_SENSORS) {
		const hit = sensorKeys.find((k) => re.test(k));
		if (hit) return hit;
	}
	return null;
}

/** `hwmon.<chip>.<driver>.<channel>` for a CPU sensor, else no match. */
const CPU_SENSOR_KEY = /^hwmon\.(\d+)\.(coretemp|k10temp)\.(.+)$/;

/**
 * The sensors that can vouch for the die sensor: OTHER readings of the same
 * physical package, on the same chip — the per-core sensors for `coretemp`,
 * the sibling channels (`Tctl` beside `Tccd1`, …) for `k10temp`.
 *
 * THIS IS THE "independent readings" HALF OF THE TRACKING RULE, and its two
 * exclusions are both load-bearing:
 *
 *   - A sensor on another DEVICE never vouches for the die. claw-5's `nouveau`
 *     reads a GPU 20 °C above its FX-8350 and moved +0 °C under the CPU load;
 *     treating it as the reference would hand a stuck k10temp a GPU's stillness
 *     as agreement. Only `coretemp`/`k10temp` channels on the die's OWN chip
 *     are counted, and a `zone.` die key (an `x86_pkg_temp` with no coretemp
 *     beside it, say) answers none at all — no per-core zone readings exist.
 *   - For `coretemp`, a second socket's `Package_id_1` never vouches for this
 *     socket: under a load pinned to one socket it cannot move with this die,
 *     and as a "reference" it could only drag the median down and loosen the
 *     rule. A core is vouched for by its siblings and its own package; a
 *     package by its cores.
 *
 * Not independent of the die sensor's DRIVER, and deliberately so: a driver
 * that froze every channel it owns freezes die and references together, which
 * is the `nothing-moved-under-load` case in {@link doctorFindings} and stays
 * BLOCKING. The independence that matters is of the physical sensor elements,
 * which is what "the per-core sensors" means.
 *
 * @param {string} dieKey the {@link cpuSensor} pick, WITHOUT the idle./peak.
 *   prefix
 * @param {string[]} sensorKeys keys WITHOUT the prefix, typically the idle set
 * @returns {string[]} the subset of `sensorKeys` that can vouch for `dieKey`
 */
export function independentCpuSensors(dieKey, sensorKeys) {
	const die = CPU_SENSOR_KEY.exec(String(dieKey ?? ''));
	if (!die) return [];
	const [, chip, driver, dieChannel] = die;
	const dieIsCore = /^Core_\d+$/.test(dieChannel);
	return sensorKeys.filter((k) => {
		if (k === dieKey) return false;
		const s = CPU_SENSOR_KEY.exec(k);
		if (!s || s[1] !== chip || s[2] !== driver) return false;
		if (driver === 'k10temp') return true;
		if (dieIsCore) return /^(Core_\d+|Package_id_\d+)$/.test(s[3]);
		return /^Core_\d+$/.test(s[3]);
	});
}

/**
 * Keys the shell's `sensors()` emits. ANYTHING ELSE UNDER THE SAME PREFIX IS NOT
 * A SENSOR — `idle.throttleCount` shares the `idle.` prefix and is a lifetime
 * event counter, and a prefix-only filter read it as a 2,022,029 milli-degree
 * sensor and raised "throttleCount read 2022 °C while the die read 61 °C" on a
 * healthy claw-1. Caught by running it against the real node.
 */
const SENSOR_KEY = /^(zone\.\d+\.|hwmon\.\d+\.)/;

/** `{ key: celsius }` for one prefix, from raw milli-degree facts. */
function sensorMap(facts, prefix) {
	const out = {};
	for (const [k, v] of Object.entries(facts)) {
		if (!k.startsWith(prefix)) continue;
		const key = k.slice(prefix.length);
		if (!SENSOR_KEY.test(key)) continue;
		const milli = Number(v);
		if (!Number.isFinite(milli)) continue;
		out[key] = Math.round(milli / 1000);
	}
	return out;
}

/**
 * Power-on hours, temperature and the health verdict out of `smartctl -H -A`.
 *
 * BOTH TABLE SHAPES, because the fleet runs both. A SATA drive answers with the
 * numbered attribute table (`9 Power_On_Hours … RAW_VALUE`) and an NVMe answers
 * with the key/value SMART log (`Power On Hours: 91,529`) — `stress-node.sh`
 * branches on the literal string `NVMe Log` for the same reason. The NVMe
 * numbers are thousands-separated, hence the digit strip; the SATA raw value can
 * carry a parenthesised tail (`39 (Min/Max 8/50)`), hence the leading-integer
 * parse rather than a whole-field number.
 *
 * `health: null` with a `reason` is NOT `health: 'PASSED'`. A drive behind a USB
 * bridge answers "Unknown USB bridge … specify device type", which is a refusal,
 * and reading a refusal as a pass is the inversion this whole file exists against.
 *
 * @param {string[]} lines the `S `-prefixed lines, already stripped
 */
export function parseSmart(lines) {
	const text = (lines ?? []).join('\n');
	const res = {
		health: null,
		powerOnHours: null,
		temperatureC: null,
		reallocated: null,
		pendingSectors: null,
		lifetimeRemainingPct: null,
		model: null,
		reason: null,
	};
	if (!text.trim()) {
		res.reason = 'smartctl returned nothing';
		return res;
	}
	const nvme = /NVMe Log/.test(text);
	const health = /(?:overall-health self-assessment test result|SMART Health Status):\s*(\S+)/.exec(
		text
	);
	if (health) res.health = health[1];

	const intOf = (s) => {
		const m = /^\s*(\d[\d,]*)/.exec(String(s ?? ''));
		return m ? Number(m[1].replace(/,/g, '')) : null;
	};
	/**
	 * RAW_VALUE column of a numbered SATA attribute row.
	 *
	 * BY FIELD INDEX, NOT BY REGEX. The table is
	 * `ID# NAME FLAG VALUE WORST THRESH TYPE UPDATED WHEN_FAILED RAW_VALUE`, so
	 * RAW_VALUE is field 10 — which is what `stress-node.sh` reads as awk's `$10`.
	 * A lazy regex over the row picked the NORMALISED value instead and reported
	 * claw-1's 19,727-hour drive as 55 hours and its 40 °C as 150 °C, both of
	 * which are the normalised columns. RAW_VALUE can carry a tail (`40 (Min/Max
	 * 8/50)`, `0 0 0`), so the rest of the row is joined and the leading integer
	 * taken.
	 */
	const attr = (name) => {
		for (const line of text.split('\n')) {
			const fields = line.trim().split(/\s+/);
			if (!/^\d+$/.test(fields[0]) || fields[1] !== name) continue;
			return intOf(fields.slice(9).join(' '));
		}
		return null;
	};
	/** `Key: value` out of the NVMe SMART log. */
	const kv = (name) => {
		const m = new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(text);
		return m ? intOf(m[1]) : null;
	};

	if (nvme) {
		res.powerOnHours = kv('Power On Hours');
		res.temperatureC = kv('Temperature');
		res.lifetimeRemainingPct = (() => {
			const used = kv('Percentage Used');
			return used === null ? null : 100 - used;
		})();
		res.reallocated = kv('Media and Data Integrity Errors');
		res.pendingSectors = null;
	} else {
		res.powerOnHours = attr('Power_On_Hours');
		res.temperatureC = attr('Temperature_Celsius') ?? attr('Airflow_Temperature_Cel');
		res.reallocated = attr('Reallocated_Sector_Ct') ?? attr('Reallocate_NAND_Blk_Cnt');
		res.pendingSectors = attr('Current_Pending_Sector') ?? attr('Current_Pending_ECC_Cnt');
		// BOTH SPELLINGS CARRY PERCENT *USED* IN THE RAW COLUMN, whatever the
		// attribute is called. Verified on claw-7's Crucial MX100:
		// `202 Percent_Lifetime_Remain … VALUE 067 … RAW 33` — 67 normalised,
		// 33 raw, summing to 100, so the raw column is the used half and the
		// attribute NAME is about the normalised column. Intel/Samsung's
		// `Percentage_Used` says used outright. One formula, not two.
		const usedPct = attr('Percent_Lifetime_Remain') ?? attr('Percentage_Used');
		res.lifetimeRemainingPct = usedPct === null ? null : 100 - usedPct;
	}
	if (res.health === null) {
		const refusal = /^(\/dev\/\S+:\s*.+)$/m.exec(text);
		res.reason = refusal
			? `the drive did not answer SMART: ${refusal[1]}`
			: 'smartctl output carried no overall-health line';
	}
	return res;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE FACET
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The `bootcamp` pointer: `$capabilities`' verdict and age, labelled as such.
 *
 * NOT EVIDENCE DOCTOR GATHERED — `from` says so, so no reader can mistake it
 * for a health measurement, and the inventory page can show the two ages side
 * by side.
 *
 * WHY IT IS NO LONGER STORED (Wave 3h). `$health` moved to the state dir and
 * `$capabilities` stayed in the manifest, so a stored copy of this pointer would
 * be a cross-tree read frozen at write time: a stale `health.json` would carry a
 * verdict the manifest has since changed, and a fresh one would look as if it
 * vouched for a `$capabilities` it only copied. S's rule
 * (`measured-facets-home-2026-09-16.md` §2.5) is that a facet pointing at
 * another moves in the same step as its target or the pointer is dropped. It is
 * dropped from the RECORD ({@link healthRecord}) and re-derived from the
 * CURRENT manifest every time a record is read, so the verdict shown is always
 * the one the manifest holds now.
 */
export function bootcampPointer(capabilities) {
	return capabilities
		? {
				from: '$capabilities',
				at: capabilities.at ?? null,
				by: capabilities.by ?? null,
				verdict:
					(capabilities.unearned?.length ?? 0) || (capabilities.blocked?.length ?? 0)
						? 'FAILS'
						: 'PASSES',
				earned: capabilities.earned ?? [],
				unearned: (capabilities.unearned ?? []).map((u) => u.id ?? u),
				blocked: (capabilities.blocked ?? []).map((b) => b.id ?? b),
				unprobed: capabilities.unprobed ?? [],
			}
		: { from: '$capabilities', at: null, why: 'this node carries no $capabilities record yet' };
}

/**
 * What `fleet doctor --write` STORES: the facet minus its `bootcamp` pointer and
 * its `pm2Claims`. See {@link bootcampPointer} for why both are re-derived on
 * read instead: each is a join against records that move without the node.
 */
export function healthRecord(health) {
	return Object.fromEntries(
		Object.entries(health).filter(([k]) => k !== 'bootcamp' && k !== 'pm2Claims')
	);
}

/**
 * The `_work` filesystem, ONLY when `doctorProbe`'s own three-state source
 * comparison positively says it differs from `/` — see that probe's comment.
 * `null` for both "same disk" and "could not tell": a reader that wants to
 * know which of those it was can still read `facts['disk.work.sameAsRoot']`
 * off the raw probe, but `$health.disk.work` itself stays a single "is there
 * something else to report" answer.
 *
 * @param {Record<string,string>} facts
 * @param {Record<string,string>} unknown
 */
function workDisk(facts, unknown) {
	if (facts['disk.work.sameAsRoot'] !== 'no') return null;
	const totalKb =
		facts['disk.work.totalKb'] === undefined ? null : Number(facts['disk.work.totalKb']);
	const availKb =
		facts['disk.work.availKb'] === undefined ? null : Number(facts['disk.work.availKb']);
	return {
		fs: facts['disk.work.fs'] ?? null,
		totalKb,
		availKb,
		freePct:
			totalKb && availKb !== null && totalKb > 0
				? Math.round((availKb / totalKb) * 1000) / 10
				: null,
		why: unknown['disk.work.availKb'] ?? null,
	};
}

/** Prefix `doctorProbe` gives every seed-cache fact/unknown line, keyed by the
 *  cache path itself — see that probe's own comment. */
const SEED_CONSUMER_PREFIX = 'consumer.seed|';

/**
 * The known large consumers of `_work`/`$HOME` space — wave 4c §F, "doctor
 * reports where the space went". Every size is KiB (`du -sk`'s own unit,
 * carried through unconverted so a reader comparing against `df`'s KiB
 * columns never has to convert). A consumer whose directory does not exist is
 * `0`, not `null` and not a `why` — that is a fact about the node (it never
 * earned the capability, never minted, never built a pnpm package), not a
 * read failure. `why` is only set when `du` itself failed against a directory
 * that DOES exist.
 *
 * @param {Record<string,string>} facts
 * @param {Record<string,string>} unknown
 */
function diskConsumers(facts, unknown) {
	const kb = (k) => (facts[k] === undefined ? null : Number(facts[k]));
	const seeds = [];
	for (const key of Object.keys(facts)) {
		if (!key.startsWith(SEED_CONSUMER_PREFIX)) continue;
		seeds.push({ cache: key.slice(SEED_CONSUMER_PREFIX.length), kb: Number(facts[key]) });
	}
	for (const key of Object.keys(unknown)) {
		if (!key.startsWith(SEED_CONSUMER_PREFIX)) continue;
		seeds.push({ cache: key.slice(SEED_CONSUMER_PREFIX.length), kb: null, why: unknown[key] });
	}
	seeds.sort((a, b) => a.cache.localeCompare(b.cache));
	return {
		jitKb: kb('consumer.jitKb'),
		warmKb: kb('consumer.warmKb'),
		cacheKb: kb('consumer.cacheKb'),
		pnpmStoreKb: kb('consumer.pnpmStoreKb'),
		pnpmStoreWhy: unknown['consumer.pnpmStoreKb'] ?? null,
		seeds,
	};
}

/**
 * Build `machines[node].$health` — the fourth `{at, by, …}` sibling facet.
 *
 * Shaped to match `$benchmark` / `$capabilities` / `$measured` exactly: a flat
 * `{at, by, …}` block written straight onto the node's entry, never nested
 * under a `$supply` parent. `supply-ledger-2026-09-07.md` records WHY that
 * choice was made (the two producers that already existed had picked it in
 * production, and renaming `$measured` is a migration this repo does not own),
 * and its closing instruction is verbatim: "Whoever builds … a `health` writer
 * should add `$enrollment` / `$health` the same way: a sibling key on
 * `machines[node]`, `{at, by, …}`."
 *
 * @param {{node: string, probe: ReturnType<parseDoctor>, reachable?: boolean,
 *          unreachableReason?: string|null, capabilities?: object|null,
 *          at?: string, by?: string}} args
 */
export function healthFacet({
	node,
	probe,
	reachable = true,
	unreachableReason = null,
	capabilities = null,
	at = new Date().toISOString(),
	by = 'fleet doctor',
}) {
	const base = { at, by, node };
	if (!reachable || !probe?.complete) {
		return {
			...base,
			reachable: false,
			why:
				unreachableReason ??
				'the probe never printed DOCTOR-END — the node stopped answering partway through, ' +
					'which is silence and not an empty result',
		};
	}
	const { facts, unknown, smart } = probe;
	const idle = sensorMap(facts, 'idle.');
	const peak = sensorMap(facts, 'peak.');
	const die = cpuSensor(Object.keys(idle));
	const num = (k) => (facts[k] === undefined ? null : Number(facts[k]));
	const totalKb = num('disk.root.totalKb');
	const availKb = num('disk.root.availKb');
	const wifi = parseWifiManager(probe.wifiRaw ?? '');
	const smartRead = parseSmart(smart);

	// The die sensor, named, plus every other sensor beside it. `loadC: null`
	// with a reason is the "I could not look" case and it carries the reason the
	// node gave (a busy box, --no-load, no readable sensor at all).
	//
	// `idleC` IS THE READING TAKEN BEFORE THE LOAD PHASE, which is only idle when
	// `runners.busy` is 0 — read the two together. claw-1 recorded `idleC: 96`
	// while serving one JIT job, and 61 °C twenty minutes earlier with none. The
	// field keeps the conventional name (`stress-node.sh` calls its own
	// `baseline.thermalC`) rather than being renamed to hide the caveat.
	const thermal = {
		sensor: die,
		idleC: die ? (idle[die] ?? null) : null,
		loadC: die ? (peak[die] ?? null) : null,
		riseC: die && idle[die] !== undefined && peak[die] !== undefined ? peak[die] - idle[die] : null,
		loadSeconds: num('load.seconds'),
		loadWorkers: num('load.workers'),
		throttleEvents:
			facts['load.throttleAfter'] !== undefined && facts['load.throttleBefore'] !== undefined
				? num('load.throttleAfter') - num('load.throttleBefore')
				: null,
		throttleTotal: num('idle.throttleCount'),
		idleSensors: idle,
		loadSensors: peak,
		why: die
			? null
			: (unknown['idle.sensors'] ??
				`no sensor in ${JSON.stringify(Object.keys(idle))} is a recognised CPU die sensor`),
		loadWhy: unknown.load ?? null,
	};

	return {
		...base,
		reachable: true,
		hostname: facts.hostname ?? null,
		product: facts.product ?? null,
		kernel: facts.kernel ?? null,
		uptimeSec: num('uptimeSec'),
		cores: num('cores'),
		load1: facts.load1 === undefined ? null : Number(facts.load1),
		rootElevation: facts.rootElevation ?? null,
		thermal,
		smart: {
			device: facts['smart.device'] ?? null,
			health: smartRead.health,
			powerOnHours: smartRead.powerOnHours,
			temperatureC: smartRead.temperatureC,
			reallocated: smartRead.reallocated,
			pendingSectors: smartRead.pendingSectors,
			lifetimeRemainingPct: smartRead.lifetimeRemainingPct,
			why: unknown.smart ?? smartRead.reason,
		},
		disk: {
			device: facts['disk.root.device'] ?? null,
			fs: facts['disk.root.fs'] ?? null,
			totalKb,
			availKb,
			freePct:
				totalKb && availKb !== null && totalKb > 0
					? Math.round((availKb / totalKb) * 1000) / 10
					: null,
			usePct: num('disk.root.usePct'),
			why: unknown['disk.root.device'] ?? unknown['disk.root.availKb'] ?? null,
			// `_work` (wave 4c §F) — ONLY when it is a filesystem DIFFERENT from `/`.
			// `disk.work.sameAsRoot` is three-state (`yes`/`no`/`unknown`, never a
			// bare boolean read off an absence); `null` here covers BOTH "same disk"
			// and "could not tell", on purpose — see the probe's own comment for why
			// guessing "different" on an unreadable source would double-report one
			// disk as two findings.
			work: workDisk(facts, unknown),
			consumers: diskConsumers(facts, unknown),
		},
		memory: { totalKb: num('mem.totalKb'), availKb: num('mem.availKb') },
		network: {
			wifiManager: wifi.manager,
			wifiReason: wifi.reason,
			radio: wifi.radio,
			nmState: wifi.nmState,
			nmConnection: wifi.nmConnection,
			ifupdownHolds: wifi.ifupdownHolds,
			operstate: facts['wifi.operstate'] ?? null,
			carrier: facts['wifi.carrier'] === undefined ? null : Number(facts['wifi.carrier']),
			ssid: facts['wifi.ssid'] ?? null,
			signalDbm: facts['wifi.signalDbm'] === undefined ? null : Number(facts['wifi.signalDbm']),
			freqMhz: facts['wifi.freqMhz'] === undefined ? null : Number(facts['wifi.freqMhz']),
			why: unknown['wifi.link'] ?? null,
		},
		reboot: {
			required: facts['reboot.required'] === 'yes',
			stagedAt:
				facts['reboot.stagedAtEpoch'] === undefined
					? null
					: new Date(Number(facts['reboot.stagedAtEpoch']) * 1000).toISOString(),
			packages: facts['reboot.packages'] ? facts['reboot.packages'].split(',').filter(Boolean) : [],
		},
		watchdog: {
			active: facts['watchdog.active'] ?? null,
			enabled: facts['watchdog.enabled'] ?? null,
			keepalive: facts['watchdog.keepalive'] ?? null,
			maxLoad1:
				facts['watchdog.maxLoad1'] === undefined ? null : Number(facts['watchdog.maxLoad1']),
			sensorPath: facts['watchdog.sensorPath'] ?? null,
			sensorC:
				facts['watchdog.sensorMilliC'] === undefined
					? null
					: Math.round(Number(facts['watchdog.sensorMilliC']) / 1000),
			why: unknown['watchdog.conf'] ?? unknown['watchdog.sensorPath'] ?? null,
		},
		runners: {
			registered: num('runners.registered'),
			failed: num('runners.failed'),
			busy: num('runners.busy'),
		},
		failedUnits: failedUnits(facts, unknown),
		pm2Units: pm2Units(facts, unknown),
		crashes: num('crashes'),
		errorsThisBoot: num('errorsThisBoot'),
		// A POINTER AT ANOTHER FACET, NOT EVIDENCE DOCTOR GATHERED. See the file
		// header and {@link bootcampPointer}.
		bootcamp: bootcampPointer(capabilities),
	};
}

/**
 * The probe's failed system units, each with when it entered that state.
 *
 * `units: null` with a `why` is "could not look"; `units: []` is a counted
 * zero. A unit whose timestamp the node did not give keeps `since: null`
 * rather than being dropped — the unit is the finding, the time is detail.
 *
 * @returns {{units: {unit: string, since: string|null}[]|null, why: string|null}}
 */
function failedUnits(facts, unknown) {
	if (facts['failedUnits.count'] === undefined) {
		return {
			units: null,
			why:
				unknown.failedUnits ?? unknown['failedUnits.count'] ?? 'the probe reported no unit count',
		};
	}
	const names = new Set(
		[...Object.keys(facts), ...Object.keys(unknown)]
			.filter((k) => k.startsWith('failedUnit.'))
			.map((k) => k.slice('failedUnit.'.length))
	);
	const units = [...names].sort().map((unit) => {
		const epoch = Number(facts[`failedUnit.${unit}`]);
		return {
			unit,
			since: Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000).toISOString() : null,
		};
	});
	return { units, why: null };
}

/**
 * The probe's pm2 managers: `bounded` from the unit's own cgroup ceiling,
 * `apps` the daemon's running children (null: not counted).
 *
 * `units: null` with a `why` is "could not look"; `units: []` is a counted zero.
 *
 * @returns {{units: {unit: string, bounded: boolean, apps: number|null}[]|null, why: string|null}}
 */
function pm2Units(facts, unknown) {
	if (facts['pm2Units.count'] === undefined) {
		return {
			units: null,
			why: unknown.pm2Units ?? unknown['pm2Units.count'] ?? 'the probe reported no pm2 unit count',
		};
	}
	const units = Object.keys(facts)
		.filter((k) => k.startsWith('pm2Unit.'))
		.sort()
		.map((k) => {
			const [max, apps] = facts[k].split(/\s+/);
			return {
				unit: k.slice('pm2Unit.'.length),
				// An unreadable ceiling is NOT a ceiling: `U` reads as unbounded.
				bounded: /^\d+$/.test(max ?? ''),
				apps: /^\d+$/.test(apps ?? '') ? Number(apps) : null,
			};
		});
	return { units, why: null };
}

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
