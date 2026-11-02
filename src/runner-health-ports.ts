/**
 * The two ci-scheduling decisions `checkLabelFloor` triggers mid-tick — the
 * backstop promotion (`runners/backstop-decision.ts`) and the hosted-runner
 * `CI_RUNNER` fallback (`runners/hosted-fallback.ts`) — as PORTS this
 * observation-domain file calls through, rather than importing either
 * module directly (wave clean-2 lane A, cut (iii)).
 *
 * Observation may not import ci-scheduling (rule 5, §3.2: "a domain reads
 * another domain's facts through a state record", never the other domain's
 * own module). ci-scheduling MAY legally import observation — this file
 * matches `src/runner-health*.ts`, so it is observation too, and
 * `backstop-decision.ts`/`hosted-fallback.ts` already type their `data`
 * argument against `TickReport` (this domain's own report shape) without
 * that being a violation.
 *
 * `index.ts` (composition, which may import anyone) wires the real
 * functions in once, inside `createFleetManager()`, before any tick can run.
 * `src/tests/helpers/runner-health-rig.ts` wires the SAME real functions for
 * the test suite, which ticks the monitor directly through `tick()`/`runTick()`
 * and never runs `createFleetManager()`. One setter serves both — the same
 * convention `fleet-probe-store.ts`'s `__setFleetProbeForTesting` already
 * uses — so production and the tests can never wire two different
 * implementations.
 *
 * Call order, inputs and GitHub calls are UNCHANGED: `checkLabelFloor` still
 * builds every field inline from the one runner listing it already fetched,
 * and still awaits the backstop decision before the hosted fallback, in the
 * same place in its control flow — only the two imports moved.
 */
import type { TickReport } from './runner-health-snapshot.js';
import type { GhRunner } from './lib/github-client.js';

export interface BackstopDecisionInput {
	token: string;
	fleetRepos: string[];
	data: TickReport;
	clawsOnline: number;
	clawsRegistered: number;
	clawsFree: number;
	ephemeralUnknown: boolean;
	pm2BusyNodes: Set<string>;
	fleetNodes: string[];
	backstopPool: GhRunner[];
	has: (r: GhRunner, label: string) => boolean;
}
export type BackstopDecisionRunner = (input: BackstopDecisionInput) => Promise<void>;

export interface HostedFallbackInput {
	token: string;
	ephemeralUnknown: boolean;
	clawsOnline: number;
	backstopOnline: number;
	data: TickReport;
}
export type HostedFallbackRunner = (input: HostedFallbackInput) => Promise<void>;

type ResetFn = () => void;
const noopReset: ResetFn = () => undefined;

let backstopDecisionRunner: BackstopDecisionRunner | null = null;
let hostedFallbackRunner: HostedFallbackRunner | null = null;
let backstopDecisionReset: ResetFn = noopReset;
let hostedFallbackReset: ResetFn = noopReset;

/**
 * The composition root's production wire for the backstop decision — also
 * the test rig's. Not "ForTesting": this one has no safe default (see
 * {@link runBackstopDecisionPort}), so production must call it too.
 */
export function setBackstopDecisionRunner(fn: BackstopDecisionRunner): void {
	backstopDecisionRunner = fn;
}

/** The composition root's / test rig's production wire for the hosted fallback. */
export function setHostedFallbackRunner(fn: HostedFallbackRunner): void {
	hostedFallbackRunner = fn;
}

/**
 * Wires the backstop decision's OWN cross-tick-memory reset
 * (`__resetBackstopDecisionForTesting`) behind this port, so
 * `runner-health.ts`'s umbrella `__resetRunnerHealthAlertsForTesting` can
 * reset it without importing `runners/backstop-decision.ts` directly.
 * Defaults to a no-op: unlike the decision itself, an unwired reset is
 * harmless — there is nothing yet to reset before the first wire.
 */
export function setBackstopDecisionReset(fn: ResetFn): void {
	backstopDecisionReset = fn;
}

/** Same as {@link setBackstopDecisionReset}, for `hosted-fallback.ts`. */
export function setHostedFallbackReset(fn: ResetFn): void {
	hostedFallbackReset = fn;
}

/**
 * `checkLabelFloor`'s call site for the backstop decision. THROWS if nothing
 * wired it — "I could not look" must never render as "nothing is wrong", and
 * a silent no-op here would be exactly that: the backstop would stop
 * promoting hokon with no error anywhere.
 */
export function runBackstopDecisionPort(input: BackstopDecisionInput): Promise<void> {
	if (!backstopDecisionRunner) {
		throw new Error(
			'[runner-health-ports] no backstop-decision runner wired — index.ts (or the test rig) ' +
				'must call setBackstopDecisionRunner() before any tick runs'
		);
	}
	return backstopDecisionRunner(input);
}

/** `checkLabelFloor`'s call site for the hosted fallback. Same throw-if-unwired rule as {@link runBackstopDecisionPort}. */
export function runHostedFallbackPort(input: HostedFallbackInput): Promise<void> {
	if (!hostedFallbackRunner) {
		throw new Error(
			'[runner-health-ports] no hosted-fallback runner wired — index.ts (or the test rig) ' +
				'must call setHostedFallbackRunner() before any tick runs'
		);
	}
	return hostedFallbackRunner(input);
}

/** `runner-health.ts`'s umbrella test reset calls this instead of importing `backstop-decision.ts` itself. */
export function resetBackstopDecisionPort(): void {
	backstopDecisionReset();
}

/** `runner-health.ts`'s umbrella test reset calls this instead of importing `hosted-fallback.ts` itself. */
export function resetHostedFallbackPort(): void {
	hostedFallbackReset();
}
