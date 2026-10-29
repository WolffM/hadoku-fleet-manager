/**
 * HOSTING RUNTIMES: what runs inside a tenant's slice, one entry per kind of thing.
 *
 * Everything else a tenant gets is the same for all of them and lives in
 * lib/hosting.mjs: the slice, the system user and its 0700 home, the
 * firewall shape its ingress names, the oom ranking, notice, read-back. What
 * differs is only this: the names on the node, and the unit text that starts
 * the tenant. Adding a kind of hosting (a plain systemd service, a container,
 * a static site) is adding an entry here; the validator accepts its name as a
 * `runtime.manager` from this table and nowhere else.
 *
 * Each entry:
 *   kind      the request kind it serves: `agent` (the fleet supervises the
 *             tenant's own executable) or `service` (the app layer deploys
 *             into a manager the fleet runs as the tenant's user).
 *   names     the user, unit names and executable for an app, derived, never
 *             typed. cardtable's are the names claw-9 has run since 10-24.
 *   unit      the unit that runs the tenant, written verbatim to the node.
 *   pathUnit  only a runtime that waits for a fleet-installed executable.
 *
 * Unit text is part of the contract with what is already running: a render
 * that changes by one byte makes the next re-declare restart the tenant
 * (cardtable's JVMs). tenant-registry.test.mjs pins both renders.
 */
import { AGENT_OOM_SCORE_ADJ } from '../../dist/runners/hosting-record.js';

/** `cardtable` → `CARDTABLE`: the prefix of the environment a tenant's unit hands it. */
const envPrefix = (app) => app.toUpperCase().replace(/-/g, '_');

/** Lines every tenant unit carries, whatever runs in it. */
const hardening = (t) => `OOMScoreAdjust=${AGENT_OOM_SCORE_ADJ}
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=${t.home}`;

export const RUNTIMES = {
	/**
	 * The tenant's own executable, supervised, as its user. With
	 * `workersOutliveRestart` (WORKERS_OUTLIVE_RESTART in
	 * lib/hosting-request.mjs) the agent gets its subtree and a restart
	 * signals only the agent.
	 */
	agent: {
		kind: 'agent',
		names: (app) => ({
			user: `${app}-agent`,
			service: `${app}-agent.service`,
			pathUnit: `${app}-agent.path`,
			/** Root-owned, written only by `--install`. */
			exec: `/opt/hosting/${app}/run`,
		}),
		unit(t) {
			const outlive = t.workersOutliveRestart
				? `
# The tenant's workers (cardtable: one JVM per match group) outlive an agent
# restart: the agent gets its own cgroup subtree to place them in, and a
# restart signals only the agent. The slice still bounds the whole subtree.
Delegate=yes
KillMode=process`
				: '';
			return `[Unit]
Description=fleet hosting: ${t.app} agent, as ${t.user}, supervised
ConditionPathIsExecutable=${t.exec}
StartLimitIntervalSec=0

[Service]
User=${t.user}
Group=${t.user}
Slice=${t.slice}
ExecStart=${t.exec}
WorkingDirectory=${t.home}
Environment=${envPrefix(t.app)}_AGENT_PORT=${t.port}
Restart=always
RestartSec=2${outlive}
${hardening(t)}

[Install]
WantedBy=multi-user.target`;
		},
		/** An agent starts once its executable exists (`--install`). */
		pathUnit: (t) => `[Unit]
Description=fleet hosting: start the ${t.app} agent once it is installed

[Path]
PathExists=${t.exec}
Unit=${t.service}

[Install]
WantedBy=multi-user.target`,
	},

	/**
	 * A pm2 daemon as the tenant's user, its PM2_HOME inside that user's 0700
	 * home. The app layer deploys INTO it; the fleet only supervises the
	 * daemon. Shaped like the pm2-<user> units `pm2 startup` writes on claw-4,
	 * and the shape hadoku_site#490 deploys against.
	 */
	pm2: {
		kind: 'service',
		/**
		 * Files the tenant's home must hold, written by the door (only when they
		 * differ) and read back by the judge. The app layer builds a service as
		 * its user with `pnpm install`, and @wolffm packages come from GitHub
		 * Packages: without this mapping that install goes out unauthenticated
		 * and 401s (watchparty's first deploy on claw-6, 2026-10-29). TOKENLESS,
		 * like every fleet `~/.npmrc`: pnpm expands NODE_AUTH_TOKEN from the
		 * deploy's own environment.
		 */
		homeFiles: {
			'.npmrc':
				'//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n' +
				'@wolffm:registry=https://npm.pkg.github.com\n',
		},
		names: (app) => ({
			user: `${app}-svc`,
			service: `pm2-${app}-svc.service`,
			pathUnit: null,
			exec: null,
		}),
		unit: (t) => `[Unit]
Description=fleet hosting: ${t.app} pm2 daemon, as ${t.user}

[Service]
Type=forking
User=${t.user}
Group=${t.user}
Slice=${t.slice}
WorkingDirectory=${t.home}
Environment=PM2_HOME=${t.home}/.pm2
Environment=PATH=/usr/local/bin:/usr/bin:/bin
PIDFile=${t.home}/.pm2/pm2.pid
ExecStart=/usr/bin/env pm2 resurrect
ExecReload=/usr/bin/env pm2 reload all
ExecStop=/usr/bin/env pm2 kill
Restart=on-failure
${hardening(t)}

[Install]
WantedBy=multi-user.target`,
	},
};

/** The managers a `service` may name: every runtime that serves the service kind. */
export const SERVICE_MANAGERS = Object.keys(RUNTIMES).filter((r) => RUNTIMES[r].kind === 'service');

/** Which runtime a NORMALIZED request runs under. */
export const runtimeOf = (request) =>
	request.kind === 'agent' ? 'agent' : request.runtime.manager;

/** The runtime entry for a tenant spec. Throws on a spec naming none: it would render nothing. */
export function runtimeFor(t) {
	const r = RUNTIMES[t.runtime];
	if (!r) throw new Error(`tenant ${t.app}: no hosting runtime "${t.runtime}"`);
	return r;
}
