/**
 * `disk-link`: did the kernel log a link error, reset or device-disable for a
 * candidate disk (hadoku-fleet-manager#156, the coordinator's rule of
 * 2026-11-24)?
 *
 * WHY. Enabling SMART on claw-10's W1F41TH6 (ST3000DM001) took it off the
 * bus: `ata1.00: SRST failed` four times, `limiting SATA link speed to 1.5
 * Gbps`, `reset failed, giving up`, `disable device`, and the optical drive
 * sharing ata1 (`ata1.01`) was disabled with it. IO PSI avg60 on the node went
 * to 13%. SMART then read the disk as `blocked` (no answer), which a later
 * scan listed as a CANDIDATE. A disk that drops its link under one SMART
 * command is not a pool disk, whatever its sectors say.
 *
 * THE RULE: any ATA/SCSI link error, reset or device-disable for the
 * candidate in the kernel log during an onboarding step REJECTS the disk, and
 * the rejection is persisted (lib/disk-rejections.mjs) so the next scan lists
 * it as rejected, not as a candidate. The same errors on the node's OTHER
 * devices are reported as node impact; they never reject the candidate.
 *
 * WHICH LINES ARE WHOSE. The node prints each block device's name, serial,
 * ATA port and SCSI address. A kernel line belongs to a device when it names
 * its `ataN.0I` (the device on port N, I its SCSI target id), its port `ataN:`
 * (port-level resets hit every device on the port), its `[sdX]`, `sd H:C:I:L`,
 * `dev sdX`, or its NVMe controller `nvmeX`. Only lines matching an ERROR
 * pattern count: a boot's `SATA link up` and `configured for UDMA/133` are not
 * errors, and an empty port's `SATA link down` names no device.
 *
 * The standalone test (`fleet qualify --disks`) reads the current boot. Each
 * onboarding step that touches a disk (wipe, burn-in, bench, node-impact)
 * reads only its own window (`sinceSec`).
 */
import { QUALIFY_TTL_DAYS } from './qualify-registry.mjs';
import {
	candidates,
	diskName,
	judgeRoot,
	nodeStatus,
	readInventory,
} from './qualify-disk-inventory.mjs';

/**
 * Kernel messages that are a link or device fault. Each is a libata, SCSI or
 * block-layer message seen when a link drops or a command fails; the first
 * eight are the exact lines claw-10 logged for W1F41TH6.
 */
export const LINK_ERROR_PATTERNS = Object.freeze([
	/SRST failed/,
	/softreset failed/,
	/hardreset failed/,
	/COMRESET failed/,
	/reset failed, giving up/,
	/limiting SATA link speed/,
	/disable device/,
	/link is slow to respond/,
	/FAILED Result:/,
	/exception Emask/,
	/failed command:/,
	/hard resetting link/,
	/SError:/,
	/revalidation failed/,
	/I\/O error, dev /,
	/Buffer I\/O error on dev/,
	/rejecting I\/O to offline device/,
	/Medium Error/,
	/timing out command/,
	/nvme\d+: (?:I\/O \d+ .*timeout|controller is down|Removing after probe failure|Device not ready)/,
]);

const MARK = 'DISK_LINK';

/**
 * The node-side read, run as root (the kernel ring is root-readable under
 * kernel.dmesg_restrict). Prints one `DEV <name> <serial|-> <ataN|-> <H:C:I:L|->`
 * per block device, then the kernel log since `sinceSec` (epoch) or this
 * boot, with epoch timestamps, between markers.
 */
export function linkReadScript({ sinceSec = null } = {}) {
	if (sinceSec !== null && !(Number.isInteger(sinceSec) && sinceSec > 0))
		throw new Error(`bad sinceSec: ${sinceSec}`);
	const since = sinceSec === null ? '' : ` --since=@${sinceSec}`;
	return [
		`# QUALIFY_${MARK}`,
		`sudo -n sh -s <<'${MARK}_EOF'`,
		'for b in /sys/block/*; do',
		'  d=${b##*/}',
		'  case $d in loop* | ram* | sr* | dm-* | zram* | md*) continue ;; esac',
		'  p=$(readlink -f "$b/device" 2>/dev/null)',
		'  ata=$(printf %s "$p" | grep -o "/ata[0-9]*/" | tr -d / | head -1)',
		'  hctl=$(printf %s "$p" | grep -oE "[0-9]+:[0-9]+:[0-9]+:[0-9]+$")',
		'  s=$(lsblk -dno SERIAL "/dev/$d" 2>/dev/null | tr -d " ")',
		'  echo "DEV $d ${s:--} ${ata:--} ${hctl:--}"',
		'done',
		'command -v journalctl >/dev/null 2>&1 || { echo "LINK_NO_JOURNAL"; exit 0; }',
		`echo ${MARK}_BEGIN`,
		`journalctl -k -b --no-pager -o short-unix${since} 2>&1`,
		'echo "LINK_RC $?"',
		`echo ${MARK}_END`,
		`${MARK}_EOF`,
	].join('\n');
}

/**
 * PURE. The read as devices and kernel lines.
 * @returns {{ devices: { name: string, serial: string|null, ata: string|null, hctl: string|null }[],
 *   lines: { at: number|null, text: string }[], complete: boolean, why: string|null }}
 */
export function parseLinkRead(out) {
	const s = String(out ?? '');
	const devices = [...s.matchAll(/^DEV (\S+) (\S+) (\S+) (\S+)$/gm)].map((m) => ({
		name: m[1],
		serial: m[2] === '-' ? null : m[2],
		ata: m[3] === '-' ? null : m[3],
		hctl: m[4] === '-' ? null : m[4],
	}));
	if (/^LINK_NO_JOURNAL$/m.test(s))
		return { devices, lines: [], complete: false, why: 'the node has no journalctl' };
	const body = s.match(new RegExp(`^${MARK}_BEGIN$([\\s\\S]*?)^${MARK}_END$`, 'm'))?.[1];
	if (body === undefined)
		return { devices, lines: [], complete: false, why: 'the kernel log read did not finish' };
	const rc = Number(body.match(/^LINK_RC (\d+)$/m)?.[1]);
	if (rc !== 0)
		return {
			devices,
			lines: [],
			complete: false,
			why: `journalctl -k exited ${Number.isFinite(rc) ? rc : 'unknown'}: ${body.trim().slice(-200)}`,
		};
	const lines = body
		.split('\n')
		.filter((l) => l.trim() && !/^LINK_RC /.test(l) && !/^-- /.test(l))
		.map((l) => {
			const at = Number(l.match(/^(\d+(?:\.\d+)?)\s/)?.[1]);
			return { at: Number.isFinite(at) ? at : null, text: l };
		});
	return { devices, lines, complete: true, why: null };
}

const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** PURE. The patterns that say a kernel line is about `dev`. */
export function deviceMatchers(dev) {
	const out = [new RegExp(`\\[${esc(dev.name)}\\]`), new RegExp(`\\bdev ${esc(dev.name)}\\b`)];
	if (dev.hctl) out.push(new RegExp(`\\bsd ${esc(dev.hctl)}:`));
	if (dev.ata) {
		out.push(new RegExp(`\\b${esc(dev.ata)}: `));
		const target = dev.hctl?.split(':')[2];
		if (target !== undefined)
			out.push(new RegExp(`\\b${esc(dev.ata)}\\.${String(target).padStart(2, '0')}: `));
	}
	const nvme = dev.name.match(/^(nvme\d+)n\d+$/)?.[1];
	if (nvme) out.push(new RegExp(`\\b${nvme}\\b`));
	return out;
}

const isError = (text) => LINK_ERROR_PATTERNS.some((p) => p.test(text));

/**
 * PURE. Every error line, per device. `byDevice[name]` is the device's own
 * error lines; a line naming no known device is `unattributed`.
 */
export function classifyLink({ devices, lines }) {
	const matchers = devices.map((d) => [d, deviceMatchers(d)]);
	const byDevice = Object.fromEntries(devices.map((d) => [d.name, []]));
	const unattributed = [];
	for (const l of lines) {
		if (!isError(l.text)) continue;
		const owners = matchers.filter(([, ms]) => ms.some((m) => m.test(l.text))).map(([d]) => d);
		if (!owners.length) unattributed.push(l.text);
		for (const d of owners) byDevice[d.name].push(l.text);
	}
	return { byDevice, unattributed };
}

/**
 * PURE. One disk's verdict from the read, plus every OTHER device's errors
 * as node impact.
 *
 * @param {{ serial: string|null }} disk
 * @param {ReturnType<typeof parseLinkRead>} read
 * @returns {{ verdict: 'pass'|'fail'|'blocked', reason: string, errors: string[],
 *   nodeImpact: { device: string, serial: string|null, errors: number, first: string }[] }}
 */
export function judgeLink(disk, read) {
	if (!read.complete)
		return { verdict: 'blocked', reason: read.why ?? 'no read', errors: [], nodeImpact: [] };
	const mine = read.devices.filter((d) => d.serial && d.serial === disk.serial);
	if (mine.length !== 1)
		return {
			verdict: 'blocked',
			reason: `${mine.length} block devices answer to serial ${disk.serial}`,
			errors: [],
			nodeImpact: [],
		};
	const dev = mine[0];
	const { byDevice } = classifyLink(read);
	const errors = byDevice[dev.name] ?? [];
	const nodeImpact = read.devices
		.filter((d) => d.name !== dev.name && byDevice[d.name]?.length)
		.map((d) => ({
			device: d.name,
			serial: d.serial,
			errors: byDevice[d.name].length,
			first: byDevice[d.name][0],
		}));
	if (errors.length)
		return {
			verdict: 'fail',
			reason:
				`REJECTED: the kernel logged ${errors.length} link error(s), reset(s) or device-disable(s) for ` +
				`${dev.name}${dev.ata ? ` (${dev.ata})` : ''}; first: ${errors[0].replace(/^\S+\s+/, '')}`,
			errors: errors.slice(0, 20),
			nodeImpact,
		};
	return {
		verdict: 'pass',
		reason: `no link error, reset or device-disable for ${dev.name}${dev.ata ? ` (${dev.ata})` : ''} in ${read.lines.length} kernel line(s)`,
		errors: [],
		nodeImpact,
	};
}

/**
 * Read the kernel log for one step's window and judge `serial`. Used by every
 * onboarding step that touches a disk; `{ verdict: 'blocked' }` when the read
 * failed, never a pass.
 */
export async function linkCheck(ctx, serial, sinceSec) {
	const r = await ctx.exec(linkReadScript({ sinceSec }), { timeoutMs: 120_000 });
	return judgeLink({ serial }, parseLinkRead(r.stdout));
}

/**
 * The rejection a link verdict carries into the ledger, for
 * lib/disk-rejections.mjs to persist. Null unless the verdict rejects.
 */
export function rejectionOf(serial, link, step) {
	return link.verdict === 'fail'
		? { serial, rule: 'link', step, reason: link.reason, evidence: link.errors.slice(0, 10) }
		: null;
}

/**
 * The `disk-link` test, by the persisted rejections (`rejected`: serial →
 * record). A disk already rejected stays failed whatever this boot's log
 * says: a reboot clears the ring, not the fault.
 */
export function makeLinkTest({ rejected = {} } = {}) {
	return {
		id: 'disk-link',
		track: 'qualify',
		needsDrain: false,
		runsAs: 'admin',
		ttlDays: QUALIFY_TTL_DAYS,
		minutes: 3,
		async run(ctx) {
			const inv = await readInventory(ctx);
			if ('error' in inv) return { status: 'could-not-look', reason: inv.error, metrics: {} };
			const r = await ctx.exec(linkReadScript(), { timeoutMs: 120_000 });
			const read = parseLinkRead(r.stdout);
			const impact = new Map();
			const disks = candidates(inv.inventory).map((d) => {
				const prior = d.serial ? rejected[d.serial] : null;
				const j = judgeLink(d, read);
				for (const x of j.nodeImpact) impact.set(x.device, x);
				const base = { serial: d.serial, device: d.device, model: d.model };
				if (prior)
					return {
						...base,
						verdict: 'fail',
						reason: `rejected ${prior.at} by the ${prior.rule} rule (${prior.step}): ${prior.reason}`,
						rejection: null,
					};
				return {
					...base,
					verdict: j.verdict,
					reason: `${diskName(d)}: ${j.reason}`,
					rejection: d.serial ? rejectionOf(d.serial, j, 'disk-link') : null,
				};
			});
			// The candidates' own errors are theirs; any OTHER device's errors
			// (the root disk, an optical drive) are the node's.
			const own = new Set(disks.map((d) => d.device.replace(/^\/dev\//, '')));
			const nodeImpact = [...impact.values()].filter((x) => !own.has(x.device));
			// A root-disk zone (#141) is judged by its root disk, as disk-smart's is.
			const rootDisk = judgeRoot(inv.inventory, (d) => {
				const j = judgeLink(d, read);
				return { serial: d.serial, device: d.device, verdict: j.verdict, reason: j.reason };
			});
			return nodeStatus('the link check', disks, { nodeImpact, rootDisk });
		},
	};
}
