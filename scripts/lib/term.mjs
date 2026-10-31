/**
 * F10 (plan `refactor-plan-2026-10-28.md` §4.1): ONE ANSI palette, instead of
 * six files each defining the same six escape codes under a different name —
 * `backstop-switch.mjs` (`R/G/Y/B/N`), `benchmark-fleet.mjs` (`BOLD/YEL/OFF`),
 * `drain-node.mjs` (`R/G/Y/B/N`), `toolpack.mjs` (`YEL/RED/GRN/OFF`),
 * `traffic-status.mjs` (`B/G/Y/R/D/N`), and `scripts/lib/emit.mjs`
 * (`YELLOW/RESET`, its one ANSI use).
 *
 * DIVERGENCE (read before touching a caller's own short names): every file
 * above picks its OWN local letters for the same six codes, and none of them
 * agree — `R`/`RED`, `G`/`GRN`, `Y`/`YEL`/`YELLOW`, `B`/`BOLD`, `N`/`OFF`/
 * `RESET`, plus `D` for dim (traffic-status only; no other file used it).
 * Nothing here renames a caller's own short identifier — every migrated file
 * keeps printing `${R}`/`${YEL}`/`${N}` exactly as it always has; only the
 * RAW LITERAL `'\x1b[31m'` moves here, assigned once and imported under
 * whatever local alias that file already used. A caller that wants the
 * shared names directly is free to import them as-is.
 *
 * No `NO_COLOR`/TTY detection here, and none existed in any of the six
 * originals either — every one of them writes raw escapes unconditionally,
 * piped or not. That is pre-existing behaviour, not something this sweep
 * changes; disabling colour for a non-TTY is a separate decision for a
 * separate PR.
 */

export const RED = '\x1b[31m';
export const GREEN = '\x1b[32m';
export const YELLOW = '\x1b[33m';
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';
export const RESET = '\x1b[0m';

/**
 * The other half of this sweep (F10): one `errText`, in place of the three
 * byte-identical copies in `benchmark-fleet.mjs`, `scripts/lib/
 * reboot-cycle.mjs` and `scripts/lib/refresh-cycle.mjs` — all three read
 * `e instanceof Error ? e.message : String(e)`, so there is no divergence to
 * record. Not a terminal concern, but F10's own list bundles it with the ANSI
 * palette as "one sweep", and a fourth file for one four-line function would
 * be the opposite of a de-duplication.
 */
export const errText = (e) => (e instanceof Error ? e.message : String(e));
