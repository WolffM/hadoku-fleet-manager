/**
 * Split {@link doctorProbe}'s stdout into facts, unknowns, the root drive's
 * smartctl lines, storage-probe.sh's lines (`T `, every disk; #138) and the
 * pm2 log-stream lines (`P `, every pm2 daemon; #143) and the io weight lines
 * (`W `, the root disk's enforcement and every declared weight; #158).
 *
 * @param {string} out
 * @returns {{complete: boolean, facts: Record<string,string>,
 *            unknown: Record<string,string>, smart: string[], storage: string[], pm2Logs: string[], ioWeight: string[],
 *            wifiRaw: string}}
 */
export function parseDoctor(out) {
	const text = String(out ?? '');
	const facts = {};
	const unknown = {};
	const smart = [];
	const storage = [];
	const pm2Logs = [];
	const ioWeight = [];
	for (const line of text.split('\n')) {
		const m = /^([DUSTPW]) (.*)$/.exec(line.replace(/\r$/, ''));
		if (!m) continue;
		if (m[1] === 'T') {
			storage.push(m[2]);
			continue;
		}
		if (m[1] === 'W') {
			ioWeight.push(m[2]);
			continue;
		}
		if (m[1] === 'P') {
			pm2Logs.push(m[2]);
			continue;
		}
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
		storage,
		pm2Logs,
		ioWeight,
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
export function sensorMap(facts, prefix) {
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
