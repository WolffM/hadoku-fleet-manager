/**
 * Ask a node a question, and ask once more before calling it silent.
 *
 * fleet-manager#112: one `node-status` read on 2026-11-17 marked five wired
 * claws unreachable at once and promoted hokon to cardtable's Forge backstop
 * for 50 s. The claws' own journals showed what happened. Every one of them
 * accepted the ssh at 21:23:46.6Z. Delivery from hokon then came in bursts
 * (21:23:54.95Z, 21:24:00.88Z), shared by every session on every wired claw,
 * while the Wi-Fi claws answered in under a second. So each 20 s attempt was
 * killed with its answer still in flight. An ssh opened at 21:24:06Z, the
 * moment after the kill, answered normally. One attempt cannot tell a node
 * that is gone from a path that paused; a second attempt can.
 *
 * Retrying is NOT tolerating (AGENTS.md, "I could not look"): a node that
 * misses every attempt is still unreachable, and the reason carries each
 * attempt's own failure, so a timeout, a refusal and a cut-off answer stay
 * three different findings.
 */

/** Attempts before a node is called unreachable: one more than the first. */
export const ANSWER_ATTEMPTS = 2;

/**
 * Run `script` on `node` with `run` (`runOn`'s shape) until `parse` accepts its
 * stdout, at most `attempts` times. Returns `{ value, misses }`. `value` is the
 * first parsed answer, or null when every attempt missed. `misses` holds one
 * reason per failed attempt, in order: empty when the first attempt answered.
 */
export async function askNode({ node, script, run, opts, parse, attempts = ANSWER_ATTEMPTS }) {
	const misses = [];
	for (let i = 0; i < attempts; i++) {
		const r = await run(node, script, opts);
		const value = parse(r.stdout);
		if (value) return { value, misses };
		misses.push(missReason(r));
	}
	return { value: null, misses };
}

/** Why one attempt gave no usable answer. The transport's own error comes first: it names a timeout. */
export function missReason(r) {
	if (r.ok) return 'the node answered but its answer stopped short';
	return r.error || String(r.stderr ?? '').trim() || 'no answer';
}

/** Every attempt's reason in one line, for an `unreachable` finding. */
export function missesWhy(misses) {
	if (misses.length === 1) return misses[0];
	return `no complete answer in ${misses.length} attempts: ${misses.map((m, i) => `(${i + 1}) ${m}`).join('; ')}`;
}
