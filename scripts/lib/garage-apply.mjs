/**
 * THE GARAGE LAYOUT, OBSERVED AND CARRIED OUT (storage bootcamp F6,
 * hadoku-fleet-manager#141). The I/O around garage-layout.mjs's pure plan.
 *
 * Everything reaches a node through `ctx`, so `fleet garage-layout` hands it
 * fleet-exec and the integration test hands it a real local cluster:
 *   ctx.exec(node, script, opts)  a script on the node as admin (runOn's result)
 *   ctx.admin(node)               that node's admin API (garage-admin.mjs)
 *   ctx.rpcAddr(node)             `<addr>:3901` peers dial it on
 *   ctx.secrets                   { GARAGE_RPC_SECRET, GARAGE_ADMIN_TOKEN } held
 *
 * BRING-UP COMES FIRST, and it is this module's. F4's REPAIRS entry installs
 * Garage only on a node that already offers `storage`, and a node earns that
 * only as a layout member (F0), so a declared zone's first install, and the
 * secrets it needs, are done here: the same GARAGE_REPAIR script, the same
 * secret files. From then on the toolchain floor keeps it.
 *
 * PEERS DIAL BY ADDRESS. The daemon's `rpc_public_addr` is unset and Garage
 * autodetects the LAN address, so the apply connects every new node by an
 * explicit `<id>@<addr>` that `ctx.rpcAddr` resolves (the tailnet name).
 */
import {
	ROOT_ZONE_DATA_DIR,
	ROOT_ZONE_DIR,
	ROOT_ZONE_RESERVE,
} from '../../dist/lib/capability-registry-storage.js';
import { GARAGE_USER, GARAGE_USER_SH, STORAGE_ROOT } from './storage-format.mjs';
import {
	GARAGE_DATA_DIRS_FILE,
	GARAGE_DETECT,
	GARAGE_RELEASE,
	GARAGE_REPAIR,
	GARAGE_SECRET_DIR,
	GARAGE_SECRET_ITEMS,
} from './toolchain-garage.mjs';
import { GarageAdminError, garageState, readCluster } from './garage-admin.mjs';
import { bucketAlias } from './garage-layout.mjs';
import { readInventory } from './qualify-disk-inventory.mjs';

const why = (r) =>
	String(r?.error || r?.stderr || r?.stdout || 'no output')
		.trim()
		.slice(-300);

/** `df` of `/`, in bytes: the ceiling of a zone that shares the root disk. */
export const ROOT_DF = 'df -B1 --output=size,used / | tail -n 1';

/** PURE. GARAGE_DETECT's answer as a probe state. */
export function detectState(out) {
	const line =
		String(out ?? '')
			.trim()
			.split('\n')[0] ?? '';
	if (line === 'OK') return { probe: 'ok', why: null };
	if (!line) return { probe: 'absent', why: 'Garage is not installed' };
	const reason = line.replace(/^WHY /, '');
	if (/vault item/.test(reason)) return { probe: 'no-secrets', why: reason };
	return { probe: 'stopped', why: reason };
}

/**
 * One declared zone, as the node reports it: Garage's state, its node id,
 * its disks and its root filesystem. Never throws; what could not be read
 * says why.
 */
export async function probeZone(ctx, node) {
	const d = await ctx.exec(node, GARAGE_DETECT, { timeoutMs: 30_000 });
	if (!d?.ok) {
		return {
			probe: 'unreachable',
			why: why(d),
			nodeId: null,
			disks: null,
			disksWhy: why(d),
			root: null,
		};
	}
	const out = {
		...detectState(d.stdout),
		nodeId: null,
		disks: null,
		disksWhy: null,
		root: null,
		rootWhy: null,
	};
	if (out.probe === 'ok') {
		try {
			const info = await ctx.admin(node).call('GET', 'GetNodeInfo?node=self');
			out.nodeId = Object.values(info?.success ?? {})[0]?.nodeId ?? null;
		} catch (e) {
			out.probe = 'stopped';
			out.why = `garage.service is active but its admin API did not answer: ${e instanceof Error ? e.message : e}`;
		}
	}
	const inv = await readInventory({ exec: (script, opts) => ctx.exec(node, script, opts) });
	if ('error' in inv) out.disksWhy = inv.error;
	else out.disks = inv.inventory.disks.map((x) => ({ serial: x.serial, sizeBytes: x.sizeBytes }));
	const df = await ctx.exec(node, ROOT_DF, { timeoutMs: 30_000 });
	const [size, used] = String(df?.stdout ?? '')
		.trim()
		.split(/\s+/)
		.map(Number);
	if (df?.ok && Number.isFinite(size) && Number.isFinite(used) && size > 0) {
		out.root = { sizeBytes: size, usedBytes: used };
	} else {
		out.rootWhy = why(df);
	}
	const zf = await ctx.exec(node, ZONE_FILES, { timeoutMs: 120_000 });
	if (zf?.ok) Object.assign(out, parseZoneFiles(zf.stdout));
	else {
		out.dataDirs = null;
		out.rootZone = null;
		out.rootZoneWhy = why(zf);
	}
	return out;
}

/**
 * The node's own record of what the layout gave it: the data-dirs file, the
 * root zone's CI reserve, whether its directory exists, and that directory's
 * size (`du`, as root: the dir is the garage user's, 0750). Sections are split
 * by a line of `@@`.
 */
export const ZONE_FILES = [
	`cat ${GARAGE_DATA_DIRS_FILE} 2>/dev/null || true`,
	'echo @@',
	`cat ${ROOT_ZONE_RESERVE} 2>/dev/null || true`,
	'echo @@',
	`if [ -d ${ROOT_ZONE_DATA_DIR} ]; then echo yes; sudo -n du -sxb ${ROOT_ZONE_DATA_DIR} | cut -f1; fi`,
].join('\n');

/** PURE. {@link ZONE_FILES}'s output. */
export function parseZoneFiles(text) {
	const [dd = '', reserve = '', dir = ''] = String(text ?? '').split(/^@@\n/m);
	const [present, du] = dir.trim().split('\n');
	const mb = reserve.trim();
	return {
		dataDirs: dd,
		rootZone: {
			dir: present === 'yes',
			reserveMb: /^\d+$/.test(mb) ? Number(mb) : null,
			duBytes: present === 'yes' && /^\d+$/.test(du ?? '') ? Number(du) : null,
		},
		rootZoneWhy: null,
	};
}

/**
 * The cluster, read through the first declared zone whose Garage answers.
 * `{ cluster: null, why }` when none does: for a pool not brought up yet
 * that is the truth, and the plan starts from an empty layout.
 */
export async function observeCluster(ctx, zones) {
	for (const [node, z] of Object.entries(zones)) {
		if (z.probe !== 'ok') continue;
		const cluster = await readCluster(ctx.admin(node));
		if (cluster.layout && cluster.status)
			return { cluster, state: garageState(cluster), via: node, why: null };
	}
	return { cluster: null, state: null, via: null, why: 'no declared zone runs Garage yet' };
}

/** Everything the plan reads. */
export async function observe(ctx, declared) {
	const zones = {};
	for (const node of Object.keys(declared.zones).sort()) zones[node] = await probeZone(ctx, node);
	return { zones, ...(await observeCluster(ctx, zones)) };
}

/** The bring-up script that writes the secret files: both, root 0600, from heredocs. */
export function secretsScript(secrets) {
	const lines = ['set -e', `sudo -n install -d -m 0711 ${GARAGE_SECRET_DIR}`];
	for (const item of GARAGE_SECRET_ITEMS) {
		if (!secrets[item]) throw new Error(`vault item ${item} is not in this process's environment`);
		const tag = `${item}_EOF`;
		lines.push(
			`sudo -n sh -c 'umask 077; cat > ${GARAGE_SECRET_DIR}/${item}.new && mv -f ${GARAGE_SECRET_DIR}/${item}.new ${GARAGE_SECRET_DIR}/${item}' <<'${tag}'`,
			secrets[item],
			tag
		);
	}
	return lines.join('\n');
}

/** Carry out bring-up steps. Throws on the first that fails, naming it. */
/** The root zone's directory, owned by the static garage user, and CI's reserve beside it. */
export function rootDirScript(reserveMb) {
	if (!Number.isInteger(reserveMb) || reserveMb <= 0)
		throw new Error(`reserve ${reserveMb} MB is not a quota`);
	return [
		'set -e',
		"sudo -n sh -s <<'ROOT_DIR_EOF'",
		'set -e',
		...GARAGE_USER_SH,
		`install -d -m 0755 ${STORAGE_ROOT} ${ROOT_ZONE_DIR}`,
		`install -d -m 0750 -o ${GARAGE_USER} -g ${GARAGE_USER} ${ROOT_ZONE_DATA_DIR}`,
		`printf '%s\\n' ${reserveMb} > ${ROOT_ZONE_RESERVE}.new && chmod 0644 ${ROOT_ZONE_RESERVE}.new && mv -f ${ROOT_ZONE_RESERVE}.new ${ROOT_ZONE_RESERVE}`,
		'ROOT_DIR_EOF',
	].join('\n');
}

/** The data-dirs file F4's repair renders the config around. */
export function dataDirsScript(text) {
	return [
		'set -e',
		'tmp="$(mktemp)"',
		'trap \'rm -f "$tmp"\' EXIT',
		'cat > "$tmp" <<\'DATA_DIRS_EOF\'',
		text.replace(/\n$/, ''),
		'DATA_DIRS_EOF',
		`sudo -n install -D -m 0644 "$tmp" ${GARAGE_DATA_DIRS_FILE}`,
	].join('\n');
}

/** The script one bring-up step runs on its node. */
export function stepScript(ctx, s) {
	if (s.step === 'secrets') return secretsScript(ctx.secrets);
	if (s.step === 'root-dir') return rootDirScript(s.reserveMb);
	if (s.step === 'data-dirs') return dataDirsScript(s.text);
	if (s.step === 'install')
		return `export TARGET_VERSION=${GARAGE_RELEASE.version}\n${GARAGE_REPAIR}`;
	throw new Error(`${s.node}: no script for bring-up step ${s.step}`);
}

/** Carry out bring-up steps. Throws on the first that fails, naming it. */
export async function applyBringUp(ctx, steps) {
	for (const s of steps) {
		if (s.blocked) throw new Error(`${s.node} ${s.step}: ${s.why}`);
		ctx.log(`   ${s.node}: ${s.step}`);
		const r = await ctx.exec(s.node, stepScript(ctx, s), { timeoutMs: 900_000 });
		if (!r?.ok) throw new Error(`${s.node} ${s.step} failed: ${why(r)}`);
	}
}

/**
 * Poll GetClusterHealth on EVERY one of `nodes` until each calls the cluster
 * healthy with all of them up. One node's view is not enough: measured on a
 * real v2.5.0 cluster, right after the apply the node that dialled saw 3 up
 * while a peer still saw 1, until gossip caught up.
 */
export async function waitHealthy(ctx, nodes, { timeoutMs = 120_000, everyMs = 500 } = {}) {
	const until = Date.now() + timeoutMs;
	const last = {};
	for (;;) {
		let ok = true;
		for (const node of nodes) {
			try {
				const h = await ctx.admin(node).call('GET', 'GetClusterHealth');
				last[node] = `${h.status}, ${h.storageNodesUp}/${h.storageNodes} up`;
				if (h.status !== 'healthy' || h.storageNodesUp < nodes.length) ok = false;
			} catch (e) {
				last[node] = e instanceof Error ? e.message : String(e);
				ok = false;
			}
		}
		if (ok) return last;
		if (Date.now() > until) {
			throw new Error(
				`the cluster was not healthy on every zone within ${timeoutMs / 1000}s: ${JSON.stringify(last)}`
			);
		}
		await new Promise((r) => setTimeout(r, everyMs));
	}
}

/**
 * Apply a ready layout through `via`: connect every new node, stage the
 * roles, apply the version, wait until every storage node is up.
 */
export async function applyLayout(ctx, via, layout, zones) {
	// A node not in any cluster yet still answers with its own status.
	const status = await ctx.admin(via).call('GET', 'GetClusterStatus');
	const known = new Set((status.nodes ?? []).filter((n) => n.isUp).map((n) => n.id));
	const dial = [];
	for (const [node, z] of Object.entries(zones)) {
		if (z.nodeId && !known.has(z.nodeId)) dial.push(`${z.nodeId}@${await ctx.rpcAddr(node)}`);
	}
	if (dial.length) {
		const res = await ctx.admin(via).call('POST', 'ConnectClusterNodes', dial);
		const bad = res.map((r, i) => (r.success ? null : `${dial[i]}: ${r.error}`)).filter(Boolean);
		if (bad.length) throw new Error(`connect refused: ${bad.join('; ')}`);
	}
	const missing = layout.roles.filter((r) => !r.remove && !r.id);
	if (missing.length) throw new Error(`no node id for ${missing.map((r) => r.zone).join(', ')}`);
	await ctx.admin(via).call('POST', 'UpdateClusterLayout', { roles: layout.roles });
	try {
		await ctx.admin(via).call('POST', 'ApplyClusterLayout', { version: layout.version });
	} catch (e) {
		// Unstage, so the next plan starts from the applied layout, and say if even that failed.
		const reason = e instanceof Error ? e.message : String(e);
		try {
			await ctx.admin(via).call('POST', 'RevertClusterLayout');
		} catch (r) {
			throw new Error(
				`${reason}; and the staged change could not be reverted: ${r instanceof Error ? r.message : r}`
			);
		}
		throw new Error(`${reason}; the staged change was reverted`);
	}
	const applied = await ctx.admin(via).call('GET', 'GetClusterLayout');
	return waitHealthy(
		ctx,
		applied.roles.map((r) => r.tags?.[0] ?? r.zone)
	);
}

/** Stop the daemon on a drained node. */
export async function stopZone(ctx, node) {
	const r = await ctx.exec(node, 'sudo -n systemctl disable --now garage.service', {
		timeoutMs: 60_000,
	});
	if (!r?.ok) throw new Error(`${node}: stopping garage.service failed: ${why(r)}`);
}

const absent = (e, code) =>
	e instanceof GarageAdminError && e.status === 404 && (!code || e.code === code);

/** What Garage holds for each declared namespace, for planBuckets. */
export async function observeBuckets(admin, declared) {
	const observed = {};
	for (const [ns, b] of Object.entries(declared.buckets ?? {})) {
		const o = { bucket: null, key: null, error: null };
		try {
			o.bucket = await admin.call(
				'GET',
				`GetBucketInfo?globalAlias=${encodeURIComponent(bucketAlias(ns))}`
			);
		} catch (e) {
			if (!absent(e, 'NoSuchBucket')) o.error = e instanceof Error ? e.message : String(e);
		}
		try {
			o.key = await admin.call('GET', `GetKeyInfo?search=${encodeURIComponent(b.key)}`);
		} catch (e) {
			if (!absent(e, 'NoSuchAccessKey')) o.error = e instanceof Error ? e.message : String(e);
		}
		observed[ns] = o;
	}
	return observed;
}

/**
 * Carry out bucket ops in order (create-bucket, create-key, grant per
 * namespace). The key's secret is never printed: it is read back from Garage
 * (`GetKeyInfo?showSecretKey=true`) by whatever delivers it to the tenant.
 */
export async function applyBuckets(ctx, admin, ops) {
	for (const op of ops) {
		ctx.log(`   ${op.ns}: ${op.op}`);
		if (op.op === 'create-bucket') {
			await admin.call('POST', 'CreateBucket', { globalAlias: op.alias });
		} else if (op.op === 'create-key') {
			await admin.call('POST', 'CreateKey', { name: op.key });
		} else if (op.op === 'grant') {
			const bucket = await admin.call(
				'GET',
				`GetBucketInfo?globalAlias=${encodeURIComponent(op.alias)}`
			);
			const key = await admin.call('GET', `GetKeyInfo?search=${encodeURIComponent(op.key)}`);
			await admin.call('POST', 'AllowBucketKey', {
				bucketId: bucket.id,
				accessKeyId: key.accessKeyId,
				permissions: { read: true, write: true, owner: false },
			});
		}
	}
}
