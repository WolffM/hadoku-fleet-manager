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

/** Groups a ci user may be in besides its own: GPU device access, granted where a GPU label is proven. */
export const ALLOWED_CI_GROUPS = ['video', 'render'];

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
n=0; wrong=0
# By process name, not command line: see hosting.mjs observeScript.
for q in $(pgrep -x 'Runner\\.(Listener|Worker)'); do
	u=$(awk '/^Uid:/{print $2}' "/proc/$q/status" 2>/dev/null) || continue
	n=$((n+1))
	[ "$u" = "$(id -u "$CI" 2>/dev/null)" ] || wrong=$((wrong+1))
done
echo "runnerProcs=$n"
echo "runnersNotCi=$wrong"
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
	for (const line of text.slice(a, b).split('\n')) {
		const i = line.indexOf('=');
		if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
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
