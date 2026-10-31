import { readFileSync } from 'node:fs';
import { manifest } from './paths.mjs';
import { measuredFacets } from '../../dist/lib/measured.js';

/** "Twice a year" cadence, unchanged — the `never`/`stale` coverage bands. */
const STALE_DAYS = 200;

export function fleetMachines() {
	const doc = JSON.parse(readFileSync(manifest('fleet-runner-manifest.json'), 'utf8'));
	return doc.machines ?? {};
}

export function fleetNodes() {
	return Object.keys(fleetMachines());
}

/**
 * Every node's stored `$benchmark`, merged — the state dir first, the manifest's
 * copy while the migration is in flight. `src/lib/measured.ts` is the one
 * answer; nothing in this file reads either tree directly any more.
 *
 * WHY DUE AND COVERAGE READ THE FACET AND NOT `fleet-benchmarks.json`. Until
 * Wave 3h they read the run ledger beside the manifest. That was measured
 * before this change (S §6's hard requirement, executed against a fixture of
 * the live manifest with every `$benchmark` stripped and the live ledger
 * beside it): `--due 30 --report --json` answered `due: [], ok: true`. The
 * facet was gone and the gate read the fleet as freshly measured, because the
 * ledger it actually consulted still was. After the manifest edit that is the
 * PRODUCTION state, and it would have stayed green until the ledger's newest
 * runs aged past the threshold, while no node had a record anywhere a reader
 * looks. The `at` stamp on the record a reader is served is the only honest
 * age.
 */
function storedBenchmarks() {
	return measuredFacets('benchmark', fleetMachines());
}

/**
 * One sentence per node with no usable record, saying WHICH kind of absence.
 * "Never measured" and "the record exists and cannot be read" are different
 * jobs, and the second must not be dressed as the first.
 */
function noRecordFinding(node, result) {
	return result.unavailable === 'unreadable' || result.unavailable === 'malformed'
		? `${node}: benchmark record UNREADABLE (${result.unavailable}) — ${result.why}`
		: `${node}: NEVER measured — no benchmark record (${result.unavailable})`;
}

// ── COVERAGE ACROSS RUNS, NOT JUST THIS ONE ────────────────────────────────
// A node skipped for being busy is a normal outcome for ONE run and a silent
// gap across many. claw-2 carries 39% of all fleet jobs, is therefore almost
// never idle, and had never once been measured — while every run that skipped
// it exited 0 and printed a table that looked complete. hokon had never been
// measured either, for an entirely different reason (it refuses ssh to itself),
// and the file looked equally healthy both ways.
//
// Per-run reporting cannot catch either case, because neither is a failure of
// any single run. Only the stored record knows. "I could not look" must never
// render as "nothing is wrong" — so a node whose record is UNAVAILABLE, for any
// of measured.ts's five reasons, lands in `never` and fails the run.
// STALE_DAYS is declared at the top of the file (the "twice a year" cadence).

export function coverageOf(measured) {
	const stored = storedBenchmarks();
	const never = [];
	const stale = [];
	/** node -> the finding sentence for a node in `never`. */
	const why = new Map();
	for (const n of Object.keys(stored.nodes)) {
		// This invocation has not been persisted yet; it counts as fresh.
		if (measured[n]) continue;
		const r = stored.nodes[n];
		if (r.unavailable) {
			never.push(n);
			why.set(n, noRecordFinding(n, r));
			continue;
		}
		const days = Math.round((Date.now() - Date.parse(r.value.at)) / 86400000);
		if (days > STALE_DAYS) stale.push({ node: n, days });
	}
	return { never, stale, why };
}

/** The findings a coverage result implies, `skip` excepted (guests). */
export function coverageFindings(c, skip = new Set()) {
	return [
		...c.never.filter((n) => !skip.has(n)).map((n) => c.why?.get(n) ?? `${n}: NEVER measured`),
		...c.stale
			.filter((x) => !skip.has(x.node))
			.map((x) => `${x.node}: last measured ${x.days}d ago`),
	];
}

/** The emitted shape of `coverage` — the internal `why` map stays internal. */
export const coverageJson = (c, scoped) => ({ never: c.never, stale: c.stale, scoped });

/** `key value` lines between BENCH-BEGIN and BENCH-END. */
export function parse(text) {
	const lines = text.split('\n');
	const b = lines.findIndex((l) => l.startsWith('BENCH-BEGIN'));
	if (b === -1) throw new Error('no BENCH-BEGIN — the script did not run');
	const e = lines.findIndex((l, i) => i > b && l.startsWith('BENCH-END'));
	// A record with no END is TRUNCATED, and a half-measured box must not read
	// as a fully measured one.
	if (e === -1) throw new Error('BENCH-BEGIN with no BENCH-END — truncated');
	const out = {};
	for (const line of lines.slice(b + 1, e)) {
		const s = line.trim();
		if (!s) continue;
		const sp = s.indexOf(' ');
		if (sp === -1) continue;
		const v = s.slice(sp + 1).trim();
		out[s.slice(0, sp)] = v.startsWith('unknown') ? null : v;
	}
	return out;
}

/**
 * A DEGRADED RUN MUST NOT ERASE WHAT A BETTER ONE MEASURED.
 *
 * $benchmark is replaced wholesale, so a run that could not measure a facet
 * would otherwise overwrite the facet with null and the evidence is simply
 * gone. That is not hypothetical: hokon has no passwordless sudo, so ANY
 * unattended run there falls back to unprivileged and comes back with no disk
 * timings, no SMART and no DIMM data -- silently deleting the numbers an
 * operator had to type a password to obtain. "I could not look" would become
 * "there is nothing there", which is the inversion this repo keeps
 * re-learning.
 *
 * Promoted to the top level (wave 3x) so `--cadence`'s single-node write can
 * share this guard with the multi-node `--write` path below rather than
 * reimplementing it.
 */
function lostFacets(before, after, path = '') {
	if (!before || typeof before !== 'object') return [];
	const lost = [];
	for (const [k, v] of Object.entries(before)) {
		const n = after?.[k];
		const at = path ? `${path}.${k}` : k;
		if (v && typeof v === 'object') lost.push(...lostFacets(v, n, at));
		else if (v !== null && v !== undefined && v !== '' && (n === null || n === undefined))
			lost.push(at);
	}
	return lost;
}

/**
 * Decide whether a freshly measured record is safe to persist over whatever is
 * already stored for `node`. Pure: builds the candidate inventory entry and
 * compares it against the stored one, but writes nothing — the caller calls
 * `writeFacet` only when this says `ok`.
 */
export function decideRecord(node, r, { stored, force = false }) {
	const next = inventoryEntry(r);
	const prev = stored.nodes[node];
	const lost = lostFacets(prev && !prev.unavailable ? prev.value : null, next);
	if (lost.length && !force) return { ok: false, lost, rooted: r['capture.root'] ?? null };
	return { ok: true, record: next };
}

/**
 * The finding for a record decideRecord refused, naming the fields (#121).
 *
 * It used to say "needs a rooted capture" for ANY lost field. claw-9's capture
 * ran under sudo and was refused anyway, so the advice sent the reader after a
 * cause that was not there. Root is advised only when the capture SAYS it ran
 * unprivileged (`capture.root no`, from benchmark-node.sh); otherwise the
 * finding states what happened and leaves the cause to the field list.
 */
export function degradedFinding({ node, lost, rooted }) {
	const fields =
		lost.slice(0, 6).join(', ') + (lost.length > 6 ? ` (+${lost.length - 6} more)` : '');
	if (rooted === 'no')
		return `${node}: needs a rooted capture — this run ran unprivileged and could not measure ${lost.length} field(s): ${fields}`;
	return `${node}: ${lost.length} field(s) went from a value to unmeasured, so the stored record was kept: ${fields}`;
}

// `rootDisk`, `rootDiskField`, `ROWS`, `liveIface`, `liveLinkSpeed` and
// `inventoryEntry` below are pure table/record builders, kept at module scope
// (not nested in `main()`) because `decideRecord` above calls `inventoryEntry`
// and `decideRecord` is shared with `runCadenceCli`. See the comment above
// `async function main()` for why everything STATEFUL starts there instead.
const rootDisk = (r) => {
	const k = Object.keys(r).find(
		(x) => /^disk\..*\.mountpoints$/.test(x) && (r[x] || '').includes('/')
	);
	return k ? k.split('.')[1] : null;
};
/**
 * A SMART FIGURE BELONGS TO A DEVICE, AND THIS TABLE NAMES ONE — the root disk.
 *
 * The `disk hours` and `disk realloc` rows used to read
 * `find(r, /^disk\..*\.powerOnHours$/)`: the FIRST matching key in enumeration
 * order, which is `/sys/block/*` in alphabetical order and therefore `sda`
 * whatever `/` is actually on. The `root disk` row directly above them resolves
 * its device from `mountpoints`, so on any box where root is not the first disk
 * those rows described TWO DIFFERENT DRIVES in one column with nothing saying
 * so.
 *
 * claw-9 is the live case and the reason this is a fix rather than a tidy-up:
 * root is `sdb`, a 240G SSD at 29888 hours with 7 reallocated sectors, while
 * `sda` is a 1TB spinner at 31450 hours with 0. The table printed the SSD's
 * model beside the HDD's age and the HDD's zero — the root disk's 7 reallocs
 * appeared nowhere, and the column was read as one drive in a wave brief.
 *
 * One resolver, one device: `rootDisk(r)`, which is the same answer
 * `inventoryEntry`'s `rootDisk` block has always used. A field the root disk
 * does not report is `—`, never another disk's value.
 */
const rootDiskField = (r, field) => {
	const d = rootDisk(r);
	return (d ? r[`disk.${d}.${field}`] : null) ?? '—';
};

export const ROWS = [
	['cpu', (r) => (r['cpu.model'] || '').replace(/\(R\)|\(TM\)|CPU|@.*/g, '').trim()],
	['cores / threads', (r) => `${r['cpu.cores'] ?? '?'} / ${r['cpu.threads'] ?? '?'}`],
	['max MHz', (r) => r['cpu.mhzMax'] ?? '—'],
	[
		'RAM',
		(r) =>
			`${Math.round((+r['mem.totalKb'] || 0) / 1048576)}G ${r['mem.type'] ?? ''} ${r['mem.speedMTs'] ?? ''}`,
	],
	[
		'mem bandwidth',
		(r) =>
			r['bench.memBandwidthBps'] ? `${(r['bench.memBandwidthBps'] / 1e9).toFixed(2)} GB/s` : '—',
	],
	[
		'cpu 1-core',
		(r) =>
			r['bench.cpuSha512SingleKBps']
				? `${Math.round(parseFloat(r['bench.cpuSha512SingleKBps']) / 1024)} MB/s`
				: '—',
	],
	[
		'cpu all-core',
		(r) =>
			r['bench.cpuSha512AllCoreKBps']
				? `${Math.round(parseFloat(r['bench.cpuSha512AllCoreKBps']) / 1024)} MB/s`
				: '—',
	],
	['disk write', (r) => r['bench.diskWrite.root'] ?? '—'],
	['disk read', (r) => r['bench.diskRead.root'] ?? '—'],
	[
		'root disk',
		(r) => {
			const n = rootDisk(r);
			if (!n) return '—';
			return `${r[`disk.${n}.model`] ?? n}${r[`disk.${n}.rotational`] === '1' ? ' SPIN' : ' ssd'}`;
		},
	],
	// THE ROOT DISK'S, not the first disk's — see rootDiskField.
	['disk hours', (r) => rootDiskField(r, 'powerOnHours')],
	['disk realloc', (r) => rootDiskField(r, 'reallocated')],
	[
		'net to archive',
		(r) =>
			r['bench.netArchiveBps'] ? `${(r['bench.netArchiveBps'] / 125000).toFixed(0)} Mbit/s` : '—',
	],
	// The interface that is UP, not the first in sort order — see liveLinkSpeed.
	['link speed', (r) => liveLinkSpeed(r) ?? '—'],
	['GPU', (r) => `${r['gpu.driver'] ?? '—'}${r['gpu.nvencAv1Capable'] === 'yes' ? ' av1' : ''}`],
	['idle -> load C', (r) => `${r['thermal.idleC'] ?? '?'} -> ${r['thermal.loadedC'] ?? '?'}`],
	['PCIe errors', (r) => r['stability.aerCorrectable'] ?? '—'],
	[
		'failed units',
		// THE NAMES BEHIND THE COUNT (#87 §4), not only the count — a dead runner
		// unit and something benign both read "1" without them.
		(r) => {
			const n = r['stability.failedUnits'];
			if (n == null) return '—';
			const names = r['stability.failedUnitNames'];
			return names ? `${n} (${names})` : n;
		},
	],
	['OOM kills', (r) => r['stability.oomKills'] ?? '—'],
	['uptime days', (r) => (r.uptimeSec ? Math.round(r.uptimeSec / 86400) : '—')],
];

/**
 * The INVENTORY entry: what this node IS, as measured, with the date it was
 * measured on it.
 *
 * It lived in the manifest beside $measured until Wave 3h; it now lives in
 * `<stateDir>/benchmark.json` (`src/lib/measured.ts`), because re-measuring is
 * not an editorial act and a commit per measurement bought nothing.
 *
 * TIMESTAMPED, because every figure here decays. A disk that read 480MB/s in
 * September is not evidence about the same disk in March, and `at` is what lets
 * a reader tell a current measurement from a stale one. `benchmark.log` keeps
 * the series — every write, with the raw capture — and this keeps the latest.
 */
/**
 * THE INTERFACE THIS BOX IS ACTUALLY ON: one with carrier, falling back to any
 * that reports a link speed at all.
 *
 * Named separately from the speed it carries because EVERY per-interface figure
 * has to come from the SAME interface. `linkSpeed` was moved off first-match
 * key order when claw-1's unplugged enp4s0 outranked the wlp5s0 it really runs
 * on; `duplex` was left on `find()` in the same pass and kept reporting the
 * dead port's — the same defect, one field over.
 */
function liveIface(r) {
	const ifaces = [
		...new Set(
			Object.keys(r)
				.filter((k) => k.startsWith('net.'))
				.map((k) => k.split('.')[1])
		),
	];
	const up = ifaces.filter((i) => r[`net.${i}.carrier`] === '1' && r[`net.${i}.linkSpeed`]);
	return up[0] ?? ifaces.find((i) => r[`net.${i}.linkSpeed`]) ?? null;
}

/** The linkSpeed of an interface with carrier, falling back to any. */
function liveLinkSpeed(r) {
	const pick = liveIface(r);
	return pick ? r[`net.${pick}.linkSpeed`] : null;
}

function inventoryEntry(r) {
	const disk = rootDisk(r);
	// A MEASURED ZERO IS A VALUE (#121). This was `Number(...) || null`, which
	// stored every 0 as null: no record in benchmark.json ever held a zero, so
	// "no OOM kills" and "could not look" read the same, and lostFacets then
	// refused claw-9 for two nights because its AER count went 34 -> 0 after a
	// reboot — the box got healthier and the guard read it as a lost field.
	// Null now means only what parse() makes null: an `unknown` or no digits.
	const num = (v) => {
		if (v == null) return null;
		const digits = String(v).replace(/[^0-9.]/g, '');
		if (digits === '') return null;
		const n = Number(digits);
		return Number.isFinite(n) ? n : null;
	};
	// A RATE CARRIES A UNIT, AND num() THREW IT AWAY. dd reports in whatever
	// unit fits, so a slow disk says "184 MB/s" and a fast one says "1.9 GB/s" —
	// and stripping the non-digits scored the fast one as 1.9. The bug hit ONLY
	// the fastest disks in the fleet, because only they cross into GB/s: hokon's
	// root disk was recorded at 1.9 MB/s, the slowest number in the file, when it
	// is the quickest device we own at ~1900. A comparison table is exactly where
	// that inversion does its damage.
	const rateMBps = (v) => {
		if (v == null) return null;
		const m = String(v).match(/([0-9.]+)\s*([kMGT]?)B\/s/i);
		if (!m) return num(v);
		const n = Number(m[1]);
		if (!Number.isFinite(n)) return null;
		// dd counts in SI, so GB/s is 1e9 B/s, not 2^30.
		const scale = { k: 1 / 1000, m: 1, g: 1000, t: 1_000_000 };
		return Math.round(n * (scale[m[2].toLowerCase()] ?? 1));
	};
	return {
		at: new Date().toISOString(),
		by: 'fleet benchmark',
		cpu: {
			model: r['cpu.model'] ?? null,
			// PHYSICAL cores and threads, separately. The manifest's own `cores`
			// field is really threads — claw-1 is 4c/8t and recorded as cores: 8 —
			// so recording both is the only way to tell which any future reader
			// meant.
			cores: num(r['cpu.cores']),
			threads: num(r['cpu.threads']),
			maxMhz: num(r['cpu.mhzMax']),
			governor: r['cpu.governor'] ?? null,
			avx2: r['cpu.flag.avx2'] === 'yes',
			aes: r['cpu.flag.aes'] === 'yes',
			// sha512: the RANKING number, because SHA-NI does not touch it. See
			// benchmark-node.sh for the measurements that settled this.
			sha512SingleMBps: r['bench.cpuSha512SingleKBps']
				? Math.round(parseFloat(r['bench.cpuSha512SingleKBps']) / 1024)
				: null,
			sha512AllCoreMBps: r['bench.cpuSha512AllCoreKBps']
				? Math.round(parseFloat(r['bench.cpuSha512AllCoreKBps']) / 1024)
				: null,
			shaNi: r['cpu.flag.shaNi'] === 'yes',
			// SHA-NI accelerated where present. Kept for history and as the
			// cheapest SHA-NI detector; NOT comparable across vendors.
			sha256SingleMBps: r['bench.cpuSha256SingleKBps']
				? Math.round(parseFloat(r['bench.cpuSha256SingleKBps']) / 1024)
				: null,
			sha256AllCoreMBps: r['bench.cpuSha256AllCoreKBps']
				? Math.round(parseFloat(r['bench.cpuSha256AllCoreKBps']) / 1024)
				: null,
		},
		memory: {
			totalKb: num(r['mem.totalKb']),
			type: r['mem.type'] ?? null,
			speedMTs: num(r['mem.speedMTs']),
			sticks: num(r['mem.sticks']),
			slots: num(r['mem.slots']),
			swapKb: num(r['mem.swapTotalKb']),
			// STREAM triad, chosen 2026-09-07 (P1.4) because it accounts for
			// write-allocate traffic and two other methods do not — see
			// benchmark-node.sh's memory-bandwidth section for the comparison.
			bandwidthMBps: r['bench.memBandwidthBps']
				? Math.round(parseFloat(r['bench.memBandwidthBps']) / 1_000_000)
				: null,
			bandwidthMethod: r['bench.memBandwidthMethod'] ?? null,
		},
		rootDisk: disk
			? {
					device: disk,
					model: r[`disk.${disk}.model`] ?? null,
					kind: r[`disk.${disk}.kind`] ?? null,
					rotational: r[`disk.${disk}.rotational`] === '1',
					sizeBytes: num(r[`disk.${disk}.sizeBytes`]),
					scheduler: r[`disk.${disk}.scheduler`] ?? null,
					writeMBps: rateMBps(r['bench.diskWrite.root']),
					readMBps: rateMBps(r['bench.diskRead.root']),
					smartHealth: r[`disk.${disk}.smartHealth`] ?? null,
					powerOnHours: num(r[`disk.${disk}.powerOnHours`]),
					// ATA and NVMe express wear differently and BOTH are kept. A null
					// means the drive does not report that measure, NOT that the
					// measure is zero — claw-3 reported no disk hours at all until
					// the NVMe log format was parsed.
					reallocatedSectors: num(r[`disk.${disk}.reallocated`]),
					pendingSectors: num(r[`disk.${disk}.pendingSectors`]),
					wearLeveling: num(r[`disk.${disk}.wearLeveling`]),
					percentageUsed: num(r[`disk.${disk}.percentageUsed`]),
					availableSparePct: num(r[`disk.${disk}.availableSparePct`]),
					mediaErrors: num(r[`disk.${disk}.mediaErrors`]),
					unsafeShutdowns: num(r[`disk.${disk}.unsafeShutdowns`]),
					tempC: num(r[`disk.${disk}.tempC`]),
				}
			: null,
		// EVERY drive, not only the one / is on. claw-4 has a second 1TB disk
		// that nothing looking at / would ever mention.
		disks: [
			...new Set(
				Object.keys(r)
					.filter((k) => /^disk\.[^.]+\.model$/.test(k))
					.map((k) => k.split('.')[1])
			),
		].map((d) => ({
			device: d,
			model: r[`disk.${d}.model`],
			kind: r[`disk.${d}.kind`] ?? null,
			rotational: r[`disk.${d}.rotational`] === '1',
			sizeBytes: num(r[`disk.${d}.sizeBytes`]),
			mountpoints: r[`disk.${d}.mountpoints`],
			smartHealth: r[`disk.${d}.smartHealth`] ?? null,
			powerOnHours: num(r[`disk.${d}.powerOnHours`]),
		})),
		gpu: {
			driver: r['gpu.driver'] ?? null,
			count: num(r['gpu.count']),
			device: r['gpu.1.device'] ?? null,
			// Silicon generation, not "is there a GPU". A GTX 745 has an NVENC
			// block and no AV1 encoder at all, which is why av1-nvenc probes `no`
			// on hardware that plainly has a GPU.
			av1Encode: r['gpu.nvencAv1Capable'] === 'yes',
		},
		network: {
			// THE INTERFACE THAT IS ACTUALLY UP. First-match key order put claw-1's
			// unplugged enp4s0 ahead of the wlp5s0 it really runs on — so the fleet
			// table showed a dead port's non-answer as that node's network.
			//
			// BOTH fields come off that one interface. `duplex` stayed on the
			// first-match reader after `linkSpeed` was fixed, so a wifi node
			// reported the speed of its wireless link beside the duplex of an
			// unplugged socket. A wireless interface emits no duplex at all
			// (benchmark-node.sh only emits it when the kernel has one), and `—`
			// for "this link has no duplex" is the honest answer; another device's
			// `full` is not.
			linkSpeed: liveLinkSpeed(r),
			duplex: (() => {
				const i = liveIface(r);
				return (i ? r[`net.${i}.duplex`] : null) ?? '—';
			})(),
			archiveMbits: r['bench.netArchiveBps'] ? Math.round(r['bench.netArchiveBps'] / 125000) : null,
		},
		thermal: {
			idleC: num(r['thermal.idleC']),
			loadedC: num(r['thermal.loadedC']),
			// WHERE the number came from, and whether to believe it. Both AMD
			// boxes read 0 until 2026-09-03 because only thermal_zone was
			// consulted, and claw-5 now reads ~20C loaded because k10temp on
			// family 15h is a relative offset. A temperature with no provenance
			// is what let both of those pass as measurements.
			source: r['thermal.loadedC.source'] ?? r['thermal.idleC.source'] ?? null,
			suspect: r['thermal.loadedC.suspect'] ?? null,
		},
		stability: {
			aerCorrectable: num(r['stability.aerCorrectable']),
			failedUnits: num(r['stability.failedUnits']),
			// THE NAMES BEHIND THE COUNT (#87 §4): a count alone cannot tell a dead
			// runner unit from something benign without ssh-ing in — the exact gap
			// that left claw-3 and claw-6's `failed units: 1` undiagnosable on
			// 2026-10-04. Comma-joined by benchmark-node.sh; `[]` (not null) when
			// the count is genuinely zero.
			failedUnitNames: r['stability.failedUnitNames']
				? r['stability.failedUnitNames'].split(',').filter(Boolean)
				: [],
			oomKills: num(r['stability.oomKills']),
			uptimeSec: num(r.uptimeSec),
		},
		chassis: {
			vendor: r['dmi.sys_vendor'] ?? null,
			product: r['dmi.product_name'] ?? null,
			board: r['dmi.board_name'] ?? null,
			bios: r['dmi.bios_version'] ?? null,
		},
	};
}
