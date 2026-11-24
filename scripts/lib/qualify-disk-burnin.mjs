/**
 * `disk-burnin`: read every sector of ONE disk, and on a blank disk also write
 * and verify every sector, then check that SMART did not get worse (storage
 * bootcamp F2, hadoku-fleet-manager#137).
 *
 * IT WRITES TO A DISK, so it runs only when asked, for one disk named by
 * SERIAL: `fleet qualify --machine <node> --burn-in <serial> --confirm`.
 * Without `--confirm` it only reports its plan. It is in no playlist.
 *
 * TWO MODES, chosen once, when the burn-in starts, from F1's inventory:
 *   write  the disk is `blank` (media, and no partition table, filesystem or
 *          partition). Phase `read` (a full-surface read), then phase `write`
 *          (fio writes every sector and reads it back with a crc32c verify).
 *   read   anything else, `blank: null` (not looked at) included. Phase
 *          `read` only. Nothing is written.
 * Before EVERY chunk the node re-finds the device by serial (a device name
 * moves between boots), refuses the root disk, and in write mode refuses a
 * disk that is mounted, has a partition, or carries any signature `blkid -p`
 * knows. A disk formatted halfway through stops its burn-in; it is not
 * overwritten.
 *
 * LONG AND RESUMABLE. A 1 TB disk is ~2 h of reading and ~4 h of write and
 * verify, longer than one qualification window. The disk is processed in
 * CHUNK_MB chunks, and after each one the progress is written to a state file
 * on the node (`STATE_DIR/<serial>.json`, root-owned). Each invocation
 * continues where the last stopped, for at most its budget, under the
 * drain/idle hold of `fleet qualify` (qualify-runner.mjs). An unfinished
 * burn-in is `could-not-look` with its progress, never a pass. A finished one
 * stays recorded in the state file; remove that file to burn the disk in again.
 *
 * FAIL is the disk's: a read or verify error, a chunk slower than FLOOR_MBPS
 * (a disk that slow is retrying sectors), or SMART worse after than before
 * (new reallocated, pending or offline-uncorrectable sectors). It is a weak
 * point of the node (qualify-baseline.mjs), never an operator task.
 */
import { QUALIFY_TTL_DAYS } from './qualify-registry.mjs';
import { fioJob } from './qualify-io.mjs';
import { readInventory } from './qualify-disk-inventory.mjs';

/** One chunk: 16 GiB, a few minutes of I/O on any disk the pool would take. */
export const CHUNK_MB = 16 * 1024;
/** MB/s below which a chunk is a disk retrying sectors, not a slow disk. */
export const FLOOR_MBPS = 10;
/** Minutes one invocation spends, inside the 180-min qualification window. */
export const BUDGET_MINUTES = 170;
export const STATE_DIR = '/var/lib/fleet-storage/burnin';
const STATE_SCHEMA = 1;
const MB = 1024 * 1024;
const DEADLINE_RCS = new Set([124, 137]);

const SERIAL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function assertSerial(serial) {
	if (typeof serial !== 'string' || !SERIAL_RE.test(serial))
		throw new Error(`${JSON.stringify(serial)} is not a disk serial this burn-in will name`);
	return serial;
}
const statePath = (serial) => `${STATE_DIR}/${assertSerial(serial)}.json`;
const asRoot = (tag, body) => [`sudo -n sh -s <<'${tag}_EOF'`, ...body, `${tag}_EOF`].join('\n');

/** Prints the state file between markers, or NO_STATE. */
export function stateReadScript(serial) {
	return asRoot('BURNIN_STATE', [
		`f='${statePath(serial)}'`,
		'if [ -f "$f" ]; then echo STATE_BEGIN; cat "$f"; echo; echo STATE_END; else echo NO_STATE; fi',
	]);
}

/** Writes the state file atomically; prints STATE_SAVED. Base64, so no JSON is ever shell-quoted. */
export function stateWriteScript(serial, state) {
	const b64 = Buffer.from(JSON.stringify(state)).toString('base64');
	return asRoot('BURNIN_SAVE', [
		'set -e',
		`f='${statePath(serial)}'`,
		`mkdir -p '${STATE_DIR}'`,
		`printf '%s' '${b64}' | base64 -d > "$f.tmp"`,
		'mv "$f.tmp" "$f"',
		'echo STATE_SAVED',
	]);
}

/** `{ok, state}` (null when none), or `{ok:false, reason}`. */
export function parseState(out) {
	const s = String(out ?? '');
	if (/^NO_STATE$/m.test(s)) return { ok: true, state: null };
	const body = s.match(/^STATE_BEGIN$([\s\S]*?)^STATE_END$/m)?.[1];
	if (body === undefined) return { ok: false, reason: 'the state file could not be read' };
	try {
		const state = JSON.parse(body);
		if (state?.schema !== STATE_SCHEMA)
			return { ok: false, reason: `state schema ${state?.schema}` };
		return { ok: true, state };
	} catch (e) {
		return {
			ok: false,
			reason: `the state file is not JSON: ${e instanceof Error ? e.message : e}`,
		};
	}
}

function assertInt(name, v) {
	if (!Number.isInteger(v) || v < 0) throw new Error(`bad ${name}: ${v}`);
}

/**
 * One chunk on the node, as root. The device is found by serial; every guard
 * runs again; fio is under `timeout`. Prints BURNIN_REFUSE <why>, or BURNIN_DEV,
 * fio's JSON between BURNIN_JSON markers, BURNIN_RC and BURNIN_MS.
 */
export function chunkScript({ serial, phase, offsetBytes, lengthBytes, deadlineSec }) {
	assertSerial(serial);
	for (const [n, v] of Object.entries({ offsetBytes, lengthBytes, deadlineSec })) assertInt(n, v);
	if (phase !== 'read' && phase !== 'write') throw new Error(`bad phase: ${phase}`);
	const fio =
		phase === 'read'
			? '--rw=read --readonly'
			: '--rw=write --verify=crc32c --do_verify=1 --verify_fatal=1';
	return asRoot('BURNIN_CHUNK', [
		'set -u',
		`serial='${serial}'`,
		'dev=""; n=0',
		'for b in /sys/block/*; do',
		'  d=${b##*/}',
		'  case $d in loop* | ram* | sr* | dm-* | zram* | md*) continue ;; esac',
		'  [ "$(lsblk -dno SERIAL "/dev/$d" 2>/dev/null)" = "$serial" ] && { dev=/dev/$d; n=$((n + 1)); }',
		'done',
		'[ "$n" -eq 1 ] || { echo "BURNIN_REFUSE $n devices answer to serial $serial"; exit 3; }',
		'if lsblk -nro MOUNTPOINT "$dev" | grep -qx /; then echo "BURNIN_REFUSE $dev holds /"; exit 3; fi',
		...(phase === 'write'
			? [
					'if lsblk -nro MOUNTPOINT "$dev" | grep -q .; then echo "BURNIN_REFUSE $dev is mounted"; exit 3; fi',
					'[ "$(lsblk -nro NAME "$dev" | wc -l)" -eq 1 ] || { echo "BURNIN_REFUSE $dev has partitions"; exit 3; }',
					'blkid -p "$dev" >/dev/null 2>&1; sig=$?',
					// 2 is blkid's "nothing found"; 0 is a signature, anything else is unknown.
					'[ "$sig" -eq 2 ] || { echo "BURNIN_REFUSE $dev carries a signature or could not be probed (blkid -p exit $sig)"; exit 3; }',
				]
			: []),
		'echo "BURNIN_DEV $dev"',
		't0=$(date +%s%N)',
		'echo BURNIN_JSON_BEGIN',
		`timeout -k 10 ${deadlineSec} fio --name=burnin --filename="$dev" ${fio} --bs=1M --direct=1` +
			` --ioengine=psync --offset=${offsetBytes} --size=${lengthBytes} --output-format=json`,
		'rc=$?',
		'echo; echo BURNIN_JSON_END',
		't1=$(date +%s%N)',
		'echo "BURNIN_RC $rc"',
		'echo "BURNIN_MS $(( (t1 - t0) / 1000000 ))"',
	]);
}

/** @returns {{ refused: string|null, dev: string|null, rc: number|null, ms: number|null, error: number|null, bytes: number|null }} */
export function parseChunk(out, phase) {
	const s = String(out ?? '');
	const field = (k) => s.match(new RegExp(`^${k} (.+)$`, 'm'))?.[1]?.trim() ?? null;
	const job = fioJob(s, 'BURNIN_JSON');
	const io = phase === 'read' ? job?.read : job?.write;
	const n = (x) =>
		x === null || x === undefined || !Number.isFinite(Number(x)) ? null : Number(x);
	return {
		refused: field('BURNIN_REFUSE'),
		dev: field('BURNIN_DEV'),
		rc: n(field('BURNIN_RC')),
		ms: n(field('BURNIN_MS')),
		error: n(job?.error),
		bytes: n(io?.io_bytes),
	};
}

const pct = (st) => {
	const per = st.sizeBytes;
	const done = st.phases.indexOf(st.phase) * per + st.offsetBytes;
	return Math.floor((100 * done) / (st.phases.length * per));
};
const smartOf = (d) => ({
	status: d.smart.status,
	reallocated: d.smart.reallocated,
	pendingSectors: d.smart.pendingSectors,
	offlineUncorrectable: d.smart.offlineUncorrectable,
});

/** PURE. The state a burn-in starts from: its mode is fixed here, from `blank`. */
export function initialState(disk, at) {
	const mode = disk.blank === true ? 'write' : 'read';
	return {
		schema: STATE_SCHEMA,
		serial: disk.serial,
		model: disk.model,
		sizeBytes: disk.sizeBytes,
		mode,
		why:
			mode === 'write'
				? 'blank: no partition table, filesystem or partition'
				: disk.blank === false
					? 'not blank: it carries a partition table, filesystem or partition, so nothing is written'
					: 'lsblk did not answer for it, so it is not known to be blank and nothing is written',
		phases: mode === 'write' ? ['read', 'write'] : ['read'],
		phase: 'read',
		offsetBytes: 0,
		startedAt: at,
		updatedAt: at,
		chunks: 0,
		slowestMbps: null,
		smartBefore: smartOf(disk),
		result: null,
	};
}

/**
 * PURE. Why the SMART record after a burn-in refuses the disk, or null.
 * New reallocated, pending or offline-uncorrectable sectors are sectors the
 * burn-in found going bad.
 */
export function smartWorse(before, after) {
	if (after.status !== 'ok') return `SMART after the burn-in reads ${after.status}`;
	const out = [];
	for (const k of ['reallocated', 'pendingSectors', 'offlineUncorrectable']) {
		if (Number.isFinite(after[k]) && after[k] > (before[k] ?? 0))
			out.push(`${k} ${before[k] ?? 0} → ${after[k]}`);
	}
	return out.length ? `SMART got worse during the burn-in: ${out.join(', ')}` : null;
}

const tail = (r) =>
	String(r?.error || r?.stderr || r?.stdout || '')
		.trim()
		.slice(-300);

/**
 * What a burn-in of `serial` would do now, read-only: the disk, its state, the
 * mode. `{error}` when the disk cannot be found or named.
 */
export async function planBurnin(ctx, serial) {
	assertSerial(serial);
	const read = await readInventory(ctx);
	if ('error' in read) return { error: read.error };
	const matches = read.inventory.disks.filter((d) => d.serial === serial);
	if (matches.length !== 1)
		return {
			error: `${matches.length} disks on ${ctx.node} answer to serial ${serial}; candidates: ${
				read.inventory.disks
					.filter((d) => !d.isRoot && d.mediaPresent)
					.map((d) => `${d.serial} (${d.device})`)
					.join(', ') || 'none'
			}`,
		};
	const disk = matches[0];
	if (disk.isRoot)
		return { error: `${serial} (${disk.device}) holds /; the root disk is never burned in` };
	const sr = await ctx.exec(stateReadScript(serial), { timeoutMs: 60_000 });
	const st = parseState(sr.stdout);
	if (!st.ok) return { error: `${statePath(serial)}: ${st.reason}; ${tail(sr)}` };
	if (st.state && st.state.sizeBytes !== disk.sizeBytes)
		return {
			error: `${statePath(serial)} was written for a ${st.state.sizeBytes}-byte disk, and ${serial} is ${disk.sizeBytes}`,
		};
	const state = st.state ?? initialState(disk, new Date(ctx.nowMs ?? Date.now()).toISOString());
	const summary = st.state
		? state.result
			? `finished ${state.updatedAt}: ${state.result.status}: ${state.result.reason}`
			: `${state.mode} mode, ${pct(state)}% done, at phase ${state.phase} offset ${state.offsetBytes}`
		: `would start in ${state.mode} mode (${state.why}); phases ${state.phases.join(' then ')} over ${Math.round(disk.sizeBytes / 1e9)} GB`;
	return { disk, state, fresh: !st.state, summary };
}

/**
 * The test for one serial. Sizes and the clock are injectable so the tests run
 * the loop against a fake node; the floor is not.
 */
export function makeBurninTest({
	serial,
	budgetMinutes = BUDGET_MINUTES,
	chunkMb = CHUNK_MB,
	now = Date.now,
}) {
	assertSerial(serial);
	const chunkBytes = chunkMb * MB;
	return {
		id: 'disk-burnin',
		track: 'qualify',
		needsDrain: true,
		runsAs: 'admin',
		ttlDays: QUALIFY_TTL_DAYS,
		minutes: budgetMinutes + 5,
		async run(ctx) {
			const started = now();
			const plan = await planBurnin(ctx, serial);
			if ('error' in plan) return result('could-not-look', plan.error, null);
			let st = plan.state;
			if (st.result)
				return result(
					st.result.status,
					`${plan.summary} (remove ${statePath(serial)} to run it again)`,
					st
				);

			const save = async (next) => {
				const w = await ctx.exec(stateWriteScript(serial, next), { timeoutMs: 60_000 });
				return w.ok && /^STATE_SAVED$/m.test(String(w.stdout))
					? null
					: `the state file was not saved: ${tail(w)}`;
			};
			const finish = async (status, reason) => {
				const at = new Date(now()).toISOString();
				st = { ...st, updatedAt: at, result: { status, reason } };
				const bad = await save(st);
				return result(status, bad ? `${reason}; and ${bad}` : reason, st);
			};
			if (plan.fresh) {
				const bad = await save(st);
				if (bad) return result('could-not-look', bad, st);
			}
			ctx.log?.(`   ${serial}: ${plan.summary}`);

			while (st.phase !== 'done') {
				const lengthBytes = Math.min(chunkBytes, st.sizeBytes - st.offsetBytes);
				const ioMb = (lengthBytes / MB) * (st.phase === 'write' ? 2 : 1);
				const deadlineSec = Math.ceil(ioMb / FLOOR_MBPS) + 30;
				if ((now() - started) / 1000 + deadlineSec > budgetMinutes * 60)
					return result(
						'could-not-look',
						`burn-in of ${serial} is ${pct(st)}% done (${st.mode} mode, phase ${st.phase}); ` +
							`the ${budgetMinutes}-min budget is spent. It resumes where it stopped: run the same command again`,
						st
					);
				const r = await ctx.exec(
					chunkScript({
						serial,
						phase: st.phase,
						offsetBytes: st.offsetBytes,
						lengthBytes,
						deadlineSec,
					}),
					{ timeoutMs: (deadlineSec + 120) * 1000 }
				);
				const c = parseChunk(r.stdout, st.phase);
				const where = `${st.phase} chunk at ${Math.round(st.offsetBytes / MB)} MiB`;
				if (c.refused)
					return result(
						'could-not-look',
						`the ${where} was refused on the node: ${c.refused}; the burn-in stopped, nothing was written`,
						st
					);
				if (c.rc !== null && DEADLINE_RCS.has(c.rc))
					return finish(
						'fail',
						`${serial}: the ${where} ran under ${FLOOR_MBPS} MB/s (its ${deadlineSec} s deadline passed): the disk is retrying sectors`
					);
				if (c.rc === null)
					return result(
						'could-not-look',
						`the ${where} did not report: ${tail(r) || 'no output'}`,
						st
					);
				if (c.rc !== 0 || (c.error !== null && c.error !== 0))
					return finish(
						'fail',
						`${serial}: the ${where} failed: fio exit ${c.rc}, error ${c.error ?? 'none reported'}${st.phase === 'write' ? ' (a write or verify error)' : ' (a read error)'}`
					);
				if (c.bytes !== null && c.bytes < lengthBytes)
					return result(
						'could-not-look',
						`the ${where} moved ${c.bytes} of ${lengthBytes} bytes`,
						st
					);
				const mbps = c.ms > 0 ? Math.round(ioMb / (c.ms / 1000)) : null;
				const offsetBytes = st.offsetBytes + lengthBytes;
				const phaseDone = offsetBytes >= st.sizeBytes;
				const nextPhase = phaseDone
					? (st.phases[st.phases.indexOf(st.phase) + 1] ?? 'done')
					: st.phase;
				st = {
					...st,
					phase: nextPhase,
					offsetBytes: phaseDone ? 0 : offsetBytes,
					chunks: st.chunks + 1,
					slowestMbps: mbps === null ? st.slowestMbps : Math.min(st.slowestMbps ?? Infinity, mbps),
					updatedAt: new Date(now()).toISOString(),
				};
				const bad = await save(st);
				if (bad) return result('could-not-look', `after the ${where}: ${bad}`, st);
				ctx.log?.(
					`   ${serial}: ${where} ok at ${mbps} MB/s, ${st.phase === 'done' ? 100 : pct(st)}%`
				);
			}

			const after = await readInventory(ctx);
			if ('error' in after)
				return result(
					'could-not-look',
					`every sector passed, but SMART could not be re-read: ${after.error}`,
					st
				);
			const disk = after.inventory.disks.find((d) => d.serial === serial);
			if (!disk)
				return result(
					'could-not-look',
					`every sector passed, but ${serial} is gone from the inventory`,
					st
				);
			const worse = smartWorse(st.smartBefore, smartOf(disk));
			if (worse) return finish('fail', `${serial}: ${worse}`);
			return finish(
				'pass',
				`${serial}: every sector ${st.mode === 'write' ? 'read, written and verified' : 'read (read-only: the disk was not blank)'}` +
					` over ${st.chunks} chunk(s), slowest ${st.slowestMbps} MB/s; SMART unchanged`
			);
		},
	};

	function result(status, reason, st) {
		return {
			status,
			reason,
			metrics: {
				disks: [
					{
						serial,
						verdict: status === 'pass' ? 'pass' : status === 'fail' ? 'fail' : 'blocked',
						reason,
						mode: st?.mode ?? null,
						phase: st?.phase ?? null,
						pct: st ? (st.phase === 'done' ? 100 : pct(st)) : null,
						slowestMbps: st?.slowestMbps ?? null,
					},
				],
				bars: { floorMbps: FLOOR_MBPS, chunkMb },
			},
		};
	}
}
