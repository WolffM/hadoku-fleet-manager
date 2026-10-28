/**
 * OFFERS: what each node can lend to hosting, measured. The second part of the
 * hosting layer (docs/planning/hosting-layer-2026-10-27.md §4).
 *
 * The arithmetic, stated once:
 *
 *   hostableMb = MemTotal − minFreeMb − ciReserveMb − Σ declared slices − unbounded neighbours
 *   ciReserveMb = ciJobMb × CI_KEEP_JOBS
 *
 * `ciJobMb` is what one CI job is charged: the node's hand-set `jobP95Mb`
 * where it has one, else `slice.unitMaxMb`, the per-unit cap admission
 * itself charges. How many CI jobs a hosting node keeps is the OPERATOR's
 * dial and still open; {@link CI_KEEP_JOBS} is the stated default, and every
 * offer says what hosting costs CI in jobs, so the trade is visible either way.
 *
 * Facts come from the node (one ssh, as admin): MemTotal, cores, free disk
 * under the state filesystem, whether the default route is wired, and every
 * pm2 manager's memory ceiling (an unbounded one is charged at what it holds
 * now, and named, because `not-beside-unbounded` reads it). Nothing about the
 * node is taken from the manifest's rounded figures.
 */
import { ciIsSeparate } from '../../dist/lib/node-users.js';
import { parseInstalledVersion } from './tool-release.mjs';

/** CI jobs a hosting node keeps by default. The operator's dial; see the header. */
export const CI_KEEP_JOBS = 1;

/** The routing labels that name a GPU, shown on their own and matched by `gpu:<label>`. */
const GPU_LABEL = /nvenc|cuda|nvdec|av1/;

/** Where tenant state lives: the agent homes and the pm2 state roots sit on this filesystem. */
const STATE_FS = '/var/lib';

/**
 * The PATH a service runs with: the pm2 runtime's unit pins it
 * (lib/hosting-runtimes.mjs). Tools are executed with exactly this, not with
 * the login shell's PATH, so a tool only an interactive user can find fails here.
 */
export const SERVICE_PATH = '/usr/local/bin:/usr/bin:/bin';

/**
 * The runtime half of the offer: node's version and each named tool, EXECUTED
 * with the service's PATH. A tool passes when `--version` or `-version` exits
 * 0 (ffmpeg only knows the second). Names are validated by the request schema.
 */
export function runtimeProbe(tools = []) {
	const run = `env -i PATH=${SERVICE_PATH}`;
	return [
		`echo "node=$(${run} node --version 2>/dev/null)"`,
		...tools.map(
			(t) =>
				`if ${run} ${t} --version >/dev/null 2>&1 || ${run} ${t} -version >/dev/null 2>&1; ` +
				`then echo "tool=${t} ok"; else echo "tool=${t} no"; fi`
		),
	].join('\n');
}

/** One ssh: the node's own figures, `KEY=value` between markers. `tools`: what the tenants ask to run. */
export const offerProbe = (tools = []) => `echo OFFER-BEGIN
${runtimeProbe(tools)}
echo "memTotalMb=$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo)"
echo "nproc=$(nproc)"
echo "diskFreeGb=$(df -BG --output=avail ${STATE_FS} 2>/dev/null | tail -1 | tr -dc 0-9)"
dev=$(ip route show default 2>/dev/null | awk '{print $5; exit}')
echo "routeDev=$dev"
echo "wireless=$([ -n "$dev" ] && [ -d "/sys/class/net/$dev/wireless" ] && echo yes || echo no)"
for u in $(systemctl list-units --no-legend --plain 'pm2-*.service' 2>/dev/null | awk '{print $1}'); do
	cg=$(systemctl show "$u" -p ControlGroup --value 2>/dev/null)
	echo "pm2=$u $(cat /sys/fs/cgroup$cg/memory.max 2>/dev/null || echo ?) $(cat /sys/fs/cgroup$cg/memory.current 2>/dev/null || echo ?)"
done
echo OFFER-END
`;

/** Parse {@link OFFER_PROBE}; null when the end marker never arrived. */
export function parseOfferProbe(stdout) {
	const text = String(stdout ?? '');
	const a = text.indexOf('OFFER-BEGIN');
	const b = text.indexOf('OFFER-END');
	if (a === -1 || b === -1 || b < a) return null;
	const kv = {};
	const pm2 = [];
	const tools = {};
	for (const line of text.slice(a, b).split('\n')) {
		const i = line.indexOf('=');
		if (i <= 0) continue;
		const k = line.slice(0, i).trim();
		const v = line.slice(i + 1).trim();
		if (k === 'pm2') {
			const [unit, max, cur] = v.split(/\s+/);
			const mib = (x) => (/^\d+$/.test(x ?? '') ? Math.round(Number(x) / 1048576) : null);
			pm2.push({
				unit,
				bounded: max !== 'max' && max !== '?',
				maxMb: mib(max),
				currentMb: mib(cur),
			});
		} else if (k === 'tool') {
			const [name, verdict] = v.split(/\s+/);
			tools[name] = verdict === 'ok';
		} else kv[k] = v;
	}
	const num = (k) => (/^\d+$/.test(kv[k] ?? '') ? Number(kv[k]) : null);
	return {
		memTotalMb: num('memTotalMb'),
		nproc: num('nproc'),
		diskFreeGb: num('diskFreeGb'),
		link: kv.routeDev ? (kv.wireless === 'yes' ? 'wifi' : 'wired') : null,
		pm2,
		// Absent key: a probe that did not ask. Empty value: no node on the service PATH.
		node: 'node' in kv ? parseInstalledVersion(kv.node) : undefined,
		tools,
	};
}

/**
 * One node's offer. `facts` is {@link parseOfferProbe}'s (null: could not
 * look); `machine` its manifest entry; `tenants` the hosting declarations on
 * it (`{ tenant, memoryMb, cores, mode }`); `pm2Peer` whether the app layer
 * declares it a pm2 host (null: could not read); `drain` its drain record;
 * `labels` the routing labels it offers now, as `nodeOffer` decides them
 * (null: could not read the proof or revocation records).
 */
export function offerFor({
	node,
	machine,
	facts,
	tenants = [],
	pm2Peer = null,
	drain = null,
	labels = null,
}) {
	const unknown = [];
	if (!facts) {
		return {
			node,
			reachable: false,
			hostable: null,
			unknown: ['the node did not finish answering'],
		};
	}
	const ciJobMb = machine?.jobP95Mb ?? machine?.slice?.unitMaxMb ?? null;
	if (ciJobMb === null)
		unknown.push('no jobP95Mb or slice.unitMaxMb: what a CI job costs here is unknown');
	if (facts.memTotalMb === null) unknown.push('MemTotal unreadable');
	if (facts.nproc === null) unknown.push('core count unreadable');
	if (facts.link === null) unknown.push('no default route: wired or Wi-Fi unknown');
	if (pm2Peer === null) unknown.push("the app layer's pm2 host list was unreadable");
	if (labels === null) unknown.push('the labels it offers are unknown');

	const minFreeMb = machine?.minFreeMb ?? 1024;
	const tenantMb = tenants.reduce((s, t) => s + t.memoryMb, 0);
	const tenantCores = tenants.reduce((s, t) => s + t.cores, 0);
	const unbounded = facts.pm2.filter((p) => !p.bounded);
	const unboundedMb = unbounded.reduce((s, p) => s + (p.currentMb ?? 0), 0);
	const ciReserveMb = ciJobMb === null ? null : ciJobMb * CI_KEEP_JOBS;
	const memoryMb =
		facts.memTotalMb === null || ciReserveMb === null
			? null
			: Math.max(0, facts.memTotalMb - minFreeMb - ciReserveMb - tenantMb - unboundedMb);
	// CI keeps at least one core; a tenant quota beyond that is a promise the node cannot keep.
	const cores = facts.nproc === null ? null : Math.max(0, facts.nproc - tenantCores - 1);
	return {
		node,
		reachable: true,
		hostable: { memoryMb, cores, diskFreeGb: facts.diskFreeGb },
		measured: { memTotalMb: facts.memTotalMb, nproc: facts.nproc },
		minFreeMb,
		link: facts.link,
		ci: {
			jobMb: ciJobMb,
			keepJobs: CI_KEEP_JOBS,
			maxConcurrent: machine?.maxConcurrent ?? null,
			cutOver: ciIsSeparate(machine),
		},
		tenants,
		pm2: { present: facts.pm2.length > 0, unbounded: unbounded.map((p) => p.unit), unboundedMb },
		pm2Peer,
		drain: drain ? { kind: drain.kind ?? 'maintenance', until: drain.until ?? null } : null,
		labels,
		gpu: (labels ?? []).filter((c) => GPU_LABEL.test(c)),
		runtime: { node: facts.node, tools: facts.tools ?? {} },
		unknown,
	};
}

/**
 * How many CI jobs still fit on a node once `extraMb` more is hosted on it:
 * the cost of a slice, in the unit the fleet actually spends.
 */
export function ciJobsAfter(offer, extraMb) {
	if (!offer.reachable || offer.ci.jobMb === null || offer.measured.memTotalMb === null)
		return null;
	const room =
		offer.measured.memTotalMb -
		offer.minFreeMb -
		offer.tenants.reduce((s, t) => s + t.memoryMb, 0) -
		offer.pm2.unboundedMb -
		extraMb;
	const fit = Math.floor(room / offer.ci.jobMb);
	return Math.max(0, Math.min(offer.ci.maxConcurrent ?? fit, fit));
}
