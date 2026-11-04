/**
 * A SLICE OF k UNITS, the door's half (scripts/hosting.mjs). How many units a
 * claw holds is the converger's (lib/hosting-converge.mjs); the door records
 * the size and holds it to the tenant's `slices.max`, which counts UNITS.
 */
import { parseCores, parseMemoryMb } from './hosting.mjs';
import { unitsOf } from './hosting-request.mjs';

/**
 * `--end --memory M --cores C` on a shared slice is a SHRINK: it serves at its
 * full size until the end, then is re-declared at this one. `{ shrinkTo }`,
 * null when no size was given (a plain end), or `{ why }` it is refused.
 */
export function shrinkOf(memory, cores, rec) {
	if (!memory) return { shrinkTo: null };
	let shrinkTo;
	try {
		shrinkTo = { memoryMb: parseMemoryMb(memory), cores: parseCores(cores) };
	} catch (err) {
		return { why: err.message };
	}
	if (rec && shrinkTo.memoryMb < rec.memoryMb && shrinkTo.cores <= rec.cores) return { shrinkTo };
	return {
		why: `a shrink is of a shared slice, to less memory than its ${rec?.memoryMb ?? '?'} MiB and no more cores.`,
	};
}

/** Why `memoryMb` on this node puts `request` past `slices.max` units, or null. `elsewhere`: its primaries on other nodes. */
export function unitsRefusal(request, elsewhere, memoryMb) {
	const total =
		elsewhere.reduce((n, h) => n + unitsOf(request, h.memoryMb), 0) + unitsOf(request, memoryMb);
	return total > request.slices.max
		? `${request.app} would hold ${total} units; its slices.max is ${request.slices.max}.`
		: null;
}
