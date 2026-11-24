/**
 * `disk-wipe`: clear an old filesystem off a candidate disk so its burn-in
 * can write and verify every sector (hadoku-fleet-manager#156).
 *
 * POLICY (storage-pool coordinator, 2026-11-24): a non-root disk in a claw is
 * fleet property. Onboarding RECORDS what it finds (each signature's type,
 * label, uuid, and each partition's size) in the result and proceeds; it
 * never stops to ask. The root disk is never touched. This is the step the
 * coordinator did by hand on claw-10's WD-WCATR9739694 (an ntfs partition
 * labelled Storage1 on a dos table): burn-in plans read-only on a disk that
 * is not blank (qualify-disk-burnin.mjs), so the wipe comes first.
 *
 *   fleet qualify --machine <node> --wipe <serial>            the plan: what it carries, nothing written
 *   fleet qualify --machine <node> --wipe <serial> --confirm  record it, `wipefs -a` each partition, then the disk
 *
 * REFUSED on the node, before anything is written, whatever the plan said:
 * the serial answers to other than exactly one disk; it is not a whole disk;
 * it holds `/` or anything mounted; it is swap; something holds it (LVM, md,
 * dm-crypt). After the wipe, `blkid -p` must find nothing: a disk still
 * carrying a signature is a fail, never a pass.
 *
 * The kernel log over the step's own window is read around it
 * (qualify-disk-forms.mjs `withLinkCheck`): a link error during the wipe
 * rejects the disk like any other step.
 */
import { assertSerial } from './qualify-disk-burnin.mjs';
import { QUALIFY_TTL_DAYS } from './qualify-registry.mjs';

const MARK = 'DISK_WIPE';

/**
 * The node script, as root. `apply` false lists and writes nothing.
 * Prints WIPE_REFUSE <why>, or WIPE_DEV, the lsblk JSON and each signature
 * listing between markers, then (apply) WIPE_AFTER <blkid -p exit>.
 */
export function wipeScript({ serial, apply }) {
	assertSerial(serial);
	return [
		`sudo -n sh -s <<'${MARK}_EOF'`,
		'set -u',
		`serial='${serial}'`,
		'refuse() { echo "WIPE_REFUSE $*"; exit 3; }',
		'for t in lsblk wipefs blkid; do command -v "$t" >/dev/null 2>&1 || refuse "$t is not installed"; done',
		'dev=""; n=0',
		'for d in $(lsblk -dnpo NAME); do',
		'  [ "$(lsblk -dno SERIAL "$d" 2>/dev/null | sed "s/[[:space:]]*$//")" = "$serial" ] && { dev=$d; n=$((n + 1)); }',
		'done',
		'[ "$n" -eq 1 ] || refuse "$n disks answer to serial $serial"',
		'[ "$(lsblk -dno TYPE "$dev")" = disk ] || refuse "$dev is not a whole disk"',
		'mp=$(lsblk -nro MOUNTPOINT "$dev" | grep -v "^$" | tr "\\n" " ")',
		'[ -z "$mp" ] || refuse "$dev is mounted: $mp"',
		'for p in $(lsblk -nrpo NAME "$dev"); do grep -qs "^$p " /proc/swaps && refuse "$p is swap"; done',
		'for h in /sys/block/${dev#/dev/}/holders/* /sys/block/${dev#/dev/}/*/holders/*; do',
		'  [ ! -e "$h" ] || refuse "$dev is held by ${h##*/}"',
		'done',
		'echo "WIPE_DEV $dev"',
		'echo WIPE_LSBLK_BEGIN',
		'lsblk -J -b -o NAME,TYPE,SIZE,FSTYPE,LABEL,UUID,PTTYPE "$dev"',
		'echo WIPE_LSBLK_END',
		'parts=$(lsblk -nrpo NAME,TYPE "$dev" | awk \'$2 == "part" { print $1 }\')',
		'for p in $parts "$dev"; do',
		'  echo "WIPE_SIG_BEGIN $p"; wipefs -J "$p" 2>&1; echo "WIPE_SIG_END $p"',
		'done',
		...(apply
			? [
					'for p in $parts; do wipefs -a "$p" >/dev/null || refuse "wipefs -a $p failed"; done',
					'wipefs -a "$dev" >/dev/null || refuse "wipefs -a $dev failed"',
					'command -v udevadm >/dev/null 2>&1 && udevadm settle',
					'blockdev --rereadpt "$dev" 2>/dev/null || true',
					'blkid -p "$dev" >/dev/null 2>&1; echo "WIPE_AFTER $?"',
					'echo "WIPE_PARTS_AFTER $(lsblk -nro NAME "$dev" | tail -n +2 | wc -l)"',
				]
			: []),
		'echo WIPE_END',
		`${MARK}_EOF`,
	].join('\n');
}

const jsonOr = (text, fallback) => {
	const brace = String(text ?? '').indexOf('{');
	if (brace < 0) return fallback;
	try {
		return JSON.parse(String(text).slice(brace));
	} catch {
		// A torn listing is "not read"; the caller says so.
		return fallback;
	}
};

/**
 * PURE. The node's output as what the disk carried and what the wipe left.
 * @returns {{ refused: string|null, dev: string|null, complete: boolean,
 *   partitions: { name: string, sizeBytes: number|null, fstype: string|null, label: string|null, uuid: string|null }[],
 *   pttype: string|null, signatures: { device: string, type: string|null, label: string|null, uuid: string|null, offset: string|null }[],
 *   unread: string[], blkidAfter: number|null, partsAfter: number|null }}
 */
export function parseWipe(out) {
	const s = String(out ?? '');
	const field = (k) => s.match(new RegExp(`^${k} (.+)$`, 'm'))?.[1]?.trim() ?? null;
	const lsblk = jsonOr(s.match(/^WIPE_LSBLK_BEGIN$([\s\S]*?)^WIPE_LSBLK_END$/m)?.[1], null);
	const disk = lsblk?.blockdevices?.[0] ?? null;
	const partitions = (disk?.children ?? []).map((p) => ({
		name: p.name,
		sizeBytes: Number.isFinite(Number(p.size)) ? Number(p.size) : null,
		fstype: p.fstype ?? null,
		label: p.label ?? null,
		uuid: p.uuid ?? null,
	}));
	const signatures = [];
	const unread = [];
	for (const m of s.matchAll(/^WIPE_SIG_BEGIN (\S+)$([\s\S]*?)^WIPE_SIG_END \1$/gm)) {
		const body = m[2].trim();
		if (!body) continue; // wipefs prints nothing for a device with no signature
		const doc = jsonOr(body, null);
		if (!doc) {
			unread.push(`${m[1]}: ${body.slice(0, 160)}`);
			continue;
		}
		for (const x of doc.signatures ?? [])
			signatures.push({
				device: x.device ?? m[1],
				type: x.type ?? null,
				label: x.label ?? null,
				uuid: x.uuid ?? null,
				offset: x.offset ?? null,
			});
	}
	const num = (v) => (v === null || !Number.isFinite(Number(v)) ? null : Number(v));
	return {
		refused: field('WIPE_REFUSE'),
		dev: field('WIPE_DEV'),
		complete: /^WIPE_END$/m.test(s),
		pttype: disk?.pttype ?? null,
		partitions,
		signatures,
		unread,
		blkidAfter: num(field('WIPE_AFTER')),
		partsAfter: num(field('WIPE_PARTS_AFTER')),
	};
}

/** PURE. What the disk carries, in words, for the plan and the result. */
export function describe(w) {
	const out = [];
	if (w.pttype) out.push(`a ${w.pttype} partition table`);
	for (const p of w.partitions)
		out.push(
			`${p.name}${p.fstype ? ` ${p.fstype}` : ''}${p.label ? ` "${p.label}"` : ''}` +
				`${p.sizeBytes ? ` ${(p.sizeBytes / 1e9).toFixed(1)} GB` : ''}`
		);
	const types = [...new Set(w.signatures.map((x) => x.type).filter(Boolean))];
	if (types.length) out.push(`signatures: ${types.join(', ')}`);
	return out.length ? out.join('; ') : 'nothing: no partition table, partition or signature';
}

const tail = (r) =>
	String(r?.error || r?.stderr || r?.stdout || '')
		.trim()
		.slice(-300);

/** The plan for `serial`, read-only: `{ dev, carries, wipe }` or `{ error }`. */
export async function planWipe(ctx, serial) {
	const r = await ctx.exec(wipeScript({ serial, apply: false }), { timeoutMs: 120_000 });
	const w = parseWipe(r.stdout);
	if (w.refused) return { error: `refused on ${ctx.node}: ${w.refused}` };
	if (!w.complete || !w.dev) return { error: `the listing did not finish: ${tail(r)}` };
	if (w.unread.length) return { error: `signatures not read: ${w.unread.join('; ')}` };
	return { dev: w.dev, carries: describe(w), wipe: w };
}

/** The test for one serial; it writes, so it exists only with `--confirm`. */
export function makeWipeTest({ serial }) {
	assertSerial(serial);
	return {
		id: 'disk-wipe',
		track: 'qualify',
		needsDrain: false,
		runsAs: 'admin',
		ttlDays: QUALIFY_TTL_DAYS,
		minutes: 5,
		async run(ctx) {
			const r = await ctx.exec(wipeScript({ serial, apply: true }), { timeoutMs: 300_000 });
			const w = parseWipe(r.stdout);
			const found = { pttype: w.pttype, partitions: w.partitions, signatures: w.signatures };
			const out = (status, reason) => ({
				status,
				reason,
				metrics: {
					disks: [
						{
							serial,
							device: w.dev,
							verdict: status === 'pass' ? 'pass' : status === 'fail' ? 'fail' : 'blocked',
							reason,
							found,
						},
					],
				},
			});
			if (w.refused)
				return out('could-not-look', `refused on the node, nothing written: ${w.refused}`);
			if (!w.complete)
				return out('could-not-look', `the wipe did not report its end: ${tail(r) || 'no output'}`);
			const carried = describe(w);
			if (w.blkidAfter !== 2 || w.partsAfter !== 0)
				return out(
					'fail',
					`${serial} (${w.dev}) still carries something after wipefs -a: ` +
						`blkid -p exit ${w.blkidAfter ?? 'unknown'} (2 is "nothing found"), ${w.partsAfter ?? '?'} partition(s)`
				);
			return out('pass', `${serial} (${w.dev}) is blank; it carried ${carried}`);
		},
	};
}
