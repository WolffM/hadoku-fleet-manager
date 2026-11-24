/**
 * THE STORAGE INVENTORY RECORD — the contract the storage bootcamp reads
 * (hadoku-fleet-manager#136; qualify #137, the format/mount converger #140,
 * the Garage layout manager #141 and the pool gate #142 consume it).
 *
 * `parseStorage` in `storage-inventory.mjs` builds it from
 * `scripts/storage-probe.sh`'s output, and `storage-inventory.test.mjs` holds
 * every record it builds from the real-node fixtures to exactly these keys. A
 * `.ts` file imports it the way `src/label-floor.ts` imports demand-derive.mjs.
 *
 * NULL MEANS "NOT REPORTED", never zero or false. A disk is named by `serial`
 * for anything that acts on it; `device` (sda, nvme0n1) moves between boots.
 */

/**
 * Why there is or is not a SMART reading:
 * - `ok`          the drive answered and its health is PASSED/OK
 * - `failing`     the drive answered and its health is anything else
 * - `no-tool`     smartctl is not installed on the node
 * - `not-root`    smartctl is installed, but the probe could not open the device
 * - `unsupported` the drive or its USB bridge refused SMART
 * - `disabled`    the drive has SMART switched off
 * - `no-answer`   smartctl ran and said nothing this parser recognises
 */
export type SmartStatus =
	'ok' | 'failing' | 'no-tool' | 'not-root' | 'unsupported' | 'disabled' | 'no-answer';

export interface StorageSmart {
	status: SmartStatus;
	/** Why the status is not `ok`, in a sentence; null when it is. */
	why: string | null;
	health: string | null;
	powerOnHours: number | null;
	temperatureC: number | null;
	/** ATA reallocated sectors, or NVMe media-and-data-integrity errors. */
	reallocated: number | null;
	pendingSectors: number | null;
	/** ATA attribute 198: sectors the drive's own offline scan could not read. */
	offlineUncorrectable: number | null;
	/** ATA attribute 187 (Reported_Uncorrect, Samsung's Uncorrectable_Error_Cnt). */
	reportedUncorrect: number | null;
	lifetimeRemainingPct: number | null;
}

export interface StorageFilesystem {
	fstype: string;
	uuid: string | null;
	label: string | null;
}

export interface StoragePartition {
	name: string;
	sizeBytes: number;
	fstype: string | null;
	uuid: string | null;
	label: string | null;
	mountpoint: string | null;
}

export interface StorageDisk {
	/** Kernel name: `sda`, `nvme0n1`. Not stable across boots; see `serial`. */
	device: string;
	path: string;
	model: string | null;
	serial: string | null;
	sizeBytes: number;
	/** False for an empty card-reader slot, which the kernel lists at 0 bytes. */
	mediaPresent: boolean;
	rotational: boolean | null;
	removable: boolean | null;
	/** lsblk TRAN: `sata`, `ata`, `nvme`, `usb`. */
	transport: string | null;
	kind: 'nvme' | 'ata';
	scheduler: string | null;
	/**
	 * sysfs `queue/zoned`: `none`, `host-aware` or `host-managed`; null when the
	 * probe did not report it. `none` is NOT evidence of CMR: a drive-managed
	 * SMR disk hides its zones and says `none`.
	 */
	zoned: string | null;
	/** smartctl's `TRIM Command:` line; null when the drive printed none. */
	trim: boolean | null;
	/** `/` is on this disk. */
	isRoot: boolean;
	/** Anything on this disk is mounted, swap included. */
	mounted: boolean;
	mountpoints: string[];
	/** `gpt`, `dos`, or null for none. */
	partitionTable: string | null;
	/** A filesystem on the whole disk, with no partition table under it. */
	filesystem: StorageFilesystem | null;
	partitions: StoragePartition[];
	/**
	 * Media present, and no partition table, filesystem or partition on it.
	 * Null when lsblk did not answer for the disk: not looked at is not blank.
	 */
	blank: boolean | null;
	smart: StorageSmart;
}

export interface StorageInventory {
	schema: 1;
	/** The probe ran as root; SMART needs it. */
	root: boolean;
	/** Path to smartctl, or null when the node has none. */
	smartTool: string | null;
	/** lsblk was there; without it no filesystem, UUID or serial is known. */
	lsblk: boolean;
	disks: StorageDisk[];
}

export const STORAGE_SCHEMA: 1;
export function parseStorage(text: string): StorageInventory;
export function parseLsblkRow(row: string): Record<string, string>;
