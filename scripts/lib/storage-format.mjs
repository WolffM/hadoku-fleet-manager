/**
 * THE FORMAT + MOUNT CONVERGER (storage bootcamp F5, hadoku-fleet-manager#140):
 * a qualified disk becomes one GPT partition, one ext4 (or xfs) filesystem, an
 * fstab line by UUID with `nofail`, and a mount at `/srv/storage/<serial>` with
 * a `garage/` data directory the Garage daemon owns.
 *
 * THIS MODULE DESTROYS DATA. The rules are the deliverable:
 *
 *   - DRY RUN BY DEFAULT. Without `--disk <serial> --confirm` it prints the
 *     exact script it would run, and runs nothing but the read-only probe.
 *   - A DISK IS NAMED BY SERIAL, never by device (`sdb` moves between boots).
 *     The serial is read AGAIN on the node, by the same script that formats,
 *     immediately before the first write, and must match exactly one disk,
 *     the one planned. So is every refusal below: the plan is made from a probe
 *     taken minutes earlier, and the node is the only authority on now.
 *   - REFUSED, always: the root disk; a mounted disk (swap included) or one a
 *     device-mapper/md holder sits on; a disk with no serial, or a serial two
 *     disks share (claw-4's card readers all report one); an empty slot; a disk
 *     the probe could not see into (`blank: null`); a disk that has not passed
 *     every F2 disk test (#137). Refused unless `--wipe-signature`: any
 *     partition table, partition or filesystem signature.
 *   - UNDER THE DRAIN/IDLE HOLD (`underIdleHold`, proof-drain.mjs): a format
 *     runs on a node with no CI job on it, and the hold is lifted on every path.
 *
 * QUALIFIED means: for each test in {@link DISK_QUALIFY_TESTS}, the node's
 * newest result in `qualify-results.json` (qualify-results.mjs) lists this
 * serial in `metrics.disks` with verdict `pass` — the per-disk shape F2's
 * `qualify-disk-inventory.mjs` writes. No result at all is "not qualified",
 * never a pass.
 *
 * THE GARAGE USER. F4's unit (toolchain-garage.mjs) runs as `DynamicUser`,
 * whose uid is allocated at start and owns only /var/lib/garage. A disk
 * mounted elsewhere needs an owner that survives a restart, and systemd says
 * how: "If a statically allocated user or group of the configured name already
 * exists, it is used and no dynamic user/group is allocated" (systemd.exec(5),
 * DynamicUser=). So this creates the static system user `garage` and gives it
 * `<mount>/garage`. The mount point itself is `chattr +i` before mounting, so a
 * disk that fails to appear at boot (`nofail`) leaves an unwritable directory,
 * never a root filesystem quietly filling with pool data.
 */

import { resultKey } from './qualify-results.mjs';
import { underIdleHold } from './proof-drain.mjs';

/** Every mount the converger makes lives under here, one per disk, by serial. */
export const STORAGE_ROOT = '/srv/storage';
/** The directory under a mount that Garage's `data_dir` names. */
export const GARAGE_DATA_SUBDIR = 'garage';
/** The static user F4's DynamicUser unit then runs as (see the header). */
export const GARAGE_USER = 'garage';
/** F2's disk tests (#137). Every one must have passed THIS serial. */
export const DISK_QUALIFY_TESTS = ['disk-smr', 'disk-smart', 'disk-burnin'];
export const FILESYSTEMS = ['ext4', 'xfs'];
/** Exit code of the node script when a guard refuses: nothing was written. */
export const REFUSED_EXIT = 3;

// A serial becomes a path and a shell word: allow only what needs no quoting.
const SERIAL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/;
const DEVICE_RE = /^\/dev\/[a-z0-9]+$/;

export const mountPointFor = (serial) => `${STORAGE_ROOT}/${serial}`;

/**
 * PURE. Whether `serial` on `node` passed every F2 disk test.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function qualifiedFor(ledger, node, serial) {
	if (!ledger?.ok) return { ok: false, reason: `not qualified: ${ledger?.reason ?? 'no ledger'}` };
	for (const id of DISK_QUALIFY_TESTS) {
		const last = ledger.results?.[resultKey(node, id)]?.last;
		if (!last) return { ok: false, reason: `not qualified: no ${id} result for ${node}` };
		const disks = Array.isArray(last.metrics?.disks) ? last.metrics.disks : [];
		const mine = disks.find((d) => d?.serial === serial);
		if (!mine) {
			return { ok: false, reason: `not qualified: ${id} (${last.at}) did not judge ${serial}` };
		}
		if (mine.verdict !== 'pass') {
			return {
				ok: false,
				reason: `not qualified: ${id} (${last.at}) says ${mine.verdict}: ${mine.reason ?? 'no reason'}`,
			};
		}
	}
	return { ok: true };
}

/** What the disk carries that a format would destroy, in words; [] when blank. */
function signatures(d) {
	const out = [];
	if (d.partitionTable) out.push(`${d.partitionTable} partition table`);
	if (d.filesystem) out.push(`${d.filesystem.fstype} filesystem`);
	for (const p of d.partitions) out.push(`${p.name}${p.fstype ? ` (${p.fstype})` : ''}`);
	return out;
}

/**
 * PURE. One disk's verdict from the F1 record and the F2 ledger.
 *
 * @param {{ node: string, inventory: import('./storage-inventory.d.mts').StorageInventory,
 *   disk: import('./storage-inventory.d.mts').StorageDisk, ledger: any,
 *   fs?: string, wipeSignature?: boolean }} a
 * @returns {{ serial: string|null, device: string, model: string|null,
 *   verdict: 'converged'|'would-format'|'refused', reasons: string[], script: string|null }}
 */
export function judgeDisk({
	node,
	inventory,
	disk: d,
	ledger,
	fs = 'ext4',
	wipeSignature = false,
}) {
	const base = { serial: d.serial, device: d.device, model: d.model, sizeBytes: d.sizeBytes };
	const mount = d.serial && SERIAL_RE.test(d.serial) ? mountPointFor(d.serial) : null;
	if (mount && d.mountpoints.includes(mount)) {
		return {
			...base,
			verdict: 'converged',
			reasons: [`already mounted at ${mount}`],
			script: null,
		};
	}
	const reasons = [];
	if (!FILESYSTEMS.includes(fs))
		reasons.push(`filesystem ${fs} is not one of ${FILESYSTEMS.join('/')}`);
	if (!inventory.lsblk)
		reasons.push('lsblk did not answer on the node: no serial or mount is known');
	if (!d.serial) reasons.push('no serial: a disk is named by serial or not at all');
	else if (!SERIAL_RE.test(d.serial))
		reasons.push(`serial ${JSON.stringify(d.serial)} is not a safe path word`);
	else if (inventory.disks.filter((o) => o.serial === d.serial).length > 1) {
		reasons.push(`serial ${d.serial} is shared by more than one disk on ${node}`);
	}
	if (!DEVICE_RE.test(d.path)) reasons.push(`device path ${d.path} is not a plain /dev node`);
	if (d.isRoot) reasons.push('the root disk');
	if (d.mounted) reasons.push(`mounted: ${d.mountpoints.join(', ') || 'yes'}`);
	if (!d.mediaPresent || !d.sizeBytes) reasons.push('no media');
	if (d.blank === null) reasons.push('lsblk did not report this disk: not looked at is not blank');
	const sig = signatures(d);
	if (sig.length && !wipeSignature) {
		reasons.push(`carries ${sig.join(', ')}: refused without --wipe-signature`);
	}
	if (d.serial) {
		const q = qualifiedFor(ledger, node, d.serial);
		if (!q.ok) reasons.push(q.reason);
	}
	if (reasons.length) return { ...base, verdict: 'refused', reasons, script: null };
	return {
		...base,
		verdict: 'would-format',
		reasons: sig.length ? [`will WIPE ${sig.join(', ')}`] : [],
		script: formatScript({ serial: d.serial, device: d.path, fs, wipeSignature }),
	};
}

/** PURE. Every candidate (non-root, media present) disk, or one by serial. */
export function planNode({ node, inventory, ledger, disk = null, fs, wipeSignature }) {
	const pick = disk
		? inventory.disks.filter((d) => d.serial === disk)
		: inventory.disks.filter((d) => !d.isRoot && d.mediaPresent && d.sizeBytes > 0);
	return pick.map((d) => judgeDisk({ node, inventory, disk: d, ledger, fs, wipeSignature }));
}

const MKFS = {
	ext4: 'mkfs.ext4 -q -F -m 0 -L fleet-storage "$PART"',
	xfs: 'mkfs.xfs -q -f -L fleet-storage "$PART"',
};

/**
 * The script the node runs as root. Two halves: GUARDS, which re-read the
 * serial and re-check every refusal and exit {@link REFUSED_EXIT} having
 * written nothing; then the ACTIONS. `set -eu`: any failed step stops it.
 * `FSTAB` and `SYSBLOCK` are named once at the top so a test can point them
 * at a scratch tree; nothing on a node changes them.
 */
export function formatScript({ serial, device, fs = 'ext4', wipeSignature = false }) {
	if (!SERIAL_RE.test(serial)) throw new Error(`unsafe serial ${JSON.stringify(serial)}`);
	if (!DEVICE_RE.test(device)) throw new Error(`unsafe device ${JSON.stringify(device)}`);
	if (!MKFS[fs]) throw new Error(`unsupported filesystem ${fs}`);
	const mnt = mountPointFor(serial);
	return [
		'set -eu',
		`SERIAL='${serial}'`,
		`DEV='${device}'`,
		`MNT='${mnt}'`,
		`WIPE=${wipeSignature ? 1 : 0}`,
		"FSTAB='/etc/fstab'",
		"SYSBLOCK='/sys/block'",
		`refuse() { echo "REFUSED $SERIAL on $(hostname): $*" >&2; exit ${REFUSED_EXIT}; }`,
		'# --- guards: read the node NOW; nothing below writes until all pass ---',
		`for t in lsblk wipefs sfdisk udevadm blkid findmnt mkfs.${fs} chattr getent useradd; do`,
		'  command -v "$t" >/dev/null 2>&1 || refuse "$t is not installed: nothing was touched"',
		'done',
		'n=0; found=""',
		'for d in $(lsblk -dnpo NAME); do',
		'  s=$(lsblk -dno SERIAL "$d" | sed "s/[[:space:]]*$//")',
		'  if [ "$s" = "$SERIAL" ]; then n=$((n + 1)); found=$d; fi',
		'done',
		'[ "$n" = 1 ] || refuse "serial matches $n disks, not exactly one"',
		'[ "$found" = "$DEV" ] || refuse "serial is $found now, not the planned $DEV"',
		'[ "$(lsblk -dno TYPE "$DEV")" = disk ] || refuse "$DEV is not a whole disk"',
		'mp=$(lsblk -nro MOUNTPOINT "$DEV") || refuse "lsblk could not read the mounts of $DEV"',
		'mp=$(printf "%s\\n" "$mp" | grep -v "^$" | tr "\\n" " " || true)',
		'[ -z "$mp" ] || refuse "mounted: $mp"',
		'for h in "$SYSBLOCK/${DEV#/dev/}"/holders/* "$SYSBLOCK/${DEV#/dev/}"/*/holders/*; do',
		'  [ ! -e "$h" ] || refuse "held by ${h##*/}"',
		'done',
		'sig=$(wipefs --noheadings -O TYPE "$DEV") || refuse "wipefs could not read the signatures of $DEV"',
		'parts=$(lsblk -nro NAME "$DEV") || refuse "lsblk could not list the partitions of $DEV"',
		'sig=$(printf "%s" "$sig" | tr "\\n" " ")',
		'parts=$(printf "%s\\n" "$parts" | tail -n +2 | tr "\\n" " ")',
		'if [ -n "$sig$parts" ] && [ "$WIPE" != 1 ]; then',
		'  refuse "carries signatures [$sig] partitions [$parts]: needs --wipe-signature"',
		'fi',
		'! grep -qs "[[:space:]]$MNT[[:space:]]" "$FSTAB" || refuse "$FSTAB already names $MNT"',
		'# --- actions ---',
		'if [ "$WIPE" = 1 ]; then',
		'  for p in $(lsblk -nrpo NAME,TYPE "$DEV" | awk \'$2 == "part" { print $1 }\'); do wipefs -a "$p"; done',
		'  wipefs -a "$DEV"',
		'fi',
		// sfdisk, not parted: util-linux is on every node, parted on none of the
		// claws measured (claw-9, claw-10; 2026-11-23). One GPT partition from
		// 1 MiB to the end.
		`printf 'label: gpt\\nname=fleet-storage, type=linux\\n' | sfdisk --quiet "$DEV"`,
		'udevadm settle',
		'PART=$(lsblk -nrpo NAME,TYPE "$DEV" | awk \'$2 == "part" { print $1 }\')',
		'[ "$(printf "%s\\n" "$PART" | grep -c .)" = 1 ] || { echo "expected one partition on $DEV, got: $PART" >&2; exit 1; }',
		'wipefs -a "$PART"',
		MKFS[fs],
		'UUID=$(blkid -s UUID -o value "$PART")',
		'[ -n "$UUID" ] || { echo "no UUID on $PART after mkfs" >&2; exit 1; }',
		`install -d -m 0755 '${STORAGE_ROOT}' "$MNT"`,
		'chattr +i "$MNT"',
		'cp -p "$FSTAB" "$FSTAB.fleet-storage.bak"',
		`printf '%s\\n' "# fleet storage $SERIAL (fleet-manager scripts/lib/storage-format.mjs)" \\`,
		`  "UUID=$UUID $MNT ${fs} defaults,nofail,noatime,x-systemd.device-timeout=30s 0 2" >> "$FSTAB"`,
		'systemctl daemon-reload',
		'mount "$MNT"',
		'[ "$(findmnt -no UUID "$MNT")" = "$UUID" ] || { echo "$MNT is not $UUID after mount" >&2; exit 1; }',
		`getent passwd ${GARAGE_USER} >/dev/null ||`,
		`  useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin ${GARAGE_USER}`,
		`install -d -m 0750 -o ${GARAGE_USER} -g ${GARAGE_USER} "$MNT/${GARAGE_DATA_SUBDIR}"`,
		'echo "FORMATTED $SERIAL $PART $UUID $MNT"',
	].join('\n');
}

/** The root script wrapped for an admin-role runOn: fed to `sudo -n sh -s`. */
export function rootWrapped(script) {
	return ["sudo -n sh -s <<'STORAGE_FORMAT_EOF'", script, 'STORAGE_FORMAT_EOF'].join('\n');
}

/**
 * Plan one node and, only with `confirm` and a `disk` whose verdict is
 * `would-format`, run it under the idle hold.
 *
 * @param {{ node: string, disk?: string|null, confirm?: boolean, fs?: string,
 *   wipeSignature?: boolean, deps: {
 *     readInventory: (node: string) => Promise<{ ok: true, inventory: any } | { ok: false, reason: string }>,
 *     readLedger: () => any,
 *     hold: (node: string, reason: string, act: () => Promise<any>) => Promise<any>,
 *     runRoot: (node: string, script: string) => Promise<{ ok: boolean, stdout?: string, stderr?: string, error?: string }>,
 *   } }} a
 */
export async function convergeNode({
	node,
	disk = null,
	confirm = false,
	fs,
	wipeSignature,
	deps,
}) {
	const inv = await deps.readInventory(node);
	if (!inv.ok) return { node, status: 'could-not-look', reason: inv.reason, disks: [] };
	const disks = planNode({
		node,
		inventory: inv.inventory,
		ledger: deps.readLedger(),
		disk,
		fs,
		wipeSignature,
	});
	if (disk && !disks.length) {
		return { node, status: 'refused', reason: `no disk with serial ${disk} on ${node}`, disks };
	}
	if (!confirm || !disk) return { node, status: 'dry-run', reason: null, disks };
	const [d] = disks;
	if (d.verdict !== 'would-format') {
		return {
			node,
			status: d.verdict === 'converged' ? 'converged' : 'refused',
			reason: d.reasons.join('; '),
			disks,
		};
	}
	const held = await deps.hold(node, `storage-format ${d.serial} (returns when formatted)`, () =>
		deps.runRoot(node, d.script)
	);
	if (held.status !== 'measured') {
		return {
			node,
			status: 'could-not-look',
			reason: held.reason,
			disks,
			undrainFailed: held.undrainFailed,
		};
	}
	const r = held.result;
	const tail = [
		r.error,
		String(r.stderr || r.stdout || '')
			.trim()
			.split('\n')
			.slice(-3)
			.join(' | '),
	]
		.filter(Boolean)
		.join(': ');
	// runOn carries no exit code; the guards' own marker line says refused.
	const status = r.ok
		? 'formatted'
		: /^REFUSED /m.test(String(r.stderr ?? ''))
			? 'refused'
			: 'failed';
	return {
		node,
		status,
		reason: r.ok ? String(r.stdout).trim().split('\n').pop() : tail,
		disks,
		undrainFailed: held.undrainFailed,
	};
}

/** The real hold: proof-drain's underIdleHold, which undrains on every path. */
export const idleHold = (holdDeps) => (node, reason, act) =>
	underIdleHold(node, ['storage'], holdDeps, act, {}, { reason });
