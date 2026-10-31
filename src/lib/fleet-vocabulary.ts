/** @see FleetMachine.state */
export type ClawState =
	'free' | 'busy' | 'demoted' | 'offline' | 'absent' | 'mintable' | 'unreachable' | 'sick';

/**
 * Why the backstop is up, or `'none'`. A UNION, not `string`.
 *
 * `decideBackstop` has returned exactly these four since it was written, and the
 * report widened them to `string | null` on the way out — so the panel's
 * four-branch switch fell through to "unknown" for any value it had not been
 * told about, and a rename here would have surfaced as a grey pill on the one
 * page opened when something is already wrong.
 */
export type BackstopReason = 'outage' | 'saturation' | 'holding' | 'none';
