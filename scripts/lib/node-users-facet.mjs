/**
 * The node-users FACET: is a node's ci user what the fleet says it is?
 * (docs/planning/node-users-2026-10-27.md §3, src/lib/node-users.ts.)
 *
 * Every fact is READ from where the kernel or the account database keeps it,
 * never from what a cutover wrote:
 *
 *   exists, uid, home       `getent passwd`
 *   home 0700, owned        `stat`
 *   linger                  `/var/lib/systemd/linger/<user>`
 *   groups                  `id -Gn`, against ALLOWED_CI_GROUPS
 *   no sudo                 `sudo -l -U`, read as admin
 *   ssh key restricted      the ci user's authorized_keys, every line `from=` and `restrict`
 *   CI runs as ci           the uid of every Runner.Listener/Worker in /proc
 *   no secret in argv       no runner's /proc cmdline carries `--jitconfig`
 *
 * The last one is what catches a code path still minting as admin after a
 * cutover. Read as ADMIN: only admin may run `sudo -l -U` and read another
 * user's 0700 home.
 *
 * A node that has not been cut over (`users.ci` absent) is reported as such,
 * with what that means today, ci = admin with NOPASSWD sudo, as an advisory:
 * true, and worth seeing, but not drift from a declaration nobody made yet.
 */
import { ciIsSeparate, nodeHome, nodeUser } from '../../dist/lib/node-users.js';
import { TENANT_USER_SUFFIXES } from './tenant-registry.mjs';

/** Groups a ci user may be in besides its own: GPU device access, granted where a GPU label is proven. */
export const ALLOWED_CI_GROUPS = ['video', 'render'];

/**
 * Which accounts {@link judgeNodeAccounts} must claim: the human uid range, any
 * account with a login shell, and any named like a tenant's user (a tenant user
 * is a SYSTEM account, below 1000, with no shell). root is the system's own.
 */
const ACCOUNT_SELECT =
	`$3!=0 && (($3>=1000 && $3<60000) || $7 !~ /(nologin|false|sync|shutdown|halt)$/` +
	TENANT_USER_SUFFIXES.map((x) => ` || $1 ~ /${x}$/`).join('') +
	`)`;

/** `KEY=value` lines between markers, like the hosting observation. */
export function usersObserveScript(machine) {
	const ci = nodeUser(machine, 'ci');
	const admin = nodeUser(machine, 'admin');
	return `CI=${ci}
ADMIN=${admin}
CI_HOME=${nodeHome(machine, 'ci')}
echo USERS-BEGIN
if pw=$(getent passwd "$CI"); then
	echo "ciUid=$(echo "$pw" | cut -d: -f3)"
	echo "ciHome=$(echo "$pw" | cut -d: -f6)"
	echo "ciShell=$(echo "$pw" | cut -d: -f7)"
	echo "ciGroups=$(id -Gn "$CI" 2>/dev/null)"
	echo "ciHomeStat=$(stat -c '%U:%a' "$CI_HOME" 2>/dev/null)"
	echo "ciLinger=$([ -e "/var/lib/systemd/linger/$CI" ] && echo yes || echo no)"
	echo "ciSudo=$(sudo -n -l -U "$CI" 2>/dev/null | grep -c 'may run' || true)"
	echo "sudoReadable=$(sudo -n true 2>/dev/null && echo yes || echo no)"
	keys=$(sudo -n cat "$CI_HOME/.ssh/authorized_keys" 2>/dev/null)
	echo "keysRead=$([ $? -eq 0 ] && echo yes || echo no)"
	echo "keyLines=$(printf '%s\\n' "$keys" | grep -c '[^[:space:]]' || true)"
	echo "keyUnrestricted=$(printf '%s\\n' "$keys" | grep '[^[:space:]]' | grep -vc '^from="[^"]*".*\\brestrict\\b' || true)"
fi
n=0; wrong=0; argv=0
# By process name, not command line: see hosting.mjs observeScript.
for q in $(pgrep -x 'Runner\\.(Listener|Worker)'); do
	u=$(awk '/^Uid:/{print $2}' "/proc/$q/status" 2>/dev/null) || continue
	n=$((n+1))
	[ "$u" = "$(id -u "$CI" 2>/dev/null)" ] || wrong=$((wrong+1))
	tr '\\0' '\\n' < "/proc/$q/cmdline" 2>/dev/null | grep -qx -- '--jitconfig' && argv=$((argv+1))
done
echo "runnerProcs=$n"
echo "runnersNotCi=$wrong"
echo "secretArgv=$argv"
# Every account that must be claimed: name:uid:shell:groups:sudo:slice-tasks.
# slice-tasks is hosting-<app>.slice's pids.current for a tenant-named account:
# the kernel's count over the whole subtree, which admin can read even where a
# tenant delegates sub-cgroups it cannot enter. '-' is no such slice, 'U' a
# slice whose count could not be read.
echo "accountsRead=$(getent passwd >/dev/null && echo yes || echo no)"
getent passwd | awk -F: '${ACCOUNT_SELECT} {print $1":"$3":"$7}' | while IFS=: read -r name uid shell; do
	groups=$(id -Gn "$name" 2>/dev/null | tr ' ' ',')
	sudo=$(sudo -n -l -U "$name" 2>/dev/null | grep -c 'may run' || true)
	tasks=-
	for suffix in ${TENANT_USER_SUFFIXES.join(' ')}; do
		case "$name" in *"$suffix")
			c="/sys/fs/cgroup/hosting.slice/hosting-\${name%"$suffix"}.slice"
			[ -d "$c" ] && tasks=$(cat "$c/pids.current" 2>/dev/null || echo U) ;;
		esac
	done
	echo "account=$name:$uid:$shell:$groups:$sudo:$tasks"
done
echo USERS-END
`;
}

/** Parse {@link usersObserveScript}; null when the end marker never arrived. */
export function parseUsersObservation(stdout) {
	const text = String(stdout ?? '');
	const a = text.indexOf('USERS-BEGIN');
	const b = text.indexOf('USERS-END');
	if (a === -1 || b === -1 || b < a) return null;
	const kv = {};
	const accounts = [];
	for (const line of text.slice(a, b).split('\n')) {
		const i = line.indexOf('=');
		if (i <= 0) continue;
		const key = line.slice(0, i).trim();
		const value = line.slice(i + 1).trim();
		if (key !== 'account') {
			kv[key] = value;
			continue;
		}
		const [name, uid, shell, groups, sudo, tasks] = value.split(':');
		accounts.push({
			name,
			uid: Number(uid),
			shell,
			groups: groups ? groups.split(',') : [],
			sudo: /^\d+$/.test(sudo ?? '') ? Number(sudo) : null,
			/** null when there is no slice; 'unread' when there is one and its count was not readable. */
			sliceTasks: /^\d+$/.test(tasks ?? '') ? Number(tasks) : tasks === 'U' ? 'unread' : null,
		});
	}
	const num = (k) => (kv[k] === undefined || kv[k] === '' ? null : Number(kv[k]));
	return {
		exists: kv.ciUid !== undefined,
		uid: num('ciUid'),
		home: kv.ciHome ?? null,
		shell: kv.ciShell ?? null,
		groups: kv.ciGroups ? kv.ciGroups.split(/\s+/) : null,
		homeStat: kv.ciHomeStat || null,
		linger: kv.ciLinger === 'yes',
		sudo: num('ciSudo'),
		sudoReadable: kv.sudoReadable === 'yes',
		keysRead: kv.keysRead === 'yes',
		keyLines: num('keyLines'),
		keyUnrestricted: num('keyUnrestricted'),
		runnerProcs: num('runnerProcs'),
		runnersNotCi: num('runnersNotCi'),
		secretArgv: num('secretArgv'),
		/** null when the account database could not be read: could not look. */
		accounts: kv.accountsRead === 'yes' ? accounts : null,
	};
}

/**
 * Judge one node. `{ state, findings }`, findings classed like node-status's:
 *   not-cut-over   ci = admin; one ADVISORY saying what that means today
 *   ok             every guarantee holds
 *   drift          a declared ci user that is not what it must be: BLOCKING
 *   unobserved     the node did not finish answering: BLOCKING
 */
export function judgeNodeUsers(machine, obs) {
	const findings = [];
	const block = (why) => findings.push({ class: 'blocking', category: 'ci-user-drift', why });
	if (!obs) {
		findings.push({
			class: 'blocking',
			category: 'ci-user-unobserved',
			why: 'the node did not finish answering, so who runs its CI is unknown',
		});
		return { state: 'unobserved', findings };
	}
	const ci = nodeUser(machine, 'ci');
	// Every node, cut over or not: /proc/<pid>/cmdline is world-readable, so a
	// JIT config in argv hands its private key to any local user, a hosted
	// tenant included (0.34.125 moved it to the environment).
	if (obs.secretArgv > 0)
		findings.push({
			class: 'blocking',
			category: 'runner-secret-in-argv',
			why: `${obs.secretArgv} runner process(es) carry --jitconfig on a world-readable command line`,
		});
	if (!ciIsSeparate(machine)) {
		findings.push({
			class: 'advisory',
			category: 'ci-is-admin',
			why: `CI runs as the admin user ${ci}${obs.sudo > 0 ? ', which has sudo: any job can become root here' : ''} (not cut over to its own user yet)`,
		});
		return { state: 'not-cut-over', findings };
	}
	if (!obs.exists) {
		block(`the ci user ${ci} does not exist`);
		return { state: 'drift', findings };
	}
	const home = nodeHome(machine, 'ci');
	if (obs.home !== home) block(`${ci}'s home is ${obs.home}, not ${home}`);
	if (obs.homeStat !== `${ci}:700`)
		block(`${home} is ${obs.homeStat ?? 'unreadable'}, not ${ci}-owned 0700`);
	if (!obs.linger)
		block(
			`${ci} has no linger, so its systemd manager (and runners.slice) stops when no one is logged in`
		);
	if (obs.groups === null) block(`could not read ${ci}'s groups`);
	else {
		const extra = obs.groups.filter((g) => g !== ci && !ALLOWED_CI_GROUPS.includes(g));
		if (extra.length)
			block(
				`${ci} is in ${extra.join(', ')}: only its own group and ${ALLOWED_CI_GROUPS.join('/')} are allowed`
			);
	}
	if (!obs.sudoReadable || obs.sudo === null) block(`could not read ${ci}'s sudo rights`);
	else if (obs.sudo > 0) block(`${ci} may run sudo`);
	if (!obs.keysRead)
		block(`could not read ${ci}'s authorized_keys, so who may log in as it is unknown`);
	else if (!(obs.keyLines > 0))
		block(`${ci} has no authorized key, so the controller cannot act as ci`);
	else if (obs.keyUnrestricted > 0)
		block(`${obs.keyUnrestricted} of ${ci}'s authorized keys lack from= and restrict`);
	if (obs.runnerProcs === null) block('could not count the runner processes');
	else if (obs.runnersNotCi > 0)
		block(
			`${obs.runnersNotCi} of ${obs.runnerProcs} runner process(es) do not run as ${ci}: something still mints as another user`
		);
	return { state: findings.length ? 'drift' : 'ok', findings };
}

const NO_LOGIN = /\/(nologin|false)$/;

/**
 * Claim every account on a node from the record that creates it
 * (docs/planning/node-users-2026-10-27.md §2, phase 2). Only `fleet node-users`
 * asks this; node-status, which tenants read, does not.
 *
 *   admin, ci           `machines.<node>.users`, through the registry
 *   <app>-agent / -svc  a registered tenant's user (the tenant registry). It
 *                       must not log in, sudo, or share a group with ci:
 *                       BLOCKING. With nothing running in its slice it is the
 *                       user `fleet hosting --remove` keeps by design: ADVISORY
 *   anything else       claimed by no role and no tenant: BLOCKING
 *
 * Whether a RUNNING tenant is declared on this node is the hosting record's
 * question, not this one: node-users reads config, never the tenancy domain's
 * records (layer-map.mjs).
 *
 * @param {object} machine
 * @param {ReturnType<typeof parseUsersObservation>} obs
 * @param {{ app: string, user: string }[]} registered every registered tenant's app and user
 */
export function judgeNodeAccounts(machine, obs, registered) {
	const findings = [];
	if (!obs || obs.accounts === null) {
		findings.push({
			class: 'blocking',
			category: 'accounts-unobserved',
			why: "could not read the node's account database, so who may log in or run here is unknown",
		});
		return findings;
	}
	const admin = nodeUser(machine, 'admin');
	const ci = ciIsSeparate(machine) ? nodeUser(machine, 'ci') : null;
	const byUser = new Map(registered.map((t) => [t.user, t]));
	for (const acct of obs.accounts) {
		if (acct.name === admin || acct.name === ci) continue;
		const tenant = byUser.get(acct.name);
		if (!tenant) {
			findings.push({
				class: 'blocking',
				category: 'unclaimed-user',
				why: `${acct.name} (uid ${acct.uid}, ${acct.shell}) is claimed by no role in machines.<node>.users and no registered tenant`,
			});
			continue;
		}
		const block = (why) => findings.push({ class: 'blocking', category: 'tenant-user-drift', why });
		if (!NO_LOGIN.test(acct.shell)) block(`${acct.name} has a login shell, ${acct.shell}`);
		if (acct.sudo === null) block(`could not read ${acct.name}'s sudo rights`);
		else if (acct.sudo > 0) block(`${acct.name} may run sudo`);
		if (ci && acct.groups.includes(ci)) block(`${acct.name} shares the group ${ci} with CI`);
		if (acct.sliceTasks === 'unread')
			block(
				`could not read whether ${tenant.app} runs here: hosting-${tenant.app}.slice has no readable pids.current`
			);
		else if (!(acct.sliceTasks > 0))
			findings.push({
				class: 'advisory',
				category: 'tenant-user-kept',
				why: `${acct.name} is registered tenant ${tenant.app}'s user with nothing running in its slice here; \`fleet hosting --remove\` keeps the user and home by design`,
			});
	}
	return findings;
}
