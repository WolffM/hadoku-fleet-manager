/**
 * PM2 CEILING: whether one pm2 manager is bounded, read off the kernel, and
 * by what. Shared by hosting-offers' probe and the doctor's, which both list
 * every `pm2-*.service` and must agree on the answer (fleet-manager#46).
 *
 * A manager is bounded by its OWN unit's `memory.max`, or, for a service
 * tenant's `pm2-<app>-svc.service`, by the slice it runs in:
 * `RUNTIMES.pm2.unit` puts it under `hosting-<app>.slice`, which carries the
 * tenant's `MemoryMax` while the unit sets none, so the unit's own cgroup reads
 * `max`. Only a TENANT slice counts: a manager in `system.slice` shares that
 * slice with everything else on the node, and its ceiling is no budget for it.
 *
 * Every figure is the kernel's, as the probe printed it. A ceiling that could
 * not be read is NOT a ceiling: only a number bounds.
 */

/** A tenant manager's ControlGroup, `/hosting.slice/hosting-<app>.slice/<unit>`; `$1` is the app. */
const TENANT_SLICE = /^\/hosting\.slice\/hosting-([^/]+)\.slice\/[^/]+$/;

/** Bytes as the kernel prints them, in MiB; null for `max`, `?` or anything else. */
export const mib = (x) => (/^\d+$/.test(x ?? '') ? Math.round(Number(x) / 1048576) : null);

/**
 * @param {{ ownMax?: string, sliceMax?: string, cg?: string }} raw the unit's
 *   own `memory.max`, its parent cgroup's, and its ControlGroup, as printed
 * @returns {{ bounded: boolean, maxMb: number | null, by: 'unit' | 'slice' | null, tenant: string | null }}
 *   `tenant` is the app whose hosting slice holds the manager (null: none)
 */
export function pm2Ceiling({ ownMax, sliceMax, cg }) {
	const m = TENANT_SLICE.exec(cg ?? '');
	const tenant = m ? m[1] : null;
	const own = mib(ownMax);
	if (own !== null) return { bounded: true, maxMb: own, by: 'unit', tenant };
	const slice = tenant === null ? null : mib(sliceMax);
	if (slice !== null) return { bounded: true, maxMb: slice, by: 'slice', tenant };
	return { bounded: false, maxMb: null, by: null, tenant };
}
