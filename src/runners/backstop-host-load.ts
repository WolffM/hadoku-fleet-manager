/**
 * The backstop host's load and memory, as the saturation gate reads it —
 * split out of `backstop-decision.ts` (wave 5r lane C, pure move) to bring
 * that file under the 800-line ceiling. `__setHostLoadReaderForTesting`
 * stays re-exported from `backstop-decision.ts`, so no importer elsewhere
 * needed to change.
 */
import os from 'node:os';
import { readFileSync } from 'node:fs';

import { isLocalNode } from '../lib/node-identity.js';

export type HostLoad = { load1: number; cores: number; memAvailableMb: number };
let hostLoadReader: (node: string) => HostLoad | null = readHostLoadFromProc;
export const readHostLoad = (node: string): HostLoad | null => hostLoadReader(node);
/** Test seam: the backstop's idle check reads this instead of /proc. */
export function __setHostLoadReaderForTesting(
	fn: ((node: string) => HostLoad | null) | null
): void {
	hostLoadReader = fn ?? readHostLoadFromProc;
}

/** The backstop host's load and memory for `isHostIdle`, read from /proc when it is THIS box. */
function readHostLoadFromProc(
	node: string
): { load1: number; cores: number; memAvailableMb: number } | null {
	if (!isLocalNode(node)) return null;
	try {
		const load1 = Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
		const mem = /MemAvailable:\s+(\d+) kB/.exec(readFileSync('/proc/meminfo', 'utf8'));
		return { load1, cores: os.cpus().length, memAvailableMb: mem ? Number(mem[1]) / 1024 : 0 };
	} catch {
		return null;
	}
}
