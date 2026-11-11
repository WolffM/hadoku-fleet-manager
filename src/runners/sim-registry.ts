/** Every policy `fleet simulate --policy` can run, by name; parameters come from `--set key=value`. */
import { baselinePolicy, type SimPolicy } from './sim-engine.js';
import { legacyHoldPolicy, reservationPolicy, type ReservationParams } from './sim-policies.js';
import { tunedPolicy, type TunedParams } from './sim-tuned.js';

export const POLICIES: Readonly<
	Record<string, (params?: Readonly<Record<string, number>>) => SimPolicy>
> = {
	baseline: () => baselinePolicy(),
	'legacy-hold': () => legacyHoldPolicy(),
	reservation: (params) => reservationPolicy(params as Partial<ReservationParams> | undefined),
	tuned: (params) => tunedPolicy(params as Partial<TunedParams> | undefined),
};
