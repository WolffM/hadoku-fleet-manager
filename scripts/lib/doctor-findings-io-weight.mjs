/**
 * doctor-findings-io-weight: an IOWeight the kernel does not enforce
 * (hadoku-fleet-manager#158).
 *
 * cgroup v2's io.weight is only a request. The kernel acts on it through BFQ
 * or through io.cost, both per device. A device on the `none` (or
 * mq-deadline) scheduler with no `enable=1` line in the root's io.cost.qos
 * serves every cgroup FIFO, whatever weight it was given. On the hub on
 * 2026-11-24 the production pm2 unit carried IOWeight=1000 and the agent
 * scopes 20, the root NVMe was `[none]` with io.cost empty, and production's
 * io.pressure averaged 31% over five minutes under agent builds.
 *
 * TWO FINDINGS, both judged from the kernel's own files, never from a unit:
 *
 *   unenforced  a cgroup below the top level declares a non-default weight,
 *               and a whole disk under the root filesystem enforces none.
 *   diluted     io.weight is hierarchical: siblings share their parent's
 *               share. The highest-weighted cgroup sits under a top-level
 *               slice whose weight is no more than another top-level slice
 *               that holds a lower-weighted cgroup. Once enforced, it is
 *               capped at its slice's share of the root, whatever its own
 *               weight says (1000 against 20 still splits 100:100 at the
 *               root when one is in system.slice and the other in
 *               user.slice).
 *
 * The root's whole disks are found from the root mount down (`lsblk -s`
 * through dm-crypt and LVM), never by a device number.
 *
 * SHIPPED QUIET. Every finding is ADVISORY and `shadow: true` until its
 * false-positive rate is known (AGENTS.md, "a new gate starts quiet").
 */

import { ADVISORY } from './preflight.mjs';
import { f } from './doctor-findings-record.mjs';

const CATEGORY = 'io-weight';

/** The kernel's default io.weight. A cgroup at it declared nothing. */
export const DEFAULT_IO_WEIGHT = 100;

/**
 * The node half. Reads only world-readable files, so it needs no root. Prints
 * only `W ` lines, tab-separated, and decides nothing:
 *
 *   W disk <maj:min> <name> <scheduler>   a whole disk under the root fs
 *   W qos <line>                          one line of the root's io.cost.qos
 *   W noiocost <why>                      the kernel has no io.cost
 *   W weight <cgroup> <weight>            every top-level cgroup, and any deeper one off the default
 *   W fail <why>                          the root's disks could not be found
 *   W end                                 the stanza ran to its end
 */
export const IO_WEIGHT_SH = String.raw`io_weight() {
	src=$(findmnt -no SOURCE / 2>/dev/null | head -n1 | sed 's/\[.*//')
	if [ -z "$src" ]; then
		printf 'W fail\t%s\n' "findmnt named no device for /"
	elif ! disks=$(lsblk -snro MAJ:MIN,TYPE,NAME "$src" 2>/dev/null | awk '$2=="disk"{print $1" "$3}' | sort -u) || [ -z "$disks" ]; then
		printf 'W fail\t%s\n' "lsblk found no whole disk under $src"
	else
		printf '%s\n' "$disks" | while read -r mm name; do
			sch=$(sed -n 's/.*\[\(.*\)\].*/\1/p' "/sys/block/$name/queue/scheduler" 2>/dev/null)
			[ -n "$sch" ] || sch=-
			printf 'W disk\t%s\t%s\t%s\n' "$mm" "$name" "$sch"
		done
	fi
	if [ -r /sys/fs/cgroup/io.cost.qos ]; then
		while IFS= read -r l; do [ -n "$l" ] && printf 'W qos\t%s\n' "$l"; done < /sys/fs/cgroup/io.cost.qos
	else
		printf 'W noiocost\t%s\n' "this kernel has no io.cost controller (no /sys/fs/cgroup/io.cost.qos)"
	fi
	find /sys/fs/cgroup -mindepth 2 -maxdepth 12 -name io.weight -exec awk '$1=="default" {
		r = FILENAME; sub("^/sys/fs/cgroup/", "", r); sub("/io[.]weight$", "", r)
		if (r ~ /\// && $2 == 100) next
		printf "W weight\t%s\t%s\n", r, $2
	}' {} + 2>/dev/null
	echo 'W end'
}`;

/**
 * One io.cost.qos line, `MAJ:MIN enable=1 ctrl=auto rpct=... ...`, as
 * `{dev, enabled, ctrl}`. null for a line that is not one.
 */
export function parseQos(line) {
	const [dev, ...kv] = String(line ?? '')
		.trim()
		.split(/\s+/);
	if (!/^\d+:\d+$/.test(dev ?? '')) return null;
	const o = Object.fromEntries(kv.map((p) => p.split('=')));
	return { dev, enabled: o.enable === '1', ctrl: o.ctrl ?? null };
}

/** Does this disk act on io.weight? BFQ does by itself; anything else needs io.cost on. */
const enforcing = (d) => d.scheduler === 'bfq' || d.ioCost === true;

/**
 * The dilution: the highest-weighted cgroup below the top level, against
 * every top-level slice that holds a lower-weighted cgroup and weighs at
 * least as much as the high one's own slice. `share` is the most the high
 * cgroup can get of the device while both slices are busy.
 *
 * @param {{cgroup: string, weight: number}[]} weights
 */
export function dilution(weights) {
	const top = (cg) => cg.split('/')[0];
	const topWeight = new Map(
		weights.filter((w) => !w.cgroup.includes('/')).map((w) => [w.cgroup, w.weight])
	);
	const deep = weights.filter((w) => w.cgroup.includes('/'));
	const tw = (t) => topWeight.get(t) ?? DEFAULT_IO_WEIGHT;
	// Highest weight first; the first one that is diluted is the one reported.
	for (const high of [...deep].sort((a, b) => b.weight - a.weight)) {
		const highTop = top(high.cgroup);
		const against = [];
		for (const t of new Set(deep.map((d) => top(d.cgroup)))) {
			if (t === highTop || tw(t) < tw(highTop)) continue;
			const low = deep.filter((d) => top(d.cgroup) === t && d.weight < high.weight);
			if (!low.length) continue;
			const lowest = low.reduce((a, b) => (b.weight < a.weight ? b : a));
			against.push({ slice: t, weight: tw(t), lowest: lowest.cgroup, lowestWeight: lowest.weight });
		}
		if (!against.length) continue;
		const share = tw(highTop) / (tw(highTop) + Math.max(...against.map((a) => a.weight)));
		return {
			high: high.cgroup,
			weight: high.weight,
			slice: highTop,
			sliceWeight: tw(highTop),
			against,
			share,
		};
	}
	return null;
}

/**
 * `$health.ioWeight` out of the probe's `W ` lines: `{read: false, why}` when
 * the stanza did not finish or found no disk under root, else
 * `{read: true, ioCostAvailable, disks, weights, declared, diluted}`.
 *
 * @param {string[]} lines the `W `-prefixed lines, already stripped
 * @param {Record<string,string>} unknown the probe's `U` reasons
 */
export function ioWeightFacet(lines, unknown = {}) {
	if (unknown.ioWeight) return { read: false, why: unknown.ioWeight };
	const rows = (lines ?? []).map((l) => l.split('\t'));
	if (!rows.some((r) => r[0] === 'end')) {
		return { read: false, why: 'the io weight listing did not run to its end' };
	}
	const fail = rows.find((r) => r[0] === 'fail');
	if (fail) return { read: false, why: fail[1] || 'the root filesystem’s disks were not found' };
	const qos = new Map();
	for (const r of rows) {
		if (r[0] !== 'qos') continue;
		const q = parseQos(r[1]);
		if (q) qos.set(q.dev, q);
	}
	const ioCostAvailable = !rows.some((r) => r[0] === 'noiocost');
	const disks = rows
		.filter((r) => r[0] === 'disk' && r.length >= 4)
		.map(([, dev, name, scheduler]) => ({
			dev,
			name,
			scheduler,
			ioCost: ioCostAvailable ? qos.get(dev)?.enabled === true : null,
			ctrl: qos.get(dev)?.ctrl ?? null,
		}));
	if (!disks.length)
		return { read: false, why: 'no whole disk was listed under the root filesystem' };
	const weights = rows
		.filter((r) => r[0] === 'weight' && r.length >= 3 && /^\d+$/.test(r[2]))
		.map(([, cgroup, w]) => ({ cgroup, weight: Number(w) }));
	const declared = weights.filter((w) => w.cgroup.includes('/') && w.weight !== DEFAULT_IO_WEIGHT);
	return { read: true, ioCostAvailable, disks, weights, declared, diluted: dilution(weights) };
}

/** The exact line that turns io.cost on for one disk, automatic QoS and model. */
export const enableLine = (dev) => `${dev} enable=1 ctrl=auto`;

const range = (declared) => {
	const ws = declared.map((d) => d.weight);
	const lo = Math.min(...ws);
	const hi = Math.max(...ws);
	return declared.length === 1
		? `${declared[0].cgroup} declares io.weight ${lo}`
		: `${declared.length} cgroups declare io.weight ${lo === hi ? lo : `${lo}..${hi}`}`;
};

/**
 * The findings. All advisory and shadow.
 *
 * @param {{node: string, ioWeight?: ReturnType<typeof ioWeightFacet>}} health
 */
export function ioWeightFindings(health) {
	const quiet = (status, why, extra = {}) =>
		f(health, CATEGORY, ADVISORY, status, why, { shadow: true, ...extra });
	const w = health.ioWeight;
	if (!w) {
		return [
			quiet(
				'not-recorded',
				'this $health record has no io weight reading: it was written before the doctor ' +
					'checked whether the root disk enforces io.weight.'
			),
		];
	}
	if (!w.read) {
		return [quiet('unreadable', `io weights were not read: ${w.why}. Not read is not healthy.`)];
	}
	if (!w.declared.length) return [];
	const out = [];
	const loose = w.disks.filter((d) => !enforcing(d));
	if (loose.length) {
		const how = w.ioCostAvailable
			? `as root: ${loose.map((d) => `echo "${enableLine(d.dev)}" > /sys/fs/cgroup/io.cost.qos`).join('; ')} ` +
				'(scripts/io-cost.sh plans, applies and persists it)'
			: 'this kernel has no io.cost; only the bfq scheduler would enforce it';
		out.push(
			quiet(
				'unenforced',
				`${range(w.declared)}, but the root filesystem's ` +
					`${loose.map((d) => `${d.name} (${d.dev}, scheduler ${d.scheduler}, io.cost ${d.ioCost === null ? 'absent' : 'off'})`).join(', ')} ` +
					'enforces no weight, so every cgroup is served first come first served. ' +
					`Enforce it ${how}.`,
				{ disks: loose.map((d) => d.dev) }
			)
		);
	}
	const dl = w.diluted;
	if (dl) {
		out.push(
			quiet(
				'diluted',
				`${dl.high} declares io.weight ${dl.weight}, but its top-level slice ${dl.slice} weighs ` +
					`${dl.sliceWeight} against ${dl.against.map((a) => `${a.slice} ${a.weight} (holding ${a.lowest} at ${a.lowestWeight})`).join(', ')}. ` +
					'io.weight is shared down the tree, so while both are busy it gets at most ' +
					`${Math.round(dl.share * 100)}% of the disk, not what ${dl.weight} implies.`,
				{ high: dl.high, share: Number(dl.share.toFixed(3)) }
			)
		);
	}
	return out;
}

/** The one-line summary `fleet doctor` prints for the node. */
export function ioWeightLine(w) {
	if (!w) return 'not recorded';
	if (!w.read) return `unread: ${w.why}`;
	const disks = w.disks
		.map(
			(d) =>
				`${d.name} ${d.scheduler}${d.ioCost ? ' io.cost on' : d.scheduler === 'bfq' ? '' : ' UNENFORCED'}`
		)
		.join(', ');
	const decl = w.declared.length ? range(w.declared) : 'no cgroup declares a weight';
	const dil = w.diluted
		? `; ${w.diluted.high} capped at ${Math.round(w.diluted.share * 100)}%`
		: '';
	return `${disks}; ${decl}${dil}`;
}
