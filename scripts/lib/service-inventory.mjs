/**
 * RESIDENT DEMAND — the pure half of `fleet service-inventory`.
 *
 * The four Wave-3 migrations (PM2 services, cron jobs, deployment checkouts,
 * the dataplatform mirror) are workloads nothing has ever measured. The floor
 * reads ONE file — `~/.hadoku-mgmt/demand-ledger.jsonl` — and the wave's
 * settled decision is that resident demand is a second CLASS in it, not a
 * second ledger. Schema: `docs/planning/service-ledger-2026-09-10.md`.
 *
 * Split from `scripts/service-inventory.mjs` for the same reason
 * `demand-derive.mjs` split from `check-tool-inventory.mjs`: the shape rules
 * and the merge are the part that can silently destroy an operator's ledger,
 * and they must be assertable without a PM2, a cgroup, or a real state dir.
 *
 * EVERY COLUMN IS A NUMBER OR AN EXPLICIT `{unmeasured}`. CLAUDE.md's
 * "'I could not look' must never render as 'nothing is wrong'" applied to a
 * ledger column: a reader that coerces an absent measurement to 0 has turned
 * no-evidence into a claim of zero demand, which is how a workload gets placed
 * on a node that cannot hold it. So `null` is refused, an empty reason is
 * refused, and the producer THROWS rather than emit either.
 */

/** The discriminator this module owns. Every row it writes carries it. */
export const RESIDENT_CLASS = 'resident';

/**
 * The only `kind` values a resident row may carry: the four Wave-3 migrations,
 * and `slice`, a hosting tenant's own cgroup on whichever node declares it
 * (`fleet service-inventory --slices`, measured from the controller).
 */
export const RESIDENT_KINDS = ['pm2', 'cron', 'checkout', 'mirror', 'slice'];

/** The five resource columns, in schema order. */
export const RESOURCE_COLUMNS = ['ram', 'cpu', 'disk', 'net', 'gpu'];

/**
 * An explicit "could not look", with the reason carried.
 *
 * The reason is REQUIRED and must say what could not be read and why — a rate
 * limit, a timeout and an in-process attribution are three different jobs, and
 * `check-queue-health` named a repo and nothing else until 2026-09-07 for
 * exactly this reason. An empty or whitespace reason throws here rather than
 * reaching the ledger, because `{unmeasured: ""}` is indistinguishable from a
 * shrug and a later reader cannot act on it.
 */
export function unmeasured(why) {
	if (typeof why !== 'string' || !why.trim()) {
		throw new Error('unmeasured() requires a non-empty reason — see service-ledger schema §2.3');
	}
	return { unmeasured: why };
}

/** Is this resource cell a real measurement (rather than an explicit gap)? */
export function isMeasured(cell) {
	return typeof cell === 'number' && Number.isFinite(cell);
}

/**
 * Sum one resource column across rows — or refuse.
 *
 * Returns a number only when EVERY row measured it. One `{unmeasured}` makes
 * the total unknowable, and a partial total presented as a total is the exact
 * inversion this schema exists to prevent: it understates demand, and the
 * understatement is invisible. The reason names the rows that blocked it.
 */
export function sumColumn(rows, column) {
	const gaps = rows.filter((r) => !isMeasured(r[column]));
	if (gaps.length) {
		return unmeasured(
			`${gaps.length} of ${rows.length} row(s) did not measure ${column}: ` +
				gaps.map((r) => `${r.kind}/${r.name}`).join(', ')
		);
	}
	return rows.reduce((n, r) => n + r[column], 0);
}

/**
 * Refuse a row that is not schema-shaped, naming the field.
 *
 * A writer that emits a malformed row poisons a file four other gates read.
 * `parseDemandLedger` already THROWS on an unparseable line rather than
 * skipping it; this is the same rule one step earlier — the row never becomes
 * a line.
 */
export function validateResidentRow(row) {
	const where = `${row?.kind ?? '?'}/${row?.name ?? '?'}`;
	if (!row || typeof row !== 'object') throw new Error('resident row is not an object');
	if (row.class !== RESIDENT_CLASS) {
		throw new Error(
			`${where}: class must be "${RESIDENT_CLASS}", got ${JSON.stringify(row.class)}`
		);
	}
	if (!RESIDENT_KINDS.includes(row.kind)) {
		throw new Error(`${where}: kind must be one of ${RESIDENT_KINDS.join('|')}`);
	}
	for (const f of ['name', 'host']) {
		if (typeof row[f] !== 'string' || !row[f].trim()) throw new Error(`${where}: ${f} is required`);
	}
	for (const col of RESOURCE_COLUMNS) {
		const cell = row[col];
		if (isMeasured(cell)) {
			if (cell < 0) throw new Error(`${where}: ${col} is negative (${cell})`);
			continue;
		}
		if (!cell || typeof cell !== 'object' || typeof cell.unmeasured !== 'string') {
			throw new Error(
				`${where}: ${col} must be a finite number or {unmeasured:"<why>"}, got ${JSON.stringify(cell)}`
			);
		}
		if (!cell.unmeasured.trim()) throw new Error(`${where}: ${col} unmeasured reason is empty`);
	}
	const p = row.provenance;
	if (!p || typeof p !== 'object') throw new Error(`${where}: provenance is required`);
	for (const f of ['at', 'by', 'host', 'scope']) {
		if (typeof p[f] !== 'string' || !p[f].trim()) {
			throw new Error(`${where}: provenance.${f} is required`);
		}
	}
	if (!['per-service', 'per-slice'].includes(p.scope)) {
		throw new Error(`${where}: provenance.scope must be per-service or per-slice, got ${p.scope}`);
	}
	if (!Array.isArray(p.sources) || !p.sources.length) {
		throw new Error(`${where}: provenance.sources must name at least one kernel/supervisor source`);
	}
	return row;
}

/**
 * The `(class, kind, name, host)` key. Idempotency rests on this and nothing
 * else — no synthesised row id, which would let two rows for one workload
 * coexist.
 */
export function rowKey(row) {
	return `${row.class}\u0000${row.kind}\u0000${row.name}\u0000${row.host}`;
}

/**
 * Merge resident rows into an existing ledger's TEXT, returning the new text.
 *
 * THE WHOLE POINT: every line that is not this host's resident rows survives
 * verbatim, in its original order. `fleet tool-inventory --write` rewrites the
 * ledger from its own CI rows and destroys everything else (measured — see
 * `docs/planning/service-ledger-2026-09-10.md` §3); this writer must not
 * commit the mirror-image sin against CI demand.
 *
 * An unparseable line THROWS. Dropping it would silently shorten the ledger a
 * floor gate reads, which is `parseDemandLedger`'s rule and the reason it
 * throws too.
 *
 * Idempotent by construction: the resident block for `host` is replaced, never
 * appended to, so a second run with the same input differs only in
 * `provenance.at`. `kinds` narrows the block to those kinds: the slice writer
 * runs apart from hokon's local one, and must not delete its pm2 rows.
 */
export function mergeResidentRows(existingText, rows, host, { kinds = null } = {}) {
	if (typeof host !== 'string' || !host.trim()) throw new Error('mergeResidentRows needs a host');
	for (const r of rows) {
		validateResidentRow(r);
		if (r.host !== host)
			throw new Error(`row ${r.kind}/${r.name} is for host ${r.host}, not ${host}`);
		if (kinds && !kinds.includes(r.kind))
			throw new Error(`row ${r.kind}/${r.name} is outside the kinds this write replaces`);
	}
	const seen = new Set();
	for (const r of rows) {
		const k = rowKey(r);
		if (seen.has(k)) throw new Error(`duplicate resident row for ${r.kind}/${r.name} on ${host}`);
		seen.add(k);
	}

	const kept = [];
	let replaced = 0;
	const lines = (existingText ?? '').split('\n');
	for (const [i, line] of lines.entries()) {
		if (!line.trim()) continue;
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch (err) {
			throw new Error(
				`demand ledger line ${i + 1} is not JSON (${err.message}). Refusing to rewrite a ledger ` +
					`this cannot fully read — a partial rewrite silently deletes demand four gates consume.`
			);
		}
		if (
			parsed.class === RESIDENT_CLASS &&
			parsed.host === host &&
			(!kinds || kinds.includes(parsed.kind))
		) {
			replaced += 1;
			continue;
		}
		kept.push(line);
	}

	const out = [...kept, ...rows.map((r) => JSON.stringify(r))];
	return { text: out.join('\n') + '\n', kept: kept.length, replaced, written: rows.length };
}

/**
 * A PM2 app's egress class, by the SAME prefix rule `check-egress-slices.mjs`
 * applies.
 *
 * `pm_cwd` is a PREFIX of `ecosystemRoot`, never an equality test: mgmt-api
 * runs from `srv/hadoku_site/services/mgmt-api`, and an equality test
 * misclassifies the single most important service on the box as unknown. An app
 * that is neither under the root nor declared in `hokonLocal` is UNCLASSIFIED
 * and that is a finding, not a default — a new PM2 app silently inheriting
 * fleet egress is the drift the taxonomy exists to catch.
 */
export function egressClassFor(appName, pmCwd, spec) {
	const declared = (spec?.hokonLocal ?? []).find((e) => e.app === appName);
	if (declared) return declared.class;
	if (typeof pmCwd !== 'string' || !pmCwd) return 'unclassified';
	const root = spec?.ecosystemRoot;
	if (!root) return 'unclassified';
	return pmCwd.replace(/\/+$/, '').concat('/').includes(`${root}/`) ? 'ecosystem' : 'unclassified';
}

/**
 * Every descendant pid of `root`, from a pid→ppid map.
 *
 * A PM2 "app" is a wrapper that spawns the real process — `tunnel` spawns
 * cloudflared, `dataplatform` spawns a venv python, `valheim` spawns a game
 * server. Measuring only the pid PM2 reports charges a service for its
 * wrapper's few MB and nothing for the work, so every per-service figure here
 * is over the whole subtree.
 */
export function descendantPids(root, ppidByPid) {
	const children = new Map();
	for (const [pid, ppid] of ppidByPid) {
		if (!children.has(ppid)) children.set(ppid, []);
		children.get(ppid).push(pid);
	}
	const out = [];
	const stack = [root];
	const seen = new Set();
	while (stack.length) {
		const pid = stack.pop();
		if (seen.has(pid)) continue; // a pid cycle cannot happen, but a reused pid in a stale map can
		seen.add(pid);
		out.push(pid);
		for (const c of children.get(pid) ?? []) stack.push(c);
	}
	return out;
}

/**
 * Per-pid TCP byte counters out of `ss -tinp` output.
 *
 * `ss` prints a socket header line carrying `users:(("name",pid=N,fd=M))` and
 * then an indented info line carrying `bytes_sent:` / `bytes_received:`. The
 * counters are CUMULATIVE PER SOCKET since it opened, so a rate needs two
 * samples and `socketsAppeared` records how many sockets in the second sample
 * were not in the first — a socket that opened and closed entirely inside the
 * window contributes nothing and cannot be recovered, which is the blind spot
 * the schema states rather than hides.
 */
export function parseSsSockets(text) {
	const byPid = new Map();
	let pending = null;
	for (const line of (text ?? '').split('\n')) {
		if (/^\s/.test(line)) {
			if (!pending) continue;
			const sent = Number(/\bbytes_sent:(\d+)/.exec(line)?.[1] ?? 0);
			const recv = Number(/\bbytes_received:(\d+)/.exec(line)?.[1] ?? 0);
			for (const pid of pending) {
				if (!byPid.has(pid)) byPid.set(pid, { bytes: 0, sockets: 0 });
				const e = byPid.get(pid);
				e.bytes += sent + recv;
				e.sockets += 1;
			}
			pending = null;
			continue;
		}
		const pids = [...line.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
		pending = pids.length ? pids : null;
	}
	return byPid;
}

/** `usage_usec` out of a cgroup `cpu.stat`. Throws if the field is absent. */
export function parseCpuStatUsec(text) {
	const m = /^usage_usec\s+(\d+)$/m.exec(text ?? '');
	if (!m) {
		throw new Error('cpu.stat carries no usage_usec — the cgroup was read but says nothing usable');
	}
	return Number(m[1]);
}

/**
 * Millicores from CPU-microseconds over a wall-clock window.
 *
 * 1000 = one core saturated for the whole window. A zero or negative window is
 * a bug in the caller, not a zero-CPU workload, so it throws.
 */
export function millicores(cpuUsec, wallMs) {
	if (!(wallMs > 0)) throw new Error(`millicores needs a positive window, got ${wallMs}ms`);
	return Math.round((cpuUsec / 1000 / wallMs) * 1000);
}

/**
 * Cron job durations out of the cron-worker's own log.
 *
 * THIS IS THE JOB RECORD, and it is the supervisor's, not a declaration. The
 * Temporal worker logs `execute_job <name> (http)` when it dispatches and
 * httpx logs `HTTP Request: POST <url> "HTTP/1.1 <code>"` when the route
 * returns; the delta is the route's measured wall duration. Matched per job
 * name in order, so a job dispatched twice in the window yields two runs.
 *
 * A dispatch with no completion line is an OPEN run, counted separately and
 * never silently treated as a zero-duration success: an overrun killed at the
 * Temporal timeout looks exactly like that, and it is the most interesting
 * case in the file.
 */
export function parseCronRuns(text, jobByRouteKey = new Map()) {
	const ts = (line) => {
		const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d),(\d+)/.exec(line);
		return m ? Date.parse(`${m[1]}T${m[2]}.${m[3].padStart(3, '0')}Z`) : null;
	};

	// EVENTS FIRST, PAIRED SECOND, because the caller concatenates eight rotated
	// log files and `readdirSync` order is not chronological — it hands the live
	// `cron-worker-error.log` before the seven dated ones (measured 2026-09-10).
	// Sorting alone was NOT the bug, and checking that is what found the real
	// one: see the LIFO note below.
	const events = [];
	for (const line of (text ?? '').split('\n')) {
		const at = ts(line);
		if (at === null) continue;
		const started = /execute_job (\S+) \(/.exec(line);
		if (started) {
			events.push({ at, type: 0, name: started[1] });
			continue;
		}
		const done = /HTTP Request: POST \S*\/run\/(\S+) "HTTP\/[\d.]+ (\d+)/.exec(line);
		// THE DISPATCH AND THE COMPLETION DO NOT AGREE ON THE NAME. The worker
		// logs `execute_job datastore:backup` and then POSTs
		// `/api/cron/privileged/run/datastore-backup` — a different string for
		// the same job, because a privileged job's route is named separately in
		// `profiles.json`. Keying on the URL segment alone left all three
		// privileged jobs reporting zero runs while they ran nightly (measured
		// 2026-09-10), which is "I could not look" rendered as "nothing ran".
		if (done)
			events.push({
				at,
				type: 1,
				name: jobByRouteKey.get(done[1]) ?? done[1],
				status: Number(done[2]),
			});
	}
	// A start and its completion can share a millisecond; type orders them.
	events.sort((a, b) => a.at - b.at || a.type - b.type);

	// LIFO, NOT FIFO — a completion belongs to the MOST RECENT dispatch.
	//
	// Measured 2026-09-10: two `ci:drain-enforced` dispatches on 09-07 and 09-08
	// never logged a completion (per-file counts: starts 6/144/144/144/61, ends
	// 5/143/144/144/61). A FIFO queue therefore handed every later completion a
	// start two ten-minute cycles too old, and the job reported a p50 of 1,199 s
	// against a 60 s timeout — for 497 runs, every single one of them wrong. It
	// looked exactly like a real overrun, and a FIFO is the natural thing to
	// write, which is the whole reason this comment exists.
	//
	// Every profile here declares `overlap: "skip"`, so runs of one job do not
	// overlap — but this does not rely on that declaration. Given a completion,
	// the newest unmatched dispatch is the only one it can belong to, and any
	// OLDER unmatched dispatch is abandoned: it is reported as such, never
	// recycled as some later completion's partner. One unlogged dispatch must
	// cost one run's duration, not every duration after it.
	const runs = new Map();
	const open = new Map();
	const abandoned = new Map();
	const orphanCompletions = new Map();
	let negativeDurations = 0;
	for (const e of events) {
		if (e.type === 0) {
			if (!open.has(e.name)) open.set(e.name, []);
			open.get(e.name).push(e.at);
			continue;
		}
		const stack = open.get(e.name);
		if (!stack?.length) {
			// A completion whose dispatch is older than the retained logs. Counted,
			// because "the log starts mid-run" and "the worker dispatched nothing"
			// are different facts.
			orphanCompletions.set(e.name, (orphanCompletions.get(e.name) ?? 0) + 1);
			continue;
		}
		const startedAt = stack.pop();
		if (stack.length) {
			abandoned.set(e.name, (abandoned.get(e.name) ?? 0) + stack.length);
			stack.length = 0;
		}
		const durationSec = (e.at - startedAt) / 1000;
		if (durationSec < 0) {
			// Cannot happen once the events are sorted. Counted rather than
			// clamped, so a future log format change is visible instead of quietly
			// producing zeros.
			negativeDurations += 1;
			continue;
		}
		if (!runs.has(e.name)) runs.set(e.name, []);
		runs.get(e.name).push({ startedAt, durationSec, status: e.status });
	}
	return {
		runs,
		openDispatches: new Map([...open].filter(([, q]) => q.length).map(([n, q]) => [n, q.length])),
		abandonedDispatches: abandoned,
		orphanCompletions,
		negativeDurations,
	};
}

/** p50/max/n over a job's measured durations. `null` when there are no runs. */
export function durationStats(list) {
	if (!list?.length) return null;
	const xs = list.map((r) => r.durationSec).sort((a, b) => a - b);
	return {
		runs: xs.length,
		p50Sec: Number(xs[Math.floor((xs.length - 1) / 2)].toFixed(3)),
		maxSec: Number(xs[xs.length - 1].toFixed(3)),
		nonOkRuns: list.filter((r) => r.status >= 300).length,
	};
}

/**
 * Flatten `profiles.json` into one entry per cron JOB.
 *
 * One row per job, not per profile: the profile is the schedule, the job is the
 * unit of work and the thing with a measured duration. A job name repeated
 * across profiles THROWS — the ledger key is the name, so a silent overwrite
 * would drop a real workload, and two schedules for one name is a config bug
 * worth surfacing rather than averaging.
 */
export function flattenCronProfiles(profilesJson) {
	const out = [];
	const seen = new Map();
	for (const p of profilesJson?.profiles ?? []) {
		for (const j of p.jobs ?? []) {
			if (seen.has(j.name)) {
				throw new Error(
					`cron job "${j.name}" appears in both "${seen.get(j.name)}" and "${p.name}" — ` +
						`the ledger key is the job name, so one would silently overwrite the other`
				);
			}
			seen.set(j.name, p.name);
			out.push({
				name: j.name,
				profile: p.name,
				cron: p.schedule?.cron ?? null,
				timezone: p.schedule?.timezone ?? null,
				overlap: p.schedule?.overlap ?? null,
				executor: j.executor ?? null,
				timeoutSec: j.timeout_s ?? null,
				route: j.http?.url ?? null,
				method: j.http?.method ?? null,
				selfReports: j.self_reports === true,
			});
		}
	}
	if (!out.length) {
		throw new Error(
			'profiles.json yielded ZERO cron jobs. The cron worker does not run on nothing — ' +
				'treat this as unreadable, not as clean.'
		);
	}
	return out;
}

/**
 * One ssh per node: each named slice's cgroup read, a `windowS` sleep, then
 * read again, so CPU is a delta the node measured on its own clock. The
 * figures are the kernel's (`memory.peak`, `cpu.stat`), never the tenant's.
 *
 * @param {{ app: string, cgroup: string }[]} slices
 */
export function sliceProbe(slices, windowS) {
	if (!Number.isInteger(windowS) || windowS < 1)
		throw new Error('sliceProbe needs a whole-second window');
	for (const s of slices) {
		if (!/^[a-z0-9][a-z0-9-]*$/.test(s.app) || !/^[a-zA-Z0-9/._-]+$/.test(s.cgroup))
			throw new Error(`unsafe slice ${JSON.stringify(s)}`);
	}
	const read = (tag) =>
		slices
			.map(
				(s) =>
					`c=/sys/fs/cgroup${s.cgroup}; if [ -d "$c" ]; then ` +
					`echo "${tag} ${s.app} $(cut -d' ' -f1 /proc/uptime) $(cat $c/memory.current 2>/dev/null || echo U) ` +
					`$(cat $c/memory.peak 2>/dev/null || echo U) $(awk '/^usage_usec /{print $2}' $c/cpu.stat 2>/dev/null || echo U)"; ` +
					`else echo "${tag} ${s.app} absent"; fi`
			)
			.join('\n');
	return `echo SLICES-BEGIN\n${read('A')}\nsleep ${windowS}\n${read('B')}\necho SLICES-END\n`;
}

/** Parse {@link sliceProbe}: `app → { a, b }` samples, or null when the end marker never arrived. */
export function parseSliceProbe(stdout) {
	const text = String(stdout ?? '');
	if (!/^SLICES-END$/m.test(text)) return null;
	const out = new Map();
	const n = (x) => (/^\d+$/.test(x ?? '') ? Number(x) : null);
	for (const line of text.split('\n')) {
		const m = /^([AB]) (\S+) (.*)$/.exec(line.trim());
		if (!m) continue;
		const [up, current, peak, usage] = m[3].split(/\s+/);
		const sample =
			m[3] === 'absent'
				? { absent: true }
				: {
						uptimeS: /^\d+(\.\d+)?$/.test(up ?? '') ? Number(up) : null,
						current: n(current),
						peak: n(peak),
						usageUsec: n(usage),
					};
		out.set(m[2], { ...out.get(m[2]), [m[1].toLowerCase()]: sample });
	}
	return out;
}

/**
 * A `kind: slice` resident row from two samples of one slice. RAM is the
 * cgroup's `memory.peak` (bytes, since the slice was created: what a request
 * must be sized for), CPU the millicores it used across the window. Disk, net
 * and GPU are not per-slice in the kernel and are said so, never zeroed.
 */
export function sliceRow({ app, host, samples, at, by }) {
	const { a, b } = samples ?? {};
	const why = (what) => `${what} of hosting slice ${app} on ${host}`;
	const ram =
		b && !b.absent && b.peak !== null
			? b.peak
			: unmeasured(`${why('memory.peak')} was not readable`);
	const wallMs =
		a?.uptimeS != null && b?.uptimeS != null ? Math.round((b.uptimeS - a.uptimeS) * 1000) : null;
	const cpu =
		a && b && !a.absent && !b.absent && a.usageUsec !== null && b.usageUsec !== null && wallMs > 0
			? millicores(b.usageUsec - a.usageUsec, wallMs)
			: unmeasured(`${why('cpu.stat usage_usec')} was not readable at both ends of the window`);
	return {
		class: RESIDENT_CLASS,
		kind: 'slice',
		name: app,
		host,
		ram,
		cpu,
		disk: unmeasured('a slice has no disk figure in the kernel; its state dir is not sampled yet'),
		net: unmeasured('a slice has no network counters in the kernel without per-cgroup accounting'),
		gpu: unmeasured('no GPU is assigned to a hosting slice'),
		detail: { memoryCurrent: b?.current ?? null, sampleWindowMs: wallMs },
		provenance: {
			at,
			by,
			host,
			sources: ['memory.peak', 'cpu.stat'],
			scope: 'per-slice',
		},
	};
}
