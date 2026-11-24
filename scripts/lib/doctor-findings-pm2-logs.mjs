/**
 * doctor-findings-pm2-logs — a PM2 app whose stdout reaches no file
 * (hadoku-fleet-manager#143).
 *
 * PM2 (7.0.1) writes each forked app's out and err log through a write stream
 * its daemon (God) owns. When a write fails, ENOSPC on a momentarily full
 * disk, the stream errors, Node closes its fd, and PM2 only logs the error: it
 * never reopens the file. The app keeps running and its output goes nowhere
 * until it is respawned or `pm2 reloadLogs` runs, which recreates every app's
 * streams and restarts nothing. hokon lost two days of dataplatform-data's
 * stdout that way (hadoku_site#640); mgmt-api's watchdog heals the HUB's own
 * daemon since be997e543. Nothing looked at a claw's daemons.
 *
 * THE CHECK, the hub's shape: every running fork-mode app's out and err path
 * must be an open fd of its God. A path God does not hold is a dead stream.
 *
 * EVERY DAEMON ON THE NODE, found by the process it runs (`PM2 vX: God Daemon
 * (<home>)`), never by a list of tenants or units: the tenant daemons under
 * /var/lib/<tenant>-svc, admin's and ci's own. Read through `sudo -n` because
 * every one but admin's belongs to another user, and claw-1/2/3 mount /proc
 * hidepid, where admin's own `ps` would see none of them. An app's paths come
 * from its process environment (PM2 puts its whole pm2_env there), never from
 * a `pm2` command: any pm2 command spawns a daemon as the caller when none
 * answers (lib/hosting-pm2-strays.mjs).
 *
 * SHIPPED QUIET. Every finding is ADVISORY and `shadow: true` until its
 * false-positive rate is known (AGENTS.md, "a new gate starts quiet").
 *
 * THE REPAIR is `fleet doctor --reload-logs`: `pm2 reloadLogs` as the
 * daemon's own user, only on a daemon this run found a dead stream under, and
 * only if that same daemon is still the one running. {@link reloadLogsScript}.
 */

import { ADVISORY } from './preflight.mjs';
import { f } from './doctor-findings-record.mjs';

const CATEGORY = 'pm2-log-stream';

/**
 * The node half. Needs the doctor probe's `SUDO` and `ROOTOK`. Prints only
 * `P ` lines, tab-separated, and decides nothing:
 *
 *   P god <pid> <user> <home>          a daemon read
 *   P fd <pid> <target>                one of its open files (`/`-rooted, not /dev)
 *   P app <pid> <name> <mode> <out> <err>   a running app, paths canonical
 *   P unread <pid> <user> <home> <why> a daemon seen and not read
 *   P blind <why>                      other users' daemons cannot even be seen
 *   P end                              the stanza ran to its end
 */
export const PM2_LOGS_SH = String.raw`pm2_logs() {
	if [ "$ROOTOK" = yes ]; then R="$SUDO"; else R=""; fi
	if [ -z "$R" ] && [ "$(id -u)" != 0 ] && awk '$2=="/proc" && /hidepid=(1|2|invisible|noaccess)/' /proc/mounts 2>/dev/null | grep -q .; then
		printf 'P blind\t%s\n' "/proc is hidepid and sudo -n was refused, so another user's pm2 daemon is invisible here"
	fi
	$R ps -eo pid=,user:32=,args= | while read -r pid user args; do
		case "$args" in "PM2 v"*": God Daemon ("*")") ;; *) continue ;; esac
		home=$(printf '%s' "$args" | sed 's/.*God Daemon (\(.*\))$/\1/')
		if ! fds=$($R find "/proc/$pid/fd" -mindepth 1 -maxdepth 1 -printf '%l\n' 2>/dev/null); then
			printf 'P unread\t%s\t%s\t%s\t%s\n' "$pid" "$user" "$home" "its open files could not be listed (needs root, and sudo -n was refused)"
			continue
		fi
		printf 'P god\t%s\t%s\t%s\n' "$pid" "$user" "$home"
		printf '%s\n' "$fds" | while IFS= read -r t; do
			case "$t" in /dev/*|"") ;; /*) printf 'P fd\t%s\t%s\n' "$pid" "$t" ;; esac
		done
		for c in $($R pgrep -P "$pid"); do
			if ! env=$($R cat "/proc/$c/environ" 2>/dev/null | tr '\0' '\n'); then continue; fi
			n=$(printf '%s\n' "$env" | sed -n 's/^name=//p' | head -n1)
			[ -n "$n" ] || continue
			m=$(printf '%s\n' "$env" | sed -n 's/^exec_mode=//p' | head -n1)
			o=$(printf '%s\n' "$env" | sed -n 's/^pm_out_log_path=//p' | head -n1)
			e=$(printf '%s\n' "$env" | sed -n 's/^pm_err_log_path=//p' | head -n1)
			[ -n "$o" ] && o=$($R readlink -m "$o" 2>/dev/null || printf '%s' "$o")
			[ -n "$e" ] && e=$($R readlink -m "$e" 2>/dev/null || printf '%s' "$e")
			[ -n "$m" ] || m=-; [ -n "$o" ] || o=-; [ -n "$e" ] || e=-
			printf 'P app\t%s\t%s\t%s\t%s\t%s\n' "$pid" "$n" "$m" "$o" "$e"
		done
	done
	echo 'P end'
}`;

/** PM2 writes nothing for these (Utility.startLogging), so God holds no fd for them. */
const discarded = (file) => !file || file === '-' || file.includes('NULL') || file === '/dev/null';

/**
 * One daemon's dead streams: the running fork-mode apps' log files its God
 * holds no fd for. Cluster-mode workers write their own logs, not God.
 *
 * @param {{name: string, mode: string, out: string, err: string}[]} apps
 * @param {Set<string>} fds
 */
export function deadStreams(apps, fds) {
	const missing = [];
	for (const app of apps) {
		if (app.mode === 'cluster_mode') continue;
		for (const file of new Set([app.out, app.err])) {
			if (discarded(file) || fds.has(file)) continue;
			missing.push({ app: app.name, file });
		}
	}
	return missing;
}

/**
 * `$health.pm2Logs` out of the probe's `P ` lines: `{read: false, why}` when
 * the stanza did not finish (a cut-off listing is not "no daemons"), else
 * `{read: true, blind, daemons}`, each daemon with its apps and dead streams,
 * or with `unread` when it was seen and could not be read.
 *
 * @param {string[]} lines the `P `-prefixed lines, already stripped
 * @param {Record<string,string>} unknown the probe's `U` reasons
 */
export function pm2LogsFacet(lines, unknown = {}) {
	if (unknown.pm2Logs) return { read: false, why: unknown.pm2Logs };
	const rows = (lines ?? []).map((l) => l.split('\t'));
	if (!rows.some((r) => r[0] === 'end')) {
		return { read: false, why: 'the pm2 log-stream listing did not run to its end' };
	}
	const byPid = new Map();
	const fds = new Map();
	let blind = null;
	for (const [kind, ...r] of rows) {
		if (kind === 'god' && r.length >= 3) {
			byPid.set(r[0], { pid: Number(r[0]), user: r[1], home: r[2], apps: [], missing: [] });
			fds.set(r[0], new Set());
		} else if (kind === 'unread' && r.length >= 4) {
			byPid.set(r[0], { pid: Number(r[0]), user: r[1], home: r[2], unread: r[3] });
		} else if (kind === 'fd' && r.length >= 2) fds.get(r[0])?.add(r[1]);
		else if (kind === 'app' && r.length >= 5) {
			byPid.get(r[0])?.apps?.push({ name: r[1], mode: r[2], out: r[3], err: r[4] });
		} else if (kind === 'blind' && r[0]) blind = r[0];
	}
	const daemons = [...byPid.values()].map((d) =>
		d.unread ? d : { ...d, missing: deadStreams(d.apps, fds.get(String(d.pid))) }
	);
	return { read: true, blind, daemons };
}

/**
 * The findings. All advisory and shadow.
 *
 * @param {{node: string, pm2Logs?: ReturnType<typeof pm2LogsFacet>}} health
 */
export function pm2LogFindings(health) {
	const quiet = (status, why, extra = {}) =>
		f(health, CATEGORY, ADVISORY, status, why, { shadow: true, ...extra });
	const p = health.pm2Logs;
	if (!p) {
		return [
			quiet(
				'not-recorded',
				'this $health record has no pm2 log-stream reading: it was written before the doctor ' +
					'checked whether each pm2 app still writes to its log files.'
			),
		];
	}
	if (!p.read) {
		return [
			quiet('unreadable', `pm2 log streams were not read: ${p.why}. Not read is not healthy.`),
		];
	}
	const out = [];
	if (p.blind) out.push(quiet('blind', `pm2 log streams: ${p.blind}.`));
	for (const d of p.daemons) {
		const extra = { user: d.user, home: d.home };
		if (d.unread) {
			out.push(
				quiet('daemon-unread', `${d.user}'s pm2 (${d.home}) was not read: ${d.unread}.`, extra)
			);
		} else if (d.missing.length) {
			out.push(
				quiet(
					'dead-stream',
					`${d.user}'s pm2 (${d.home}) holds no open file for ` +
						`${d.missing.map((m) => `${m.app}'s ${m.file}`).join(', ')}: a write failed ` +
						'(ENOSPC) and PM2 never reopened the stream, or the file was deleted under it, ' +
						'so that output reaches no file. ' +
						`\`fleet doctor --machine ${health.node} --reload-logs\` reopens it as ${d.user} ` +
						'(pm2 reloadLogs; restarts nothing).',
					{ ...extra, missing: d.missing }
				)
			);
		}
	}
	return out;
}

/** The one-line summary `fleet doctor` prints: every pm2 home on the node and its state. */
export function pm2LogsLine(p) {
	if (!p) return 'not recorded';
	if (!p.read) return `unread: ${p.why}`;
	if (!p.daemons.length) return p.blind ? `unread: ${p.blind}` : 'no pm2 daemon';
	const each = p.daemons.map((d) => {
		if (d.unread) return `${d.home} UNREAD`;
		const n = d.apps.length;
		const dead = d.missing.length ? `, ${d.missing.length} DEAD` : n ? ', streams open' : '';
		return `${d.home} ${n} app${n === 1 ? '' : 's'}${dead}`;
	});
	return each.join('; ') + (p.blind ? `; ${p.blind}` : '');
}

/** Names this file will embed in a remote shell: observed, then checked, never quoted around. */
const SAFE_USER = /^[a-z_][a-z0-9_-]*$/;
const SAFE_HOME = /^\/[A-Za-z0-9._/-]+$/;

/**
 * `pm2 reloadLogs` for ONE daemon, as its own user, run on the node as admin.
 * Refuses unless the daemon at `pid` is still the God of `home` (a restarted
 * daemon opened fresh streams, and a pm2 command with none answering would
 * spawn one). Prints the pm2 output, then {@link PM2_LOGS_SH}'s listing again,
 * so the caller judges the after-state from the node, not from pm2's word.
 *
 * @param {{pid: number, user: string, home: string}} d
 */
export function reloadLogsScript({ pid, user, home }) {
	if (!Number.isInteger(pid) || pid <= 0 || !SAFE_USER.test(user) || !SAFE_HOME.test(home)) {
		throw new Error(
			`reloadLogsScript: refusing an unsafe daemon ${JSON.stringify({ pid, user, home })}`
		);
	}
	return [
		'set -u',
		'if [ "$(id -u)" = 0 ]; then SUDO=""; else SUDO="sudo -n"; fi',
		'if $SUDO true 2>/dev/null; then ROOTOK=yes; else ROOTOK=no; fi',
		'if [ "$ROOTOK" = yes ]; then R="$SUDO"; else R=""; fi',
		`case "$($R ps -o args= -p ${pid} 2>/dev/null)" in`,
		`  "PM2 v"*": God Daemon (${home})") ;;`,
		`  *) echo "RELOAD-REFUSED pid ${pid} is no longer the pm2 daemon of ${home}"; exit 3 ;;`,
		'esac',
		`if [ "$(id -u)" = "$(id -u ${user})" ]; then AS=""; else AS="sudo -n -u ${user}"; fi`,
		`$AS env PM2_HOME=${home} PATH=/usr/local/bin:/usr/bin:/bin pm2 reloadLogs 2>&1 | sed 's/^/RELOAD /'`,
		PM2_LOGS_SH,
		'pm2_logs | sed "s/^/after /"',
	].join('\n');
}

/**
 * Judge a {@link reloadLogsScript} run: `{ok, why?, missingAfter}`. `ok` only
 * when pm2 said it reloaded AND the node then shows the daemon holding every
 * one of its apps' files.
 */
export function judgeReload(stdout, { pid }) {
	const text = String(stdout ?? '');
	const refused = /^RELOAD-REFUSED (.*)$/m.exec(text);
	if (refused) return { ok: false, why: refused[1], missingAfter: null };
	const after = text
		.split('\n')
		.filter((l) => l.startsWith('after P '))
		.map((l) => l.slice('after P '.length));
	const facet = pm2LogsFacet(after);
	const d = facet.read ? facet.daemons.find((x) => x.pid === pid) : null;
	if (!d || d.unread) {
		return {
			ok: false,
			why: 'the daemon could not be read back after the reload',
			missingAfter: null,
		};
	}
	const reloaded = /All logs reloaded/.test(text);
	if (!reloaded)
		return { ok: false, why: 'pm2 did not report "All logs reloaded"', missingAfter: d.missing };
	if (d.missing.length)
		return { ok: false, why: 'streams are still dead after the reload', missingAfter: d.missing };
	return { ok: true, missingAfter: [] };
}
