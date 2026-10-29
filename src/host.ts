/**
 * The injected host.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT `__dirname` ARITHMETIC.
 *
 * Inside mgmt-api this component reached out of its own tree with five
 * `resolve(__dirname, '../../../…')` paths, and EVERY loader behind them fails
 * SOFT. Moved without them, nothing throws: `loadTierManifest()` returns null,
 * `loadClawNodes()` returns an empty set, and that empty set is deliberately
 * read as "unknown → fall back to the label reading". Measured on two real
 * runners before the move:
 *
 *     census with the manifest      -> clawsOnline 2
 *     census with an EMPTY manifest -> clawsOnline 1   <-- a demoted claw vanishes
 *
 * `clawsOnline` decides whether the fleet declares an OUTAGE and promotes the
 * production host as a builder. A mis-pathed extraction therefore boots, passes
 * every test, serves traffic, and quietly mis-detects outages — and no gate
 * catches it, because `check:fleet-coverage` validates that file's CONTENT
 * against GitHub, not whether this code can find it.
 *
 * So the paths are REQUIRED CONFIGURATION. `requirePaths()` stats every one at
 * construction and throws naming the missing file. Loud at boot beats silent
 * forever.
 *
 * The accessors below are module-level on purpose. The component holds ~16
 * mutable singletons and is a singleton by construction; threading a context
 * object through 6,400 lines would have been a rewrite, not a move, and the
 * point of this pass was to move it without changing its behaviour.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { measuredFacetPaths } from './lib/measured-paths.js';

/** Mirrors mgmt-api's discord-sink result. Structural, so the host's real one fits. */
export interface PostDiscordResult {
	posted: boolean;
	sinkRecorded: boolean;
	lastError?: string;
}

export interface FleetHostLogger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export interface FleetHost {
	logger: FleetHostLogger;
	/** Discord alerting. `recordQuietly` books an alert without posting it. */
	alerts: {
		post(content: string, source: string): Promise<PostDiscordResult>;
		recordQuietly(content: string, source: string): void;
	};
	/** Job-result reporting. An OUTPUT port — never a route module. */
	jobs: {
		recordJobResult(
			jobName: string,
			jobState: 'succeeded' | 'failed',
			durationMs: number,
			opts?: { cron?: string; data?: Record<string, unknown>; error?: string }
		): Promise<void>;
	};
	/** Returns undefined when unset; monitors skip a tick rather than throw. */
	githubToken(): string | undefined;
	/** Directory holding fleet-runner-manifest / fleet-runner-coverage. */
	manifestDir: string;
	/** Operator state root (`~/.hadoku-mgmt`). job-history.jsonl lives here. */
	stateDir: string;
	/** `pnpm-store-doctor.sh`. A CONTRACT WITH CI, not internal detail — the
	 *  guarded install writes the sick marker, this script clears it. */
	storeDoctorPath: string;
	/**
	 * DEPRECATED: the host's cron profiles, read for a declared-cron window.
	 * Absent when the host reports its busy periods through host leases
	 * (`host-lease.ts`), which is how the standalone service runs.
	 */
	cronProfilesPath?: string;
	/**
	 * Does this host run the fleet's in-process loops — the fast loop (probe,
	 * repair, label writes, dispatch) and runner-health (outage detection,
	 * the hokon backstop)?
	 *
	 * OPTIONAL. Omitted or `true` is today's behaviour: `start()` starts both.
	 * `false` makes this a PASSIVE host — `start()` starts neither, and logs one
	 * line saying so. The router and `snapshot()` keep working either way (see
	 * `FleetManager.snapshot` in index.ts for what a passive host's snapshot
	 * returns).
	 *
	 * This exists for active/passive pm2 hosting (hadoku_site, designed
	 * 2026-10-01): a passive mgmt-api replica must not run these loops, because
	 * two controllers running them is not redundancy, it is double-dispatch and
	 * double label writes against ONE 5,000/hr GitHub budget (AGENTS.md
	 * `REAP_INTERVAL_MS`). See `docs/control-plane.md` for the full assumption
	 * this flag is cutting into.
	 */
	controller?: boolean;
}

let current: FleetHost | null = null;

function need(): FleetHost {
	if (!current) {
		throw new Error(
			'@wolffm/fleet-manager: host not installed. Call createFleetManager(host) before ' +
				'using any fleet module.'
		);
	}
	return current;
}

/**
 * Fail loudly, at construction, on a path that does not exist.
 *
 * This is the whole reason the extraction is safe. Every one of these feeds a
 * loader that returns empty rather than throwing, so an unchecked bad path is
 * indistinguishable from a healthy fleet with nothing in it.
 */
function requirePaths(host: FleetHost): void {
	const required: [string, string][] = [
		['manifestDir', host.manifestDir],
		['manifestDir/fleet-runner-manifest.json', `${host.manifestDir}/fleet-runner-manifest.json`],
		['manifestDir/fleet-runner-coverage.json', `${host.manifestDir}/fleet-runner-coverage.json`],
		['storeDoctorPath', host.storeDoctorPath],
		...(host.cronProfilesPath !== undefined
			? ([['cronProfilesPath', host.cronProfilesPath]] as [string, string][])
			: []),
	];
	const missing = required.filter(([, p]) => !p || !existsSync(p)).map(([n, p]) => `${n} (${p})`);
	if (missing.length) {
		throw new Error(
			`@wolffm/fleet-manager: ${missing.length} required path(s) do not exist:\n  ` +
				missing.join('\n  ') +
				'\n\nThese are not optional. Every loader behind them fails SOFT — an absent ' +
				'manifest reads as an empty fleet, which mis-detects outages instead of erroring.'
		);
	}
	// stateDir is created on demand by job-history, so it is not required to
	// pre-exist; it must merely be set.
	if (!host.stateDir) throw new Error('@wolffm/fleet-manager: stateDir is required.');
}

/**
 * The state-dir facet files (`src/lib/measured.ts`) that are NOT there.
 *
 * DECLARED, BUT NOT YET REQUIRED — and the difference is the migration order,
 * not a judgement that they matter less. `$benchmark` and `$health` moved out of
 * the manifest in Wave 3h, and the manifest was the one tree guarded by an
 * existence check at construction (`requirePaths` above); `stateDir()` has none.
 * `measured-facets-home-2026-09-16.md` §2.3 rule 2 moves the guard with the
 * data: these files join the boot check. §4 step 1 declares them OPTIONAL,
 * because on the day this ships no node has a state-dir file yet and a throwing
 * guard would refuse to boot a healthy fleet mid-migration. §4 step 7 flips
 * them to required, once every node has both files.
 *
 * Until then a missing one is SAID at boot (see {@link installHost}) rather than
 * thrown — never silent. Nothing in-process reads either facet today; the
 * readers are the CLI's, and they render a missing file as due / could-not-look
 * on their own.
 */
export function missingMeasuredFiles(host: Pick<FleetHost, 'stateDir'>): string[] {
	return measuredFacetPaths(host.stateDir)
		.filter(({ path }) => !existsSync(path))
		.map(({ facet, path }) => `${facet} (${path})`);
}

export function installHost(host: FleetHost): void {
	requirePaths(host);
	const missing = missingMeasuredFiles(host);
	if (missing.length) {
		host.logger.warn(
			`@wolffm/fleet-manager: ${missing.length} state-dir facet file(s) absent: ` +
				`${missing.join(', ')}. Not yet required (measured-facets-home §4 step 7); every ` +
				'reader of them treats the absence as due / could-not-look, never as healthy.'
		);
	}
	current = host;
}

/** What a one-shot CLI process can honestly supply to the library. */
export interface CliHostOptions {
	/** Library messages. A `--json` command must send these to stderr, never stdout. */
	logger: FleetHostLogger;
	manifestDir: string;
	stateDir: string;
	githubToken?: () => string | undefined;
}

/**
 * The host for a standalone `scripts/*.mjs` subcommand that reaches library code
 * which logs (the JIT mint, `ghWrite`) but is not mgmt-api and not the service.
 *
 * WHY NOT `installHost`: it demands `storeDoctorPath` and `cronProfilesPath`
 * exist, which makes every CLI depend on a sibling hadoku_site checkout — the
 * coupling the service split exists to end. WHY NOT `createFleetManager`: it is
 * the singleton that builds the monitors, and a CLI must not construct the thing
 * that ticks (and its guard stays exactly as it is).
 *
 * WHAT IT REFUSES TO DO: the members a CLI has no business using are not
 * no-ops, they THROW. A silent `alerts.post` would let a CLI path "alert"
 * nobody and report success; a throw makes the first such use a loud, local bug.
 * It also refuses to run when a host is already installed, so it can never mask
 * or replace mgmt-api's real one.
 */
export function installCliHost(opts: CliHostOptions): void {
	if (current) {
		throw new Error(
			'@wolffm/fleet-manager: installCliHost called with a host already installed — a CLI ' +
				'host must never replace the real one.'
		);
	}
	if (!opts.manifestDir || !existsSync(opts.manifestDir)) {
		throw new Error(
			`@wolffm/fleet-manager: manifestDir does not exist (${opts.manifestDir}). A manifest ` +
				'that resolves to nothing reads as a healthy fleet of zero machines.'
		);
	}
	if (!opts.stateDir) throw new Error('@wolffm/fleet-manager: stateDir is required.');
	const notForCli = (what: string): never => {
		throw new Error(
			`@wolffm/fleet-manager: ${what} is not available to a CLI host (installCliHost). ` +
				'Only logging, manifestDir, stateDir and the GitHub token are.'
		);
	};
	current = {
		logger: opts.logger,
		alerts: {
			post: () => notForCli('alerts.post'),
			recordQuietly: () => notForCli('alerts.recordQuietly'),
		},
		jobs: { recordJobResult: () => notForCli('jobs.recordJobResult') },
		githubToken: opts.githubToken ?? (() => undefined),
		manifestDir: opts.manifestDir,
		stateDir: opts.stateDir,
		get storeDoctorPath(): string {
			return notForCli('storeDoctorPath');
		},
		get cronProfilesPath(): string | undefined {
			return notForCli('cronProfilesPath');
		},
	};
}

/** Test seam. Not part of the supported API. */
/** For an inbound call that must work in a process that never installed a host. */
export function hostInstalled(): boolean {
	return current !== null;
}

export function __setHostForTesting(host: FleetHost | null): void {
	current = host;
}

export const logger: FleetHostLogger = {
	info: (m) => need().logger.info(m),
	warn: (m) => need().logger.warn(m),
	error: (m) => need().logger.error(m),
};

export const postDiscord: FleetHost['alerts']['post'] = (content, source) =>
	need().alerts.post(content, source);

export const recordAlertQuietly: FleetHost['alerts']['recordQuietly'] = (content, source) =>
	need().alerts.recordQuietly(content, source);

export const recordJobResult: FleetHost['jobs']['recordJobResult'] = (
	jobName,
	jobState,
	durationMs,
	opts
) => need().jobs.recordJobResult(jobName, jobState, durationMs, opts);

export const githubToken = (): string | undefined => need().githubToken();

/**
 * How often a loop that started before the host had a token looks again (#133).
 *
 * mgmt-api boots with its vault SEALED whenever an ecosystem reload restarts
 * Vaultwarden beside it, so "no token at start()" is a normal boot, not a
 * misconfiguration. On 2026-10-22 02:32 runner-health read it once, disabled
 * itself, and the Fleet panel showed every claw `unpolled` for 17 minutes until
 * the next restart. `githubToken()` is an env read in mgmt-api, so polling it
 * costs nothing; the first tick goes out within this long of the unseal.
 */
export const TOKEN_RETRY_MS = 5_000;

export const manifestDir = (): string => need().manifestDir;

/** A named manifest or allowlist inside {@link manifestDir}. */
export const manifest = (name: string): string => join(need().manifestDir, name);
export const stateDir = (): string => need().stateDir;
export const storeDoctorPath = (): string => need().storeDoctorPath;
export const cronProfilesPath = (): string | undefined => need().cronProfilesPath;
