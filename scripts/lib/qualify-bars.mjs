/**
 * The qualification BARS and how long a result stands (wave bootcamp2,
 * operator-approved 2026-11-11). Pure constants, in the config layer, so both
 * the tests that judge against them (lifecycle) and doctor, which reports a
 * qualification's verdict beside the live limit (observation), read the SAME
 * numbers without either importing the other. qualify-registry.mjs re-exports
 * them for the test modules.
 */

/**
 * The bars, decided by the operator on 2026-11-11 ("1. and 4. are both fine").
 * A test reads the bar from here, never from a literal of its own, so the
 * ceiling has one home.
 */
export const QUALIFY_BARS = Object.freeze({
	/**
	 * CPU pressure (avg300 `cpu some`, %) at the 90th percentile of a ramp step.
	 * 20 is doctor's own oversubscription line (doctor-findings-cpu.mjs): at or
	 * above it every job on the node runs measurably slower.
	 */
	cpuPressureP90Pct: 20,
	/**
	 * Package temperature, °C. Doctor's advisory line (THERMAL_ADVISORY_C):
	 * between 90 and the 100 °C trip a part boosts to its own limit, and
	 * claw-1/claw-3 paged nightly at 97–98 °C before their ceiling was cut to 1.
	 */
	packageTempC: 90,
	/** New core throttle events allowed during a step. Any throttle is a fail. */
	newThrottleEvents: 0,
	/**
	 * A heavy job's duration at k concurrent, over the same job's duration alone
	 * on the same node. The jdk21 canary's peer budget uses the same 1.5x.
	 */
	durationRatio: 1.5,
	/** Watchdog reboots or OOM kills allowed during a window. */
	watchdogOrOomEvents: 0,
});

/** Days a qualification result stands before the node is due again (operator, 11-11). */
export const QUALIFY_TTL_DAYS = 21;
