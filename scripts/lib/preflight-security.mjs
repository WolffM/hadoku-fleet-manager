/**
 * preflight's SECURITY-UPDATES signal — split out of `preflight.mjs` (wave 5s
 * lane D, 800-line ceiling). See that file's header for the full "2026-10-25"
 * context. Every function here is pure: the probe script runs on the node
 * through `check-fleet-preflight.mjs`, which also owns `pendingSince`'s
 * state file.
 *
 * Re-exported from `preflight.mjs`, so nothing outside this pair of files
 * needs to know the split happened.
 */
import { BLOCKING } from './preflight.mjs';

/**
 * How many days a claw may go without the outcome unattended-upgrades exists for.
 *
 * apt-daily-upgrade fires daily (06:00 + up to 60 min jitter), so a healthy
 * claw installs a Debian security update within about a day of its lists
 * seeing it. Seven days is that cadence with room for a node out of service
 * over a long weekend (a drained node is deferred anyway) — and short enough
 * that the 2026-10-25 breakage, which ran from first boot for about seven
 * weeks, would have failed this gate in its first week. Debian publishes
 * several security updates for the stable release in any ordinary week, so
 * "pending, and nothing from Debian-Security installed for 7 days" is never
 * the normal state of a working node.
 */
export const SECURITY_STALE_DAYS = 7;

/**
 * How old apt's last successful list refresh may be. apt-daily refreshes about
 * twice a day; three days is six missed refreshes. Past it the node cannot SEE
 * new security updates, so "nothing pending" from it means nothing.
 */
export const LISTS_STALE_DAYS = 3;

/**
 * The node half: apt's own cache, read through python3-apt (unattended-
 * upgrades' own dependency, so present wherever the thing being checked is).
 * Read-only and unprivileged. The last security install is the newest
 * `upgrade` line in dpkg's own log (world-readable, rotated, gzipped past .1)
 * whose NEW version apt still knows from a Debian-Security index. An UPGRADE,
 * deliberately: a fresh `apt-get install` of a new package also lands the
 * security archive's version, and on 10-25 claw-5/6/8 read as "installed from
 * security this week" on an `unzip` the toolchain converger installed, while
 * not one pending update had been applied. dpkg logs the node's local time,
 * converted to epoch on the node. Every upgradable package whose
 * CANDIDATE comes from Debian-Security is pending. `update-stamp` is what
 * apt.systemd.daily touches after a list refresh.
 */
export const SECURITY_PROBE = `python3 - <<'PY'
import glob, gzip, os, time
try:
    import apt
except Exception as e:
    print('ERROR python3-apt unavailable: %s' % e)
    raise SystemExit(0)
SEC = 'Debian-Security'
c = apt.Cache()
def from_security(name, version):
    for key in (name, name.split(':')[0]):
        if key in c:
            v = c[key].versions.get(version)
            return v is not None and any(o.label == SEC for o in v.origins)
    return False
logs = sorted(glob.glob('/var/log/dpkg.log*'), key=lambda f: os.stat(f).st_mtime, reverse=True)
last, lastpkg = None, ''
for f in logs:
    opener = gzip.open if f.endswith('.gz') else open
    try:
        with opener(f, 'rt', errors='replace') as fh:
            rows = [l.split() for l in fh if ' upgrade ' in l]
    except OSError:
        continue
    for r in reversed(rows):
        if len(r) >= 6 and r[2] == 'upgrade' and from_security(r[3], r[5]):
            last = int(time.mktime(time.strptime('%s %s' % (r[0], r[1]), '%Y-%m-%d %H:%M:%S')))
            lastpkg = '%s=%s' % (r[3].split(':')[0], r[5])
            break
    if last:
        break
pending = []
for p in c:
    cand = p.candidate
    if p.is_upgradable and cand is not None and any(o.label == SEC for o in cand.origins):
        pending.append('%s=%s' % (p.shortname, cand.version))
try:
    lists = str(int(os.stat('/var/lib/apt/periodic/update-stamp').st_mtime))
except OSError:
    lists = 'NONE'
print('LISTS %s' % lists)
print('LAST %s %s' % (last or 'NONE', lastpkg))
for x in sorted(pending):
    print('PKG %s' % x)
print('END security-probe')
PY
`;

/** {@link SECURITY_PROBE}'s answer, or `null` when it is not one. */
export function parseSecurityProbe(text) {
	const lines = String(text ?? '')
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);
	const err = lines.find((l) => l.startsWith('ERROR '));
	if (err) return { error: err.slice(6) };
	if (!lines.includes('END security-probe')) return null;
	const word = (tag) => lines.find((l) => l.startsWith(`${tag} `))?.split(/\s+/)[1] ?? '';
	const epochMs = (v) => (/^\d+$/.test(v) ? Number(v) * 1000 : null);
	return {
		listsAtMs: epochMs(word('LISTS')),
		lastInstallAtMs: epochMs(word('LAST')),
		lastPackage: lines.find((l) => l.startsWith('LAST '))?.split(/\s+/)[2] ?? null,
		pending: lines.filter((l) => l.startsWith('PKG ')).map((l) => l.slice(4)),
	};
}

/**
 * When each pending `pkg=version` was first seen on this node, carried from the
 * last run. Pure: the caller reads and writes the file. A package no longer
 * pending is dropped, so a version that installs and a newer one that arrives
 * later starts its own clock.
 *
 * @param {Record<string,string>} prev  `pkg=version` -> ISO first seen
 * @returns {Record<string,string>}
 */
export function pendingSince(prev, pending, nowMs = Date.now()) {
	const now = new Date(nowMs).toISOString();
	return Object.fromEntries(pending.map((p) => [p, prev?.[p] ?? now]));
}

const daysAgo = (ms, nowMs) => (nowMs - ms) / 86_400_000;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * One node's security-update outcome -> a finding, or `null`.
 *
 * `probe` is `{ node, ok, error?, listsAtMs, lastInstallAtMs, lastPackage,
 * pending }`; `firstSeen` is {@link pendingSince} for the node. BLOCKING in
 * every case, and in this order, because each one hides the next:
 *
 *   unreachable    could not look.
 *   lists-stale    apt has not refreshed in LISTS_STALE_DAYS (or never), so
 *                  an empty pending list would be blindness, not a clean box.
 *   not-installing updates are pending and nothing from Debian-Security has
 *                  been installed in SECURITY_STALE_DAYS (or ever) — the
 *                  2026-10-25 shape. Needs no history, so a lost state file
 *                  cannot soften it.
 *   stuck          some pending update was first seen more than
 *                  SECURITY_STALE_DAYS ago while others installed: one
 *                  package held back (a conffile prompt, a dependency the
 *                  security archive does not carry) behind a node that is
 *                  otherwise patching.
 *
 * `check-fleet-preflight.mjs` applies a FURTHER demotion of its own on top of
 * this (wave gates2 lane F1b, operator-approved): every `security-updates`
 * finding from that gate's cron EXCEPT `unreachable` becomes advisory there,
 * because `fleet apt-security` owns acting on it. Not done here, in the
 * shared classifier, so a future second consumer of this pure function is not
 * handed somebody else's severity decision — see `rebootFinding`'s own note
 * in `preflight.mjs` for why that same shape applies to pending-reboot.
 */
export function securityUpdateFinding(
	probe,
	firstSeen = {},
	{ nowMs = Date.now(), staleDays = SECURITY_STALE_DAYS, listsStaleDays = LISTS_STALE_DAYS } = {}
) {
	const base = { category: 'security-updates', node: probe.node, class: BLOCKING };
	if (!probe.ok) {
		return {
			...base,
			status: 'unreachable',
			why: `${probe.node} could not be checked for pending security updates: ${probe.error}.`,
		};
	}
	if (probe.listsAtMs === null || daysAgo(probe.listsAtMs, nowMs) > listsStaleDays) {
		return {
			...base,
			status: 'lists-stale',
			why:
				`${probe.node}'s apt lists were ${probe.listsAtMs === null ? 'never refreshed by apt-daily (no update-stamp)' : `last refreshed ${day(probe.listsAtMs)}, ${Math.round(daysAgo(probe.listsAtMs, nowMs))} days ago`}` +
				` — past ${listsStaleDays} days, so it cannot see new security updates and "none pending" ` +
				'from it means nothing. Check apt-daily.timer and `apt-get update` on the node.',
		};
	}
	const pending = probe.pending ?? [];
	if (!pending.length) return null;
	const sample =
		pending.slice(0, 5).join(', ') + (pending.length > 5 ? `, +${pending.length - 5} more` : '');
	const last = probe.lastInstallAtMs;
	if (last === null || daysAgo(last, nowMs) > staleDays) {
		return {
			...base,
			status: 'not-installing',
			pending: pending.length,
			lastInstall: last === null ? null : new Date(last).toISOString(),
			why:
				`${probe.node} has ${pending.length} Debian security update(s) pending (${sample}) and ` +
				(last === null
					? 'has never installed anything from Debian-Security'
					: `has installed nothing from Debian-Security since ${day(last)} (${probe.lastPackage}), ` +
						`${Math.round(daysAgo(last, nowMs))} days`) +
				` — past ${staleDays} days, unattended-upgrades is not doing its job. ` +
				`Run \`fleet apt-security --machine ${probe.node}\` (it executes the dry run and says why).`,
		};
	}
	const stuck = pending.filter((p) => {
		const t = Date.parse(firstSeen[p] ?? '');
		return Number.isFinite(t) && daysAgo(t, nowMs) > staleDays;
	});
	if (!stuck.length) return null;
	return {
		...base,
		status: 'stuck',
		pending: pending.length,
		stuck,
		why:
			`${probe.node} has ${stuck.length} Debian security update(s) pending for more than ${staleDays} ` +
			`days (${stuck.slice(0, 5).join(', ')}${stuck.length > 5 ? ', ...' : ''}) while it installed ` +
			`others as recently as ${day(last)}: held back, not forgotten. ` +
			`\`sudo unattended-upgrade --dry-run -d\` on ${probe.node} names the reason.`,
	};
}
