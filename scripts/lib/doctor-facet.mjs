import { cpuSensor, sensorMap, parseSmart } from './doctor-parse.mjs';
import { parseWifiManager } from './node-interfaces.mjs';

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
		Object.entries(health).filter(([k]) => k !== 'bootcamp' && k !== 'pm2Claims' && k !== 'cpuLoad')
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
			// `max-load-1=64,max-load-5=48`, `none`, or null when the conf was unreadable.
			loadTrigger: facts['watchdog.loadTrigger'] ?? null,
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
		nic: nicFacet(facts, unknown),
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
 * The default-route NIC: which interface, wired or Wi-Fi, the kernel's link
 * speed and this boot's link drops. A null field carries its `why`: could not
 * look, never zero.
 *
 * @returns {{iface: string|null, kind: 'wired'|'wifi'|null, speedMbps: number|null, linkDowns: number|null, why: string|null}}
 */
function nicFacet(facts, unknown) {
	const n = (k) => (facts[k] === undefined ? null : Number(facts[k]));
	const iface = facts['nic.iface'] ?? null;
	return {
		iface,
		kind: facts['nic.kind'] === 'wired' || facts['nic.kind'] === 'wifi' ? facts['nic.kind'] : null,
		speedMbps: n('nic.speedMbps'),
		linkDowns: n('nic.linkDowns'),
		why:
			iface === null
				? (unknown.nic ?? 'the probe reported no default-route interface')
				: (unknown['nic.speedMbps'] ?? unknown['nic.linkDowns'] ?? null),
	};
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
