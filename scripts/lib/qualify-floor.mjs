/**
 * `floor-admin` and `floor-ci` — EXECUTE the node's provisioning floor
 * instead of inspecting it (wave bootcamp2 Q3).
 *
 * WHY. Five of the 37 node incidents in the 10-11..11-11 retrospective were a
 * floor that read as present and did not work:
 *
 *   - unattended-upgrades on every claw matched NOTHING for ~7 weeks (found
 *     10-25): the pattern named an archive Debian's security suite does not
 *     carry, the timer ran daily, and "No packages found that can be upgraded
 *     unattended" reads exactly like a patched box.
 *   - claw-10's smartd has been failed since 11-09 on a dead 3 TB disk, so it
 *     monitors no disk at all while smartmontools reads as installed.
 *   - claw-9 had no `unzip` after its 10-30 cutover, and APK builds failed.
 *
 * So each check RUNS the thing:
 *
 *   floor-admin  `sudo -n unattended-upgrade --dry-run -d` (apt-security's
 *                probe, reused whole) and its resolved origins matched against
 *                the node's own `apt-cache policy` releases: the pattern must
 *                match the Debian-Security archive, not merely name its label.
 *                smartd active, and its own journal for THIS run saying it
 *                monitors at least SMARTD_MIN_DEVICES device. The admin-role
 *                toolchain floor entries (pm2 hosts), their detects executed.
 *   floor-ci     every ci-role toolchain floor entry's detect, and a version
 *                command for every declared floor package that ships one, run
 *                as ci under the ci user's systemd --user manager PATH: the
 *                PATH a runner job gets, not a login shell's.
 *
 * Read-only on the node apart from what the dry run itself does (it fills
 * apt's download cache, as the daily timer does) and a throwaway venv in
 * mktemp.
 */
import { profileManifestPath } from './node-profiles.mjs';
import { judgeProbe, parseProbe, probeScript, SECURITY_LABEL } from './apt-security.mjs';
import { QUALIFY_TTL_DAYS } from './qualify-registry.mjs';
import {
	applicableRepairs,
	declaredPackages,
	parseObservation,
	probeRole,
} from './toolchain-floor.mjs';

/** Devices smartd must say it monitors. claw-10's failed smartd monitors none (since 11-09). */
export const SMARTD_MIN_DEVICES = 1;
/** Debian's unit; `smartd.service` is its alias. */
export const SMARTD_UNIT = 'smartmontools.service';

/**
 * The command that proves a declared floor package WORKS, for the packages a
 * job runs directly. Library packages have no command and stay with
 * `fleet converge-toolchain`'s dpkg read. gh, ffmpeg and mpv are not here:
 * their toolchain-floor entries already execute them. A key that is not a
 * declared package fails the test beside this file.
 */
export const PACKAGE_COMMANDS = Object.freeze({
	unzip: 'unzip -v',
	git: 'git --version',
	curl: 'curl --version',
	wget: 'wget --version',
	jq: 'jq --version',
	rsync: 'rsync --version',
	python3: 'python3 --version',
	'python3-pip': 'python3 -m pip --version',
	// ensurepip is what python3-venv adds; `--without-pip` would pass without it.
	'python3-venv': 'd=$(mktemp -d) || exit 1; python3 -m venv "$d/v"; rc=$?; rm -rf "$d"; exit $rc',
	cmake: 'cmake --version',
	'build-essential': 'gcc --version && make --version',
	gettext: 'gettext --version',
	openssl: 'openssl version',
	time: '/usr/bin/time true',
});

const errOf = (r) =>
	String(r?.error || r?.stderr || r?.stdout || 'no output')
		.trim()
		.slice(-300);
const has = (text, marker) =>
	String(text ?? '')
		.split('\n')
		.some((l) => l.trim() === marker);

// ── unattended-upgrades ─────────────────────────────────────────────────────

/** apt-security's probe, then every release apt knows, for the origin match. */
export function aptScript() {
	return `${probeScript()}apt-cache policy 2>/dev/null | sed -n 's/^ *release /QF-RELEASE release /p' | sort -u
echo QF-POLICY-END
`;
}

/** PURE. `QF-RELEASE release o=Debian,a=stable-security,…` lines → field maps (`a=now`, dpkg's own status, dropped). */
export function parseReleases(text) {
	return String(text ?? '')
		.split('\n')
		.filter((l) => l.startsWith('QF-RELEASE release '))
		.map((l) =>
			Object.fromEntries(
				l
					.slice('QF-RELEASE release '.length)
					.split(',')
					.map((kv) => kv.split('='))
					.filter(([k, v]) => k && v !== undefined)
					.map(([k, ...v]) => [k.trim(), v.join('=').trim()])
			)
		)
		.filter((r) => !(Object.keys(r).length === 1 && r.a === 'now'));
}

/** unattended-upgrades' Origins-Pattern keys, to the release field each compares. `site` is not in a release line. */
const KEYS = {
	origin: 'o',
	o: 'o',
	label: 'l',
	l: 'l',
	archive: 'a',
	a: 'a',
	suite: 'a',
	codename: 'n',
	n: 'n',
	component: 'c',
	c: 'c',
};
const glob = (pat) =>
	new RegExp(
		`^${pat
			.replace(/[.+^${}()|[\]\\]/g, '\\$&')
			.replace(/\*/g, '.*')
			.replace(/\?/g, '.')}$`
	);

/**
 * PURE. Does one Origins-Pattern (`origin=Debian,codename=trixie-security,…`)
 * match one release? Every key must match; a key the release does not carry
 * cannot be shown to match, so it does not.
 */
export function originMatches(pattern, release) {
	const tokens = String(pattern ?? '')
		.split(',')
		.map((t) => t.trim())
		.filter(Boolean);
	if (!tokens.length) return false;
	return tokens.every((t) => {
		const i = t.indexOf('=');
		const field = KEYS[t.slice(0, i)];
		return (
			i > 0 &&
			field !== undefined &&
			release[field] !== undefined &&
			glob(t.slice(i + 1)).test(release[field])
		);
	});
}

/** PURE. The dry run, judged: apt-security's drift, and the resolved origins matched against real releases. */
export function judgeApt(text) {
	const fails = [];
	const unknown = [];
	const p = parseProbe(text);
	if (!p.ok) return { fails, unknown: [p.error], metrics: {} };
	fails.push(...judgeProbe(p));
	if (!has(text, 'QF-POLICY-END')) unknown.push('apt-cache policy ended before its end marker');
	const releases = parseReleases(text);
	const patterns = String(p.origins ?? '')
		.split(/,\s+/)
		.filter(Boolean);
	const matched = releases.filter((r) => patterns.some((pat) => originMatches(pat, r)));
	const security = matched.filter((r) => r.l === SECURITY_LABEL);
	if (!releases.length) unknown.push('apt-cache policy listed no release');
	else if (!matched.length)
		fails.push(
			`the resolved origins "${p.origins ?? ''}" match none of the node's ${releases.length} apt release(s): ` +
				'unattended-upgrades would install nothing (the 10-25 shape, ~7 weeks unpatched)'
		);
	else if (!security.length)
		fails.push(
			`the resolved origins "${p.origins}" match ${matched.length} release(s), and no ${SECURITY_LABEL} one`
		);
	return {
		fails,
		unknown,
		metrics: {
			origins: p.origins,
			releases: releases.length,
			matchedSources: matched.length,
			securitySources: security.length,
			pendingSecurity: p.candidates,
			selected: p.selected.length,
		},
	};
}

// ── smartd ──────────────────────────────────────────────────────────────────

/** smartd's state, and the `Monitoring …` line from its journal for THIS invocation. */
export function smartdScript() {
	const u = SMARTD_UNIT;
	return String.raw`echo "QF-SMARTD-LOAD $(systemctl show -P LoadState ${u} 2>/dev/null)"
echo "QF-SMARTD-STATE $(systemctl is-active ${u} 2>/dev/null)"
echo "QF-SMARTD-RESULT $(systemctl show -P Result ${u} 2>/dev/null)"
inv=$(systemctl show -P InvocationID ${u} 2>/dev/null)
if [ -z "$inv" ]; then echo "QF-SMARTD-MON-ERR smartd has no invocation id"
elif J=$(journalctl _SYSTEMD_INVOCATION_ID="$inv" -o cat --no-pager 2>&1); then
  M=$(printf '%s\n' "$J" | grep -E '^Monitoring [0-9]+ ' | tail -n 1)
  if [ -n "$M" ]; then echo "QF-SMARTD-MON $M"
  else echo "QF-SMARTD-MON-ERR smartd's journal for this run carries no Monitoring line (rotated away?)"; fi
else echo "QF-SMARTD-MON-ERR journalctl refused: $(printf '%s\n' "$J" | tail -n 1)"; fi
echo QF-SMARTD-END
`;
}

/** PURE. smartd judged: installed, active, and monitoring at least SMARTD_MIN_DEVICES. */
export function judgeSmartd(text) {
	const lines = String(text ?? '')
		.split('\n')
		.map((l) => l.trim());
	const get = (tag) =>
		lines
			.find((l) => l === tag || l.startsWith(`${tag} `))
			?.slice(tag.length + 1)
			.trim() ?? null;
	if (!lines.includes('QF-SMARTD-END'))
		return { fails: [], unknown: ['the smartd read ended before its end marker'], metrics: {} };
	const load = get('QF-SMARTD-LOAD');
	const state = get('QF-SMARTD-STATE');
	const result = get('QF-SMARTD-RESULT');
	const m = /^Monitoring (\d+) ATA\/SATA, (\d+) SCSI\/SAS and (\d+) NVMe devices/.exec(
		get('QF-SMARTD-MON') ?? ''
	);
	const devices = m ? Number(m[1]) + Number(m[2]) + Number(m[3]) : null;
	const metrics = { state, result, devices };
	if (load === 'not-found')
		return {
			fails: [`${SMARTD_UNIT} is not installed (smartmontools is a declared floor package)`],
			unknown: [],
			metrics,
		};
	if (state !== 'active')
		return {
			fails: [
				`${SMARTD_UNIT} is ${state || 'unknown'} (${result || 'no result'}), so it monitors no disk`,
			],
			unknown: [],
			metrics,
		};
	if (devices === null)
		return {
			fails: [],
			unknown: [get('QF-SMARTD-MON-ERR') ?? 'smartd printed no Monitoring line'],
			metrics,
		};
	if (devices < SMARTD_MIN_DEVICES)
		return {
			fails: [
				`smartd is active and monitors ${devices} device(s); the floor is at least ${SMARTD_MIN_DEVICES}`,
			],
			unknown: [],
			metrics,
		};
	return { fails: [], unknown: [], metrics };
}

// ── the toolchain floor, executed ───────────────────────────────────────────

/** One REPAIR line per entry, the same detect and line converge-toolchain prints. */
const detectLines = (entries) =>
	entries.map(([id, t]) => `printf 'REPAIR %s %s\\n' '${id}' "$(${t.detect} || echo MISSING)"`);

/** The admin-role entries, run as admin with its own ssh PATH (what converge-toolchain reads). */
export function adminToolsScript(entries) {
	return ['cd "$HOME" 2>/dev/null || cd /', ...detectLines(entries), 'echo QF-TOOLS-END', ''].join(
		'\n'
	);
}

/**
 * The ci-role entries and the packages, run as ci under the PATH its systemd
 * --user manager hands every runner unit. Each package runs in a subshell, so
 * one that exits cannot end the read.
 */
export function ciToolsScript(entries, packages) {
	return [
		'cd "$HOME" 2>/dev/null || cd /',
		'JP=$(XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" systemctl --user show-environment 2>/dev/null | sed -n \'s/^PATH=//p\')',
		`if [ -z "$JP" ]; then echo "QF-PATH-ERR the ci user's systemd manager gave no PATH"; else`,
		'echo "QF-PATH $JP"',
		'export PATH="$JP"',
		...detectLines(entries),
		...packages.map(
			(p) => `( ${PACKAGE_COMMANDS[p]} ) >/dev/null 2>&1 || printf 'PKG-MISSING %s\\n' '${p}'`
		),
		'fi',
		'echo QF-TOOLS-END',
		'',
	].join('\n');
}

/** PURE. A tools read judged: every entry answered OK, every package ran. */
export function judgeTools(text, entries, packages, { jobPath = false } = {}) {
	const out = String(text ?? '');
	if (!has(out, 'QF-TOOLS-END'))
		return { fails: [], unknown: ['the floor read ended before its end marker'], metrics: {} };
	const pathErr = /^QF-PATH-ERR (.*)$/m.exec(out)?.[1];
	if (jobPath && pathErr) return { fails: [], unknown: [pathErr], metrics: {} };
	const path = /^QF-PATH (.*)$/m.exec(out)?.[1] ?? null;
	const said = Object.fromEntries(
		[...out.matchAll(/^REPAIR (\S+) (.*)$/gm)].map((m) => [m[1], m[2]])
	);
	const { missingPackages, brokenCapabilities } = parseObservation(out);
	const fails = [
		...brokenCapabilities.map((id) => `${id} (${said[id] || 'no answer'})`),
		...missingPackages.map((p) => `${p} (\`${PACKAGE_COMMANDS[p] ?? p}\` did not run)`),
	];
	const silent = entries.map(([id]) => id).filter((id) => !(id in said));
	return {
		fails,
		unknown: silent.length ? [`no answer for ${silent.join(', ')}`] : [],
		metrics: {
			path,
			tools: entries.map(([id]) => id),
			packages,
			broken: brokenCapabilities,
			missingPackages,
		},
	};
}

// ── the tests ───────────────────────────────────────────────────────────────

/** Fails first, then unknowns; a pass only when neither. */
function verdict(parts, passText, metrics) {
	const fails = parts.flatMap((p) => p.fails);
	const unknown = parts.flatMap((p) => p.unknown);
	if (fails.length) return { status: 'fail', reason: [...fails, ...unknown].join('; '), metrics };
	if (unknown.length) return { status: 'could-not-look', reason: unknown.join('; '), metrics };
	return { status: 'pass', reason: passText, metrics };
}

const readDeclared = () =>
	declaredPackages(process.env.FLEET_NODE_PROFILES || profileManifestPath()).common;

/**
 * Both floor tests, with the declared-package read injectable for tests.
 *
 * @param {{ readPackages?: () => string[] }} [o]
 */
export function makeFloorTests({ readPackages = readDeclared } = {}) {
	const base = { track: 'qualify', needsDrain: false, ttlDays: QUALIFY_TTL_DAYS, minutes: 15 };
	const floorAdmin = {
		...base,
		id: 'floor-admin',
		runsAs: 'admin',
		async run(ctx) {
			const read = async (script, timeoutMs, judge, what) => {
				const r = await ctx.exec(script, { timeoutMs });
				if (!r.ok && !String(r.stdout ?? '').trim())
					return { fails: [], unknown: [`${what}: ${errOf(r)}`], metrics: {} };
				return judge(r.stdout);
			};
			const apt = await read(aptScript(), 600_000, judgeApt, 'unattended-upgrade dry run');
			const smart = await read(smartdScript(), 60_000, judgeSmartd, 'smartd read');
			const entries = applicableRepairs(ctx.machine).filter(([, t]) => probeRole(t) === 'admin');
			const tools = entries.length
				? await read(
						adminToolsScript(entries),
						300_000,
						(o) => judgeTools(o, entries, []),
						'admin floor read'
					)
				: { fails: [], unknown: [], metrics: { tools: [] } };
			return verdict(
				[apt, smart, tools],
				`unattended-upgrade --dry-run resolves "${apt.metrics.origins}", which matches ` +
					`${apt.metrics.securitySources} ${SECURITY_LABEL} release(s); smartd active, monitoring ` +
					`${smart.metrics.devices} device(s)` +
					(entries.length ? `; admin floor ran: ${entries.map(([id]) => id).join(', ')}` : ''),
				{ apt: apt.metrics, smartd: smart.metrics, tools: tools.metrics }
			);
		},
	};
	const floorCi = {
		...base,
		id: 'floor-ci',
		runsAs: 'ci',
		async run(ctx) {
			let declared;
			try {
				declared = readPackages();
			} catch (e) {
				return {
					status: 'could-not-look',
					reason: `could not read the declared package floor: ${e instanceof Error ? e.message : String(e)}`,
					metrics: {},
				};
			}
			const packages = declared.filter((p) => p in PACKAGE_COMMANDS);
			const entries = applicableRepairs(ctx.machine).filter(([, t]) => probeRole(t) === 'ci');
			const r = await ctx.exec(ciToolsScript(entries, packages), { timeoutMs: 600_000 });
			const j =
				!r.ok && !String(r.stdout ?? '').trim()
					? { fails: [], unknown: [`the ci floor read: ${errOf(r)}`], metrics: {} }
					: judgeTools(r.stdout, entries, packages, { jobPath: true });
			return verdict(
				[j],
				`${entries.length} floor tool(s) (${entries.map(([id]) => id).join(', ')}) and ` +
					`${packages.length} package(s) (${packages.join(', ')}) ran as ci under the runner PATH ` +
					`(${j.metrics.path}); ${declared.length - packages.length} declared package(s) have no command ` +
					'to run here and stay with converge-toolchain',
				{ ...j.metrics, declared: declared.length }
			);
		},
	};
	return [floorAdmin, floorCi];
}

export const tests = makeFloorTests();
