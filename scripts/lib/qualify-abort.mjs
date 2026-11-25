/**
 * WHAT A KILLED QUALIFY RUN MUST STILL UNDO ON THE NODE.
 *
 * A step that starts work on a node that outlives its ssh call (the
 * node-impact load: `setsid`, its own `timeout`) registers how to stop it
 * here, and removes it once stopped. qualify-node.mjs's SIGINT/SIGTERM
 * handler runs every registered stop before it undrains and exits. Before
 * this, a run killed with its session left a Garage-shaped load writing at
 * 375 MB/s on claw-8 (2026-11-25) after the node was back in service.
 */

const hooks = new Set();

/** Register `stop` (async). Returns the function that removes it. */
export function onAbort(stop) {
	hooks.add(stop);
	return () => hooks.delete(stop);
}

/**
 * Run every registered stop, at most `timeoutMs` in all. Resolves to the
 * reasons the ones that failed or did not finish gave; never throws.
 */
export async function runAbortHooks(timeoutMs = 60_000) {
	const all = [...hooks];
	hooks.clear();
	const why = [];
	let timer;
	const done = Promise.all(
		all.map((f) =>
			Promise.resolve()
				.then(f)
				.catch((e) => why.push(e instanceof Error ? e.message : String(e)))
		)
	);
	const late = new Promise((r) => {
		timer = setTimeout(() => r('late'), timeoutMs);
	});
	if ((await Promise.race([done, late])) === 'late')
		why.push(`${all.length} stop(s) still running after ${timeoutMs} ms`);
	clearTimeout(timer);
	return why;
}
