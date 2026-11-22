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
 * THE DEV USER (a node whose manifest entry names `users.dev`) is read the
 * same way, plus two facts of its own: its slice's weight from the kernel's
 * `cpu.weight`, and `claude` by RUNNING it as that user. Its findings are
 * ADVISORY until 2026-11-27: a new check starts quiet (AGENTS.md).
 *
 * A node that has not been cut over (`users.ci` absent) is reported as such,
 * with what that means today, ci = admin with NOPASSWD sudo, as an advisory:
 * true, and worth seeing, but not drift from a declaration nobody made yet.
 */
import {
	DEV_CLAUDE_BIN,
	DEV_LEASE_BIN,
	DEV_LEASE_KEY,
	SESSION_WEIGHT,
	ciIsSeparate,
	hostsSessions,
	leaseIdentity,
	nodeHome,
	nodeUser,
} from '../../dist/lib/node-users.js';
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

/** The dev user's facts, as `dev*=` lines. Read as admin, through sudo where its 0700 home needs it. */
function devObserve(dev, home) {
	return `DEV=${dev}
DEV_HOME=${home}
if pw=$(getent passwd "$DEV"); then
	echo "devUid=$(echo "$pw" | cut -d: -f3)"
	echo "devHome=$(echo "$pw" | cut -d: -f6)"
	echo "devGroups=$(id -Gn "$DEV" 2>/dev/null)"
	echo "devHomeStat=$(stat -c '%U:%a' "$DEV_HOME" 2>/dev/null)"
	echo "devLinger=$([ -e "/var/lib/systemd/linger/$DEV" ] && echo yes || echo no)"
	echo "devSudoRead=$(sudo -n true 2>/dev/null && echo yes || echo no)"
	echo "devSudo=$(sudo -n -l -U "$DEV" 2>/dev/null | grep -c 'may run' || true)"
	dkeys=$(sudo -n cat "$DEV_HOME/.ssh/authorized_keys" 2>/dev/null)
	echo "devKeysRead=$([ $? -eq 0 ] && echo yes || echo no)"
	echo "devKeyLines=$(printf '%s\\n' "$dkeys" | grep -c '[^[:space:]]' || true)"
	echo "devKeyOpen=$(printf '%s\\n' "$dkeys" | grep '[^[:space:]]' | grep -vc '^from="[^"]*"' || true)"
	echo "devWeight=$(cat "/sys/fs/cgroup/user.slice/user-$(id -u "$DEV").slice/cpu.weight" 2>/dev/null)"
	echo "devClaude=$(sudo -n -u "$DEV" -H "$DEV_HOME/${DEV_CLAUDE_BIN}" --version 2>/dev/null | head -1)"
	echo "devRunners=$(sudo -n pgrep -c -u "$DEV" -x 'Runner\\.(Listener|Worker)' 2>/dev/null || true)"
	echo "devLeaseKey=$(sudo -n stat -c '%U:%a' "$DEV_HOME/${DEV_LEASE_KEY}" 2>/dev/null)"
	# EXECUTE the lease identity: whoami asks the edge who the key is and
	# whether the lease route admits it. Bounded: two calls of 15 s at most.
	w=$(sudo -n -u "$DEV" -H env CLAUDE_LEASE_KEY_FILE="$DEV_HOME/${DEV_LEASE_KEY}" timeout 35 "$DEV_HOME/${DEV_LEASE_BIN}" whoami 2>&1)
	echo "devLeaseId=$(printf '%s\\n' "$w" | sed -n 's/^identity:[[:space:]]*\\([^[:space:]]*\\).*/\\1/p' | head -1)"
	case "$w" in *": member ("*) m=yes ;; *"NOT a member"*) m=no ;; *) m=unknown ;; esac
	echo "devLeaseMember=$m"
	echo "devLeaseWhy=$(printf '%s\\n' "$w" | grep . | tail -1 | tr -d '\\r' | cut -c1-200)"
	echo "devGh=$(sudo -n -u "$DEV" -H timeout 20 gh api user --jq .login 2>/dev/null | tail -1)"
fi
`;
}

/** `KEY=value` lines between markers, like the hosting observation. */
export function usersObserveScript(machine) {
	const ci = nodeUser(machine, 'ci');
	const admin = nodeUser(machine, 'admin');
	const dev = hostsSessions(machine) ? nodeUser(machine, 'dev') : null;
	return `CI=${ci}
ADMIN=${admin}
CI_HOME=${nodeHome(machine, 'ci')}
echo USERS-BEGIN
${dev ? devObserve(dev, nodeHome(machine, 'dev')) : ''}if pw=$(getent passwd "$CI"); then
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
		/** The dev user's facts; null when the node names none or the account does not exist. */
		dev:
			kv.devUid === undefined
				? null
				: {
						uid: num('devUid'),
						home: kv.devHome ?? null,
						groups: kv.devGroups ? kv.devGroups.split(/\s+/) : null,
						homeStat: kv.devHomeStat || null,
						linger: kv.devLinger === 'yes',
						sudo: kv.devSudoRead === 'yes' ? num('devSudo') : null,
						keysRead: kv.devKeysRead === 'yes',
						keyLines: num('devKeyLines'),
						keyOpen: num('devKeyOpen'),
						weight: num('devWeight'),
						claude: kv.devClaude || null,
						runners: num('devRunners'),
						lease: {
							key: kv.devLeaseKey || null,
							identity: kv.devLeaseId || null,
							member:
								kv.devLeaseMember === 'yes' ? true : kv.devLeaseMember === 'no' ? false : null,
							why: kv.devLeaseWhy || null,
						},
						github: kv.devGh || null,
					},
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

/**
 * Judge node `node`'s dev user: `{ state, findings }`.
 *   none    the manifest names no `users.dev`: this node hosts no sessions
 *   ok      every guarantee holds
 *   drift   the declared dev user is not what it must be
 *
 * ADVISORY until 2026-11-27, then promoted with the count of real catches and
 * false positives in that week (AGENTS.md, "a new gate starts quiet").
 */
export function judgeNodeSessions(machine, obs, node) {
	if (!hostsSessions(machine)) return { state: 'none', findings: [] };
	const findings = [];
	const drift = (why) => findings.push({ class: 'advisory', category: 'dev-user-drift', why });
	const dev = nodeUser(machine, 'dev');
	const d = obs?.dev;
	if (!d) {
		drift(`the dev user ${dev} does not exist`);
		return { state: 'drift', findings };
	}
	const home = nodeHome(machine, 'dev');
	if (d.home !== home) drift(`${dev}'s home is ${d.home}, not ${home}`);
	if (d.homeStat !== `${dev}:700`)
		drift(`${home} is ${d.homeStat ?? 'unreadable'}, not ${dev}-owned 0700`);
	if (!d.linger) drift(`${dev} has no linger, so a session dies with the ssh that started it`);
	if (d.groups === null) drift(`could not read ${dev}'s groups`);
	else if (d.groups.some((g) => g !== dev))
		drift(
			`${dev} is in ${d.groups.filter((g) => g !== dev).join(', ')}: only its own group is allowed`
		);
	if (d.sudo === null) drift(`could not read ${dev}'s sudo rights`);
	else if (d.sudo > 0) drift(`${dev} may run sudo: a session could become root here`);
	if (!d.keysRead) drift(`could not read ${dev}'s authorized_keys`);
	else if (!(d.keyLines > 0)) drift(`${dev} has no authorized key, so the operator cannot log in`);
	else if (d.keyOpen > 0) drift(`${d.keyOpen} of ${dev}'s authorized keys lack from=`);
	if (d.weight === null) drift(`could not read the cpu.weight of ${dev}'s slice`);
	else if (d.weight !== SESSION_WEIGHT)
		drift(
			`${dev}'s slice weighs ${d.weight}, not ${SESSION_WEIGHT}: sessions and CI contend as equals`
		);
	if (!d.claude) drift(`claude does not run as ${dev}`);
	judgeLease(node, dev, d.lease, drift);
	if (!d.github)
		drift(
			`${dev}'s gh does not answer as anyone on GitHub, so its sessions cannot push or call gh`
		);
	if (d.runners === null) drift(`could not count runner processes of ${dev}`);
	else if (d.runners > 0)
		drift(`${d.runners} runner process(es) run as ${dev}: CI is using the session user`);
	return { state: findings.length ? 'drift' : 'ok', findings };
}

/**
 * The node's lease identity (plan step 4): a 0600 key of the dev user's
 * whose `claude-lease whoami` names `<node>-sessions` and is admitted to the
 * lease route. A wrong identity matters most: the sessions would lease, and
 * be granted or revoked, as someone else.
 */
function judgeLease(node, dev, lease, drift) {
	const want = leaseIdentity(node);
	if (!lease?.key)
		return drift(`${dev} has no lease key, so its sessions cannot lease from crossposter`);
	if (lease.key !== `${dev}:600`)
		drift(`${dev}'s lease key is ${lease.key}, not ${dev}-owned 0600`);
	if (lease.member === null)
		return drift(`could not ask the edge who ${dev}'s lease key is: ${lease.why ?? 'no answer'}`);
	if (lease.identity !== want)
		drift(`${dev}'s lease key is ${lease.identity ?? 'no identity'}, not ${want}`);
	if (!lease.member)
		drift(`${lease.identity ?? dev} is not on the edge list crossposter-claude-code-lease`);
}

const NO_LOGIN = /\/(nologin|false)$/;

/**
 * Claim every account on a node from the record that creates it
 * (docs/planning/node-users-2026-10-27.md §2, phase 2). Only `fleet node-users`
 * asks this; node-status, which tenants read, does not.
 *
 *   admin, ci, dev      `machines.<node>.users`, through the registry
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
	const dev = hostsSessions(machine) ? nodeUser(machine, 'dev') : null;
	const byUser = new Map(registered.map((t) => [t.user, t]));
	for (const acct of obs.accounts) {
		if (acct.name === admin || acct.name === ci || acct.name === dev) continue;
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
