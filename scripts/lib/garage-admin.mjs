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

import { GARAGE_CONFIG, GARAGE_SECRET_DIR } from './toolchain-garage.mjs';

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
 *   errors on every node up. Null when an up node's statistics were not read,
 *   and `underReplicatedWhy` names which and why. A node the cluster reports
 *   down is not counted: it is a pool-node/down finding of its own.
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
		const b = c?.nodeStats?.success?.[r.id]?.blockManagerStats;
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
			resyncErrors: typeof b?.resyncErrors === 'number' ? b.resyncErrors : null,
		};
	});
	// A member the cluster reports DOWN has no statistics to give (the drill of
	// 2026-11-24: claw-9 stopped, its entry in `error`). Its absence is the
	// pool-node/down finding, not an unread count: the members up are summed.
	// Any member UP whose statistics are missing leaves the count unread, named.
	let underReplicatedBlocks = null;
	let underReplicatedWhy = null;
	const stats = c?.nodeStats;
	if (!stats) {
		underReplicatedWhy = `GetNodeStatistics was not read: ${c?.errors?.nodeStats ?? 'no answer'}`;
	} else {
		const missing = [];
		let sum = 0;
		for (const r of roles) {
			const b = stats.success?.[r.id]?.blockManagerStats;
			if (b) sum += (b.resyncQueueLen ?? 0) + (b.resyncErrors ?? 0);
			else if (statusById.get(r.id)?.isUp !== false)
				missing.push(`${roleNode(r)}: ${String(stats.error?.[r.id] ?? 'no block statistics')}`);
		}
		if (missing.length) underReplicatedWhy = missing.join('; ');
		else underReplicatedBlocks = sum;
	}
	return { replicationFactor, nodes, underReplicatedBlocks, underReplicatedWhy, at };
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

/**
 * EVERY MEMBER'S OWN VIEW, one by one. One observer is not enough: measured
 * on the pilot (2026-11-24, #154), claw-1 saw 3/3 while claw-8 and claw-9
 * each saw claw-1 as never seen, and a reader through claw-1 called that
 * green. `waitHealthy` (garage-apply.mjs) and `ci:storage-pool` both read
 * through this.
 *
 * Per node: `{ node, health, status, why }`, where `health` is
 * GetClusterHealth and `status` GetClusterStatus as THAT node answers them.
 * Both are `null` (and `why` says why) when the node could not be read.
 *
 * @param {string[]} nodes
 * @param {(node: string) => { call: Function }} adminFor
 * @param {((node: string) => (script: string) => Promise<object>) | null} [execFor] counts each member's quarantine ({@link CORRUPTED_COUNT}) when given
 */
export async function readMemberViews(nodes, adminFor, execFor = null) {
	const views = [];
	for (const node of nodes) {
		const v = { node, health: null, status: null, why: null };
		try {
			v.health = await adminFor(node).call('GET', 'GetClusterHealth');
			v.status = await adminFor(node).call('GET', 'GetClusterStatus');
		} catch (e) {
			v.why = e instanceof Error ? e.message : String(e);
		}
		if (execFor) Object.assign(v, parseCorrupted(await execFor(node)(CORRUPTED_COUNT)));
		views.push(v);
	}
	return views;
}

/**
 * Garage's QUARANTINE, counted (#154 scope, the 2026-11-24 drill): a block
 * that fails its checksum is restored from a peer and the bad copy is kept as
 * `<hash>.zst.corrupted` beside it. Nothing else reads those files, and they
 * are the earliest sign of a disk going bad. `sudo -n` because the dirs are the
 * garage user's, 0750.
 *
 * THE WALK OUTLIVES THE READ (fleet-manager#166). Counting means a readdir of
 * every one of a data dir's ~65k block directories. Warm, claw-1 does one
 * top-level dir in 24 ms; cold, on its HDD under CI load, 3.5 s, so a full
 * cold walk is ~15 min. An hourly read with a 120 s ceiling therefore failed
 * there (130-149 s, 4 of ~48 runs on 11-24/25; >300 s measured 11-26). So the
 * walk runs DETACHED on the node under a lock, the read waits up to
 * {@link CORRUPTED_WAIT_SEC} for it, and then prints the newest COMPLETED count
 * with the time it finished. A fast node answers exactly as before: a count
 * walked this run. A slow one answers with the previous walk, and
 * {@link parseCorrupted} says "could not look" once that count is older than
 * {@link CORRUPTED_MAX_AGE_SEC}, so a walk that never finishes still fails.
 *
 * Output, one line each: `<count> <path>` per data dir and `at <epoch>` (from
 * the newest completed walk, absent before the first), `err <text>` when the
 * last walk failed, and `now <epoch>`.
 */
export const CORRUPTED_WAIT_SEC = 90;
/** Six hourly reads in a row with no completed walk is no longer a count. */
export const CORRUPTED_MAX_AGE_SEC = 6 * 3600;

/**
 * The script, with its seams named so a test can run it for real against a
 * temporary tree: the config file, the privilege prefix, the state dir.
 */
export function corruptedCountScript({
	config = GARAGE_CONFIG,
	sudo = 'sudo -n',
	stateDir = '"$HOME/.cache/fleet-garage"',
	waitSec = CORRUPTED_WAIT_SEC,
} = {}) {
	return [
		'set -eo pipefail',
		`paths="$(${sudo} grep -E '^data_dir' ${config} | grep -oE 'path = "[^"]+"' | sed -E 's/^path = "(.*)"$/\\1/')"`,
		`[ -n "$paths" ] || { echo "no data_dir path in ${config}" >&2; exit 1; }`,
		`d=${stateDir}; mkdir -p "$d"; out="$d/garage-corrupted"`,
		'walk() {',
		// A fresh `bash -c` inherits no shell options: without this, a find that
		// fails piped into wc reads as a count of 0.
		'  set -o pipefail',
		`  trap 'printf "walk killed by a signal at %s\\n" "$(date -u +%FT%TZ)" > "$out.err"; exit 1' TERM INT HUP`,
		'  t="$out.tmp"; : > "$t"',
		'  for p in $paths; do',
		`    if ! n="$(${sudo} nice -n 19 find "$p" -type f -name '*.corrupted' | wc -l)"; then`,
		`      printf 'find failed in %s at %s\\n' "$p" "$(date -u +%FT%TZ)" > "$out.err"; rm -f "$t"; return 1`,
		'    fi',
		`    printf '%s %s\\n' "$n" "$p" >> "$t"`,
		'  done',
		`  printf 'at %s\\n' "$(date +%s)" >> "$t"; mv "$t" "$out"; rm -f "$out.err"`,
		'}',
		// Its own session (setsid), so the hangup when this ssh session closes
		// never reaches sudo or find: a plain background subshell died with it
		// on claw-1 (11-26). The lock is held by the walker's inherited
		// descriptor, so the wait below ends when the walk does, whichever read
		// started it.
		'export out paths; export -f walk',
		'exec 9>"$out.lock"',
		'if flock -n 9; then setsid -f bash -c walk </dev/null >/dev/null 2>&1; fi',
		'exec 9>&-',
		`flock -w ${waitSec} "$out.lock" true || true`,
		'[ ! -f "$out" ] || cat "$out"',
		`[ ! -f "$out.err" ] || printf 'err %s\\n' "$(cat "$out.err")"`,
		`printf 'now %s\\n' "$(date +%s)"`,
	].join('\n');
}

export const CORRUPTED_COUNT = corruptedCountScript();

/**
 * PURE. {@link CORRUPTED_COUNT}'s result as `{ corrupted, corruptedWhy,
 * corruptedAgeSec }`: per data dir `{ path, disk, count }`, the disk being the
 * serial of `<storage root>/<serial>/garage` (`root` for a root zone): the
 * directory above the data dir. `corruptedAgeSec` is how long ago the walk
 * that counted them finished.
 */
export function parseCorrupted(r) {
	const fail = (why) => ({ corrupted: null, corruptedWhy: why });
	if (!r?.ok)
		return fail(
			String(r?.error || r?.stderr || r?.stdout || 'no output')
				.trim()
				.slice(-300)
		);
	const corrupted = [];
	let at = null;
	let now = null;
	let err = null;
	for (const line of String(r.stdout ?? '')
		.trim()
		.split('\n')) {
		const t = line.trim();
		let m;
		if ((m = /^at (\d+)$/.exec(t))) at = Number(m[1]);
		else if ((m = /^now (\d+)$/.exec(t))) now = Number(m[1]);
		else if ((m = /^err (.*)$/.exec(t))) err = m[1];
		else if ((m = /^(\d+) (\/\S+)$/.exec(t))) {
			const disk = m[2].split('/').filter(Boolean).at(-2) ?? m[2];
			corrupted.push({ path: m[2], disk, count: Number(m[1]) });
		} else return fail(`unexpected line: ${line.slice(0, 120)}`);
	}
	const lastErr = err ? `; the last walk failed: ${err}` : '';
	if (now === null) return fail('the count printed no clock line');
	if (at === null)
		return fail(
			err
				? `no walk has completed${lastErr}`
				: `no walk has completed yet: the first is still running after ${CORRUPTED_WAIT_SEC}s`
		);
	const age = now - at;
	if (age > CORRUPTED_MAX_AGE_SEC)
		return fail(
			`the newest completed count is ${(age / 3600).toFixed(1)} h old, over ` +
				`${CORRUPTED_MAX_AGE_SEC / 3600} h${lastErr || ': the walk has not finished since'}`
		);
	return corrupted.length
		? { corrupted, corruptedWhy: null, corruptedAgeSec: age }
		: fail('no data dir counted');
}

/**
 * PURE. How one member's GetClusterStatus sees each layout node: `up`,
 * `failed` (down, last seen some seconds ago) or `never-seen` (down with no
 * `lastSeenSecsAgo`; Garage reports null for the node itself too, which is up).
 * Keyed by fleet node (the role's first tag), nodes without a role skipped.
 *
 * @returns {Record<string, 'up' | 'failed' | 'never-seen'>}
 */
export function seenBy(status) {
	const out = {};
	for (const n of status?.nodes ?? []) {
		const node = roleNode(n.role);
		if (!node) continue;
		out[node] = n.isUp ? 'up' : n.lastSeenSecsAgo == null ? 'never-seen' : 'failed';
	}
	return out;
}
