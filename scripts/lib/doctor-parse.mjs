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
