/**
 * THE GARAGE LAYOUT PLAN: declared against observed (storage bootcamp F6,
 * hadoku-fleet-manager#141). PURE: garage-apply.mjs reads the nodes and the
 * cluster, this decides, and `fleet garage-layout` prints it (a dry run) or
 * carries it out (`--apply`).
 *
 * One zone per node, the node's name as its zone and its tag, and its
 * capacity the sum of its declared disks. What is, is read from the cluster
 * (GetClusterLayout, GetClusterStatus) and from the node (the Garage detect,
 * the storage probe's disks, `df /`); garage-layout.json says only what
 * should be.
 *
 * THE RULES (operator-agreed), judged on the layout the change would leave:
 *
 *   ceiling   every declared disk's capacity fits under 80% of the disk as
 *             the node reports it. A zone on the root disk (claw-1) gets 80%
 *             less what the rest of the system already holds there.
 *   floor     never fewer than 3 healthy zones: 3 copies need 3 zones.
 *   n-plus-1  the free space outside the biggest zone holds that zone's used
 *             bytes, so losing it can be rebuilt. With exactly 3 zones there
 *             is nowhere to rebuild a third copy, so N+1 cannot hold; that is
 *             the pilot's KNOWN state, reported and never a refusal.
 *   drain     a zone leaves by draining: its role comes out of the layout,
 *             Garage moves its partitions, and only once no older layout
 *             version is still draining is the daemon stopped. A member the
 *             file does not declare is left in place, never dropped.
 *
 * A change that breaks a rule it did not already break (or breaks it by
 * more) is REFUSED unless `override` gives a reason; the reason is recorded.
 * "Could not look" (a disk the node did not report, a member with no use
 * reading) is refused and no override passes it: the fix is to look.
 */

export const FILL_CEILING = 0.8;
export const MIN_ZONES = 3;
export const BUCKET_PREFIX = 'dp-';

/** A role's fleet node: its first tag (what the apply writes), else its zone. */
const nodeOf = (role) => role?.tags?.[0] ?? role?.zone ?? null;

const gb = (b) => (b === null || b === undefined ? '?' : `${(b / 1e9).toFixed(1)} GB`);

/** `800G`, `3.2T`, `500000000`: decimal units, as Garage prints them. Bytes or null. */
export function parseSize(s) {
	const m = /^(\d+(?:\.\d+)?)\s*([KMGT]?)B?$/i.exec(String(s ?? '').trim());
	if (!m) return null;
	const mult = { '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2].toUpperCase()];
	return Math.floor(Number(m[1]) * mult);
}

const zoneCapacity = (z) => z.disks.reduce((a, d) => a + d.capacityBytes, 0);

/**
 * The per-disk ceiling for one declared disk, or why it cannot be judged.
 * @returns {{ ceiling: number } | { why: string }}
 */
export function diskCeiling(disk, obs, garageUsedHere) {
	if (!obs?.disks) return { why: `its disks were not read: ${obs?.disksWhy ?? 'no reading'}` };
	if (disk.root) {
		if (!obs.root)
			return { why: `its root filesystem was not read: ${obs.rootWhy ?? 'no reading'}` };
		const others = Math.max(0, obs.root.usedBytes - (garageUsedHere ?? 0));
		return { ceiling: Math.floor(FILL_CEILING * obs.root.sizeBytes) - others };
	}
	const d = obs.disks.find((x) => x.serial === disk.serial);
	if (!d) return { why: `the node reports no disk with serial ${disk.serial}` };
	return { ceiling: Math.floor(FILL_CEILING * d.sizeBytes) };
}

/**
 * PURE. The plan.
 *
 * @param {{
 *   declared: { zones: Record<string, { state: 'active'|'drain', disks: { serial: string, capacityBytes: number, root?: boolean }[] }> },
 *   cluster: object | null,   // garage-admin readCluster, or null when there is none
 *   state: import('./doctor-findings-pool.d.mts').GarageState | null,
 *   zones: Record<string, { probe: 'ok'|'absent'|'stopped'|'no-secrets'|'unreachable', why: string|null, nodeId: string|null,
 *     disks: { serial: string|null, sizeBytes: number }[] | null, disksWhy?: string,
 *     root: { sizeBytes: number, usedBytes: number } | null, rootWhy?: string }>,
 *   override?: string | null,
 *   secretsMissing?: string[],   // vault items this process does not hold (bring-up writes them)
 * }} input
 */
export function planLayout({
	declared,
	cluster,
	state,
	zones,
	override = null,
	secretsMissing = [],
}) {
	const roles = cluster?.layout?.roles ?? [];
	const byNode = new Map(roles.map((r) => [nodeOf(r), r]));
	const upById = new Map((cluster?.status?.nodes ?? []).map((n) => [n.id, n.isUp === true]));
	const usedByNode = new Map((state?.nodes ?? []).map((n) => [n.node, n.usedBytes]));
	const draining = (cluster?.history?.versions ?? []).filter((v) => v.status === 'Draining');

	const bringUp = [];
	const changes = [];
	const staged = [];
	const waiting = [];
	const known = [];

	for (const [node, z] of Object.entries(declared.zones).sort()) {
		const obs = zones[node] ?? { probe: 'unreachable', why: 'not probed', nodeId: null };
		const role = byNode.get(node);
		if (z.state === 'drain') {
			if (role) {
				changes.push({ node, kind: 'remove', from: role.capacity, to: null });
				staged.push({ id: role.id, remove: true });
			} else if (draining.length) {
				waiting.push({
					node,
					why: `out of the layout; layout version(s) ${draining.map((v) => v.version).join(', ')} still draining`,
				});
			} else if (obs.probe === 'ok' || obs.probe === 'stopped' || obs.probe === 'no-secrets') {
				changes.push({ node, kind: 'stop', from: null, to: null });
			} else {
				known.push({
					node,
					why: `drained and Garage is not on it: \`fleet garage-layout --forget ${node}\``,
				});
			}
			continue;
		}
		if (obs.probe !== 'ok') bringUp.push(...bringUpSteps(node, obs, secretsMissing));
		const capacity = zoneCapacity(z);
		if (!role) {
			changes.push({ node, kind: 'add', from: null, to: capacity });
			staged.push({ id: obs.nodeId, zone: node, capacity, tags: [node] });
		} else if (role.capacity !== capacity) {
			changes.push({ node, kind: 'resize', from: role.capacity, to: capacity });
			staged.push({ id: role.id, zone: node, capacity, tags: [node] });
		}
	}
	for (const r of roles) {
		const node = nodeOf(r);
		if (!declared.zones[node]) {
			known.push({
				node,
				why: `${node} is in the layout but not declared; left as it is. Declare it, or declare and --drain it.`,
			});
		}
	}
	if (draining.length && staged.length) {
		waiting.push({
			node: 'pool',
			why: `layout version(s) ${draining.map((v) => v.version).join(', ')} still draining: one layout change at a time`,
		});
	}

	// The layout as it would be, per node: capacity, used, healthy.
	const now = new Map(roles.map((r) => [nodeOf(r), r.capacity]));
	const after = new Map(now);
	for (const c of changes) {
		if (c.kind === 'remove') after.delete(c.node);
		else if (c.kind === 'add' || c.kind === 'resize') after.set(c.node, c.to);
	}
	const healthy = (node) => {
		const r = byNode.get(node);
		if (r) return upById.get(r.id) === true;
		return true; // a new zone: the apply re-plans once its bring-up is done, and it must be up then
	};
	const used = (node) => (byNode.has(node) ? (usedByNode.get(node) ?? null) : 0);

	const checks = [
		...ceilingChecks(declared, zones, usedByNode),
		floorCheck(now, after, healthy, changes.length > 0),
		nPlusOneCheck(now, after, used, changes.length > 0),
	];

	const breaks = checks.filter((c) => c.status === 'refused' || c.status === 'could-not-look');
	const lookFailures = breaks.filter((c) => c.status === 'could-not-look');
	const overridable = breaks.filter((c) => c.status === 'refused');
	const overridden = override && !lookFailures.length ? overridable.map((c) => c.rule) : [];
	const refused = lookFailures.length > 0 || (overridable.length > 0 && !override);

	const blocked = bringUp.some((s) => s.blocked);
	const layoutReady = !refused && !waiting.length && staged.length > 0;
	return {
		bringUp,
		changes,
		layout: layoutReady
			? {
					roles: staged,
					version: (cluster?.layout?.version ?? 0) + 1,
					pendingBringUp: bringUp.length > 0,
				}
			: null,
		checks,
		waiting,
		known,
		refused,
		blocked,
		overridden,
	};
}

function bringUpSteps(node, obs, secretsMissing) {
	if (obs.probe === 'unreachable') {
		return [{ node, step: 'reach', blocked: true, why: `${node} could not be read: ${obs.why}` }];
	}
	const steps = [];
	if (obs.probe === 'absent' || obs.probe === 'no-secrets') {
		steps.push({
			node,
			step: 'secrets',
			blocked: secretsMissing.length > 0,
			why: secretsMissing.length
				? `vault item(s) ${secretsMissing.join(', ')} are not in this process's environment ` +
					'(run under dev-vault once the vault holds them)'
				: 'write the RPC secret and admin token from the vault to /etc/garage/secrets',
		});
	}
	steps.push({
		node,
		step: 'install',
		why:
			obs.probe === 'stopped'
				? (obs.why ?? 'garage.service is not active')
				: 'install the pinned Garage, its config and unit, and start it',
	});
	return steps;
}

function ceilingChecks(declared, zones, usedByNode) {
	const out = [];
	for (const [node, z] of Object.entries(declared.zones).sort()) {
		if (z.state !== 'active') continue;
		for (const disk of z.disks) {
			const name = disk.root ? `${node} root` : `${node} ${disk.serial}`;
			const c = diskCeiling(disk, zones[node], usedByNode.get(node) ?? 0);
			if ('why' in c) {
				out.push({
					rule: 'ceiling',
					status: 'could-not-look',
					subject: name,
					why: `${name}: ${c.why}`,
				});
			} else if (disk.capacityBytes > c.ceiling) {
				out.push({
					rule: 'ceiling',
					status: 'refused',
					subject: name,
					why: `${name}: declared ${gb(disk.capacityBytes)} is over its 80% ceiling of ${gb(c.ceiling)}`,
				});
			} else {
				out.push({
					rule: 'ceiling',
					status: 'ok',
					subject: name,
					why: `${name}: ${gb(disk.capacityBytes)} under its ceiling of ${gb(c.ceiling)}`,
				});
			}
		}
	}
	return out;
}

function floorCheck(now, after, healthy, changing) {
	const count = (m) => [...m.keys()].filter(healthy).length;
	const before = count(now);
	const left = count(after);
	const why = `${left} healthy zone(s) after the change (${before} now); 3 copies need ${MIN_ZONES}`;
	if (left >= MIN_ZONES || !changing) {
		return { rule: 'floor', status: left >= MIN_ZONES ? 'ok' : 'known', why };
	}
	return { rule: 'floor', status: 'refused', why };
}

/**
 * The biggest zone by capacity, and the free space outside it against that
 * zone's used bytes. Null when a used reading is missing.
 */
function nPlusOneMargin(layout, used) {
	const nodes = [...layout.keys()];
	if (nodes.some((n) => used(n) === null)) return null;
	const biggest = nodes.reduce(
		(a, n) => (a === null || layout.get(n) > layout.get(a) ? n : a),
		null
	);
	const free = nodes
		.filter((n) => n !== biggest)
		.reduce((a, n) => a + Math.max(0, layout.get(n) - used(n)), 0);
	return { biggest, free, need: used(biggest), margin: free - used(biggest) };
}

function nPlusOneCheck(now, after, used, changing) {
	if (after.size <= MIN_ZONES) {
		return {
			rule: 'n-plus-1',
			status: 'known',
			why:
				`${after.size} zone(s) for 3 copies: no spare zone, so losing one cannot be rebuilt ` +
				`until a ${MIN_ZONES + 1}th joins. Known, not refused.`,
		};
	}
	const a = nPlusOneMargin(after, used);
	if (!a) {
		return {
			rule: 'n-plus-1',
			status: 'could-not-look',
			why: 'a member has no used-bytes reading, so N+1 was not summed',
		};
	}
	const why = `free outside ${a.biggest} (the biggest zone) is ${gb(a.free)}; it holds ${gb(a.need)}`;
	if (a.margin >= 0) return { rule: 'n-plus-1', status: 'ok', why };
	const b = now.size > MIN_ZONES ? nPlusOneMargin(now, used) : null;
	const worse = !b || b.margin >= 0 || a.margin < b.margin;
	if (!changing || !worse)
		return { rule: 'n-plus-1', status: 'known', why: `${why} (already short; not made worse)` };
	return { rule: 'n-plus-1', status: 'refused', why };
}

/** A tenant namespace becomes bucket `dp-<ns>`; S3 names are 3-63 of [a-z0-9-]. */
export function bucketAlias(ns) {
	const alias = `${BUCKET_PREFIX}${ns}`;
	if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(ns) || alias.length > 63) {
		throw new Error(
			`namespace ${JSON.stringify(ns)} does not make an S3 bucket name: lowercase letters, digits and inner hyphens, ` +
				`at most ${63 - BUCKET_PREFIX.length} characters`
		);
	}
	return alias;
}

/**
 * PURE. The bucket plan. `observed[ns]` holds GetBucketInfo for the alias and
 * GetKeyInfo for the key, each null when Garage said it does not exist, and
 * `error` when it could not be asked.
 *
 * A bucket is created through the admin API with its GLOBAL alias: S3's
 * CreateBucket makes a key-local one, and rotating the key would lose it by
 * name. The tenant key gets read and write, not owner. Nothing is ever
 * deleted here: a bucket nobody declares is reported, not removed.
 */
export function planBuckets({ declared, observed, buckets = [] }) {
	const ops = [];
	const problems = [];
	for (const [ns, b] of Object.entries(declared.buckets ?? {}).sort()) {
		const alias = bucketAlias(ns);
		const o = observed[ns];
		if (!o || o.error) {
			problems.push({ ns, why: `${alias} could not be read: ${o?.error ?? 'not asked'}` });
			continue;
		}
		if (!o.bucket) ops.push({ ns, op: 'create-bucket', alias });
		if (!o.key) ops.push({ ns, op: 'create-key', key: b.key });
		const grant = o.bucket?.keys?.find((k) => k.accessKeyId === o.key?.accessKeyId);
		if (!grant?.permissions?.read || !grant?.permissions?.write) {
			ops.push({ ns, op: 'grant', alias, key: b.key });
		}
	}
	const declaredAliases = new Set(Object.keys(declared.buckets ?? {}).map(bucketAlias));
	const undeclared = buckets
		.flatMap((b) => b.globalAliases ?? [])
		.filter((a) => a.startsWith(BUCKET_PREFIX) && !declaredAliases.has(a));
	return { ops, problems, undeclared };
}
