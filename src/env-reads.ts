/**
 * EVERY ENVIRONMENT VARIABLE THIS PACKAGE READS, as data (fleet-manager#81).
 *
 * mgmt-api spawns the fleet CLI from about nine nightly jobs and used to hand
 * each one its whole `process.env`, which mirrors every vault item. To pass an
 * explicit env instead, the caller needs the names the CLI reads, and it
 * cannot derive them from outside: some are read by a computed name
 * (`fromEnv(FLEET_OWNER_ENV)`, `process.env[TOKEN_ENV]`, a loop over a token
 * list). So the list lives here, and
 * `scripts/lib/env-reads-guard.test.mjs` fails the build when a read lands
 * that it does not name, or when it names a variable nothing reads.
 *
 * `scope` says who needs the name:
 *   cli   read by the `fleet` CLI or the library when mgmt-api runs them
 *   base  never read by name here, but read by a tool the CLI spawns (`ssh`,
 *         `git`, `gh`) or by Node itself; a child env without these breaks
 *         the CLI as surely as a missing token. The guard cannot see these.
 *   ci    read only by this repo's own workflows (the ppe promoter, commit
 *         identity checks); never needed by a caller
 *   test  a test seam; a caller must NOT pass it
 *
 * `secret`: the VALUE is a credential. Whether hadoku_site holds it in the
 * vault is hadoku_site's fact, not this package's.
 *
 * Shell scripts are not scanned: the ones under `scripts/` run on nodes over
 * ssh, which forwards no environment, so the caller's env never reaches them.
 */
export type EnvReadScope = 'cli' | 'base' | 'ci' | 'test';

export interface EnvRead {
	readonly name: string;
	readonly scope: EnvReadScope;
	readonly secret: boolean;
	readonly why: string;
}

const cli = (name: string, why: string, secret = false): EnvRead => ({
	name,
	scope: 'cli',
	secret,
	why,
});
const of =
	(scope: EnvReadScope) =>
	(name: string, why: string, secret = false): EnvRead => ({ name, scope, secret, why });
const base = of('base');
const ci = of('ci');
const seam = of('test');

export const ENV_READS: readonly EnvRead[] = [
	// --- credentials -----------------------------------------------------------
	cli('HADOKU_SITE_TOKEN', 'GitHub token, first in the floor-probe token order', true),
	cli('GITHUB_TOKEN', 'GitHub token fallback (floor-probe, gh-app); ppe scripts in CI', true),
	cli('GH_TOKEN', 'GitHub token fallback; `gh-app` sets it for the gh it spawns', true),
	cli('FLEET_GITHUB_TOKEN', 'standalone serve: the GitHub token its host hands out', true),
	cli('FLEET_GH_APP_ID', 'fleet-gates GitHub App id (bulk gates mint an installation token)'),
	cli('FLEET_GH_APP_KEY', 'fleet-gates GitHub App private key (PEM)', true),
	cli('FLEET_GH_APP_INSTALLATION_ID', 'fleet-gates GitHub App installation, when not discovered'),
	cli('FLEET_SERVICE_KEY', 'monitoring-api / consumer-imports service key', true),
	cli('CLOUDFLARE_TUNNEL_API_TOKEN', 'converge-toolchain: Cloudflare tunnel API token', true),
	cli('DISCORD_EMERGENCY_NOTIFICATIONS_WEBHOOK', 'standalone serve: the paging webhook', true),
	// --- where things are ------------------------------------------------------
	cli('FLEET_MANIFEST_DIR', 'operator manifests (default <site>/scripts/admin)'),
	cli('HADOKU_SITE_ROOT', 'the hub repo checkout manifests default under'),
	cli('HADOKU_STATE_DIR', 'the state directory override'),
	cli('REPOS_DIR', 'where repo checkouts live'),
	cli('FLEET_DEPLOY_SITE_ROOT', 'the deployed site tree manifest writers target'),
	cli('FLEET_DEPLOY_ROOTS', 'extra deploy trees a manifest write fans out to'),
	cli('FLEET_NODE_PROFILES', 'node-profiles.json override'),
	cli('FLEET_USAGE_DIR', 'CLI usage-log directory'),
	cli('FLEET_SOURCE_URL', 'fleet-source: where other repos are read from'),
	cli('FLEET_SOURCE_CACHE', 'fleet-source: local cache directory'),
	cli('FLEET_SOURCE_MAX_AGE_S', 'fleet-source: cache max age'),
	cli('XDG_STATE_HOME', 'session index location'),
	// --- endpoints -------------------------------------------------------------
	cli('MGMT_API_URL', 'backstop-switch / traffic-status: mgmt-api base URL'),
	cli('MONITORING_API_BASE', 'standalone serve: monitoring-api base URL'),
	cli('FLEET_DATA_URL', 'probe-script: data endpoint'),
	// --- identity of the caller -----------------------------------------------
	cli('FLEET_CALLER', 'names the job that ran the CLI, for the usage log and job records'),
	cli('FLEET_NO_BANNER', 'suppresses the CLI banner'),
	cli('FLEET_NODE', 'service-inventory: which node this box is'),
	cli('HOSTNAME', 'backstop-switch: this box'),
	cli('USER', 'who ran a door command (drain, hosting, retire)'),
	cli('SUDO_USER', 'who ran a door command under sudo'),
	cli('SSH_CONNECTION', 'usage log: was the CLI run over ssh'),
	cli('CLAUDECODE', 'usage log: was the CLI run by an agent'),
	cli('AI_AGENT', 'usage log: was the CLI run by an agent'),
	cli('GITHUB_ACTIONS', 'usage log: was the CLI run in CI'),
	cli('name', 'usage log: the PM2 app name, when run under PM2'),
	cli('pm_id', 'usage log: the PM2 id, when run under PM2'),
	// --- behaviour -------------------------------------------------------------
	cli('FLEET_OWNER', 'GitHub owner (default: the fleet owner in fleet-config)'),
	cli('FLEET_HUB_REPO', 'the hub repo (default: fleet-config)'),
	cli('FLEET_PACKAGE_NAME', 'this package name, for self-references'),
	cli('FLEET_SSH_SUFFIX', 'suffix appended to node names for ssh'),
	cli('FLEET_GH_RESERVE', 'GitHub budget floor the gates keep'),
	cli('FLEET_EGRESS_SETTLE_MS', 'egress-slices: settle wait for a restarting app'),
	cli('FLEET_DOOR_COMMANDS', 'fleet-usage: door command table override'),
	cli('FLEET_DOOR_TABLE', 'fleet-gates: door table override'),
	cli('FLEET_LOOPS', 'standalone serve: `off` starts no loops'),
	cli('FLEET_PORT', 'standalone serve port (default 4010)'),
	cli('FLEET_SPAWNER', 'spawner helper process switch'),
	cli('FLEET_STORE_DOCTOR', 'standalone serve: doctor store switch'),
	cli('WARM_CACHE_DISABLED', 'turns the warm cache off'),
	// --- read by what the CLI spawns, never by name here -----------------------
	base('PATH', 'every spawned tool; a fake-node test helper also reads it'),
	base('HOME', '~/.ssh for ssh, ~/.gitconfig for git; enroll-ssh reads it'),
	base('SSH_AUTH_SOCK', 'ssh to the nodes when the key is held by an agent'),
	// --- this repo's own CI ----------------------------------------------------
	ci('GIT_SSH_COMMAND', 'git over ssh with the ppe deploy key'),
	ci('GIT_TERMINAL_PROMPT', 'keeps git from prompting in the ppe scripts'),
	ci('PPE_DEPLOY_KEY', 'ppe promoter/sync deploy key', true),
	ci('PPE_REMOTE', 'ppe promoter/sync remote'),
	ci('PPE_BRANCH', 'ppe branch name'),
	ci('PPE_MAIN_BRANCH', 'main branch name'),
	ci('PPE_FORCE', 'promote now'),
	ci('PPE_NOW_MS', 'promoter clock'),
	ci('GITHUB_API_URL', 'GitHub Actions API base'),
	ci('GITHUB_SERVER_URL', 'GitHub Actions server'),
	ci('GITHUB_REPOSITORY', 'GitHub Actions repo'),
	ci('GITHUB_OUTPUT', 'GitHub Actions step output file'),
	ci('GITHUB_STEP_SUMMARY', 'GitHub Actions step summary file'),
	ci('RUNNER_TEMP', 'GitHub Actions temp dir'),
	ci('GIT_AUTHOR_NAME', 'commit identity of the promoter'),
	ci('GIT_AUTHOR_EMAIL', 'commit identity checks'),
	ci('GIT_COMMITTER_NAME', 'commit identity of the promoter'),
	ci('GIT_COMMITTER_EMAIL', 'commit identity of the promoter'),
	ci('GIT_DIR', 'split-check runs inside a hook'),
	ci('GIT_INDEX_FILE', 'split-check runs inside a hook'),
	ci('GIT_WORK_TREE', 'split-check runs inside a hook'),
	ci('BOUNDARY_PROBE_REPO', 'check-boundary-contracts probe target'),
	// --- test seams: a caller must not pass these ------------------------------
	seam('NODE_TEST_CONTEXT', 'set by node:test'),
	seam('VITEST', 'set by vitest'),
	seam('FLEET_TEST_NOW', 'bootcamp clock'),
	seam('FLEET_TEST_IDLE_TIMING', 'bootcamp idle timing'),
	seam('FLEET_TEST_RELEASE_LOOKUP', 'bootcamp tool release lookup'),
	seam('FLEET_BOOTCAMP_SCRIPT_FOR_TEST', 'capabilities: bootcamp script override'),
];

/** The names a caller running the CLI must pass through: `cli` and `base`. */
export function envNamesForCaller(): string[] {
	return ENV_READS.filter((r) => r.scope === 'cli' || r.scope === 'base').map((r) => r.name);
}
