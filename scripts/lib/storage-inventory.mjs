/**
 * THE DISK INVENTORY: `scripts/storage-probe.sh`'s output, as typed records.
 *
 * This is the contract the storage bootcamp reads (qualify, the format/mount
 * converger, the Garage layout manager, the pool gate). The shape is declared
 * in `storage-inventory.d.mts` beside this file; `storage-inventory.test.mjs`
 * holds every record this parser builds to exactly the keys declared there.
 *
 * `parseSmart` lives here, not in doctor-parse.mjs: the doctor, the benchmark
 * record and this inventory all read smartctl's output, and this is the lowest
 * layer that reads a node's drives.
 *
 * NOTHING HERE TOUCHES A DISK. The probe is read-only, and so is everything
 * built on this record until a converger names a disk by serial.
 */

/** Schema of {@link parseStorage}'s record. Bump it with the .d.mts. */
export const STORAGE_SCHEMA = 1;

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
 * `kind` and the wear fields after it feed the benchmark record's flat
 * `disk.<dev>.*` keys, which kept NVMe's media errors apart from ATA's
 * reallocated count; `reallocated` folds the two for the doctor.
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
		kind: null,
		percentageUsed: null,
		availableSparePct: null,
		mediaErrors: null,
		unsafeShutdowns: null,
		wearLeveling: null,
	};
	if (!text.trim()) {
		res.reason = 'smartctl returned nothing';
		return res;
	}
	const nvme = /NVMe Log/.test(text);
	res.kind = nvme ? 'nvme' : 'ata';
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
		res.percentageUsed = kv('Percentage Used');
		res.availableSparePct = kv('Available Spare');
		res.mediaErrors = res.reallocated;
		res.unsafeShutdowns = kv('Unsafe Shutdowns');
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
		res.wearLeveling = attr('Wear_Leveling_Count');
	}
	if (res.health === null) {
		const refusal = /^(\/dev\/\S+:\s*.+)$/m.exec(text);
		res.reason = refusal
			? `the drive did not answer SMART: ${refusal[1]}`
			: 'smartctl output carried no overall-health line';
	}
	return res;
}

/**
 * `KEY="value"` pairs out of one `lsblk -P` row. lsblk escapes anything unsafe
 * as `\xNN` (a space in a label is `\x20`), so values are unescaped here.
 */
export function parseLsblkRow(row) {
	const out = {};
	for (const m of String(row).matchAll(/([A-Z:-]+)="((?:[^"\\]|\\.)*)"/g)) {
		out[m[1]] = m[2].replace(/\\x([0-9a-fA-F]{2})/g, (_, h) =>
			String.fromCharCode(parseInt(h, 16))
		);
	}
	return out;
}

const orNull = (v) => (v === undefined || v === null || v === '' ? null : v);
const numOrNull = (v) => {
	if (v === undefined || v === null || v === '') return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};
const boolOf = (v) => (v === '1' ? true : v === '0' ? false : null);

/**
 * Why SMART has no reading for a drive, as one of the record's statuses.
 *
 * FOUR ABSENCES, KEPT APART, because each is a different job: the tool is not
 * installed (install smartmontools), the run was not root (re-run with sudo),
 * the drive or its bridge refused (claw-4's card reader: no `-d` type will help
 * an empty slot), and SMART is disabled on the drive (claw-10's ST3000DM001:
 * `smartctl -s on` would answer it, and that is a write, so not ours).
 */
function smartOf(tool, root, lines) {
	const read = parseSmart(lines);
	const base = {
		health: read.health,
		powerOnHours: read.powerOnHours,
		temperatureC: read.temperatureC,
		reallocated: read.reallocated,
		pendingSectors: read.pendingSectors,
		lifetimeRemainingPct: read.lifetimeRemainingPct,
	};
	const text = lines.join('\n');
	if (!tool) return { status: 'no-tool', why: 'smartctl is not installed', ...base };
	if (!lines.length) return { status: 'no-answer', why: 'smartctl printed nothing', ...base };
	if (/open device: .* failed: Permission denied/.test(text)) {
		return {
			status: 'not-root',
			why: root
				? 'smartctl was refused the device as root'
				: 'not root: smartctl cannot open the device',
			...base,
		};
	}
	if (/^SMART Disabled\b|SMART support is:\s+Disabled/m.test(text)) {
		return { status: 'disabled', why: 'SMART is disabled on the drive', ...base };
	}
	const refusal =
		/Unknown USB bridge.*|Please specify device type.*|Unavailable - device lacks SMART capability.*/.exec(
			text
		);
	if (refusal && read.health === null) {
		return { status: 'unsupported', why: `the drive did not answer SMART: ${refusal[0]}`, ...base };
	}
	if (read.health === null) return { status: 'no-answer', why: read.reason, ...base };
	if (/^(PASSED|OK)$/.test(read.health)) return { status: 'ok', why: null, ...base };
	return { status: 'failing', why: `SMART health is ${read.health}`, ...base };
}

/**
 * The probe's output, as a {@link STORAGE_SCHEMA} record.
 *
 * THROWS on no `STORAGE-BEGIN` or no `STORAGE-END`: a probe that did not run,
 * or was cut off, must not read as a node with fewer disks. The markers may sit
 * inside a larger capture (benchmark-node.sh's), and lines outside them are
 * ignored.
 *
 * `blank` is `null`, not `false`, when lsblk did not answer for the disk: "I
 * could not look" is not "there is something on it", and neither is it blank.
 *
 * @param {string} text
 * @returns {import('./storage-inventory.d.mts').StorageInventory}
 */
export function parseStorage(text) {
	const lines = String(text ?? '')
		.split('\n')
		.map((l) => l.replace(/\r$/, ''));
	const b = lines.findIndex((l) => l.startsWith('STORAGE-BEGIN'));
	if (b === -1) throw new Error('no STORAGE-BEGIN — the storage probe did not run');
	const e = lines.findIndex((l, i) => i > b && l.startsWith('STORAGE-END'));
	if (e === -1) throw new Error('STORAGE-BEGIN with no STORAGE-END — truncated');
	const facts = {};
	const order = [];
	const rows = new Map();
	const smart = new Map();
	for (const line of lines.slice(b + 1, e)) {
		const pm = /^([PS]) (\S+) ?(.*)$/.exec(line);
		if (pm) {
			const into = pm[1] === 'P' ? rows : smart;
			if (!into.has(pm[2])) into.set(pm[2], []);
			into.get(pm[2]).push(pm[1] === 'P' ? parseLsblkRow(pm[3]) : pm[3]);
			continue;
		}
		const sp = line.indexOf(' ');
		if (sp === -1) continue;
		const k = line.slice(0, sp);
		const v = line.slice(sp + 1).trim();
		if (k === 'disk') {
			order.push(v);
			continue;
		}
		facts[k] = v.startsWith('unknown') ? null : v;
	}
	const root = facts['storage.root'] === 'yes';
	const tool =
		facts['storage.smartTool'] && facts['storage.smartTool'] !== 'absent'
			? facts['storage.smartTool']
			: null;
	const disks = order.map((d) => {
		const f = (k) => orNull(facts[`disk.${d}.${k}`]);
		const own = rows.get(d) ?? null;
		const self = own?.find((r) => r.NAME === d) ?? null;
		const parts = (own ?? []).filter((r) => r.NAME !== d && r.TYPE === 'part');
		const mountpoints = (own ?? []).map((r) => r.MOUNTPOINT).filter(Boolean);
		const sizeBytes = numOrNull(f('sizeBytes')) ?? 0;
		const partitionTable = orNull(self?.PTTYPE);
		const filesystem =
			self && self.FSTYPE
				? { fstype: self.FSTYPE, uuid: orNull(self.UUID), label: orNull(self.LABEL) }
				: null;
		return {
			device: d,
			path: `/dev/${d}`,
			model: orNull(self?.MODEL) ?? f('model'),
			serial: orNull(self?.SERIAL),
			sizeBytes,
			mediaPresent: sizeBytes > 0,
			rotational: boolOf(f('rotational')),
			removable: boolOf(f('removable')),
			transport: orNull(self?.TRAN),
			kind: f('kind') === 'nvme' ? 'nvme' : 'ata',
			scheduler: f('scheduler'),
			isRoot: mountpoints.includes('/'),
			mounted: mountpoints.length > 0,
			mountpoints,
			partitionTable,
			filesystem,
			partitions: parts.map((r) => ({
				name: r.NAME,
				sizeBytes: numOrNull(r.SIZE) ?? 0,
				fstype: orNull(r.FSTYPE),
				uuid: orNull(r.UUID),
				label: orNull(r.LABEL),
				mountpoint: orNull(r.MOUNTPOINT),
			})),
			blank:
				own === null ? null : sizeBytes > 0 && !partitionTable && !filesystem && parts.length === 0,
			smart: smartOf(tool, root, smart.get(d) ?? []),
		};
	});
	return {
		schema: STORAGE_SCHEMA,
		root,
		smartTool: tool,
		lsblk: !('storage.lsblk' in facts),
		disks,
	};
}
