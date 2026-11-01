/**
 * A TENANT'S APP UNDER SOMEBODY ELSE'S PM2 (fleet-manager#43).
 *
 * pygmalion moved into its `pygmalion-svc` tenant on 2026-10-29, and the admin
 * user's own pm2 on claw-4 and claw-6 kept its old registration: deleted from
 * neither, or deleted without a `pm2 save`, so the 10-30 reboots resurrected
 * both from dumps dated 10-28 and 10-29. They sat in a "vault sealed" retry
 * loop for 27 hours, and a secret rotation's restart reached only the tenant's
 * copy. Nothing could see them: the per-tenant checks (lib/hosting-service-
 * check.mjs) read the tenant's own unit and dump, and claw-6 held no pygmalion
 * slice at all, so no per-slice check ever ran there.
 *
 * So this sweeps EVERY node, not the tenant's: each pm2 daemon's running apps
 * (the `name` pm2 puts in each child's environment) and every saved dump on the
 * box (what a reboot brings back). A tenant's pm2 names are what its OWN dump
 * holds on any node, plus its app name — archivebot's app is `archive-bot` — so
 * the names come from observed state, never a hand-written map. Any of those
 * names under another home is a stray, running or saved.
 *
 * Read with `sudo -n` as admin: another user's /proc environ and dump are not
 * readable otherwise. Where there is no sudo (hokon) only admin's own pm2 is
 * read, and any other user's daemon is named as unread. Never a `pm2` command — any pm2 command spawns a daemon
 * when none answers (lib/hosting-service-check.mjs).
 */

/** Every pm2 daemon, its running children's names, and every saved dump on the node. */
export const STRAY_OBSERVE_SCRIPT = String.raw`if sudo -n true 2>/dev/null; then S="sudo -n"; else S=""; fi
ps -eo pid=,user:32=,args= | while read -r pid user args; do
	case "$args" in "PM2 v"*": God Daemon ("*")") ;; *) continue ;; esac
	home=$(printf '%s' "$args" | sed 's/.*God Daemon (\(.*\))$/\1/')
	# Without sudo only a daemon whose environment this shell can read is read
	# (admin's own). Any other is named, so it reads as "could not look", not clean.
	if [ -z "$S" ] && ! [ -r "/proc/$pid/environ" ]; then printf 'DAEMON-UNREAD\t%s\t%s\n' "$user" "$home"; continue; fi
	printf 'DAEMON\t%s\t%s\n' "$user" "$home"
	for c in $(pgrep -P "$pid"); do
		n=$($S cat "/proc/$c/environ" 2>/dev/null | tr '\0' '\n' | sed -n 's/^name=//p' | head -n1)
		[ -n "$n" ] && printf 'RUN\t%s\t%s\n' "$home" "$n"
	done
done
# With sudo the glob runs as root: admin cannot list another user's home, so its
# own glob would match nothing there and read as "no dump".
if [ -n "$S" ]; then dumps=$($S sh -c 'ls -d /home/*/.pm2/dump.pm2 /var/lib/*/.pm2/dump.pm2 /root/.pm2/dump.pm2 2>/dev/null')
else dumps=$(ls -d "$HOME/.pm2/dump.pm2" 2>/dev/null); fi
for d in $dumps; do
	home=$(dirname "$d")
	$S python3 -c 'import json,sys
for a in json.load(open(sys.argv[1])): print("SAVED\t" + sys.argv[2] + "\t" + a["name"])' "$d" "$home" 2>/dev/null ||
		printf 'SAVED-UNREADABLE\t%s\n' "$home"
done
echo STRAYS-END
`;

/**
 * The observation as `{ pm2Homes: { home: { owner, running: [], saved: [] } }, unreadable }`,
 * or `null` when the script did not run to its end — a truncated listing is not
 * "no daemons".
 */
export function parseStrayObservation(stdout) {
	const lines = String(stdout ?? '').split('\n');
	if (!lines.includes('STRAYS-END')) return null;
	const pm2Homes = {};
	const at = (home) => (pm2Homes[home] ??= { owner: null, running: [], saved: [] });
	const unreadableDumps = [];
	const unreadDaemons = [];
	for (const line of lines) {
		const [kind, a, b] = line.split('\t');
		if (kind === 'DAEMON' && b) at(b).owner = a;
		else if (kind === 'RUN' && b) at(a).running.push(b);
		else if (kind === 'SAVED' && b) at(a).saved.push(b);
		else if (kind === 'SAVED-UNREADABLE' && a) unreadableDumps.push(a);
		else if (kind === 'DAEMON-UNREAD' && b) unreadDaemons.push(`${a}'s (${b})`);
	}
	const why = [
		unreadableDumps.length && `could not parse the saved dump under ${unreadableDumps.join(', ')}`,
		unreadDaemons.length && `no sudo -n, so ${unreadDaemons.join(', ')} pm2 could not be read`,
	].filter(Boolean);
	return { pm2Homes, unreadable: why.length ? why.join('; ') : null };
}

/** The pm2 home a tenant's daemon runs from: `<home>/.pm2`. */
const pm2HomeOf = (spec) => `${spec.home}/.pm2`;

/**
 * Each pm2 tenant's names: its app, plus every name its own dump or daemon
 * holds on any node in this sweep.
 */
export function tenantPm2Names(specs, observations) {
	const names = new Map();
	for (const spec of specs) {
		const own = new Set([spec.app]);
		for (const obs of Object.values(observations)) {
			const mine = obs?.pm2Homes?.[pm2HomeOf(spec)];
			for (const n of [...(mine?.running ?? []), ...(mine?.saved ?? [])]) own.add(n);
		}
		names.set(spec.app, own);
	}
	return names;
}

/**
 * Judge one sweep. `specs` are the pm2 tenants' specs; `observations` is
 * `{ node: parsed | null }`, `null` for a node that could not be read and is
 * not expected down. Returns `{ strays, unreadable }`; a stray carries the
 * node, the tenant, the pm2 name, whose home it is under and whether it is
 * running, saved or both.
 */
export function judgeStrays(specs, observations) {
	const names = tenantPm2Names(specs, observations);
	const strays = [];
	const unreadable = [];
	for (const [node, obs] of Object.entries(observations)) {
		if (!obs) {
			unreadable.push({ node, why: 'the pm2 sweep did not run to its end' });
			continue;
		}
		if (obs.unreadable) unreadable.push({ node, why: obs.unreadable });
		for (const [home, h] of Object.entries(obs.pm2Homes)) {
			for (const spec of specs) {
				if (home === pm2HomeOf(spec)) continue;
				for (const name of names.get(spec.app)) {
					const running = h.running.includes(name);
					const saved = h.saved.includes(name);
					if (!running && !saved) continue;
					const where = running && saved ? 'running and saved' : running ? 'running' : 'saved';
					strays.push({
						node,
						tenant: spec.app,
						name,
						owner: h.owner,
						home,
						where,
						why:
							`${spec.app}'s pm2 app ${name} is ${where} under ${h.owner ?? home}'s pm2 (${home}), ` +
							`not ${spec.user}'s: a secret rotation or restart misses it, and a reboot ` +
							`${saved ? 'brings it back' : 'drops it'}. Remove it there: pm2 delete ${name} && pm2 save --force`,
					});
				}
			}
		}
	}
	return { strays, unreadable };
}
