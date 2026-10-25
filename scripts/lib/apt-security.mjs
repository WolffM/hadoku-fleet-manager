/**
 * apt-security — will a claw actually INSTALL Debian security updates?
 *
 * THE INCIDENT THIS EXISTS FOR (2026-10-25). node-bootstrap wrote
 * `Unattended-Upgrade::Allowed-Origins { "${distro_id}:${distro_codename}-security"; }`,
 * which unattended-upgrades expands to `o=Debian,a=trixie-security`. Debian's
 * security archive is `a=stable-security, n=trixie-security, l=Debian-Security`,
 * so the pattern matched nothing, on every node the profile ever imaged. The
 * timer fired daily, the log said "No packages found that can be upgraded
 * unattended", and that line reads exactly like a patched box. Measured that
 * day: 29 to 70 pending security updates per claw.
 *
 * So the check here EXECUTES the policy rather than reading the file it wrote
 * (AGENTS.md: "the reader for a facet may not read what the writer wrote"). It
 * runs `unattended-upgrade --dry-run -d` and reads two things from it — the
 * origins it actually resolved, and the packages it would actually pick — and
 * sets them beside apt's own count of upgradable packages whose candidate is
 * from Debian-Security (`apt-get -s dist-upgrade`). Security updates pending
 * and none selected IS the incident, whatever the file says. The periodic
 * switches are read from `apt-config`, apt's merged view of every conf.d file,
 * and the timers from systemd.
 *
 * ONE SOURCE, TWO RENDERERS. The profile's `unattendedUpgrades` block is the
 * policy. node-bootstrap renders it on a fresh node (between its
 * `BEGIN/END apt-security render` markers) and {@link renderUnattendedConf}
 * renders it for `fleet apt-security --confirm` on a node already in service.
 * apt-security.test.mjs runs the bootstrap block and compares the bytes.
 *
 * Pure: the I/O lives in `scripts/apt-security.mjs`.
 */

/** The Release `Label` of Debian's security archive — the field the pattern must pin. */
export const SECURITY_LABEL = 'Debian-Security';

/** Where the two files live; `APT_CONF_D` on the node is the test seam. */
export const APT_CONF_D = '/etc/apt/apt.conf.d';

/** The periodic switches, verbatim from node-bootstrap step 10. */
export const AUTO_UPGRADES_CONF =
	'APT::Periodic::Update-Package-Lists "1";\n' +
	'APT::Periodic::Unattended-Upgrade "1";\n' +
	'APT::Periodic::AutocleanInterval "7";\n';

/** Both have to be enabled: one refreshes the lists, the other installs from them. */
export const APT_TIMERS = ['apt-daily.timer', 'apt-daily-upgrade.timer'];

const isProse = (k) => k.startsWith('$');

/** The block without its `$why` annotations — the part that images anything. */
function policyOf(block) {
	return Object.fromEntries(Object.entries(block ?? {}).filter(([k]) => !isProse(k)));
}

/**
 * The fleet's one apt policy, from every declared profile.
 *
 * Nothing maps a node to a profile after it is imaged, so a policy the
 * profiles DISAGREE on has no answer for a node in service. That is a refusal,
 * not a pick: choosing one would converge half the fleet onto a shape its
 * profile does not declare.
 *
 * @param {Map<string, object>} profiles `loadNodeProfiles().profiles`
 */
export function aptSecurityPolicy(profiles) {
	const seen = [];
	for (const [id, p] of profiles) {
		if (!p?.unattendedUpgrades) throw new Error(`profile ${id} declares no unattendedUpgrades`);
		seen.push([id, policyOf(p.unattendedUpgrades)]);
	}
	if (!seen.length) throw new Error('no profile declares unattendedUpgrades');
	const [firstId, policy] = seen[0];
	for (const [id, other] of seen.slice(1)) {
		if (JSON.stringify(other) !== JSON.stringify(policy)) {
			throw new Error(
				`profiles ${firstId} and ${id} declare different unattendedUpgrades, and nothing records ` +
					'which profile imaged a node in service, so there is no single policy to converge on'
			);
		}
	}
	const pats = policy.originsPattern;
	if (!Array.isArray(pats) || !pats.length || !pats.every((s) => typeof s === 'string' && s)) {
		throw new Error('unattendedUpgrades.originsPattern must be a non-empty list of patterns');
	}
	if (!pats.some((s) => s.includes(`label=${SECURITY_LABEL}`))) {
		throw new Error(
			`no unattendedUpgrades.originsPattern names label=${SECURITY_LABEL}, so nothing pins the ` +
				'security archive — the 2026-10-25 shape'
		);
	}
	for (const k of ['automaticReboot', 'removeUnusedKernelPackages']) {
		if (typeof policy[k] !== 'boolean')
			throw new Error(`unattendedUpgrades.${k} must be a boolean`);
	}
	return policy;
}

/** `/etc/apt/apt.conf.d/50unattended-upgrades`, byte for byte what node-bootstrap writes. */
export function renderUnattendedConf(policy) {
	return [
		'Unattended-Upgrade::Origins-Pattern {',
		...policy.originsPattern.map((p) => `    "${p}";`),
		'};',
		`Unattended-Upgrade::Remove-Unused-Kernel-Packages "${policy.removeUnusedKernelPackages}";`,
		'Unattended-Upgrade::Remove-Unused-Dependencies "true";',
		`Unattended-Upgrade::Automatic-Reboot "${policy.automaticReboot}";`,
		'',
	].join('\n');
}

const END = 'END apt-security';

/**
 * The node half of the check. Read-only apart from what the dry run itself
 * does: it downloads what it would install into apt's cache and appends to its
 * own log, which is what the daily timer does too.
 *
 * The dry run takes apt's lock. When apt-daily holds it the dry run exits
 * non-zero, and that is reported as "could not look" with the dry run's last
 * words, never as drift and never as clean.
 */
export function probeScript() {
	return `set -u
echo "BEGIN apt-security"
out=$(sudo -n unattended-upgrade --dry-run -d 2>&1); rc=$?
echo "DRYRUN-EXIT $rc"
printf '%s\\n' "$out" | grep -m1 'Allowed origins are:' | sed 's/^.*Allowed origins are:[[:space:]]*/ORIGINS /'
printf '%s\\n' "$out" | grep -m1 'Packages that will be upgraded:' | sed 's/^.*Packages that will be upgraded:[[:space:]]*/SELECTED /'
[ "$rc" = 0 ] || printf '%s\\n' "$out" | tail -n 2 | sed 's/^/DRYRUN-TAIL /'
if sim=$(apt-get -s -o Debug::NoLocking=1 dist-upgrade 2>&1); then
	echo "CANDIDATES $(printf '%s\\n' "$sim" | grep '^Inst ' | grep -c '${SECURITY_LABEL}')"
else
	echo "CANDIDATES ERR $(printf '%s\\n' "$sim" | tail -n 1)"
fi
UPL=; UU=
eval "$(apt-config shell UPL APT::Periodic::Update-Package-Lists UU APT::Periodic::Unattended-Upgrade 2>/dev/null)"
echo "PERIODIC \${UPL:-unset} \${UU:-unset}"
for t in ${APT_TIMERS.join(' ')}; do
	e=$(systemctl is-enabled "$t" 2>/dev/null)
	echo "TIMER $t \${e:-not-found}"
done
echo "${END}"
`;
}

/**
 * The probe's answer, or `{ ok: false, error }`. An answer cut off before its
 * end marker is "could not look", however much of it arrived.
 */
export function parseProbe(text) {
	const lines = String(text ?? '')
		.split('\n')
		.map((l) => l.trim());
	if (!lines.includes(END)) {
		return { ok: false, error: `probe output ended before its end marker: ${tail(text)}` };
	}
	const field = (tag) => lines.find((l) => l === tag || l.startsWith(`${tag} `));
	const rest = (tag) => field(tag)?.slice(tag.length + 1) ?? null;
	const exit = Number(rest('DRYRUN-EXIT'));
	if (!Number.isInteger(exit)) return { ok: false, error: 'probe printed no dry-run exit status' };
	if (exit !== 0) {
		const why = lines
			.filter((l) => l.startsWith('DRYRUN-TAIL '))
			.map((l) => l.slice(12))
			.join(' | ');
		return {
			ok: false,
			error: `unattended-upgrade --dry-run exited ${exit}${why ? `: ${why}` : ''}`,
		};
	}
	const cand = rest('CANDIDATES');
	if (cand === null || !/^\d+$/.test(cand)) {
		return {
			ok: false,
			error: `apt could not count pending security updates: ${cand ?? 'no answer'}`,
		};
	}
	const [update = 'unset', upgrade = 'unset'] = (rest('PERIODIC') ?? '').split(/\s+/);
	const timers = Object.fromEntries(
		lines
			.filter((l) => l.startsWith('TIMER '))
			.map((l) => l.split(/\s+/))
			.map(([, t, state]) => [t, state ?? 'not-found'])
	);
	const selected = (rest('SELECTED') ?? '').split(/\s+/).filter(Boolean);
	return {
		ok: true,
		origins: rest('ORIGINS'),
		selected,
		candidates: Number(cand),
		periodic: { update, upgrade },
		timers,
	};
}

/**
 * What is wrong with an answered probe, one sentence each. Empty means the
 * node will install security updates on its next timer.
 */
export function judgeProbe(p) {
	const drift = [];
	const securityPinned = new RegExp(`\\b(l|label)=${SECURITY_LABEL}\\b`).test(p.origins ?? '');
	if (!securityPinned) {
		drift.push(
			`the dry run resolved origins "${p.origins ?? '(none printed)'}", and none pins label=${SECURITY_LABEL}`
		);
	}
	if (p.candidates > 0 && p.selected.length === 0) {
		drift.push(
			`${p.candidates} security update(s) are pending and the dry run selects none of them`
		);
	}
	if (p.periodic.update !== '1' || p.periodic.upgrade !== '1') {
		drift.push(
			`apt-config has APT::Periodic::Update-Package-Lists=${p.periodic.update} and ` +
				`Unattended-Upgrade=${p.periodic.upgrade}; both must be 1`
		);
	}
	for (const t of APT_TIMERS) {
		if (p.timers[t] !== 'enabled') drift.push(`${t} is ${p.timers[t] ?? 'not-found'}, not enabled`);
	}
	return drift;
}

/** `SUMMARY k=v ...`, the shape `parseSummary` and the converger read. */
export function summaryOf(p, drift, extra = {}) {
	const kv = {
		origins: drift.some((d) => d.includes('resolved origins')) ? 'wrong' : 'ok',
		candidates: p.candidates,
		selected: p.selected.length,
		drift: drift.length,
		...extra,
	};
	return `SUMMARY ${Object.entries(kv)
		.map(([k, v]) => `${k}=${v}`)
		.join(' ')}`;
}

/** The repair: both files from the policy, then the timers. Root via `sudo -n`. */
export function repairScript(policy) {
	const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
	return `set -eu
D="\${APT_CONF_D:-${APT_CONF_D}}"
sudo -n mkdir -p "$D"
printf '%s' '${b64(AUTO_UPGRADES_CONF)}' | base64 -d | sudo -n tee "$D/20auto-upgrades" >/dev/null
printf '%s' '${b64(renderUnattendedConf(policy))}' | base64 -d | sudo -n tee "$D/50unattended-upgrades" >/dev/null
sudo -n systemctl enable --now ${APT_TIMERS.join(' ')}
echo REPAIRED
`;
}

function tail(text) {
	const t = String(text ?? '').trim();
	return t ? t.split('\n').slice(-2).join(' | ').slice(0, 200) : '(no output)';
}
