/**
 * `fleet prove-job` AND A GUEST — the two CLI-side layers of the guest refusal.
 *
 * The library (`src/runners/prove-job.ts`) is layer one: it refuses a guest
 * unless the operator passed `--include-guests`, and even then it proves the
 * guest's STANDING registration through the GitHub API alone. These are the
 * other two, kept here so each is executable in a test rather than only in a
 * process that the library has already stopped short:
 *
 *   2. THE TRANSPORT. `proofShell` never reaches a guest, opt-in or not. The
 *      standing mode needs no ssh, so `--include-guests` must not open the
 *      transport — and it WOULD, silently: `runOn`'s role gate (`guestGate`)
 *      honours `--include-guests` read from `process.argv` when no `argv` is
 *      passed. So `argv: []` is passed, and a guest is refused here before
 *      `runOn` is even called.
 *   3. THE POST-CHECK. `guestPostCheck` reads the RESULT: a guest that was not
 *      refused without the opt-in, or a guest the transport was asked to reach,
 *      is a bug in this package and is reported as one.
 */

/**
 * The `sh` port `proveJob` is handed. Never reaches a guest.
 *
 * @param {{ runOn: Function, isGuest: (node: string) => boolean, timeoutMs?: number }} deps
 * @returns {{ sh: (node: string, cmd: string) => Promise<string|null>, guestReached: string[] }}
 */
export function proofShell({ runOn, isGuest, timeoutMs = 300_000 }) {
	const guestReached = [];
	return {
		guestReached,
		sh: async (node, cmd) => {
			if (isGuest(node)) {
				guestReached.push(node);
				return null;
			}
			const r = await runOn(node, cmd, { timeoutMs, includeGuests: false, argv: [] });
			return r.ok ? r.stdout : null;
		},
	};
}

/**
 * The findings a guest run adds to a result. PURE.
 *
 * @param {{verdict: string, mode?: string}} result
 * @param {{ isGuest: boolean, includeGuests: boolean, guestReached: string[] }} ctx
 * @returns {{rule: string, message: string}[]}
 */
export function guestPostCheck(result, { isGuest, includeGuests, guestReached }) {
	const out = [];
	if (isGuest && !includeGuests && result.verdict !== 'refused') {
		out.push({ rule: 'guest', message: 'a guest was proven without the opt-in — this is a bug' });
	}
	if (isGuest && includeGuests && result.verdict !== 'refused' && result.mode !== 'standing') {
		out.push({
			rule: 'guest',
			message: 'a guest was proven by a path other than its standing runner — this is a bug',
		});
	}
	if (guestReached.length) {
		out.push({
			rule: 'guest',
			message: `the proof asked the transport to reach a guest (${[...new Set(guestReached)].join(', ')}) — this is a bug`,
		});
	}
	return out;
}
