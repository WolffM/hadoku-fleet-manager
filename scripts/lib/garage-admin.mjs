/**
 * THE GARAGE ADMIN API, and the one reader of a cluster's state (storage
 * bootcamp F6, hadoku-fleet-manager#141). Garage v2.5.0's `/v2/<Endpoint>`
 * API; every shape below was read off a real 3-zone v2.5.0 cluster
 * (hadoku-dataplatform's server/tests/garage harness), not the docs.
 *
 * TWO TRANSPORTS, ONE INTERFACE: `call(method, endpoint, body?)` resolves to
 * the parsed JSON or throws a {@link GarageAdminError} that carries Garage's
 * own status and code (NoSuchBucket, BucketAlreadyExists, ...).
 *   - {@link httpAdmin}: a URL and a token in this process. The integration
 *     test drives a real cluster through it.
 *   - {@link nodeAdmin}: curl on a member node, as admin, against its loopback
 *     admin port (3903 is bound to 127.0.0.1 only; toolchain-garage.mjs). The
 *     token is read there with `sudo -n` and handed to curl on a pipe through
 *     the shell's builtin printf, so it is never in any argv or on this box.
 *
 * {@link readCluster} is the reader the layout plan and the doctor share, and
 * {@link garageState} turns what it read into the doctor's typed
 * `GarageState` (doctor-findings-pool.d.mts).
 */

import { GARAGE_SECRET_DIR } from './toolchain-garage.mjs';

export const ADMIN_PORT = 3903;
export const RPC_PORT = 3901;
const TOKEN_FILE = `${GARAGE_SECRET_DIR}/GARAGE_ADMIN_TOKEN`;

export class GarageAdminError extends Error {
	/**
	 * @param {string} message
	 * @param {{ status?: number|null, code?: string|null }} [detail]
	 */
	constructor(message, { status = null, code = null } = {}) {
		super(message);
		this.name = 'GarageAdminError';
		this.status = status;
		this.code = code;
	}
}

/** Garage's error document is `{ code, message, region, path }`. */
function errorFrom(where, status, text) {
	let code = null;
	let message = String(text ?? '').slice(0, 300);
	try {
		const doc = JSON.parse(text);
		code = doc.code ?? null;
		message = doc.message ?? message;
	} catch {
		// not JSON: the raw text, cut, is the reason
	}
	return new GarageAdminError(`${where}: HTTP ${status}${code ? ` ${code}` : ''}: ${message}`, {
		status,
		code,
	});
}

/** The admin API in this process: `url` like `http://127.0.0.1:3903`. */
export function httpAdmin({ url, token, timeoutMs = 15_000 }) {
	return {
		where: url,
		async call(method, endpoint, body) {
			const res = await fetch(`${url}/v2/${endpoint}`, {
				method,
				headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			});
			const text = await res.text();
			if (!res.ok) throw errorFrom(`${method} ${endpoint}`, res.status, text);
			return text ? JSON.parse(text) : null;
		},
	};
}

/** Quote for a POSIX shell: the body goes in a quoted heredoc, this is for the URL. */
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * The script {@link nodeAdmin} runs: one admin call on the node's loopback.
 * Prints the response body, then the HTTP status on a line of its own.
 * Exported for the test that holds the token out of every argv.
 */
export function nodeAdminScript(method, endpoint, body) {
	const lines = [
		'set -e',
		'tmp="$(mktemp -d)"',
		'trap \'rm -rf "$tmp"\' EXIT',
		`tok="$(sudo -n cat ${TOKEN_FILE})"`,
	];
	if (body !== undefined) {
		lines.push('cat > "$tmp/body" <<\'GARAGE_BODY_EOF\'', JSON.stringify(body), 'GARAGE_BODY_EOF');
	}
	lines.push(
		// printf is a builtin: the token reaches curl on stdin, never in argv.
		`printf 'Authorization: Bearer %s\\n' "$tok" | curl -sS --max-time 15 -H @- ` +
			`-H 'Content-Type: application/json' -X ${method} ` +
			(body !== undefined ? '--data-binary @"$tmp/body" ' : '') +
			`-w '\\n%{http_code}\\n' ${sq(`http://127.0.0.1:${ADMIN_PORT}/v2/${endpoint}`)}`
	);
	return lines.join('\n');
}

/**
 * The admin API of `node`, through `exec(script)` (fleet-exec's `runOn` as
 * admin: `(script) => runOn(node, script, { as: 'admin' })`).
 */
export function nodeAdmin(node, exec) {
	return {
		where: node,
		async call(method, endpoint, body) {
			const r = await exec(nodeAdminScript(method, endpoint, body));
			const out = String(r?.stdout ?? '').replace(/\n+$/, '');
			const cut = out.lastIndexOf('\n');
			const status = Number(cut >= 0 ? out.slice(cut + 1) : out);
			if (!r?.ok || !Number.isInteger(status) || status === 0) {
				throw new GarageAdminError(
					`${node} ${method} ${endpoint}: the admin call did not run: ` +
						String(r?.error || r?.stderr || out || 'no output')
							.trim()
							.slice(0, 300)
				);
			}
			const text = cut >= 0 ? out.slice(0, cut) : '';
			if (status < 200 || status >= 300)
				throw errorFrom(`${node} ${method} ${endpoint}`, status, text);
			return text ? JSON.parse(text) : null;
		},
	};
}

/**
 * Everything the plan and the doctor read, in one pass. Each part is read on
 * its own and a failed part is `null` with its reason in `errors`, so one
 * refused endpoint is not the whole cluster unread.
 */
export async function readCluster(admin) {
	const parts = {
		status: 'GetClusterStatus',
		health: 'GetClusterHealth',
		layout: 'GetClusterLayout',
		history: 'GetClusterLayoutHistory',
		statistics: 'GetClusterStatistics',
		nodeStats: 'GetNodeStatistics?node=*',
		buckets: 'ListBuckets',
	};
	const out = { via: admin.where, errors: {} };
	for (const [k, endpoint] of Object.entries(parts)) {
		try {
			out[k] = await admin.call('GET', endpoint);
		} catch (e) {
			out[k] = null;
			out.errors[k] = e instanceof Error ? e.message : String(e);
		}
	}
	return out;
}

/** The fleet node a layout role belongs to: its first tag, which the apply writes. */
export const roleNode = (role) => role?.tags?.[0] ?? role?.zone ?? null;

/**
 * PURE. A cluster as the doctor's `GarageState`.
 *
 * - `replicationFactor`: copies the ASSIGNMENT holds, the sum of every role's
 *   `storedPartitions` over the partition count. The admin API states no
 *   factor, and this is what the cluster actually does.
 * - `usedBytes` per node: the cluster's object bytes times the node's share of
 *   partitions. Garage reports no per-node use; a filesystem's `used` would
 *   count everything else on that disk (claw-1's pool is on its root).
 * - `underReplicatedBlocks`: blocks queued for resync plus blocks with resync
 *   errors on every node. Null when any node's statistics were not read.
 *
 * @returns {import('./doctor-findings-pool.d.mts').GarageState}
 */
export function garageState(c, at = new Date().toISOString()) {
	const roles = c?.layout?.roles ?? [];
	const partitions = c?.health?.partitions ?? null;
	const stored = roles.reduce((a, r) => a + (r.storedPartitions ?? 0), 0);
	const replicationFactor =
		c?.layout && partitions ? Math.round(stored / partitions) || null : null;
	const statusById = new Map((c?.status?.nodes ?? []).map((n) => [n.id, n]));
	const objectBytes = c?.statistics?.totalObjectBytes ?? null;
	const nodes = roles.map((r) => {
		const s = statusById.get(r.id);
		return {
			node: roleNode(r),
			zone: r.zone ?? null,
			up: s?.isUp === true,
			capacityBytes: typeof r.capacity === 'number' ? r.capacity : null,
			usedBytes:
				objectBytes === null || !partitions || r.storedPartitions == null
					? null
					: Math.round((objectBytes * r.storedPartitions) / partitions),
		};
	});
	let underReplicatedBlocks = null;
	const stats = c?.nodeStats;
	if (stats && Object.keys(stats.error ?? {}).length === 0) {
		const each = Object.values(stats.success ?? {}).map((s) => s.blockManagerStats);
		if (each.length === roles.length && each.every(Boolean)) {
			underReplicatedBlocks = each.reduce(
				(a, b) => a + (b.resyncQueueLen ?? 0) + (b.resyncErrors ?? 0),
				0
			);
		}
	}
	return { replicationFactor, nodes, underReplicatedBlocks, at };
}

/**
 * The doctor's pool input: the cluster read through the first member whose
 * admin API answers, as a `GarageState`. `{ garage: null, why }` names every
 * member tried and why each one could not be read; "could not look" is never
 * an empty pool.
 *
 * @param {string[]} members nodes that offer `storage`
 * @param {(node: string) => (script: string) => Promise<object>} execFor
 */
export async function readPool(members, execFor, at = new Date().toISOString()) {
	const tried = [];
	for (const node of members) {
		const c = await readCluster(nodeAdmin(node, execFor(node)));
		if (c.layout && c.status) return { garage: garageState(c, at), why: null, via: node };
		tried.push(`${node}: ${c.errors.layout ?? c.errors.status}`);
	}
	return {
		garage: null,
		why: tried.length
			? `no member's admin API answered (${tried.join('; ')})`
			: 'no member to read',
		via: null,
	};
}
