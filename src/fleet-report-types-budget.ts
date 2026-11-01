/**
 * The GitHub-budget SECTION of the `GET /fleet` contract (wave 5r lane A
 * pure move out of `fleet-report-types.ts`): one token's hourly budget as
 * GitHub last reported it, with who in this process spent it (#119). See
 * that file's own header for why this is a type-only barrel's section
 * rather than a runtime module — `fleet-report-types.ts` re-exports every
 * name below for every existing importer.
 */

/** Who made a GitHub call. One word per loop, so a page can name the spender (#119). */
export type GhCaller =
	| 'reap'
	| 'dispatch-poll'
	| 'dispatch-probe'
	| 'mint'
	| 'warm-cache'
	| 'fleet-loop'
	| 'runner-health'
	| 'backstop'
	| 'ci-alerts'
	| 'ci-runner-var'
	| 'route'
	| 'unattributed';

/**
 * One token's hourly GitHub budget, as GitHub last reported it, with who in
 * this process spent it (#119). See `gh-budget.ts`.
 *
 * `used`/`remaining` are the TOKEN's — HADOKU_SITE_TOKEN is shared with the
 * workflows that use it — while `byCaller` is only this process's calls since
 * `countedSince` (a restart resets it). `otherSinceFirst` is the difference:
 * what the token was charged in that time that no caller here accounts for.
 */
export interface FleetGithubBudget {
	/** A label and a hash prefix, never the token. */
	token: string;
	resource: string;
	limit: number;
	remaining: number;
	used: number;
	/** remaining / limit, 0..1. */
	fractionLeft: number;
	resetAt: string;
	observedAt: string;
	/** True once the clock has passed `resetAt` — a past window's reading. */
	expired: boolean;
	countedSince: string;
	/** Charged calls (non-304) and free 304s per caller, most charged first. */
	byCaller: { caller: GhCaller; charged: number; notModified: number }[];
	otherSinceFirst: number;
	/**
	 * What each metered caller (`meterGhPool`; mgmt-api's crons) moved the pool
	 * by while it ran, net of this process, most first. Upper bounds that
	 * overlap: a cron is charged with whatever else ran beside it. Optional only
	 * for readers built against an older report.
	 */
	metered?: { caller: string; runs: number; spent: number; unread: number }[];
	/** Spend that was not this process's, per five minutes, oldest first. */
	outsideTimeline?: { at: string; outside: number }[];
	/** The low-budget alert has fired for this window. */
	alerted: boolean;
	/**
	 * How many processes have carried these books over from a predecessor —
	 * mgmt-api restarts on every deploy, and the books are persisted. Optional
	 * only for readers built against an older report.
	 */
	restarts?: number;
}
